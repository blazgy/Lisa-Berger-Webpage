/** Thrown inside handlers to produce a JSON error response with a safe, user-facing message. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message, code: err.code }, err.status);
  }
  console.error("Unhandled error", err);
  return json({ error: "Interner Fehler. Bitte versuchen Sie es später erneut.", code: "internal" }, 500);
}

export async function readJson<T = Record<string, unknown>>(request: Request, maxBytes = 16_384): Promise<T> {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Ungültiges Anfrageformat.", "unsupported_media_type");
  }
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Anfrage zu groß.", "too_large");
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
    return data as T;
  } catch {
    throw new HttpError(400, "Ungültige Anfrage.", "bad_json");
  }
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

export async function enforceRateLimit(limiter: RateLimit, key: string): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) {
    throw new HttpError(429, "Zu viele Anfragen. Bitte warten Sie einen Moment und versuchen Sie es erneut.", "rate_limited");
  }
}

/** Escape text for safe inclusion in HTML (e-mails). */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function newId(): string {
  return crypto.randomUUID();
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
