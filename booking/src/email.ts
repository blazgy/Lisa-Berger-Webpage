import { WorkerMailer } from "worker-mailer";
import type { Booking, Env, Service } from "./env";
import { escapeHtml, newId } from "./http";
import { buildCalendar, PRACTICE_ADDRESS } from "./ics";
import { formatViennaLong } from "./time";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: { filename: string; content: string; mimeType: string }[];
}

/**
 * Send an e-mail. In "log" mode (development / staging) the e-mail is only stored in
 * email_log so it can be reviewed in the admin outbox. In "smtp" mode it is sent through
 * the practice mailbox and only metadata (no body) is logged.
 */
export async function sendEmail(env: Env, mail: OutgoingEmail): Promise<void> {
  const id = newId();
  const now = Date.now();
  if (env.EMAIL_MODE !== "smtp") {
    await env.DB.prepare(
      "INSERT INTO email_log (id, created_at, to_addr, subject, body_html, status) VALUES (?, ?, ?, ?, ?, 'logged')",
    )
      .bind(id, now, mail.to, mail.subject, mail.html)
      .run();
    return;
  }
  try {
    await WorkerMailer.send(
      {
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 465),
        secure: Number(env.SMTP_PORT || 465) === 465,
        startTls: Number(env.SMTP_PORT) === 587,
        credentials: { username: env.SMTP_USER || env.MAIL_FROM, password: env.SMTP_PASSWORD || "" },
        authType: ["plain", "login"],
      },
      {
        from: { name: "Praxis Lisa Berger", email: env.MAIL_FROM },
        to: mail.to,
        reply: mail.replyTo,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        attachments: mail.attachments,
      },
    );
    await env.DB.prepare("INSERT INTO email_log (id, created_at, to_addr, subject, status) VALUES (?, ?, ?, ?, 'sent')")
      .bind(id, now, mail.to, mail.subject)
      .run();
  } catch (err) {
    console.error("E-mail sending failed", err);
    await env.DB.prepare(
      "INSERT INTO email_log (id, created_at, to_addr, subject, status, error) VALUES (?, ?, ?, ?, 'failed', ?)",
    )
      .bind(id, now, mail.to, mail.subject, String(err).slice(0, 500))
      .run();
  }
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

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="de"><body style="margin:0;padding:24px;background:#F5F5F7;font-family:Georgia,serif;color:#2B2B2B;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;border-top:4px solid #B3DAB6;">
<h2 style="font-family:Arial,sans-serif;font-weight:600;margin:0 0 16px;">${escapeHtml(title)}</h2>
${bodyHtml}
<p style="margin-top:32px;">Mit freundlichen Grüßen<br>Lisa Berger, MA</p>
<p style="font-size:12px;color:#6b7280;margin-top:24px;">Praxis für Psychotherapie · ${escapeHtml(PRACTICE_ADDRESS)}<br>
Tel. +43 677 631 426 87 · info@psychotherapieberger.at</p>
</div></body></html>`;
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

export function clientConfirmationEmail(
  env: Env,
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
    : "Da der Termin sehr kurzfristig gebucht wurde, ist eine kostenfreie Online-Absage nicht mehr möglich. Falls Sie verhindert sind, kontaktieren Sie mich bitte telefonisch oder per E-Mail; kurzfristige Absagen und versäumte Stunden werden in Rechnung gestellt.";
  const policyText = canStillCancel
    ? `Kostenfreie Online-Absage bis ${deadline}:`
    : "Eine kostenfreie Online-Absage ist für diesen Termin nicht mehr möglich. Ihr Termin:";
  const html = layout(
    "Ihre Terminbestätigung",
    `<p>Guten Tag ${escapeHtml(b.name)},</p>
<p>vielen Dank für Ihre Buchung. Ihr Termin ist hiermit bestätigt:</p>
${detailsTable(rows)}
<p>${policy}</p>
${button(link, canStillCancel ? "Termin ansehen oder absagen" : "Termin ansehen")}
<p style="font-size:13px;color:#6b7280;">Den Termin für Ihren Kalender finden Sie im Anhang (termin.ics). Bitte geben Sie den Link oben nicht weiter – er ermöglicht die Absage Ihres Termins.</p>`,
  );
  const text = `Guten Tag ${b.name},

vielen Dank für Ihre Buchung. Ihr Termin ist bestätigt:

${detailsText(rows)}

${policyText}
${link}

Mit freundlichen Grüßen
Lisa Berger, MA`;
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
    to: b.email,
    replyTo: env.PRACTICE_EMAIL,
    subject: `Terminbestätigung: ${formatViennaLong(b.start_at)}`,
    html,
    text,
    attachments: [{ filename: "termin.ics", content: btoa(unescape(encodeURIComponent(ics))), mimeType: "text/calendar" }],
  };
}

export function practiceNewBookingEmail(env: Env, b: Booking, service: Service): OutgoingEmail {
  const rows: [string, string][] = [
    ...bookingRows(b, service).slice(0, 3),
    ["Name", b.name],
    ["E-Mail", b.email],
    ["Telefon", b.phone || "–"],
    ["Anmerkungen", b.notes || "–"],
  ];
  const adminLink = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin.html`;
  return {
    to: env.PRACTICE_EMAIL,
    replyTo: b.email,
    subject: headerSafe(`Neue Buchung: ${service.name}, ${formatViennaLong(b.start_at)}`),
    html: layout("Neue Online-Buchung", `${detailsTable(rows)}${button(adminLink, "Zum Praxis-Dashboard")}`),
    text: `Neue Online-Buchung\n\n${detailsText(rows)}\n\n${adminLink}`,
  };
}

export function clientCancellationEmail(env: Env, b: Booking, service: Service, byPractice: boolean): OutgoingEmail {
  const rows = bookingRows(b, service).slice(0, 2);
  const intro = byPractice
    ? "leider muss ich den folgenden Termin absagen. Ich bitte um Ihr Verständnis und melde mich gerne wegen eines Ersatztermins – Sie können auch jederzeit einen neuen Termin online buchen."
    : "hiermit bestätige ich die Absage Ihres Termins:";
  const html = layout(
    "Terminabsage",
    `<p>Guten Tag ${escapeHtml(b.name)},</p><p>${escapeHtml(intro)}</p>${detailsTable(rows)}`,
  );
  return {
    to: b.email,
    replyTo: env.PRACTICE_EMAIL,
    subject: `Terminabsage: ${formatViennaLong(b.start_at)}`,
    html,
    text: `Guten Tag ${b.name},\n\n${intro}\n\n${detailsText(rows)}\n\nMit freundlichen Grüßen\nLisa Berger, MA`,
  };
}

export function practiceCancellationEmail(env: Env, b: Booking, service: Service): OutgoingEmail {
  const rows: [string, string][] = [...bookingRows(b, service).slice(0, 3), ["Name", b.name], ["E-Mail", b.email]];
  return {
    to: env.PRACTICE_EMAIL,
    subject: headerSafe(`Absage durch Klient:in: ${formatViennaLong(b.start_at)}`),
    html: layout("Termin wurde online abgesagt", `${detailsTable(rows)}<p>Der Termin ist wieder buchbar.</p>`),
    text: `Termin wurde online abgesagt\n\n${detailsText(rows)}`,
  };
}
