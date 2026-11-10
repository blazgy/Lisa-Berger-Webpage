import { HttpError } from "./http";

const EMAIL_RE = /^[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[+0-9 ()/\-.]{5,40}$/;
// Allow letters (any script), marks, spaces and common name punctuation.
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .,'’\-]*$/u;
// Control characters except tab/newline.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function fail(message: string, code: string): never {
  throw new HttpError(400, message, code);
}

export function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") fail(`Bitte füllen Sie das Feld „${field}“ aus.`, "invalid_field");
  const trimmed = value.trim();
  if (!trimmed) fail(`Bitte füllen Sie das Feld „${field}“ aus.`, "invalid_field");
  if (trimmed.length > maxLength) fail(`Das Feld „${field}“ ist zu lang (max. ${maxLength} Zeichen).`, "invalid_field");
  if (CONTROL_RE.test(trimmed)) fail(`Das Feld „${field}“ enthält ungültige Zeichen.`, "invalid_field");
  return trimmed;
}

export function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
  return requireString(value, field, maxLength);
}

export function validateName(value: unknown): string {
  const name = requireString(value, "Name", 100).replace(/\s+/g, " ");
  if (!NAME_RE.test(name)) fail("Bitte geben Sie einen gültigen Namen an.", "invalid_name");
  return name;
}

export function validateEmail(value: unknown): string {
  const email = requireString(value, "E-Mail-Adresse", 254).toLowerCase();
  if (!EMAIL_RE.test(email)) fail("Bitte geben Sie eine gültige E-Mail-Adresse an.", "invalid_email");
  return email;
}

export function validatePhone(value: unknown): string | null {
  const phone = optionalString(value, "Telefonnummer", 40);
  if (phone && !PHONE_RE.test(phone)) fail("Bitte geben Sie eine gültige Telefonnummer an.", "invalid_phone");
  return phone;
}

export function validateId(value: unknown, field = "ID"): string {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,64}$/i.test(value)) fail(`Ungültige ${field}.`, "invalid_id");
  return value;
}

export function validateInt(value: unknown, field: string, min: number, max: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    fail(`„${field}“ muss eine ganze Zahl zwischen ${min} und ${max} sein.`, "invalid_number");
  }
  return n;
}
