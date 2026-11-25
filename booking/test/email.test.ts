import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { attemptDelivery, clientConfirmationEmail, processEmailQueue, resendEmail, sendEmail, testEmail, type Transport } from "../src/email";
import { getEmailSettings, mergeEmailSettings, saveEmailSettings } from "../src/email-settings";
import type { Env } from "../src/env";
import { sendDueReminders } from "../src/reminders";

const HOUR = 3_600_000;
const BASE = "https://booking.test";
const smtpEnv = (overrides: Partial<Env> = {}): Env => ({ ...env, EMAIL_MODE: "smtp", ...overrides }) as Env;

function recordingTransport(failTimes = 0) {
  const sent: { to: string[]; subject: string; fromName?: string }[] = [];
  let failures = 0;
  const transport: Transport = async (_env, mail) => {
    if (failures < failTimes) {
      failures++;
      throw new Error("535 Authentication failed");
    }
    sent.push({ to: mail.to, subject: mail.subject, fromName: mail.fromName });
  };
  return { sent, transport };
}

async function logRow(id: string) {
  return env.DB.prepare("SELECT status, attempts, payload, error, next_attempt_at FROM email_log WHERE id = ?")
    .bind(id)
    .first<{ status: string; attempts: number; payload: string | null; error: string | null; next_attempt_at: number | null }>();
}

async function insertBooking(id: string, startAt: number, createdAt: number, status = "confirmed") {
  await env.DB.prepare(
    `INSERT INTO bookings (id, slot_id, service_id, session_kind, start_at, end_at, name, email, status, cancel_token_hash, consent_at, created_at)
     VALUES (?, ?, 'psychotherapie', 'folgetermin', ?, ?, 'Eva Beispiel', 'eva@example.at', ?, ?, ?, ?)`,
  )
    .bind(id, `slot-${id}`, startAt, startAt + 50 * 60_000, status, `hash-${id}`, createdAt, createdAt)
    .run();
}

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bookings"),
    env.DB.prepare("DELETE FROM email_log"),
    env.DB.prepare("DELETE FROM settings WHERE key LIKE 'email_%'"),
  ]);
});

describe("e-mail delivery", () => {
  it("only stores the e-mail in log mode", async () => {
    const cfg = await getEmailSettings(env);
    const { sent, transport } = recordingTransport();
    const result = await sendEmail(env, cfg, testEmail(env, cfg, "a@example.at"), transport);
    expect(result.status).toBe("logged");
    expect(sent).toHaveLength(0);
  });

  it("sends, then keeps only metadata", async () => {
    const e = smtpEnv();
    const cfg = await getEmailSettings(e);
    const { sent, transport } = recordingTransport();
    const result = await sendEmail(e, cfg, testEmail(e, cfg, "a@example.at"), transport);
    expect(result.status).toBe("sent");
    expect(sent).toEqual([{ to: ["a@example.at"], subject: "[TEST] Test-E-Mail der Online-Terminbuchung", fromName: "Praxis Lisa Berger" }]);
    expect(await logRow(result.id!)).toMatchObject({ status: "sent", attempts: 1, payload: null, error: null });
  });

  it("retries failed attempts and gives up after three", async () => {
    const e = smtpEnv();
    const cfg = await getEmailSettings(e);
    const { transport } = recordingTransport(10);
    const first = await sendEmail(e, cfg, testEmail(e, cfg, "a@example.at"), transport);
    expect(first.status).toBe("pending");
    const row = await logRow(first.id!);
    expect(row).toMatchObject({ status: "pending", attempts: 1, error: "535 Authentication failed" });
    expect(row!.next_attempt_at!).toBeGreaterThan(Date.now() + 4 * 60_000);

    // Not due yet: the queue job leaves it alone.
    expect(await processEmailQueue(e, transport)).toBe(0);

    for (const expected of ["pending", "failed"]) {
      await env.DB.prepare("UPDATE email_log SET next_attempt_at = 0 WHERE id = ?").bind(first.id).run();
      expect((await attemptDelivery(e, first.id!, transport)).status).toBe(expected);
    }
    expect(await logRow(first.id!)).toMatchObject({ status: "failed", attempts: 3 });
    expect((await logRow(first.id!))!.payload).not.toBeNull();

    // "Send again" from the dashboard succeeds once the problem is fixed.
    const ok = recordingTransport();
    expect((await resendEmail(e, first.id!, ok.transport))!.status).toBe("sent");
    expect(ok.sent).toHaveLength(1);
    expect(await resendEmail(e, first.id!, ok.transport)).toBeNull();
  });

  it("does not send twice when an attempt is already running", async () => {
    const e = smtpEnv();
    const cfg = await getEmailSettings(e);
    const { sent, transport } = recordingTransport(1);
    const first = await sendEmail(e, cfg, testEmail(e, cfg, "a@example.at"), transport);
    await env.DB.prepare("UPDATE email_log SET next_attempt_at = 0 WHERE id = ?").bind(first.id).run();
    const [a, b] = await Promise.all([attemptDelivery(e, first.id!, transport), attemptDelivery(e, first.id!, transport)]);
    expect([a.status, b.status].sort()).toEqual(["pending", "sent"]);
    expect(sent).toHaveLength(1);
  });

  it("outside production only delivers to test recipients", async () => {
    const e = smtpEnv();
    let cfg = await getEmailSettings(e);
    const { sent, transport } = recordingTransport();
    const mail = { ...testEmail(e, cfg, "x@example.at"), kind: "client_confirmation" as const };

    expect((await sendEmail(e, cfg, mail, transport)).status).toBe("blocked");
    cfg = mergeEmailSettings(e, cfg, { testRecipients: "@example.at" });
    expect((await sendEmail(e, cfg, mail, transport)).status).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("skips disabled e-mail types", async () => {
    const e = smtpEnv();
    const cfg = mergeEmailSettings(e, await getEmailSettings(e), { enabled: { practice_new: false }, testRecipients: "@example.at" });
    const { sent, transport } = recordingTransport();
    const mail = { ...testEmail(e, cfg, "x@example.at"), kind: "practice_new" as const };
    expect((await sendEmail(e, cfg, mail, transport)).status).toBe("disabled");
    expect(sent).toHaveLength(0);
  });

  it("rejects invalid settings", () => {
    const base = { ...env } as Env;
    const cfg = { senderName: "x" } as never;
    expect(() => mergeEmailSettings(base, cfg, { senderName: "Praxis\r\nBcc: evil@example.com" })).toThrow();
    expect(() => mergeEmailSettings(base, cfg, { senderName: "<evil@example.com>" })).toThrow();
    expect(() => mergeEmailSettings(base, cfg, { replyTo: "not-an-email" })).toThrow();
    expect(() => mergeEmailSettings(base, cfg, { notifyTo: "a@example.at, b@example.at, c@example.at, d@example.at" })).toThrow();
    expect(() => mergeEmailSettings(base, cfg, { reminderHours: 1 })).toThrow();
  });
});

describe("e-mail design", () => {
  it("uses the letter layout with logo, and the handwriting only for first sessions", async () => {
    const cfg = await getEmailSettings(env);
    const service = { id: "psychotherapie", name: "Psychotherapie", duration_min: 50, price_eur: 90, description: "", icon: "", sort_order: 0, active: 1 };
    const start = Date.now() + 7 * 86_400_000;
    const booking = {
      id: "b1", slot_id: "s1", service_id: "psychotherapie", session_kind: "erstgespraech" as const, start_at: start, end_at: start + 3_000_000,
      name: "Eva <Beispiel>", email: "eva@example.at", phone: null, notes: null, status: "confirmed" as const,
      cancelled_by: null, cancelled_at: null, cancel_token_hash: "", consent_at: 0, created_at: 0,
    };
    const first = clientConfirmationEmail(env, cfg, booking, service, "TOKEN", start - 48 * HOUR);
    expect(first.html).toContain(`${env.PUBLIC_BASE_URL}/email/logo.png`);
    expect(first.html).toContain("/email/handschrift.png");
    expect(first.html).toContain("Vöcklabruck, ");
    expect(first.html).toContain("Eva &lt;Beispiel&gt;");
    expect(first.html).toContain("font-style:italic"); // cancellation hint as a note
    expect(first.text).toContain("Ich freue mich darauf, Sie kennenzulernen!");

    const followUp = clientConfirmationEmail(env, cfg, { ...booking, session_kind: "folgetermin" }, service, "TOKEN", start - 48 * HOUR);
    expect(followUp.html).not.toContain("handschrift.png");
    expect(followUp.text).not.toContain("kennenzulernen");
    expect(followUp.html).toContain("termin.html#t=TOKEN");
  });

  it("keeps the private manage link out of the calendar file", async () => {
    const cfg = await getEmailSettings(env);
    const service = { id: "psychotherapie", name: "Psychotherapie", duration_min: 50, price_eur: 90, description: "", icon: "", sort_order: 0, active: 1 };
    const start = Date.now() + 7 * 86_400_000;
    const booking = {
      id: "b1", slot_id: "s1", service_id: "psychotherapie", session_kind: "erstgespraech" as const, start_at: start, end_at: start + 3_000_000,
      name: "Eva Beispiel", email: "eva@example.at", phone: null, notes: null, status: "confirmed" as const,
      cancelled_by: null, cancelled_at: null, cancel_token_hash: "", consent_at: 0, created_at: 0,
    };
    const token = "TOKEN123abcdefghijklmnop";
    // Calendar entries get synced and shared, so the link that allows cancelling must not be in them.
    for (const deadline of [start - 48 * HOUR, Date.now() - HOUR]) {
      const mail = clientConfirmationEmail(env, cfg, booking, service, token, deadline);
      expect(mail.html).toContain(`termin.html#t=${token}`);
      const raw = atob(mail.attachments![0].content);
      const ics = new TextDecoder().decode(Uint8Array.from(raw, (ch) => ch.charCodeAt(0))).replace(/\r\n /g, "");
      expect(ics).toContain("BEGIN:VEVENT");
      expect(ics).not.toContain("#t=");
      expect(ics).not.toContain(token);
    }
  });
});

describe("appointment reminders", () => {
  it("reminds once, only for bookings made well in advance", async () => {
    const e = smtpEnv();
    const cfg = mergeEmailSettings(e, await getEmailSettings(e), { testRecipients: "@example.at" });
    await saveEmailSettings(e, cfg);
    const now = Date.now();
    await insertBooking("due", now + 20 * HOUR, now - 5 * 86_400_000);
    await insertBooking("later", now + 30 * HOUR, now - 5 * 86_400_000);
    await insertBooking("fresh", now + 20 * HOUR, now - 1 * HOUR); // booked just now: confirmation is enough
    await insertBooking("cancelled", now + 20 * HOUR, now - 5 * 86_400_000, "cancelled");

    const { sent, transport } = recordingTransport();
    expect(await sendDueReminders(e, now, transport)).toBe(1);
    expect(sent[0].subject).toContain("Erinnerung: Ihr Termin am");
    expect(await sendDueReminders(e, now, transport)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("does nothing when reminders are switched off", async () => {
    const e = smtpEnv();
    await saveEmailSettings(e, mergeEmailSettings(e, await getEmailSettings(e), { enabled: { client_reminder: false } }));
    await insertBooking("due", Date.now() + 20 * HOUR, Date.now() - 5 * 86_400_000);
    expect(await sendDueReminders(e, Date.now(), recordingTransport().transport)).toBe(0);
  });
});

describe("dashboard e-mail API", () => {
  async function login(): Promise<string> {
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, "cf-connecting-ip": "10.9.0.1" },
        body: JSON.stringify({ password: "test-admin-password-123" }),
      }),
    );
    return res.headers.get("set-cookie")!.split(";")[0];
  }
  const call = (cookie: string, path: string, method = "GET", body?: unknown) =>
    exports.default.fetch(
      new Request(BASE + path, {
        method,
        headers: { cookie, origin: BASE, "content-type": "application/json", "cf-connecting-ip": "10.9.0.2" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  it("saves settings, previews with escaping and logs a test e-mail", async () => {
    const cookie = await login();
    const put = await call(cookie, "/api/admin/email", "PUT", {
      notifyTo: ["praxis@example.at"],
      enabled: { client_reminder: false },
      templates: {
        client_confirmation: {
          subject: "Ihr Termin am {{termin}}",
          heading: "Hallo {{name}}",
          body: "Liebe:r {{name}},\n\n**Danke** für Ihre Buchung.\n\n{{termindetails}}\n\n{{absagehinweis}}\n\nHerzliche Grüße\n<script>Lisa</script>",
          hintOpen: "Absage bis {{absagefrist}} möglich.",
          hintClosed: "Absage nicht mehr möglich.",
        },
      },
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const data = (await put.json()) as {
      settings: { notifyTo: string[]; enabled: Record<string, boolean>; customized: string[] };
      status: { mode: string };
      templateInfo: { id: string }[];
    };
    expect(data.settings.notifyTo).toEqual(["praxis@example.at"]);
    expect(data.settings.enabled.client_reminder).toBe(false);
    expect(data.settings.customized).toEqual(["client_confirmation"]);
    expect(data.templateInfo).toHaveLength(6);
    expect(data.status.mode).toBe("log");

    const preview = (await (await call(cookie, "/api/admin/email/preview", "POST", { type: "client_confirmation" })).json()) as {
      html: string;
      subject: string;
    };
    expect(preview.subject).toMatch(/^Ihr Termin am /);
    expect(preview.html).toContain("Hallo Maria Muster");
    expect(preview.html).toContain("<strong>Danke</strong>");
    expect(preview.html).toContain("Herzliche Grüße<br>&lt;script&gt;Lisa&lt;/script&gt;");
    expect(preview.html).not.toContain("<script>");
    expect(preview.html).toContain("Absage bis ");
    // {{button}} was removed from the text, but the fixed button still appears.
    expect(preview.html).toContain("termin.html#t=BEISPIEL-LINK");

    const unknown = await call(cookie, "/api/admin/email", "PUT", {
      templates: { practice_new: { subject: "Neu: {{vorname}}", heading: "", body: "{{termindetails}}" } },
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain("{{vorname}}");

    // null resets a text to the default.
    const reset = (await (await call(cookie, "/api/admin/email", "PUT", { templates: { client_confirmation: null } })).json()) as {
      settings: { customized: string[] };
    };
    expect(reset.settings.customized).toEqual([]);

    const bad = await call(cookie, "/api/admin/email", "PUT", { replyTo: "nope" });
    expect(bad.status).toBe(400);

    const test = (await (await call(cookie, "/api/admin/email/test", "POST", {})).json()) as { to: string; status: string };
    expect(test).toMatchObject({ to: "praxis@example.at", status: "logged" });
    const outbox = (await (await call(cookie, "/api/admin/outbox")).json()) as { items: { kind: string; status: string }[] };
    expect(outbox.items[0]).toMatchObject({ kind: "test", status: "logged" });
  });
});
