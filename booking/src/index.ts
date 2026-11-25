import { requireAdmin } from "./auth";
import type { Env } from "./env";
import { processEmailQueue } from "./email";
import { errorResponse, HttpError } from "./http";
import { sendDueReminders } from "./reminders";
import * as admin from "./routes/admin";
import * as pub from "./routes/public";

const HOUR = 3_600_000;
/** Must match the daily trigger in wrangler.jsonc; the other trigger runs the e-mail jobs. */
const CLEANUP_CRON = "15 3 * * *";

// Content-Security-Policy for all HTML pages served by the Worker.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

function withSecurityHeaders(response: Response, env: Env): Response {
  const res = new Response(response.body, response);
  res.headers.set("x-content-type-options", "nosniff");
  if (!res.headers.has("referrer-policy")) res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  res.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (env.ENVIRONMENT !== "development") {
    res.headers.set("strict-transport-security", "max-age=31536000");
  }
  if ((res.headers.get("content-type") || "").includes("text/html")) {
    res.headers.set("content-security-policy", CSP);
    res.headers.set("x-frame-options", "DENY");
  }
  if (env.ENVIRONMENT !== "production") res.headers.set("x-robots-tag", "noindex, nofollow");
  return res;
}

/** Visible marker on every page of non-production environments. */
class StagingBanner {
  constructor(private label: string) {}
  element(el: Element) {
    el.prepend(
      `<div style="position:fixed;bottom:12px;left:12px;z-index:9999;background:#F5DF9C;color:#2B2B2B;font:600 12px/1 Arial,sans-serif;padding:8px 12px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.15);pointer-events:none;">${this.label}</div>`,
      { html: true },
    );
  }
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

async function routeApi(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const method = request.method;
  let m: RegExpMatchArray | null;

  // ---- Public ----
  if (method === "GET" && path === "/api/config") return pub.getConfig(env);
  if (method === "GET" && path === "/api/form-token") return pub.getFormToken(request, env);
  if (method === "GET" && path === "/api/services") return pub.getServices(request, env);
  if (method === "GET" && path === "/api/slots") return pub.getSlots(request, env);
  if (method === "POST" && path === "/api/bookings") return pub.createBooking(request, env, ctx);
  if (method === "POST" && path === "/api/manage") return pub.getManagedBooking(request, env);
  if (method === "POST" && path === "/api/manage/cancel") return pub.cancelManagedBooking(request, env, ctx);
  if (method === "GET" && (m = path.match(/^\/api\/calendar\/([A-Za-z0-9_-]{16,64})\.ics$/))) return pub.getCalendarFeed(env, m[1]);

  // ---- Admin session ----
  if (method === "POST" && path === "/api/admin/login") return admin.login(request, env);
  if (method === "POST" && path === "/api/admin/logout") return admin.logout(request, env);
  if (method === "GET" && path === "/api/admin/session") return admin.session(request, env);

  // ---- Admin (authenticated) ----
  if (path.startsWith("/api/admin/")) {
    await requireAdmin(request, env);
    if (method === "GET" && path === "/api/admin/bookings") return admin.listBookings(request, env);
    if (method === "POST" && (m = path.match(/^\/api\/admin\/bookings\/([^/]+)\/cancel$/))) return admin.adminCancelBooking(request, env, ctx, m[1]);
    if (method === "GET" && (m = path.match(/^\/api\/admin\/bookings\/([^/]+)\/ics$/))) return admin.bookingIcs(env, m[1]);
    if (method === "GET" && path === "/api/admin/slots") return admin.listSlots(request, env);
    if (method === "POST" && path === "/api/admin/slots") return admin.addSlot(request, env);
    if (method === "DELETE" && (m = path.match(/^\/api\/admin\/slots\/([^/]+)$/))) return admin.deleteSlot(env, m[1]);
    if (method === "GET" && path === "/api/admin/template") return admin.getTemplate(env);
    if (method === "POST" && path === "/api/admin/template") return admin.addTemplateItem(request, env);
    if (method === "POST" && path === "/api/admin/template/apply") return admin.applyTemplate(request, env);
    if (method === "DELETE" && (m = path.match(/^\/api\/admin\/template\/([^/]+)$/))) return admin.deleteTemplateItem(env, m[1]);
    if (method === "GET" && path === "/api/admin/services") return admin.getAdminServices(env);
    if (method === "PUT" && (m = path.match(/^\/api\/admin\/services\/([^/]+)$/))) return admin.updateService(request, env, m[1]);
    if (method === "POST" && path === "/api/admin/services") return admin.createService(request, env);
    if (method === "DELETE" && (m = path.match(/^\/api\/admin\/services\/([^/]+)$/))) return admin.deleteService(env, m[1]);
    if (method === "GET" && path === "/api/admin/settings") return admin.getAdminSettings(env);
    if (method === "PUT" && path === "/api/admin/settings") return admin.updateSettings(request, env);
    if (method === "POST" && path === "/api/admin/calendar-feed") return admin.regenerateFeed(env);
    if (method === "GET" && path === "/api/admin/email") return admin.getEmailConfig(env);
    if (method === "PUT" && path === "/api/admin/email") return admin.updateEmailConfig(request, env);
    if (method === "POST" && path === "/api/admin/email/test") return admin.sendTestEmail(request, env);
    if (method === "POST" && path === "/api/admin/email/preview") return admin.getEmailPreview(request, env);
    if (method === "GET" && path === "/api/admin/outbox") return admin.getOutbox(env);
    if (method === "POST" && (m = path.match(/^\/api\/admin\/outbox\/([^/]+)\/resend$/))) return admin.resendOutboxEmail(env, m[1]);
  }
  throw new HttpError(404, "Nicht gefunden.", "not_found");
}

/** Daily data-retention cleanup. */
export async function cleanup(env: Env, now = Date.now()): Promise<void> {
  const settings = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'retention_days'").first<{ value: string }>()) ?? {
    value: "90",
  };
  const cutoff = now - Number(settings.value) * 24 * HOUR;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bookings WHERE end_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM slots WHERE status = 'available' AND end_at < ?").bind(now),
    env.DB.prepare("DELETE FROM slots WHERE status = 'booked' AND end_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM email_log WHERE created_at < ?").bind(now - 30 * 24 * HOUR),
  ]);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      const cors = path.startsWith("/api/admin/") ? {} : corsHeaders(request, env);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      let response: Response;
      try {
        response = await routeApi(request, env, ctx, path);
      } catch (err) {
        response = errorResponse(err);
      }
      const res = withSecurityHeaders(response, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }

    // Static site. Old Firebase-era login page is gone; the admin page has its own login.
    if (path === "/login.html") return Response.redirect(new URL("/admin.html", url).toString(), 301);
    let response = await env.ASSETS.fetch(request);
    if (path === "/admin.html" || path === "/termin.html" || path === "/admin" || path === "/termin") {
      response = new Response(response.body, response);
      response.headers.set("cache-control", "no-store");
      response.headers.set("x-robots-tag", "noindex, nofollow");
      response.headers.set("referrer-policy", "no-referrer");
    }
    if (env.ENVIRONMENT !== "production" && (response.headers.get("content-type") || "").includes("text/html")) {
      response = new HTMLRewriter()
        .on("body", new StagingBanner(env.ENVIRONMENT === "staging" ? "TESTUMGEBUNG – keine echten Buchungen" : "LOKALE ENTWICKLUNG"))
        // Keep test traffic out of the production web analytics.
        .on('script[src*="cloudflareinsights.com"]', { element: (el) => void el.remove() })
        .transform(response);
    }
    return withSecurityHeaders(response, env);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === CLEANUP_CRON) {
      ctx.waitUntil(cleanup(env));
      return;
    }
    // Every 10 minutes: retry due e-mails, then send due appointment reminders.
    ctx.waitUntil(
      (async () => {
        await processEmailQueue(env);
        await sendDueReminders(env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
