import type { Env } from "./env";
import { HttpError } from "./http";
import { DEFAULT_FOOTER, DEFAULT_TEMPLATES, type EmailTemplate, TEMPLATE_IDS, type TemplateId, validateFooter, validateTemplate } from "./email-templates";
import { validateEmail, validateInt } from "./validate";

export const EMAIL_KINDS = [
  "client_confirmation",
  "client_reminder",
  "client_cancellation",
  "practice_new",
  "practice_cancellation",
] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number] | "test";

export interface EmailSettings {
  senderName: string;
  replyTo: string;
  notifyTo: string[];
  enabled: Record<(typeof EMAIL_KINDS)[number], boolean>;
  reminderHours: number;
  footer: string;
  templates: Record<TemplateId, EmailTemplate>;
  /** Templates that differ from the built-in default. */
  customized: TemplateId[];
  /** Only used outside production: recipients that may receive real e-mails. */
  testRecipients: string[];
}

const KEYS = {
  senderName: "email_sender_name",
  replyTo: "email_reply_to",
  notifyTo: "email_notify_to",
  reminderHours: "email_reminder_hours",
  footer: "email_footer",
  testRecipients: "email_test_recipients",
} as const;
const enabledKey = (kind: string) => `email_enabled_${kind}`;
const templateKey = (id: TemplateId) => `email_tpl_${id}`;

export const REMINDER_HOURS = { min: 2, max: 72 } as const;
const LIMITS = { senderName: 60, notifyTo: 3, testRecipients: 10 } as const;

export function defaultEmailSettings(env: Env): EmailSettings {
  return {
    senderName: "Praxis Lisa Berger",
    replyTo: env.PRACTICE_EMAIL,
    notifyTo: [env.PRACTICE_EMAIL],
    enabled: Object.fromEntries(EMAIL_KINDS.map((k) => [k, true])) as EmailSettings["enabled"],
    reminderHours: 24,
    footer: DEFAULT_FOOTER,
    templates: structuredClone(DEFAULT_TEMPLATES),
    customized: [],
    testRecipients: [],
  };
}

const splitList = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export async function getEmailSettings(env: Env): Promise<EmailSettings> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'email_%'").all<{
    key: string;
    value: string;
  }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const s = defaultEmailSettings(env);
  const str = (k: string) => map.get(k);
  if (str(KEYS.senderName)) s.senderName = str(KEYS.senderName)!;
  if (str(KEYS.replyTo)) s.replyTo = str(KEYS.replyTo)!;
  if (str(KEYS.notifyTo)) s.notifyTo = splitList(str(KEYS.notifyTo)!);
  if (str(KEYS.footer) !== undefined) s.footer = str(KEYS.footer)!;
  for (const id of TEMPLATE_IDS) {
    const raw = map.get(templateKey(id));
    if (!raw) continue;
    try {
      s.templates[id] = validateTemplate(id, JSON.parse(raw));
      s.customized.push(id);
    } catch {
      // Stored text no longer valid (e.g. placeholder removed): fall back to the default.
    }
  }
  if (str(KEYS.testRecipients) !== undefined) s.testRecipients = splitList(str(KEYS.testRecipients)!);
  const hours = Number(str(KEYS.reminderHours));
  if (Number.isInteger(hours) && hours >= REMINDER_HOURS.min && hours <= REMINDER_HOURS.max) s.reminderHours = hours;
  for (const kind of EMAIL_KINDS) {
    const v = map.get(enabledKey(kind));
    if (v !== undefined) s.enabled[kind] = v === "1";
  }
  return s;
}

function text(value: unknown, field: string, max: number, singleLine: boolean): string {
  if (typeof value !== "string") throw new HttpError(400, `${field}: ungültiger Wert.`, "invalid_input");
  const v = value.replace(/\r\n?/g, "\n").trim();
  if (v.length > max) throw new HttpError(400, `${field}: höchstens ${max} Zeichen.`, "invalid_input");
  if (singleLine && /[\n\t]/.test(v)) throw new HttpError(400, `${field}: bitte nur eine Zeile.`, "invalid_input");
  // No control characters except line breaks.
  if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(v)) throw new HttpError(400, `${field}: ungültige Zeichen.`, "invalid_input");
  return v;
}

function emailList(value: unknown, field: string, max: number, allowDomains: boolean): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? splitList(value) : null;
  if (!items) throw new HttpError(400, `${field}: ungültiger Wert.`, "invalid_input");
  if (items.length > max) throw new HttpError(400, `${field}: höchstens ${max} Adressen.`, "invalid_input");
  return [...new Set(items.map((item) => {
    if (allowDomains && typeof item === "string" && /^@[a-z0-9.-]+\.[a-z]{2,}$/i.test(item.trim())) return item.trim().toLowerCase();
    return validateEmail(item);
  }))];
}

/**
 * Validate a (partial) settings update from the dashboard and merge it into `base`.
 * Throws HttpError(400) on invalid input. Does not save anything.
 */
export function mergeEmailSettings(env: Env, base: EmailSettings, body: Record<string, unknown>): EmailSettings {
  const s: EmailSettings = { ...base, enabled: { ...base.enabled } };
  if (body.senderName !== undefined) {
    s.senderName = text(body.senderName, "Absendername", LIMITS.senderName, true);
    if (!s.senderName) throw new HttpError(400, "Bitte einen Absendernamen angeben.", "invalid_input");
    if (/[<>"@]/.test(s.senderName)) throw new HttpError(400, "Absendername: bitte ohne < > \" @.", "invalid_input");
  }
  if (body.replyTo !== undefined) s.replyTo = validateEmail(body.replyTo);
  if (body.notifyTo !== undefined) {
    s.notifyTo = emailList(body.notifyTo, "Benachrichtigung an", LIMITS.notifyTo, false);
    if (!s.notifyTo.length) throw new HttpError(400, "Bitte mindestens eine Adresse für Praxis-Benachrichtigungen angeben.", "invalid_input");
  }
  if (body.reminderHours !== undefined) {
    s.reminderHours = validateInt(body.reminderHours, "Erinnerung", REMINDER_HOURS.min, REMINDER_HOURS.max);
  }
  if (body.footer !== undefined) s.footer = validateFooter(body.footer);
  if (body.templates !== undefined) {
    if (typeof body.templates !== "object" || body.templates === null) throw new HttpError(400, "Ungültige Vorlagen.", "invalid_input");
    s.templates = { ...base.templates };
    s.customized = [...base.customized];
    for (const id of TEMPLATE_IDS) {
      const input = (body.templates as Record<string, unknown>)[id];
      if (input === undefined) continue;
      if (input === null) {
        // Reset to the default text.
        s.templates[id] = structuredClone(DEFAULT_TEMPLATES[id]);
        s.customized = s.customized.filter((c) => c !== id);
        continue;
      }
      s.templates[id] = validateTemplate(id, input);
      const same = JSON.stringify(s.templates[id]) === JSON.stringify(DEFAULT_TEMPLATES[id]);
      s.customized = same ? s.customized.filter((c) => c !== id) : [...new Set([...s.customized, id])];
    }
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "object" || body.enabled === null) throw new HttpError(400, "Ungültige Auswahl.", "invalid_input");
    for (const kind of EMAIL_KINDS) {
      const v = (body.enabled as Record<string, unknown>)[kind];
      if (v !== undefined) s.enabled[kind] = v === true;
    }
  }
  if (body.testRecipients !== undefined && env.ENVIRONMENT !== "production") {
    s.testRecipients = emailList(body.testRecipients, "Test-Empfänger", LIMITS.testRecipients, true);
  }
  return s;
}

export async function saveEmailSettings(env: Env, s: EmailSettings): Promise<void> {
  const rows: [string, string][] = [
    [KEYS.senderName, s.senderName],
    [KEYS.replyTo, s.replyTo],
    [KEYS.notifyTo, s.notifyTo.join(",")],
    [KEYS.reminderHours, String(s.reminderHours)],
    [KEYS.footer, s.footer],
    ...EMAIL_KINDS.map((k): [string, string] => [enabledKey(k), s.enabled[k] ? "1" : "0"]),
  ];
  if (env.ENVIRONMENT !== "production") rows.push([KEYS.testRecipients, s.testRecipients.join(",")]);
  const stmt = env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const del = env.DB.prepare("DELETE FROM settings WHERE key = ?");
  // Only customized texts are stored, so improvements to the defaults reach unchanged e-mails.
  const templateStmts = TEMPLATE_IDS.map((id) =>
    s.customized.includes(id) ? stmt.bind(templateKey(id), JSON.stringify(s.templates[id])) : del.bind(templateKey(id)),
  );
  await env.DB.batch([
    ...rows.map(([k, v]) => stmt.bind(k, v)),
    ...templateStmts,
    // Text fields of the first version, replaced by the editable templates.
    del.bind("email_signature"),
    del.bind("email_confirmation_note"),
    del.bind("email_reminder_note"),
  ]);
}

/** Outside production, real e-mails only go to explicitly allowed test addresses or domains. */
export function isAllowedTestRecipient(s: EmailSettings, address: string): boolean {
  const a = address.toLowerCase();
  return s.testRecipients.some((r) => (r.startsWith("@") ? a.endsWith(r) : a === r));
}
