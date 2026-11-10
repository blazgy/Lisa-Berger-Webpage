import type { Env } from "./env";
import { HttpError } from "./http";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(env: Env, token: unknown, ip: string): Promise<void> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    throw new HttpError(400, "Die Sicherheitsprüfung fehlt. Bitte laden Sie die Seite neu.", "turnstile_missing");
  }
  if (!env.TURNSTILE_SECRET) throw new Error("TURNSTILE_SECRET is not configured");
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  if (ip !== "unknown") body.append("remoteip", ip);
  const res = await fetch(VERIFY_URL, { method: "POST", body });
  const result = (await res.json().catch(() => ({}))) as { success?: boolean };
  if (!result.success) {
    throw new HttpError(403, "Die Sicherheitsprüfung ist fehlgeschlagen. Bitte versuchen Sie es erneut.", "turnstile_failed");
  }
}
