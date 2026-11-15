import { WorkerMailer } from "worker-mailer";
import { type EmailKind, type EmailSettings, isAllowedTestRecipient } from "./email-settings";
import type { Booking, Env, Service } from "./env";
import { escapeHtml, newId } from "./http";
import { buildCalendar, PRACTICE_ADDRESS } from "./ics";
import { addDays, formatViennaLong, viennaDate, viennaToUtc } from "./time";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface OutgoingEmail {
  kind: EmailKind;
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  fromName?: string;
  attachments?: { filename: string; content: string; mimeType: string }[];
}

export type DeliveryStatus = "disabled" | "logged" | "blocked" | "sent" | "pending" | "failed";
export interface DeliveryResult {
  id?: string;
  status: DeliveryStatus;
  error?: string;
}

/** Delivers one message or throws. Replaceable in tests. */
export type Transport = (env: Env, mail: OutgoingEmail) => Promise<void>;

/** Automatic attempts before an e-mail is marked as failed (it can then be re-sent from the dashboard). */
export const MAX_ATTEMPTS = 3;
/** Wait before the 2nd and 3rd attempt. */
const BACKOFF = [5 * MINUTE, 30 * MINUTE];
/** A claimed attempt that never finished (Worker stopped) becomes due again after this. */
const LEASE = 5 * MINUTE;
const SMTP_TIMEOUT = 20_000;

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Zeitüberschreitung nach ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Sends through the practice mailbox at netcup (authenticated SMTP, implicit TLS on 465). */
export const smtpTransport: Transport = async (env, mail) => {
  if (!env.SMTP_USER || !env.SMTP_PASSWORD) {
    throw new Error("SMTP-Zugangsdaten fehlen (SMTP_USER / SMTP_PASSWORD).");
  }
  const port = Number(env.SMTP_PORT || 465);
  await withTimeout(
    WorkerMailer.send(
      {
        host: env.SMTP_HOST,
        port,
        secure: port === 465,
        startTls: port === 587,
        credentials: { username: env.SMTP_USER, password: env.SMTP_PASSWORD },
        authType: ["plain", "login"],
        socketTimeoutMs: SMTP_TIMEOUT,
        responseTimeoutMs: SMTP_TIMEOUT,
        name: env.MAIL_FROM.split("@")[1] || "localhost",
      },
      {
        from: { name: mail.fromName || "Praxis Lisa Berger", email: env.MAIL_FROM },
        to: mail.to,
        reply: mail.replyTo,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        attachments: mail.attachments,
        // Marks the message as automatic, so out-of-office replies are not sent back.
        headers: { "Auto-Submitted": "auto-generated" },
      },
    ),
    SMTP_TIMEOUT + 10_000,
  );
};

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, 500);
}

/**
 * Send an e-mail.
 *
 * - Disabled e-mail types are skipped.
 * - EMAIL_MODE "log": nothing is sent; the message is stored for the dashboard outbox.
 * - Outside production, real e-mails go only to the configured test recipients; others are
 *   stored as "blocked" so test bookings never reach strangers.
 * - Otherwise the message is queued and the first attempt is made immediately. Failed attempts
 *   are retried by the scheduled job (MAX_ATTEMPTS in total). After delivery only metadata is kept.
 */
export async function sendEmail(
  env: Env,
  cfg: EmailSettings,
  input: OutgoingEmail,
  transport: Transport = smtpTransport,
): Promise<DeliveryResult> {
  if (input.kind !== "test" && !cfg.enabled[input.kind]) return { status: "disabled" };
  if (!input.to.length) return { status: "disabled" };
  const mail: OutgoingEmail = {
    ...input,
    fromName: cfg.senderName,
    subject: env.ENVIRONMENT === "production" ? input.subject : `[TEST] ${input.subject}`,
  };
  const id = newId();
  const now = Date.now();
  const to = mail.to.join(", ");

  if (env.EMAIL_MODE !== "smtp") {
    await env.DB.prepare(
      "INSERT INTO email_log (id, created_at, kind, to_addr, subject, body_html, status) VALUES (?, ?, ?, ?, ?, ?, 'logged')",
    )
      .bind(id, now, mail.kind, to, mail.subject, mail.html)
      .run();
    return { id, status: "logged" };
  }

  if (env.ENVIRONMENT !== "production" && mail.kind !== "test" && !mail.to.every((a) => isAllowedTestRecipient(cfg, a))) {
    const error = "Testumgebung: Empfänger steht nicht auf der Liste der Test-Empfänger – nicht verschickt.";
    await env.DB.prepare(
      "INSERT INTO email_log (id, created_at, kind, to_addr, subject, body_html, status, error) VALUES (?, ?, ?, ?, ?, ?, 'blocked', ?)",
    )
      .bind(id, now, mail.kind, to, mail.subject, mail.html, error)
      .run();
    return { id, status: "blocked", error };
  }

  await env.DB.prepare(
    "INSERT INTO email_log (id, created_at, kind, to_addr, subject, status, attempts, next_attempt_at, payload) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
  )
    .bind(id, now, mail.kind, to, mail.subject, now, JSON.stringify(mail))
    .run();
  return attemptDelivery(env, id, transport);
}

/** One delivery attempt for a queued e-mail. Safe against concurrent attempts (claim with lease). */
export async function attemptDelivery(env: Env, id: string, transport: Transport = smtpTransport): Promise<DeliveryResult> {
  const now = Date.now();
  const claim = await env.DB.prepare(
    `UPDATE email_log SET status = 'sending', next_attempt_at = ?
     WHERE id = ? AND status IN ('pending', 'sending') AND next_attempt_at <= ? AND payload IS NOT NULL`,
  )
    .bind(now + LEASE, id, now)
    .run();
  if ((claim.meta.changes ?? 0) !== 1) return { id, status: "pending" };

  const row = await env.DB.prepare("SELECT payload, attempts FROM email_log WHERE id = ?")
    .bind(id)
    .first<{ payload: string; attempts: number }>();
  if (!row) return { id, status: "pending" };
  const attempts = row.attempts + 1;

  try {
    await transport(env, JSON.parse(row.payload) as OutgoingEmail);
    await env.DB.prepare(
      "UPDATE email_log SET status = 'sent', sent_at = ?, attempts = ?, payload = NULL, error = NULL, next_attempt_at = NULL WHERE id = ?",
    )
      .bind(Date.now(), attempts, id)
      .run();
    return { id, status: "sent" };
  } catch (err) {
    const error = errorText(err);
    console.error("E-mail delivery failed", { id, attempts, error });
    const failed = attempts >= MAX_ATTEMPTS;
    await env.DB.prepare("UPDATE email_log SET status = ?, attempts = ?, error = ?, next_attempt_at = ? WHERE id = ?")
      .bind(failed ? "failed" : "pending", attempts, error, failed ? null : Date.now() + BACKOFF[attempts - 1], id)
      .run();
    return { id, status: failed ? "failed" : "pending", error };
  }
}

/** Scheduled job: retry e-mails whose next attempt is due. */
export async function processEmailQueue(env: Env, transport: Transport = smtpTransport): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM email_log WHERE status IN ('pending', 'sending') AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20",
  )
    .bind(Date.now())
    .all<{ id: string }>();
  for (const { id } of results) await attemptDelivery(env, id, transport);
  return results.length;
}

/** Dashboard "send again" for an e-mail that failed all automatic attempts. */
export async function resendEmail(env: Env, id: string, transport: Transport = smtpTransport): Promise<DeliveryResult | null> {
  const res = await env.DB.prepare(
    "UPDATE email_log SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE id = ? AND status = 'failed' AND payload IS NOT NULL",
  )
    .bind(Date.now(), id)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return null;
  return attemptDelivery(env, id, transport);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<Booking["session_kind"], string> = {
  erstgespraech: "Erstgespräch",
  folgetermin: "Folgetermin",
};

export function kindLabel(kind: Booking["session_kind"]): string {
  return KIND_LABEL[kind];
}

/** Strip characters that must never appear in a header line (subject). */
function headerSafe(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 120);
}

/** Escaped multi-line text (from the dashboard) as HTML. */
function multiline(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function layout(title: string, bodyHtml: string, signature: string | null): string {
  return `<!doctype html><html lang="de"><body style="margin:0;padding:24px;background:#F5F5F7;font-family:Georgia,serif;color:#2B2B2B;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;border-top:4px solid #B3DAB6;">
<h2 style="font-family:Arial,sans-serif;font-weight:600;margin:0 0 16px;">${escapeHtml(title)}</h2>
${bodyHtml}
${signature ? `<p style="margin-top:32px;">${multiline(signature)}</p>` : ""}
<p style="font-size:12px;color:#6b7280;margin-top:24px;">Praxis für Psychotherapie · ${escapeHtml(PRACTICE_ADDRESS)}<br>
Tel. +43 677 631 426 87 · info@psychotherapieberger.at</p>
</div></body></html>`;
}

function note(value: string): string {
  return value ? `<p style="background:#F5F5F7;border-radius:12px;padding:12px 16px;">${multiline(value)}</p>` : "";
}

function detailsTable(rows: [string, string][]): string {
  return `<table style="border-collapse:collapse;margin:16px 0;width:100%;font-size:15px;">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:6px 0;">${escapeHtml(v)}</td></tr>`,
    )
    .join("")}</table>`;
}

function detailsText(rows: [string, string][]): string {
  return rows.map(([k, v]) => `${k}: ${v}`).join("\n");
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#B3DAB6;color:#2B2B2B;text-decoration:none;padding:12px 24px;border-radius:999px;font-family:Arial,sans-serif;font-weight:600;">${escapeHtml(label)}</a></p>`;
}

const textBlock = (value: string) => (value ? `\n\n${value}` : "");

export function manageUrl(env: Env, token: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/termin.html#t=${token}`;
}

function bookingRows(b: Booking, service: Service): [string, string][] {
  return [
    ["Termin", formatViennaLong(b.start_at)],
    ["Therapieform", `${service.name} (${service.duration_min} Minuten, ${service.price_eur} €)`],
    ["Art", kindLabel(b.session_kind)],
    ["Ort", PRACTICE_ADDRESS],
  ];
}

const LATE_POLICY =
  "Falls Sie verhindert sind, kontaktieren Sie mich bitte telefonisch oder per E-Mail; kurzfristige Absagen und versäumte Stunden werden in Rechnung gestellt.";

export function clientConfirmationEmail(
  env: Env,
  cfg: EmailSettings,
  b: Booking,
  service: Service,
  token: string,
  cancelDeadline: number,
): OutgoingEmail {
  const rows = bookingRows(b, service);
  const link = manageUrl(env, token);
  const deadline = formatViennaLong(cancelDeadline);
  const canStillCancel = cancelDeadline > Date.now();
  const policy = canStillCancel
    ? `Sie können den Termin bis <strong>${escapeHtml(deadline)}</strong> kostenfrei online absagen. Danach bitte ich Sie, mich telefonisch oder per E-Mail zu kontaktieren; kurzfristige Absagen und versäumte Stunden werden in Rechnung gestellt.`
    : `Da der Termin sehr kurzfristig gebucht wurde, ist eine kostenfreie Online-Absage nicht mehr möglich. ${LATE_POLICY}`;
  const policyText = canStillCancel
    ? `Kostenfreie Online-Absage bis ${deadline}:`
    : "Eine kostenfreie Online-Absage ist für diesen Termin nicht mehr möglich. Ihr Termin:";
  const html = layout(
    "Ihre Terminbestätigung",
    `<p>Guten Tag ${escapeHtml(b.name)},</p>
<p>vielen Dank für Ihre Buchung. Ihr Termin ist hiermit bestätigt:</p>
${detailsTable(rows)}
${note(cfg.confirmationNote)}
<p>${policy}</p>
${button(link, canStillCancel ? "Termin ansehen oder absagen" : "Termin ansehen")}
<p style="font-size:13px;color:#6b7280;">Den Termin für Ihren Kalender finden Sie im Anhang (termin.ics). Bitte geben Sie den Link oben nicht weiter – er ermöglicht die Absage Ihres Termins.</p>`,
    cfg.signature,
  );
  const text = `Guten Tag ${b.name},

vielen Dank für Ihre Buchung. Ihr Termin ist bestätigt:

${detailsText(rows)}${textBlock(cfg.confirmationNote)}

${policyText}
${link}${textBlock(cfg.signature)}`;
  const ics = buildCalendar([
    {
      uid: `${b.id}@psychotherapieberger.at`,
      start: b.start_at,
      end: b.end_at,
      summary: `${service.name} – Lisa Berger`,
      description: canStillCancel ? `Online absagen bis ${deadline}: ${link}` : `Termin ansehen: ${link}`,
      location: PRACTICE_ADDRESS,
    },
  ]);
  return {
    kind: "client_confirmation",
    to: [b.email],
    replyTo: cfg.replyTo,
    subject: `Terminbestätigung: ${formatViennaLong(b.start_at)}`,
    html,
    text,
    attachments: [{ filename: "termin.ics", content: btoa(unescape(encodeURIComponent(ics))), mimeType: "text/calendar" }],
  };
}

export function clientReminderEmail(
  cfg: EmailSettings,
  b: Booking,
  service: Service,
  cancelDeadline: number,
  now = Date.now(),
): OutgoingEmail {
  const rows = bookingRows(b, service);
  const canStillCancel = cancelDeadline > now;
  const policy = canStillCancel
    ? `Falls Sie verhindert sind, können Sie den Termin noch bis ${formatViennaLong(cancelDeadline)} über den Link in Ihrer Terminbestätigung kostenfrei absagen.`
    : LATE_POLICY;
  return {
    kind: "client_reminder",
    to: [b.email],
    replyTo: cfg.replyTo,
    subject: `Erinnerung: Ihr Termin am ${formatViennaLong(b.start_at)}`,
    html: layout(
      "Erinnerung an Ihren Termin",
      `<p>Guten Tag ${escapeHtml(b.name)},</p>
<p>ich möchte Sie an Ihren bevorstehenden Termin erinnern:</p>
${detailsTable(rows)}
${note(cfg.reminderNote)}
<p>${escapeHtml(policy)}</p>
<p>Ich freue mich auf Sie.</p>`,
      cfg.signature,
    ),
    text: `Guten Tag ${b.name},

ich möchte Sie an Ihren bevorstehenden Termin erinnern:

${detailsText(rows)}${textBlock(cfg.reminderNote)}

${policy}

Ich freue mich auf Sie.${textBlock(cfg.signature)}`,
  };
}

export function practiceNewBookingEmail(env: Env, cfg: EmailSettings, b: Booking, service: Service): OutgoingEmail {
  const rows: [string, string][] = [
    ...bookingRows(b, service).slice(0, 3),
    ["Name", b.name],
    ["E-Mail", b.email],
    ["Telefon", b.phone || "–"],
    ["Anmerkungen", b.notes || "–"],
  ];
  const adminLink = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin.html`;
  return {
    kind: "practice_new",
    to: cfg.notifyTo,
    replyTo: b.email,
    subject: headerSafe(`Neue Buchung: ${service.name}, ${formatViennaLong(b.start_at)}`),
    html: layout("Neue Online-Buchung", `${detailsTable(rows)}${button(adminLink, "Zum Praxis-Dashboard")}`, null),
    text: `Neue Online-Buchung\n\n${detailsText(rows)}\n\n${adminLink}`,
  };
}

export function clientCancellationEmail(cfg: EmailSettings, b: Booking, service: Service, byPractice: boolean): OutgoingEmail {
  const rows = bookingRows(b, service).slice(0, 2);
  const intro = byPractice
    ? "leider muss ich den folgenden Termin absagen. Ich bitte um Ihr Verständnis und melde mich gerne wegen eines Ersatztermins – Sie können auch jederzeit einen neuen Termin online buchen."
    : "hiermit bestätige ich die Absage Ihres Termins:";
  return {
    kind: "client_cancellation",
    to: [b.email],
    replyTo: cfg.replyTo,
    subject: `Terminabsage: ${formatViennaLong(b.start_at)}`,
    html: layout("Terminabsage", `<p>Guten Tag ${escapeHtml(b.name)},</p><p>${escapeHtml(intro)}</p>${detailsTable(rows)}`, cfg.signature),
    text: `Guten Tag ${b.name},\n\n${intro}\n\n${detailsText(rows)}${textBlock(cfg.signature)}`,
  };
}

export function practiceCancellationEmail(cfg: EmailSettings, b: Booking, service: Service): OutgoingEmail {
  const rows: [string, string][] = [...bookingRows(b, service).slice(0, 3), ["Name", b.name], ["E-Mail", b.email]];
  return {
    kind: "practice_cancellation",
    to: cfg.notifyTo,
    replyTo: b.email,
    subject: headerSafe(`Absage durch Klient:in: ${formatViennaLong(b.start_at)}`),
    html: layout("Termin wurde online abgesagt", `${detailsTable(rows)}<p>Der Termin ist wieder buchbar.</p>`, null),
    text: `Termin wurde online abgesagt\n\n${detailsText(rows)}`,
  };
}

export function testEmail(cfg: EmailSettings, to: string): OutgoingEmail {
  const body =
    "Diese Test-E-Mail wurde aus dem Praxis-Dashboard verschickt. Wenn sie angekommen ist, funktioniert der automatische E-Mail-Versand der Online-Terminbuchung.";
  return {
    kind: "test",
    to: [to],
    replyTo: cfg.replyTo,
    subject: "Test-E-Mail der Online-Terminbuchung",
    html: layout("Test-E-Mail", `<p>${escapeHtml(body)}</p>`, cfg.signature),
    text: `${body}${textBlock(cfg.signature)}`,
  };
}

// ---------------------------------------------------------------------------
// Dashboard preview with sample data
// ---------------------------------------------------------------------------

export const PREVIEW_TYPES = ["client_confirmation", "client_reminder", "client_cancellation", "practice_new", "practice_cancellation"] as const;
export type PreviewType = (typeof PREVIEW_TYPES)[number];

export function previewEmail(env: Env, cfg: EmailSettings, type: PreviewType, service: Service, cancelWindowHours: number): OutgoingEmail {
  // Next week, 10:00 Vienna time.
  const start = viennaToUtc(addDays(viennaDate(Date.now()), 7), "10:00");
  const sample: Booking = {
    id: "vorschau",
    slot_id: "vorschau",
    service_id: service.id,
    session_kind: "erstgespraech",
    start_at: start,
    end_at: start + service.duration_min * MINUTE,
    name: "Maria Muster",
    email: "maria.muster@example.com",
    phone: "+43 660 1234567",
    notes: "Beispiel-Anmerkung",
    status: "confirmed",
    cancelled_by: null,
    cancelled_at: null,
    cancel_token_hash: "",
    consent_at: Date.now(),
    created_at: Date.now(),
  };
  const deadline = start - cancelWindowHours * HOUR;
  switch (type) {
    case "client_confirmation":
      return clientConfirmationEmail(env, cfg, sample, service, "BEISPIEL-LINK", deadline);
    case "client_reminder":
      // Shown as it arrives: reminderHours before the appointment.
      return clientReminderEmail(cfg, sample, service, deadline, start - cfg.reminderHours * HOUR);
    case "client_cancellation":
      return clientCancellationEmail(cfg, sample, service, false);
    case "practice_new":
      return practiceNewBookingEmail(env, cfg, sample, service);
    case "practice_cancellation":
      return practiceCancellationEmail(cfg, sample, service);
  }
}
