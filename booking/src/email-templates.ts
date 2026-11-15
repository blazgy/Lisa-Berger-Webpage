/**
 * Editable e-mail texts. Each e-mail has a subject, a heading and a body written as plain text
 * with {{placeholders}}. Blank lines separate paragraphs, **text** is bold. Links and buttons are
 * not part of the text: {{button}} only marks where the fixed button goes.
 */
import { escapeHtml, HttpError } from "./http";
import { PRACTICE_ADDRESS } from "./ics";

export const TEMPLATE_IDS = [
  "client_confirmation",
  "client_reminder",
  "client_cancellation",
  "client_cancellation_by_practice",
  "practice_new",
  "practice_cancellation",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface EmailTemplate {
  subject: string;
  heading: string;
  body: string;
  /** Only for confirmation and reminder: text for {{absagehinweis}} while online cancellation is possible … */
  hintOpen?: string;
  /** … and once it is no longer possible. */
  hintClosed?: string;
}

export const PLACEHOLDER_LABELS: Record<string, string> = {
  name: "Name der Klient:in",
  termin: "Datum und Uhrzeit",
  therapieform: "Therapieform",
  dauer: "Dauer",
  preis: "Preis",
  art: "Erstgespräch / Folgetermin",
  ort: "Adresse der Praxis",
  termindetails: "Tabelle mit allen Termindaten",
  absagefrist: "Datum der Absagefrist",
  absagehinweis: "Absage-Hinweis (siehe unten)",
  button: "Position des Buttons",
  email: "E-Mail der Klient:in",
  telefon: "Telefon der Klient:in",
  anmerkungen: "Anmerkungen der Klient:in",
  kontaktdaten: "Tabelle mit Kontaktdaten",
  handschrift: "Handschrift „Ich freue mich darauf, Sie kennenzulernen!“ (nur bei Erstgesprächen)",
};

const COMMON = ["name", "termin", "therapieform", "dauer", "preis", "art", "ort", "termindetails"];
const CONTACT = ["email", "telefon", "anmerkungen", "kontaktdaten"];

export const TEMPLATE_PLACEHOLDERS: Record<TemplateId, string[]> = {
  client_confirmation: [...COMMON, "absagefrist", "absagehinweis", "button", "handschrift"],
  client_reminder: [...COMMON, "absagefrist", "absagehinweis"],
  client_cancellation: COMMON,
  client_cancellation_by_practice: COMMON,
  practice_new: [...COMMON, ...CONTACT, "button"],
  practice_cancellation: [...COMMON, ...CONTACT],
};
/** Placeholders allowed inside the cancellation hints. */
export const HINT_PLACEHOLDERS = [...COMMON, "absagefrist"];
export const HAS_HINTS: TemplateId[] = ["client_confirmation", "client_reminder"];

export const TEMPLATE_LABELS: Record<TemplateId, string> = {
  client_confirmation: "Terminbestätigung",
  client_reminder: "Terminerinnerung",
  client_cancellation: "Absagebestätigung (Absage durch Klient:in)",
  client_cancellation_by_practice: "Absage durch die Praxis",
  practice_new: "Neue Buchung (an die Praxis)",
  practice_cancellation: "Online-Absage (an die Praxis)",
};

const SIGNATURE = "Mit freundlichen Grüßen\nLisa Berger, MA";
const LATE_POLICY =
  "Falls Sie verhindert sind, kontaktieren Sie mich bitte telefonisch oder per E-Mail; kurzfristige Absagen und versäumte Stunden werden in Rechnung gestellt.";

export const DEFAULT_FOOTER = `Praxis für Psychotherapie · ${PRACTICE_ADDRESS}\nTel. +43 677 631 426 87 · info@psychotherapieberger.at`;

export const DEFAULT_TEMPLATES: Record<TemplateId, EmailTemplate> = {
  client_confirmation: {
    subject: "Terminbestätigung: {{termin}}",
    heading: "Ihre Terminbestätigung",
    body: `Guten Tag {{name}},

vielen Dank für Ihre Buchung. Ihr Termin ist hiermit bestätigt:

{{termindetails}}

{{absagehinweis}}

{{button}}

Den Termin für Ihren Kalender finden Sie im Anhang (termin.ics). Bitte geben Sie den Link nicht weiter – er ermöglicht die Absage Ihres Termins.

{{handschrift}}

${SIGNATURE}`,
    hintOpen:
      "Sie können den Termin bis **{{absagefrist}}** kostenfrei online absagen. Danach bitte ich Sie, mich telefonisch oder per E-Mail zu kontaktieren; kurzfristige Absagen und versäumte Stunden werden in Rechnung gestellt.",
    hintClosed: `Da der Termin sehr kurzfristig gebucht wurde, ist eine kostenfreie Online-Absage nicht mehr möglich. ${LATE_POLICY}`,
  },
  client_reminder: {
    subject: "Erinnerung: Ihr Termin am {{termin}}",
    heading: "Erinnerung an Ihren Termin",
    body: `Guten Tag {{name}},

ich möchte Sie an Ihren bevorstehenden Termin erinnern:

{{termindetails}}

{{absagehinweis}}

Ich freue mich auf Sie.

${SIGNATURE}`,
    hintOpen:
      "Falls Sie verhindert sind, können Sie den Termin noch bis {{absagefrist}} über den Link in Ihrer Terminbestätigung kostenfrei absagen.",
    hintClosed: LATE_POLICY,
  },
  client_cancellation: {
    subject: "Terminabsage: {{termin}}",
    heading: "Terminabsage",
    body: `Guten Tag {{name}},

hiermit bestätige ich die Absage Ihres Termins:

{{termindetails}}

${SIGNATURE}`,
  },
  client_cancellation_by_practice: {
    subject: "Terminabsage: {{termin}}",
    heading: "Terminabsage",
    body: `Guten Tag {{name}},

leider muss ich den folgenden Termin absagen. Ich bitte um Ihr Verständnis und melde mich gerne wegen eines Ersatztermins – Sie können auch jederzeit einen neuen Termin online buchen.

{{termindetails}}

${SIGNATURE}`,
  },
  practice_new: {
    subject: "Neue Buchung: {{therapieform}}, {{termin}}",
    heading: "Neue Online-Buchung",
    body: `{{termindetails}}

{{kontaktdaten}}

{{button}}`,
  },
  practice_cancellation: {
    subject: "Absage durch Klient:in: {{termin}}",
    heading: "Termin wurde online abgesagt",
    body: `{{termindetails}}

{{kontaktdaten}}

Der Termin ist wieder buchbar.`,
  },
};

export const TEMPLATE_LIMITS = { subject: 150, heading: 100, body: 5000, hint: 1000, footer: 500 } as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([a-zA-ZäöüÄÖÜß]+)\s*\}\}/g;

function cleanText(value: unknown, field: string, max: number, singleLine: boolean, required: boolean): string {
  if (typeof value !== "string") throw new HttpError(400, `${field}: ungültiger Wert.`, "invalid_input");
  const v = value.replace(/\r\n?/g, "\n").trim();
  if (required && !v) throw new HttpError(400, `${field}: darf nicht leer sein.`, "invalid_input");
  if (v.length > max) throw new HttpError(400, `${field}: höchstens ${max} Zeichen.`, "invalid_input");
  if (singleLine && /\n/.test(v)) throw new HttpError(400, `${field}: bitte nur eine Zeile.`, "invalid_input");
  if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(v)) throw new HttpError(400, `${field}: ungültige Zeichen.`, "invalid_input");
  return v;
}

function checkPlaceholders(text: string, allowed: string[], field: string): void {
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const key = m[1].toLowerCase();
    if (!allowed.includes(key)) {
      throw new HttpError(
        400,
        `${field}: Den Platzhalter {{${m[1]}}} gibt es hier nicht. Möglich sind: ${allowed.map((k) => `{{${k}}}`).join(", ")}.`,
        "invalid_input",
      );
    }
  }
}

export function validateTemplate(id: TemplateId, input: unknown): EmailTemplate {
  if (typeof input !== "object" || input === null) throw new HttpError(400, "Ungültige Vorlage.", "invalid_input");
  const raw = input as Record<string, unknown>;
  const label = TEMPLATE_LABELS[id];
  const allowed = TEMPLATE_PLACEHOLDERS[id];
  const subjectAllowed = allowed.filter((k) => !["termindetails", "kontaktdaten", "button", "absagehinweis"].includes(k));
  const t: EmailTemplate = {
    subject: cleanText(raw.subject, `${label} – Betreff`, TEMPLATE_LIMITS.subject, true, true),
    heading: cleanText(raw.heading, `${label} – Überschrift`, TEMPLATE_LIMITS.heading, true, false),
    body: cleanText(raw.body, `${label} – Text`, TEMPLATE_LIMITS.body, false, true),
  };
  checkPlaceholders(t.subject, subjectAllowed, `${label} – Betreff`);
  checkPlaceholders(t.heading, subjectAllowed, `${label} – Überschrift`);
  checkPlaceholders(t.body, allowed, `${label} – Text`);
  if (HAS_HINTS.includes(id)) {
    t.hintOpen = cleanText(raw.hintOpen, `${label} – Hinweis (Absage möglich)`, TEMPLATE_LIMITS.hint, false, true);
    t.hintClosed = cleanText(raw.hintClosed, `${label} – Hinweis (Absage nicht mehr möglich)`, TEMPLATE_LIMITS.hint, false, true);
    checkPlaceholders(t.hintOpen, HINT_PLACEHOLDERS, `${label} – Hinweis`);
    checkPlaceholders(t.hintClosed, HINT_PLACEHOLDERS, `${label} – Hinweis`);
  }
  return t;
}

export function validateFooter(value: unknown): string {
  return cleanText(value, "Fußzeile", TEMPLATE_LIMITS.footer, false, false);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A placeholder value: inline text, or a block (table, button) with its own HTML. */
export interface Value {
  text: string;
  /** Inline HTML (already escaped). */
  html?: string;
  /** HTML that replaces the whole paragraph when the placeholder stands alone in it. */
  alone?: string;
  /** Block-only value (table, button, image): never rendered inside running text. */
  block?: boolean;
}
export type Values = Record<string, Value>;

const bold = (html: string) => html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
const stripBold = (text: string) => text.replace(/\*\*(.+?)\*\*/g, "$1");

/** Inline HTML for a piece of template text: escaped, placeholders filled in, **bold**, line breaks. */
export function renderInline(template: string, values: Values): string {
  let out = "";
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    out += escapeHtml(template.slice(last, m.index));
    const v = values[m[1].toLowerCase()];
    out += v ? (v.html !== undefined && !v.block ? v.html : escapeHtml(v.text)) : "";
    last = m.index! + m[0].length;
  }
  out += escapeHtml(template.slice(last));
  return bold(out).replace(/\n/g, "<br>");
}

export function renderText(template: string, values: Values): string {
  return stripBold(template.replace(PLACEHOLDER_RE, (_, key: string) => values[key.toLowerCase()]?.text ?? ""));
}

/** Paragraph style of the letter design (Lora, generous line height). */
export const P_STYLE = "margin:0 0 20px;font-family:Lora,Georgia,'Times New Roman',serif;font-size:17px;line-height:1.75;color:#2B2B2B;";

/**
 * Body HTML: paragraphs separated by blank lines. A paragraph that is only one placeholder
 * renders that placeholder's own block (table, button, image, styled hint) instead.
 */
export function renderBodyHtml(template: string, values: Values): string {
  const parts: string[] = [];
  let buttonPlaced = false;
  for (const para of template.split(/\n\s*\n/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (/\{\{\s*button\s*\}\}/i.test(trimmed)) buttonPlaced = true;
    const only = trimmed.match(/^\{\{\s*([a-zA-ZäöüÄÖÜß]+)\s*\}\}$/);
    const v = only ? values[only[1].toLowerCase()] : undefined;
    if (v && v.alone !== undefined) {
      if (v.alone) parts.push(v.alone);
      continue;
    }
    const html = renderInline(trimmed, values);
    if (html.replace(/<br>/g, "").trim()) parts.push(`<p style="${P_STYLE}">${html}</p>`);
  }
  // The button is fixed: if it was removed from the text, it still appears at the end.
  if (!buttonPlaced && values.button?.alone) parts.push(values.button.alone);
  return parts.join("\n");
}

export function renderBodyText(template: string, values: Values): string {
  let text = renderText(template, values);
  if (values.button && !/\{\{\s*button\s*\}\}/i.test(template)) text += `\n\n${values.button.text}`;
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
