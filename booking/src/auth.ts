import { setSetting } from "./data";
import type { Env } from "./env";
import { base64UrlDecode, base64UrlEncode, HttpError, randomToken, sha256Hex } from "./http";

/**
 * Admin authentication: one practice password (stored as a PBKDF2 hash secret) and an
 * HMAC-signed session cookie. Generate the hash with `npm run hash-password`.
 *
 * A session ends when it expires, on logout (which ends every open session, see
 * revokeSessions) and when the password hash or SESSION_SECRET changes.
 */

export const SESSION_COOKIE = "__Host-lb_admin";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();

/** Hash format: pbkdf2$<iterations>$<salt b64url>$<hash b64url> */
export async function hashPassword(password: string, iterations = 100_000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
  const iterations = Number(iterStr);
  if (scheme !== "pbkdf2" || !Number.isInteger(iterations) || !saltB64 || !hashB64) return false;
  const expected = base64UrlDecode(hashB64);
  const actual = await pbkdf2(password, base64UrlDecode(saltB64), iterations);
  return timingSafeEqual(expected, actual);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET missing or too short");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

// Domain separation: session signatures can never be confused with the public form tokens
// that are signed with the same secret (see spam.ts).
const SESSION_PURPOSE = "admin-session:";
const SESSION_GENERATION_KEY = "session_generation";

/**
 * What a session signature covers: its purpose, the current password hash and the payload.
 * Changing the admin password therefore invalidates every session issued before.
 */
async function sessionMessage(env: Env, payload: string): Promise<Uint8Array> {
  return encoder.encode(`${SESSION_PURPOSE}${await sha256Hex(env.ADMIN_PASSWORD_HASH ?? "")}:${payload}`);
}

/** Sessions carry the generation they were issued in; logout starts a new one. */
async function sessionGeneration(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(SESSION_GENERATION_KEY).first<{ value: string }>();
  return row?.value ?? "0";
}

/** Ends every open admin session, including copies of the cookie on other devices. */
export async function revokeSessions(env: Env): Promise<void> {
  await setSetting(env, SESSION_GENERATION_KEY, randomToken(12));
}

export async function createSessionCookie(env: Env): Promise<string> {
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ exp: Date.now() + SESSION_TTL_SECONDS * 1000, gen: await sessionGeneration(env) })),
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), await sessionMessage(env, payload)));
  return `${SESSION_COOKIE}=${payload}.${base64UrlEncode(sig)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return false;
  const [payload, sig] = match.slice(SESSION_COOKIE.length + 1).split(".");
  if (!payload || !sig) return false;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(env.SESSION_SECRET),
      base64UrlDecode(sig),
      await sessionMessage(env, payload),
    );
    if (!ok) return false;
    const { exp, gen } = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (typeof exp !== "number" || exp <= Date.now() || typeof gen !== "string") return false;
    return gen === (await sessionGeneration(env));
  } catch {
    return false;
  }
}

/** Rejects requests that another website made the browser send. */
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, "Ungültige Herkunft der Anfrage.", "bad_origin");
  }
}

/**
 * Admin requests must carry the session cookie; state-changing requests must also come
 * from the same origin (CSRF defence in addition to SameSite=Strict).
 */
export async function requireAdmin(request: Request, env: Env): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") requireSameOrigin(request);
  if (!(await isAuthenticated(request, env))) {
    throw new HttpError(401, "Bitte melden Sie sich an.", "unauthenticated");
  }
}
