import { WorkerMailer } from "worker-mailer";
import { type EmailKind, type EmailSettings, isAllowedTestRecipient } from "./email-settings";
import type { Booking, Env, Service } from "./env";
import { escapeHtml, newId } from "./http";
import {
  renderBodyHtml,
  renderBodyText,
  renderInline,
  renderText,
  P_STYLE,
  type TemplateId,
  type Values,
} from "./email-templates";
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
// E-mails built from the editable templates
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
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 150);
}

// Design "Persönlicher Brief": a letter on white paper – logo with place and date, Lora text,
// a quiet list for the appointment details and an outlined button. Table-based, inline styles,
// so it holds up in Gmail, Outlook and Apple Mail. Images load from the booking site.

const FONT_HEAD = "Epilogue,'Helvetica Neue',Helvetica,Arial,sans-serif";
const FONT_BODY = "Lora,Georgia,'Times New Roman',serif";
const FONT_LINK =
  '<link href="https://fonts.googleapis.com/css2?family=Epilogue:wght@400;500;600&family=Lora:ital,wght@0,400;0,600;1,400;1,600&display=swap" rel="stylesheet">';

const assetUrl = (env: Env, path: string) => `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/email/${path}`;

const sentDate = (now: number) =>
  new Intl.DateTimeFormat("de-AT", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Vienna" })
    .format(new Date(now))
    ;

function layout(env: Env, heading: string, bodyHtml: string, footer: string, now = Date.now()): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">${FONT_LINK}
<style>
body{margin:0;padding:0;background:#F2F2F0;-webkit-text-size-adjust:100%;}
table{border-collapse:collapse;}
img{border:0;display:block;}
@media (max-width:620px){
  .px{padding-left:22px!important;padding-right:22px!important;}
  .stack{display:block!important;width:100%!important;box-sizing:border-box!important;}
  .lbl{padding-bottom:0!important;border-bottom:0!important;}
  .val{padding-top:2px!important;}
  .full a{display:block!important;text-align:center!important;}
  .hide-sm{display:none!important;}
}
</style></head>
<body style="margin:0;padding:0;background:#F2F2F0;">
<table role="presentation" width="100%" bgcolor="#F2F2F0" style="background:#F2F2F0;"><tr><td align="center" style="padding:0 8px;">
<table role="presentation" width="100%" style="max-width:600px;margin:28px 0;">
<tr><td bgcolor="#FFFFFF" style="background:#FFFFFF;border-radius:6px;">
  <table role="presentation" width="100%"><tr>
    <td class="px" style="padding:40px 52px 0;" valign="top"><img src="${escapeHtml(assetUrl(env, "logo.png"))}" width="136" height="44" alt="Berger Psychotherapie"></td>
    <td class="px hide-sm" align="right" valign="top" style="padding:46px 52px 0;font-family:${FONT_BODY};font-size:13px;font-style:italic;color:#6B7280;">Vöcklabruck, ${sentDate(now)}</td>
  </tr></table>
  <table role="presentation" width="100%"><tr><td class="px" style="padding:44px 52px 40px;">
    ${heading ? `<h1 style="margin:0 0 26px;font-family:${FONT_HEAD};font-size:20px;line-height:1.35;font-weight:600;color:#2B2B2B;">${heading}</h1>` : ""}
    ${bodyHtml}
  </td></tr></table>
  ${
    footer
      ? `<table role="presentation" width="100%"><tr><td class="px" style="padding:0 52px 36px;">
    <table role="presentation" width="100%"><tr><td style="border-top:1px solid #E5E5E2;padding-top:18px;font-family:${FONT_HEAD};font-size:11px;line-height:1.8;letter-spacing:.02em;color:#8A8D92;">${escapeHtml(footer).replace(/\n/g, "<br>")}</td></tr></table>
  </td></tr></table>`
      : ""
  }
</td></tr></table>
</td></tr></table>
</body></html>`;
}

function table(rows: [string, string][]): Value {
  const html = `<table role="presentation" width="100%" style="margin:6px 0 26px;border-top:1px solid #B3DAB6;">${rows
    .map(
      ([k, v]) => `<tr>
<td class="stack lbl" width="130" valign="top" style="padding:13px 14px 13px 0;border-bottom:1px solid #E7EFE8;font-family:${FONT_HEAD};font-size:13px;font-weight:500;color:#5C7A60;">${escapeHtml(k)}</td>
<td class="stack val" valign="top" style="padding:13px 0;border-bottom:1px solid #E7EFE8;font-family:${FONT_BODY};font-size:16px;line-height:1.55;color:#2B2B2B;">${escapeHtml(v).replace(/\n/g, "<br>")}</td></tr>`,
    )
    .join("")}</table>`;
  return { block: true, text: rows.map(([k, v]) => `${k}: ${v}`).join("\n"), alone: html };
}

function button(href: string, label: string): Value {
  return {
    block: true,
    text: `${label}: ${href}`,
    alone: `<table role="presentation" class="full" style="margin:2px 0 30px;border-collapse:separate;"><tr><td style="border:1.5px solid #2B2B2B;border-radius:999px;">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 28px;font-family:${FONT_HEAD};font-size:14px;font-weight:600;letter-spacing:.02em;color:#2B2B2B;text-decoration:none;">${escapeHtml(label)}</a></td></tr></table>`,
  };
}

type Value = Values[string];
const plain = (text: string): Value => ({ text });

export function manageUrl(env: Env, token: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/termin.html#t=${token}`;
}

const HANDWRITING_TEXT = "Ich freue mich darauf, Sie kennenzulernen!";

function bookingValues(env: Env, b: Booking, service: Service): Values {
  const values: Values = {
    name: plain(b.name),
    termin: plain(formatViennaLong(b.start_at)),
    therapieform: plain(service.name),
    dauer: plain(`${service.duration_min} Minuten`),
    preis: plain(`${service.price_eur} €`),
    art: plain(kindLabel(b.session_kind)),
    ort: plain(PRACTICE_ADDRESS),
    email: plain(b.email),
    telefon: plain(b.phone || "–"),
    anmerkungen: plain(b.notes || "–"),
  };
  values.termindetails = table([
    ["Termin", values.termin.text],
    ["Therapieform", `${service.name} (${service.duration_min} Minuten, ${service.price_eur} €)`],
    ["Art", values.art.text],
    ["Ort", PRACTICE_ADDRESS],
  ]);
  values.kontaktdaten = table([
    ["Name", b.name],
    ["E-Mail", b.email],
    ["Telefon", b.phone || "–"],
    ["Anmerkungen", b.notes || "–"],
  ]);
  // Lisa's handwritten line – only fitting before a first meeting.
  const first = b.session_kind === "erstgespraech";
  values.handschrift = {
    block: true,
    text: first ? HANDWRITING_TEXT : "",
    alone: first
      ? `<img src="${escapeHtml(assetUrl(env, "handschrift.png"))}" width="250" height="85" alt="${HANDWRITING_TEXT}" style="margin:0 0 14px -6px;">`
      : "",
  };
  return values;
}

/** Adds {{absagefrist}} and {{absagehinweis}} (the hint text depends on whether online cancellation is still possible). */
function withCancelHint(cfg: EmailSettings, id: TemplateId, values: Values, cancelDeadline: number, now: number): Values {
  const tpl = cfg.templates[id];
  const out: Values = { ...values, absagefrist: plain(formatViennaLong(cancelDeadline)) };
  const hint = (cancelDeadline > now ? tpl.hintOpen : tpl.hintClosed) ?? "";
  const html = renderInline(hint, out);
  out.absagehinweis = {
    text: renderText(hint, out),
    html,
    // On its own line the hint is set in italics, like a note in a letter.
    alone: hint ? `<p style="${P_STYLE}font-style:italic;color:#3F3F3F;">${html}</p>` : "",
  };
  return out;
}

function build(
  env: Env,
  cfg: EmailSettings,
  id: TemplateId,
  values: Values,
  base: Omit<OutgoingEmail, "subject" | "html" | "text">,
  now = Date.now(),
): OutgoingEmail {
  const tpl = cfg.templates[id];
  return {
    ...base,
    subject: headerSafe(renderText(tpl.subject, values)),
    html: layout(env, renderInline(tpl.heading, values), renderBodyHtml(tpl.body, values), cfg.footer, now),
    text: `${renderBodyText(tpl.body, values)}${cfg.footer ? `\n\n--\n${cfg.footer}` : ""}`,
  };
}

export function clientConfirmationEmail(
  env: Env,
  cfg: EmailSettings,
  b: Booking,
  service: Service,
  token: string,
  cancelDeadline: number,
): OutgoingEmail {
  const now = Date.now();
  const link = manageUrl(env, token);
  const canStillCancel = cancelDeadline > now;
  const values = withCancelHint(cfg, "client_confirmation", bookingValues(env, b, service), cancelDeadline, now);
  values.button = button(link, canStillCancel ? "Termin ansehen oder absagen" : "Termin ansehen");
  const ics = buildCalendar([
    {
      uid: `${b.id}@psychotherapieberger.at`,
      start: b.start_at,
      end: b.end_at,
      summary: `${service.name} – Lisa Berger`,
      description: canStillCancel ? `Online absagen bis ${formatViennaLong(cancelDeadline)}: ${link}` : `Termin ansehen: ${link}`,
      location: PRACTICE_ADDRESS,
    },
  ]);
  return build(env, cfg, "client_confirmation", values, {
    kind: "client_confirmation",
    to: [b.email],
    replyTo: cfg.replyTo,
    attachments: [{ filename: "termin.ics", content: btoa(unescape(encodeURIComponent(ics))), mimeType: "text/calendar" }],
  });
}

export function clientReminderEmail(
  env: Env,
  cfg: EmailSettings,
  b: Booking,
  service: Service,
  cancelDeadline: number,
  now = Date.now(),
): OutgoingEmail {
  const values = withCancelHint(cfg, "client_reminder", bookingValues(env, b, service), cancelDeadline, now);
  return build(env, cfg, "client_reminder", values, { kind: "client_reminder", to: [b.email], replyTo: cfg.replyTo }, now);
}

export function practiceNewBookingEmail(env: Env, cfg: EmailSettings, b: Booking, service: Service): OutgoingEmail {
  const values = bookingValues(env, b, service);
  values.button = button(`${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin.html`, "Zum Praxis-Dashboard");
  return build(env, cfg, "practice_new", values, { kind: "practice_new", to: cfg.notifyTo, replyTo: b.email });
}

export function clientCancellationEmail(
  env: Env,
  cfg: EmailSettings,
  b: Booking,
  service: Service,
  byPractice: boolean,
): OutgoingEmail {
  return build(env, cfg, byPractice ? "client_cancellation_by_practice" : "client_cancellation", bookingValues(env, b, service), {
    kind: "client_cancellation",
    to: [b.email],
    replyTo: cfg.replyTo,
  });
}

export function practiceCancellationEmail(env: Env, cfg: EmailSettings, b: Booking, service: Service): OutgoingEmail {
  return build(env, cfg, "practice_cancellation", bookingValues(env, b, service), {
    kind: "practice_cancellation",
    to: cfg.notifyTo,
    replyTo: b.email,
  });
}

export function testEmail(env: Env, cfg: EmailSettings, to: string): OutgoingEmail {
  const body =
    "Diese Test-E-Mail wurde aus dem Praxis-Dashboard verschickt. Wenn sie angekommen ist, funktioniert der automatische E-Mail-Versand der Online-Terminbuchung.";
  return {
    kind: "test",
    to: [to],
    replyTo: cfg.replyTo,
    subject: "Test-E-Mail der Online-Terminbuchung",
    html: layout(env, "Test-E-Mail", `<p style="${P_STYLE}">${escapeHtml(body)}</p>`, cfg.footer),
    text: body,
  };
}

// ---------------------------------------------------------------------------
// Dashboard preview with sample data
// ---------------------------------------------------------------------------

export function previewEmail(env: Env, cfg: EmailSettings, id: TemplateId, service: Service, cancelWindowHours: number): OutgoingEmail {
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
  switch (id) {
    case "client_confirmation":
      return clientConfirmationEmail(env, cfg, sample, service, "BEISPIEL-LINK", deadline);
    case "client_reminder":
      // Shown as it arrives: reminderHours before the appointment.
      return clientReminderEmail(env, cfg, sample, service, deadline, start - cfg.reminderHours * HOUR);
    case "client_cancellation":
      return clientCancellationEmail(env, cfg, sample, service, false);
    case "client_cancellation_by_practice":
      return clientCancellationEmail(env, cfg, sample, service, true);
    case "practice_new":
      return practiceNewBookingEmail(env, cfg, sample, service);
    case "practice_cancellation":
      return practiceCancellationEmail(env, cfg, sample, service);
  }
}
