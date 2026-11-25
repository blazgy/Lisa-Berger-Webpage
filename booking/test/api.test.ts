import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "../src/index";
import { createFormToken, MAX_FORM_AGE_MS } from "../src/spam";
import { addDays, viennaDate, viennaTime } from "../src/time";

const BASE = "https://booking.test";
const PASSWORD = "test-admin-password-123";
let ipCounter = 0;

interface CallOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  origin?: string | null;
}

async function call(path: string, opts: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": `10.0.0.${++ipCounter % 250}` };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  const origin = opts.origin === undefined ? BASE : opts.origin;
  if (origin) headers.origin = origin;
  return exports.default.fetch(
    new Request(BASE + path, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

async function login(): Promise<string> {
  const res = await call("/api/admin/login", { body: { password: PASSWORD } });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

/** A Vienna calendar date `days` from today. */
function futureDate(days: number): string {
  return addDays(viennaDate(Date.now()), days);
}

async function createSlot(cookie: string, date: string, time: string, serviceId = "psychotherapie"): Promise<string> {
  const res = await call("/api/admin/slots", { cookie, body: { date, time, serviceId } });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function bookingBody(slotId: string, overrides: Record<string, unknown> = {}) {
  return {
    slotId,
    serviceId: "psychotherapie",
    sessionKind: "erstgespraech",
    name: "Anna Müller",
    email: "anna@example.at",
    phone: "+43 660 1234567",
    notes: "Bitte <b>nicht</b> anrufen",
    consent: true,
    website: "",
    // Issued 10 s ago: like a person who took a moment to fill in the form.
    formToken: await createFormToken(env, Date.now() - 10_000),
    ...overrides,
  };
}

/** Book through the public API and wait for the e-mails to be written. */
async function book(slotId: string, overrides: Record<string, unknown> = {}): Promise<Response> {
  const res = await call("/api/bookings", { body: await bookingBody(slotId, overrides) });
  // E-mails are sent via waitUntil; give them a moment.
  await new Promise((r) => setTimeout(r, 50));
  return res;
}

async function latestManageToken(): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT body_html FROM email_log WHERE subject LIKE '%Terminbestätigung%' ORDER BY created_at DESC LIMIT 1",
  ).first<{ body_html: string }>();
  const match = row!.body_html.match(/termin\.html#t=([A-Za-z0-9_-]+)/);
  return match![1];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bookings"),
    env.DB.prepare("DELETE FROM slots"),
    env.DB.prepare("DELETE FROM email_log"),
    env.DB.prepare("DELETE FROM template_items"),
    env.DB.prepare("UPDATE settings SET value = '48' WHERE key = 'cancel_window_hours'"),
    env.DB.prepare("DELETE FROM settings WHERE key LIKE 'email_%'"),
  ]);
});

describe("admin authentication", () => {
  it("rejects a wrong password and requires same-origin", async () => {
    expect((await call("/api/admin/login", { body: { password: "nope" } })).status).toBe(401);
    expect((await call("/api/admin/login", { body: { password: PASSWORD }, origin: null })).status).toBe(403);
    expect((await call("/api/admin/login", { body: { password: PASSWORD }, origin: "https://evil.test" })).status).toBe(403);
  });

  it("protects admin endpoints", async () => {
    expect((await call("/api/admin/bookings")).status).toBe(401);
    expect((await call("/api/admin/bookings", { cookie: "__Host-lb_admin=forged.sig" })).status).toBe(401);
    const cookie = await login();
    expect((await call("/api/admin/bookings", { cookie })).status).toBe(200);
    // State-changing admin call from another origin is refused even with a valid cookie.
    const res = await call("/api/admin/slots", { cookie, origin: "https://evil.test", body: { date: futureDate(5), time: "10:00", serviceId: "psychotherapie" } });
    expect(res.status).toBe(403);
  });

  it("sets a hardened session cookie", async () => {
    const res = await call("/api/admin/login", { body: { password: PASSWORD } });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-lb_admin=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
  });
});

describe("slots", () => {
  it("rejects overlapping and past slots", async () => {
    const cookie = await login();
    const date = futureDate(5);
    await createSlot(cookie, date, "10:00");
    const overlap = await call("/api/admin/slots", { cookie, body: { date, time: "10:30", serviceId: "paartherapie" } });
    expect(overlap.status).toBe(409);
    const past = await call("/api/admin/slots", { cookie, body: { date: futureDate(-2), time: "10:00", serviceId: "psychotherapie" } });
    expect(past.status).toBe(400);
    // Back-to-back is fine (10:00–10:50, then 10:50).
    await createSlot(cookie, date, "10:50");
  });

  it("applies the weekly template without duplicates", async () => {
    const cookie = await login();
    expect((await call("/api/admin/template", { cookie, body: { weekday: 2, time: "09:00", serviceId: "psychotherapie" } })).status).toBe(201);
    expect((await call("/api/admin/template", { cookie, body: { weekday: 4, time: "15:00", serviceId: "spieltherapie" } })).status).toBe(201);
    const first = await call("/api/admin/template/apply", { cookie, body: { date: futureDate(14), weeks: 2 } });
    expect(await first.json()).toMatchObject({ created: 4, skipped: 0 });
    const second = await call("/api/admin/template/apply", { cookie, body: { date: futureDate(14), weeks: 2 } });
    expect(await second.json()).toMatchObject({ created: 0, skipped: 4 });
  });
});

describe("public booking flow", () => {
  it("lists services including Spieltherapie with current prices", async () => {
    const services = (await (await call("/api/services")).json()) as { id: string; priceEur: number }[];
    expect(services.map((s) => s.id)).toEqual(["psychotherapie", "paartherapie", "spieltherapie"]);
    expect(services.find((s) => s.id === "paartherapie")!.priceEur).toBe(190);
  });

  it("books a slot, escapes e-mail content and blocks double booking", async () => {
    const cookie = await login();
    const slotId = await createSlot(cookie, futureDate(7), "11:00");

    const slots = (await (await call("/api/slots?service=psychotherapie")).json()) as { id: string; time: string }[];
    expect(slots).toEqual([expect.objectContaining({ id: slotId, time: "11:00" })]);

    const res = await book(slotId);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(((await (await call("/api/slots?service=psychotherapie")).json()) as unknown[]).length).toBe(0);

    const again = await book(slotId, { email: "other@example.at" });
    expect(again.status).toBe(409);

    const mails = (await env.DB.prepare("SELECT to_addr, subject, body_html FROM email_log ORDER BY to_addr").all<{
      to_addr: string;
      subject: string;
      body_html: string;
    }>()).results;
    expect(mails.map((m) => m.to_addr)).toEqual(["anna@example.at", "info@psychotherapieberger.at"]);
    const practiceMail = mails.find((m) => m.to_addr === "info@psychotherapieberger.at")!;
    expect(practiceMail.body_html).toContain("Bitte &lt;b&gt;nicht&lt;/b&gt; anrufen");
    expect(practiceMail.body_html).not.toContain("<b>nicht</b>");
  });

  it("validates input and consent", async () => {
    const cookie = await login();
    const slotId = await createSlot(cookie, futureDate(7), "12:00");
    expect((await book(slotId, { consent: false })).status).toBe(400);
    expect((await book(slotId, { email: "not-an-email" })).status).toBe(400);
    expect((await book(slotId, { name: "<script>" })).status).toBe(400);
    expect((await book(slotId, { sessionKind: "other" })).status).toBe(400);
    expect((await book(slotId, { serviceId: "paartherapie" })).status).toBe(409);
    expect((await book(slotId, { notes: "x".repeat(1001) })).status).toBe(400);
  });

  it("rejects bots: filled honeypot, too fast, missing, forged or stale form token", async () => {
    const cookie = await login();
    const slotId = await createSlot(cookie, futureDate(7), "13:00");
    const code = async (overrides: Record<string, unknown>) => {
      const res = await book(slotId, overrides);
      expect(res.status).toBe(400);
      return ((await res.json()) as { code: string }).code;
    };
    expect(await code({ website: "https://spam.example" })).toBe("spam_rejected");
    expect(await code({ formToken: await createFormToken(env, Date.now() - 500) })).toBe("too_fast");
    expect(await code({ formToken: undefined })).toBe("form_expired");
    const [payload] = (await createFormToken(env)).split(".");
    expect(await code({ formToken: `${payload}.forged` })).toBe("form_expired");
    expect(await code({ formToken: await createFormToken(env, Date.now() - MAX_FORM_AGE_MS - 1000) })).toBe("form_expired");
    // The slot is still free afterwards, and a normal booking goes through.
    expect((await book(slotId)).status).toBe(201);
  });

  it("issues form tokens through the public API", async () => {
    const res = await call("/api/form-token");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { formToken: string }).formToken).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it("does not offer slots inside the minimum notice period", async () => {
    const cookie = await login();
    // Three hours from now is inside the default 24 h minimum notice.
    const soon = Date.now() + 3 * 3_600_000;
    const id = await createSlot(cookie, viennaDate(soon), viennaTime(soon));
    const slots = (await (await call("/api/slots?service=psychotherapie")).json()) as { id: string }[];
    expect(slots.find((s) => s.id === id)).toBeUndefined();
    expect((await book(id)).status).toBe(409);
  });
});

describe("client self-service cancellation", () => {
  it("lets the client cancel before the deadline and frees the slot", async () => {
    const cookie = await login();
    const slotId = await createSlot(cookie, futureDate(10), "09:00");
    expect((await book(slotId)).status).toBe(201);
    const token = await latestManageToken();

    const view = (await (await call("/api/manage", { body: { token } })).json()) as { canCancel: boolean; status: string };
    expect(view).toMatchObject({ canCancel: true, status: "confirmed" });

    const cancel = await call("/api/manage/cancel", { body: { token } });
    expect(cancel.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const slots = (await (await call("/api/slots?service=psychotherapie")).json()) as { id: string }[];
    expect(slots.map((s) => s.id)).toContain(slotId);
    expect((await call("/api/manage/cancel", { body: { token } })).status).toBe(409);

    const subjects = (await env.DB.prepare("SELECT subject FROM email_log").all<{ subject: string }>()).results.map((r) => r.subject);
    expect(subjects.some((s) => s.includes("Terminabsage"))).toBe(true);
    expect(subjects.some((s) => s.includes("Absage durch Klient:in"))).toBe(true);
  });

  it("refuses online cancellation after the configured window", async () => {
    const cookie = await login();
    const slotId = await createSlot(cookie, futureDate(3), "09:00");
    expect((await book(slotId)).status).toBe(201);
    const token = await latestManageToken();
    const settings = await call("/api/admin/settings", { method: "PUT", cookie, body: { cancelWindowHours: 168 } });
    expect(settings.status).toBe(200);
    const view = (await (await call("/api/manage", { body: { token } })).json()) as { canCancel: boolean };
    expect(view.canCancel).toBe(false);
    expect((await call("/api/manage/cancel", { body: { token } })).status).toBe(409);
  });

  it("rejects unknown tokens", async () => {
    expect((await call("/api/manage", { body: { token: "a".repeat(43) } })).status).toBe(404);
    expect((await call("/api/manage", { body: { token: "../../etc" } })).status).toBe(404);
  });
});

describe("admin booking management", () => {
  it("cancels a booking with or without releasing the slot", async () => {
    const cookie = await login();
    const a = await createSlot(cookie, futureDate(8), "09:00");
    const b = await createSlot(cookie, futureDate(8), "11:00");
    await book(a);
    await book(b, { email: "b@example.at" });
    const bookings = (await (await call("/api/admin/bookings", { cookie })).json()) as { id: string; email: string }[];
    expect(bookings.length).toBe(2);
    const bookingA = bookings.find((x) => x.email === "anna@example.at")!;
    const bookingB = bookings.find((x) => x.email === "b@example.at")!;

    expect((await call(`/api/admin/bookings/${bookingA.id}/cancel`, { cookie, body: { notify: true, release: true } })).status).toBe(200);
    expect((await call(`/api/admin/bookings/${bookingB.id}/cancel`, { cookie, body: { notify: false, release: false } })).status).toBe(200);

    const open = (await (await call("/api/slots?service=psychotherapie")).json()) as { id: string }[];
    expect(open.map((s) => s.id)).toEqual([a]);
    const cancelled = (await (await call("/api/admin/bookings?scope=cancelled", { cookie })).json()) as unknown[];
    expect(cancelled.length).toBe(2);
  });

  it("serves a private calendar feed and per-booking .ics", async () => {
    const cookie = await login();
    const slotId = await createSlot(cookie, futureDate(9), "14:00", "spieltherapie");
    expect((await book(slotId, { serviceId: "spieltherapie", sessionKind: "folgetermin" })).status).toBe(201);

    const { calendarFeedUrl } = (await (await call("/api/admin/calendar-feed", { cookie, body: {} })).json()) as { calendarFeedUrl: string };
    const feed = await call(new URL(calendarFeedUrl).pathname);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toContain("text/calendar");
    const text = await feed.text();
    expect(text).toContain("SUMMARY:Spieltherapie: Anna Müller");
    expect(text).toContain("Folgetermin");

    expect((await call("/api/calendar/wrongwrongwrongwrongwrong.ics")).status).toBe(404);

    const [booking] = (await (await call("/api/admin/bookings", { cookie })).json()) as { id: string }[];
    const ics = await call(`/api/admin/bookings/${booking.id}/ics`, { cookie });
    expect(ics.headers.get("content-disposition")).toContain("attachment");
  });

  it("edits service price and duration", async () => {
    const cookie = await login();
    const res = await call("/api/admin/services/spieltherapie", { method: "PUT", cookie, body: { priceEur: 95, durationMin: 60 } });
    expect(res.status).toBe(200);
    const services = (await (await call("/api/services")).json()) as { id: string; priceEur: number; durationMin: number }[];
    expect(services.find((s) => s.id === "spieltherapie")).toMatchObject({ priceEur: 95, durationMin: 60 });
    await call("/api/admin/services/spieltherapie", { method: "PUT", cookie, body: { priceEur: 90, durationMin: 50 } });
  });

  it("adds, hides and removes a therapy form", async () => {
    const cookie = await login();
    const created = await call("/api/admin/services", {
      cookie,
      body: { name: "Kinder- & Jugendtherapie", durationMin: 45, priceEur: 80, description: "Für Kinder ab 6", icon: "baby", active: true },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(id).toBe("kinder-jugendtherapie");

    const publicList = async () => ((await (await call("/api/services")).json()) as { id: string; icon: string }[]);
    expect((await publicList()).find((s) => s.id === id)).toMatchObject({ icon: "baby" });

    // Unchecking "online buchbar" hides it from the website.
    expect((await call(`/api/admin/services/${id}`, { method: "PUT", cookie, body: { active: false } })).status).toBe(200);
    expect((await publicList()).some((s) => s.id === id)).toBe(false);

    // Same name again gets its own id; invalid icon is rejected.
    const again = (await (await call("/api/admin/services", { cookie, body: { name: "Kinder- & Jugendtherapie", durationMin: 45, priceEur: 80 } })).json()) as { id: string };
    expect(again.id).toBe("kinder-jugendtherapie-2");
    expect((await call("/api/admin/services", { cookie, body: { name: "X", durationMin: 45, priceEur: 80, icon: "skull" } })).status).toBe(400);

    // A form with released slots cannot be removed …
    await call(`/api/admin/services/${id}`, { method: "PUT", cookie, body: { active: true } });
    const slotId = await createSlot(cookie, futureDate(10), "09:00", id);
    const blocked = await call(`/api/admin/services/${id}`, { method: "DELETE", cookie });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toContain("online buchbar");

    // … but can once nothing refers to it.
    await call(`/api/admin/slots/${slotId}`, { method: "DELETE", cookie });
    expect((await call(`/api/admin/services/${id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await call(`/api/admin/services/${again.id}`, { method: "DELETE", cookie })).status).toBe(200);
    const admins = (await (await call("/api/admin/services", { cookie })).json()) as { id: string }[];
    expect(admins.map((s) => s.id)).toEqual(["psychotherapie", "paartherapie", "spieltherapie"]);
  });
});

describe("data retention", () => {
  it("deletes bookings older than the retention period", async () => {
    const old = Date.now() - 200 * 86_400_000;
    await env.DB.prepare(
      `INSERT INTO bookings (id, slot_id, service_id, session_kind, start_at, end_at, name, email, status, cancel_token_hash, consent_at, created_at)
       VALUES ('old', 's', 'psychotherapie', 'erstgespraech', ?, ?, 'X', 'x@example.at', 'confirmed', 'h', ?, ?)`,
    )
      .bind(old, old + 3_000_000, old, old)
      .run();
    await cleanup(env);
    expect(await env.DB.prepare("SELECT id FROM bookings WHERE id = 'old'").first()).toBeNull();
  });
});

describe("static site", () => {
  it("serves pages with security headers and noindex outside production", async () => {
    const ctx = createExecutionContext();
    const res = await exports.default.fetch(new Request(`${BASE}/`));
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(await res.text()).toContain("LOKALE ENTWICKLUNG");
  });
});
