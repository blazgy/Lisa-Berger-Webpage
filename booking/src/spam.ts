import { hmacKey } from "./auth";
import type { Env } from "./env";
import { base64UrlDecode, base64UrlEncode, HttpError } from "./http";

/**
 * Spam protection for the booking form without third-party services or device access:
 * - a honeypot field ("website") that is hidden from people but filled in by simple bots,
 * - a signed timestamp issued when the contact form is shown; the booking is rejected if it
 *   arrives faster than a person could fill in the form, or after the form has gone stale.
 * Together with the per-IP rate limit this replaces Cloudflare Turnstile.
 */

/** A person needs longer than this to fill in name, e-mail and consent. */
export const MIN_FILL_MS = 3_000;
/** Form timestamps older than this are rejected; the browser then fetches a new one. */
export const MAX_FORM_AGE_MS = 2 * 3_600_000;

const encoder = new TextEncoder();
// Domain separation: these signatures can never be confused with admin session cookies.
const PURPOSE = "booking-form:";

export async function createFormToken(env: Env, now = Date.now()): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(String(now)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), encoder.encode(PURPOSE + payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** Returns the time the token was issued, or null if it is missing, malformed or forged. */
async function readFormToken(env: Env, token: unknown): Promise<number | null> {
  if (typeof token !== "string" || token.length > 200) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(env.SESSION_SECRET),
      base64UrlDecode(sig),
      encoder.encode(PURPOSE + payload),
    );
    if (!ok) return null;
    const issued = Number(new TextDecoder().decode(base64UrlDecode(payload)));
    return Number.isFinite(issued) ? issued : null;
  } catch {
    return null;
  }
}

export async function checkBookingSpam(env: Env, body: Record<string, unknown>, now = Date.now()): Promise<void> {
  if (body.website !== undefined && body.website !== "") {
    throw new HttpError(
      400,
      "Die Buchung konnte nicht gesendet werden. Bitte versuchen Sie es erneut oder kontaktieren Sie mich per E-Mail.",
      "spam_rejected",
    );
  }
  const issued = await readFormToken(env, body.formToken);
  if (issued === null || issued > now || now - issued > MAX_FORM_AGE_MS) {
    throw new HttpError(400, "Das Formular war zu lange geöffnet. Bitte senden Sie es erneut.", "form_expired");
  }
  if (now - issued < MIN_FILL_MS) {
    throw new HttpError(400, "Bitte prüfen Sie Ihre Angaben und senden Sie das Formular dann erneut.", "too_fast");
  }
}
