import type { Env } from "./env";
import { base64UrlDecode, base64UrlEncode, HttpError } from "./http";

/**
 * Admin authentication: one practice password (stored as a PBKDF2 hash secret) and a
 * stateless, HMAC-signed session cookie. Generate the hash with `npm run hash-password`.
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

export async function createSessionCookie(env: Env): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({ exp: Date.now() + SESSION_TTL_SECONDS * 1000 })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), encoder.encode(payload)));
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
      encoder.encode(payload),
    );
    if (!ok) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

/**
 * Admin requests must carry the session cookie; state-changing requests must also come
 * from the same origin (CSRF defence in addition to SameSite=Strict).
 */
export async function requireAdmin(request: Request, env: Env): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) {
      throw new HttpError(403, "Ungültige Herkunft der Anfrage.", "bad_origin");
    }
  }
  if (!(await isAuthenticated(request, env))) {
    throw new HttpError(401, "Bitte melden Sie sich an.", "unauthenticated");
  }
}
