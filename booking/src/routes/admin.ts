import { clearSessionCookie, createSessionCookie, isAuthenticated, requireSameOrigin, revokeSessions, verifyPassword } from "../auth";
import {
  cancelBooking,
  createSlot,
  getBooking,
  getService,
  getSettings,
  hasOverlap,
  listServices,
  NUMERIC_SETTING_KEYS,
  setSetting,
  settingBounds,
} from "../data";
import {
  clientCancellationEmail,
  kindLabel,
  MAX_ATTEMPTS,
  previewEmail,
  resendEmail,
  sendEmail,
  testEmail,
} from "../email";
import { getEmailSettings, mergeEmailSettings, saveEmailSettings } from "../email-settings";
import {
  DEFAULT_TEMPLATES,
  HAS_HINTS,
  HINT_PLACEHOLDERS,
  PLACEHOLDER_LABELS,
  TEMPLATE_IDS,
  TEMPLATE_LABELS,
  TEMPLATE_PLACEHOLDERS,
  type TemplateId,
} from "../email-templates";
import type { Booking, Env, Service } from "../env";
import { clientIp, enforceRateLimit, HttpError, json, newId, randomToken, readJson } from "../http";
import { buildCalendar, PRACTICE_ADDRESS } from "../ics";
import { addDays, DATE_RE, mondayOf, TIME_RE, viennaDate, viennaTime, viennaToUtc } from "../time";
import { optionalString, requireString, validateEmail, validateId, validateInt } from "../validate";


// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function login(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request);
  await enforceRateLimit(env.LOGIN_LIMITER, `login:${clientIp(request)}`);
  const { password } = await readJson<{ password?: unknown }>(request);
  if (typeof password !== "string" || password.length > 200 || !(await verifyPassword(password, env.ADMIN_PASSWORD_HASH))) {
    throw new HttpError(401, "Das Passwort ist nicht korrekt.", "bad_password");
  }
  return json({ ok: true }, 200, { "set-cookie": await createSessionCookie(env) });
}

/** Ends the session on the server too, so a copy of the cookie stops working. */
export async function logout(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request);
  // Only someone who is logged in can end sessions; strangers just get the cookie cleared.
  if (await isAuthenticated(request, env)) await revokeSessions(env);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

export async function session(request: Request, env: Env): Promise<Response> {
  return json({ authenticated: await isAuthenticated(request, env), environment: env.ENVIRONMENT, emailMode: env.EMAIL_MODE });
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

function adminBooking(b: Booking & { service_name?: string }) {
  return {
    id: b.id,
    serviceId: b.service_id,
    serviceName: b.service_name ?? b.service_id,
    sessionKind: b.session_kind,
    sessionKindLabel: kindLabel(b.session_kind),
    start: new Date(b.start_at).toISOString(),
    end: new Date(b.end_at).toISOString(),
    date: viennaDate(b.start_at),
    time: viennaTime(b.start_at),
    name: b.name,
    email: b.email,
    phone: b.phone,
    notes: b.notes,
    status: b.status,
    cancelledBy: b.cancelled_by,
    cancelledAt: b.cancelled_at ? new Date(b.cancelled_at).toISOString() : null,
    createdAt: new Date(b.created_at).toISOString(),
  };
}

export async function listBookings(request: Request, env: Env): Promise<Response> {
  const scope = new URL(request.url).searchParams.get("scope") || "upcoming";
  const now = Date.now();
  const where =
    scope === "past"
      ? "b.status = 'confirmed' AND b.start_at < ?1 ORDER BY b.start_at DESC"
      : scope === "cancelled"
        ? "b.status = 'cancelled' AND ?1 = ?1 ORDER BY b.cancelled_at DESC"
        : "b.status = 'confirmed' AND b.start_at >= ?1 ORDER BY b.start_at ASC";
  const { results } = await env.DB.prepare(
    `SELECT b.*, v.name AS service_name FROM bookings b LEFT JOIN services v ON v.id = b.service_id WHERE ${where} LIMIT 500`,
  )
    .bind(now)
    .all<Booking & { service_name: string }>();
  return json(results.map(adminBooking));
}

export async function adminCancelBooking(request: Request, env: Env, ctx: ExecutionContext, id: string): Promise<Response> {
  const body = await readJson<{ notify?: unknown; release?: unknown }>(request);
  const booking = await getBooking(env, validateId(id));
  if (!booking) throw new HttpError(404, "Buchung nicht gefunden.", "not_found");
  if (booking.status !== "confirmed") throw new HttpError(409, "Diese Buchung ist bereits abgesagt.", "already_cancelled");
  const release = body.release !== false;
  if (!(await cancelBooking(env, booking, "admin", release))) {
    throw new HttpError(409, "Diese Buchung ist bereits abgesagt.", "already_cancelled");
  }
  if (body.notify !== false) {
    const service = (await getService(env, booking.service_id)) as Service;
    ctx.waitUntil(getEmailSettings(env).then((cfg) => sendEmail(env, cfg, clientCancellationEmail(env, cfg, booking, service, true))));
  }
  return json({ ok: true });
}

export async function bookingIcs(env: Env, id: string): Promise<Response> {
  const booking = await getBooking(env, validateId(id));
  if (!booking) throw new HttpError(404, "Buchung nicht gefunden.", "not_found");
  const service = await getService(env, booking.service_id);
  const ics = buildCalendar([
    {
      uid: `${booking.id}@psychotherapieberger.at`,
      start: booking.start_at,
      end: booking.end_at,
      summary: `${service?.name ?? booking.service_id}: ${booking.name}`,
      description: [kindLabel(booking.session_kind), booking.phone ? `Tel. ${booking.phone}` : "", booking.email].filter(Boolean).join("\n"),
      location: PRACTICE_ADDRESS,
      status: booking.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
    },
  ]);
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="termin-${viennaDate(booking.start_at)}.ics"`,
      "cache-control": "no-store",
    },
  });
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export async function listSlots(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const from = params.get("from") || viennaDate(Date.now());
  const to = params.get("to") || addDays(from, 62);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new HttpError(400, "Ungültiger Zeitraum.", "invalid_range");
  const { results } = await env.DB.prepare(
    `SELECT s.*, v.name AS service_name, b.name AS client_name FROM slots s
     LEFT JOIN services v ON v.id = s.service_id
     LEFT JOIN bookings b ON b.id = s.booking_id AND b.status = 'confirmed'
     WHERE s.start_at >= ? AND s.start_at < ? ORDER BY s.start_at`,
  )
    .bind(viennaToUtc(from, "00:00"), viennaToUtc(addDays(to, 1), "00:00"))
    .all<{ id: string; service_id: string; service_name: string; start_at: number; end_at: number; status: string; client_name: string | null }>();
  return json(
    results.map((s) => ({
      id: s.id,
      serviceId: s.service_id,
      serviceName: s.service_name,
      date: viennaDate(s.start_at),
      time: viennaTime(s.start_at),
      endTime: viennaTime(s.end_at),
      start: new Date(s.start_at).toISOString(),
      status: s.status,
      clientName: s.client_name,
    })),
  );
}

async function activeServiceOrThrow(env: Env, id: unknown): Promise<Service> {
  const service = await getService(env, validateId(id, "Therapieform"));
  if (!service) throw new HttpError(400, "Unbekannte Therapieform.", "invalid_service");
  return service;
}

function parseDateTime(date: unknown, time: unknown): number {
  if (typeof date !== "string" || !DATE_RE.test(date) || typeof time !== "string" || !TIME_RE.test(time)) {
    throw new HttpError(400, "Bitte geben Sie ein gültiges Datum und eine gültige Uhrzeit an.", "invalid_datetime");
  }
  try {
    return viennaToUtc(date, time);
  } catch {
    throw new HttpError(400, "Bitte geben Sie ein gültiges Datum an.", "invalid_datetime");
  }
}

export async function addSlot(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const service = await activeServiceOrThrow(env, body.serviceId);
  const slot = await createSlot(env, service, parseDateTime(body.date, body.time));
  return json({ id: slot.id }, 201);
}

export async function deleteSlot(env: Env, id: string): Promise<Response> {
  const result = await env.DB.prepare("DELETE FROM slots WHERE id = ? AND status = 'available'").bind(validateId(id)).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new HttpError(409, "Gebuchte Slots können nicht gelöscht werden – bitte sagen Sie die Buchung ab.", "slot_booked");
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Weekly template
// ---------------------------------------------------------------------------

export async function getTemplate(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.weekday, t.time, t.service_id, v.name AS service_name FROM template_items t
     LEFT JOIN services v ON v.id = t.service_id ORDER BY t.weekday, t.time`,
  ).all<{ id: string; weekday: number; time: string; service_id: string; service_name: string }>();
  return json(results.map((t) => ({ id: t.id, weekday: t.weekday, time: t.time, serviceId: t.service_id, serviceName: t.service_name })));
}

export async function addTemplateItem(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const weekday = validateInt(body.weekday, "Wochentag", 1, 7);
  if (typeof body.time !== "string" || !TIME_RE.test(body.time)) throw new HttpError(400, "Ungültige Uhrzeit.", "invalid_time");
  const service = await activeServiceOrThrow(env, body.serviceId);
  const id = newId();
  await env.DB.prepare("INSERT INTO template_items (id, weekday, time, service_id) VALUES (?, ?, ?, ?)")
    .bind(id, weekday, body.time, service.id)
    .run();
  return json({ id }, 201);
}

export async function deleteTemplateItem(env: Env, id: string): Promise<Response> {
  await env.DB.prepare("DELETE FROM template_items WHERE id = ?").bind(validateId(id)).run();
  return json({ ok: true });
}

export async function applyTemplate(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (typeof body.date !== "string" || !DATE_RE.test(body.date)) throw new HttpError(400, "Bitte wählen Sie eine Woche.", "invalid_date");
  const weeks = validateInt(body.weeks ?? 1, "Anzahl Wochen", 1, 12);
  const { results: items } = await env.DB.prepare("SELECT weekday, time, service_id FROM template_items").all<{
    weekday: number;
    time: string;
    service_id: string;
  }>();
  if (items.length === 0) throw new HttpError(400, "Die Wochen-Vorlage ist leer.", "empty_template");
  const services = new Map((await listServices(env, false)).map((s) => [s.id, s]));
  const monday = mondayOf(body.date);
  const now = Date.now();
  let created = 0;
  let skipped = 0;
  for (let w = 0; w < weeks; w++) {
    for (const item of items) {
      const service = services.get(item.service_id);
      const date = addDays(monday, w * 7 + item.weekday - 1);
      const start = viennaToUtc(date, item.time);
      if (!service || start <= now || (await hasOverlap(env, start, start + service.duration_min * 60_000))) {
        skipped++;
        continue;
      }
      await env.DB.prepare(
        "INSERT INTO slots (id, service_id, start_at, end_at, status, booking_id, created_at) VALUES (?, ?, ?, ?, 'available', NULL, ?)",
      )
        .bind(newId(), service.id, start, start + service.duration_min * 60_000, now)
        .run();
      created++;
    }
  }
  return json({ created, skipped, weekOf: monday });
}

// ---------------------------------------------------------------------------
// Services & settings
// ---------------------------------------------------------------------------

/** Icons offered for a therapy form (Lucide names, shown on the booking cards on the website). */
export const SERVICE_ICONS = ["user", "users", "puzzle", "baby", "heart", "heart-handshake", "smile", "leaf", "message-circle", "sparkles"];

export async function getAdminServices(env: Env): Promise<Response> {
  return json(
    (await listServices(env, false)).map((s) => ({
      id: s.id,
      name: s.name,
      durationMin: s.duration_min,
      priceEur: s.price_eur,
      description: s.description,
      icon: s.icon,
      active: s.active === 1,
    })),
  );
}

function serviceFields(body: Record<string, unknown>, current?: Service) {
  const name = requireString(body.name ?? current?.name, "Name", 60);
  const duration = validateInt(body.durationMin ?? current?.duration_min, "Dauer", 10, 240);
  const price = validateInt(body.priceEur ?? current?.price_eur, "Preis", 0, 2000);
  const description = optionalString(body.description ?? current?.description ?? "", "Beschreibung", 200) ?? "";
  const icon = body.icon ?? current?.icon ?? "user";
  if (typeof icon !== "string" || !SERVICE_ICONS.includes(icon)) throw new HttpError(400, "Ungültiges Symbol.", "invalid_input");
  const active = body.active === undefined ? (current?.active ?? 1) : body.active ? 1 : 0;
  return { name, duration, price, description, icon, active };
}

/** URL-friendly id from the name, e.g. "Kinder- & Jugendtherapie" -> "kinder-jugendtherapie". */
function slugify(name: string): string {
  const map: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };
  const slug = name
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => map[c])
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "therapieform";
}

export async function createService(request: Request, env: Env): Promise<Response> {
  const f = serviceFields(await readJson(request));
  const base = slugify(f.name);
  let id = base;
  for (let i = 2; await getService(env, id); i++) id = `${base}-${i}`;
  const order = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM services").first<{ next: number }>();
  await env.DB.prepare(
    "INSERT INTO services (id, name, duration_min, price_eur, description, icon, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, f.name, f.duration, f.price, f.description, f.icon, order?.next ?? 1, f.active)
    .run();
  return json({ id }, 201);
}

export async function updateService(request: Request, env: Env, id: string): Promise<Response> {
  const service = await getService(env, validateId(id));
  if (!service) throw new HttpError(404, "Therapieform nicht gefunden.", "not_found");
  const f = serviceFields(await readJson(request), service);
  await env.DB.prepare(
    "UPDATE services SET name = ?, duration_min = ?, price_eur = ?, description = ?, icon = ?, active = ? WHERE id = ?",
  )
    .bind(f.name, f.duration, f.price, f.description, f.icon, f.active, service.id)
    .run();
  return json({ ok: true });
}

/** Remove a therapy form that was never used. Used ones can only be switched off (history stays intact). */
export async function deleteService(env: Env, id: string): Promise<Response> {
  const service = await getService(env, validateId(id));
  if (!service) throw new HttpError(404, "Therapieform nicht gefunden.", "not_found");
  const used = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM slots WHERE service_id = ?) AS slots,
            (SELECT COUNT(*) FROM bookings WHERE service_id = ?) AS bookings,
            (SELECT COUNT(*) FROM template_items WHERE service_id = ?) AS template`,
  )
    .bind(service.id, service.id, service.id)
    .first<{ slots: number; bookings: number; template: number }>();
  if (used && (used.slots || used.bookings || used.template)) {
    const where = [
      used.slots ? "freigegebene Termine" : "",
      used.bookings ? "Buchungen" : "",
      used.template ? "Einträge in der Wochen-Vorlage" : "",
    ].filter(Boolean).join(", ");
    throw new HttpError(
      409,
      `„${service.name}“ hat noch ${where}. Entfernen Sie diese zuerst – oder nehmen Sie einfach das Häkchen bei „online buchbar“ heraus.`,
      "service_in_use",
    );
  }
  await env.DB.prepare("DELETE FROM services WHERE id = ?").bind(service.id).run();
  return json({ ok: true });
}

function feedUrl(env: Env, token: string | null): string | null {
  return token ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/calendar/${token}.ics` : null;
}

export async function getAdminSettings(env: Env): Promise<Response> {
  const s = await getSettings(env);
  return json({
    cancelWindowHours: s.cancel_window_hours,
    minNoticeHours: s.min_notice_hours,
    bookingHorizonDays: s.booking_horizon_days,
    retentionDays: s.retention_days,
    maxBookingsPerDay: s.max_bookings_per_day,
    calendarFeedUrl: feedUrl(env, s.calendar_feed_token),
  });
}

const SETTINGS_BODY_KEYS: Record<string, (typeof NUMERIC_SETTING_KEYS)[number]> = {
  cancelWindowHours: "cancel_window_hours",
  minNoticeHours: "min_notice_hours",
  bookingHorizonDays: "booking_horizon_days",
  retentionDays: "retention_days",
  maxBookingsPerDay: "max_bookings_per_day",
};

export async function updateSettings(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  for (const [bodyKey, dbKey] of Object.entries(SETTINGS_BODY_KEYS)) {
    if (body[bodyKey] === undefined) continue;
    const { min, max } = settingBounds(dbKey);
    await setSetting(env, dbKey, String(validateInt(body[bodyKey], bodyKey, min, max)));
  }
  return getAdminSettings(env);
}

export async function regenerateFeed(env: Env): Promise<Response> {
  const token = randomToken(24);
  await setSetting(env, "calendar_feed_token", token);
  return json({ calendarFeedUrl: feedUrl(env, token) });
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

function emailStatus(env: Env) {
  return {
    environment: env.ENVIRONMENT,
    mode: env.EMAIL_MODE,
    from: env.MAIL_FROM,
    smtpHost: env.SMTP_HOST,
    smtpConfigured: Boolean(env.SMTP_USER && env.SMTP_PASSWORD),
  };
}

export async function getEmailConfig(env: Env): Promise<Response> {
  const settings = await getEmailSettings(env);
  const { testRecipients, ...rest } = settings;
  return json({
    status: emailStatus(env),
    settings: env.ENVIRONMENT === "production" ? rest : settings,
    templateInfo: TEMPLATE_IDS.map((id) => ({
      id,
      label: TEMPLATE_LABELS[id],
      kind: id === "client_cancellation_by_practice" ? "client_cancellation" : id,
      hasHints: HAS_HINTS.includes(id),
      placeholders: TEMPLATE_PLACEHOLDERS[id].map((key) => ({ key, label: PLACEHOLDER_LABELS[key] })),
      hintPlaceholders: HAS_HINTS.includes(id) ? HINT_PLACEHOLDERS : [],
      defaults: DEFAULT_TEMPLATES[id],
    })),
  });
}

export async function updateEmailConfig(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const merged = mergeEmailSettings(env, await getEmailSettings(env), body);
  await saveEmailSettings(env, merged);
  return getEmailConfig(env);
}

export async function sendTestEmail(request: Request, env: Env): Promise<Response> {
  await enforceRateLimit(env.LOGIN_LIMITER, `test-email:${clientIp(request)}`);
  const body = await readJson<{ to?: unknown }>(request);
  const cfg = await getEmailSettings(env);
  const to = body.to === undefined || body.to === "" ? cfg.notifyTo[0] : validateEmail(body.to);
  const result = await sendEmail(env, cfg, testEmail(env, cfg, to));
  return json({ to, ...result });
}

export async function getEmailPreview(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ type?: unknown; settings?: unknown }>(request);
  if (typeof body.type !== "string" || !(TEMPLATE_IDS as readonly string[]).includes(body.type)) {
    throw new HttpError(400, "Unbekannte Vorschau.", "invalid_input");
  }
  const id = body.type as TemplateId;
  const draft = body.settings && typeof body.settings === "object" ? (body.settings as Record<string, unknown>) : {};
  const cfg = mergeEmailSettings(env, await getEmailSettings(env), draft);
  const [service] = await listServices(env, false);
  if (!service) throw new HttpError(404, "Keine Therapieform vorhanden.", "not_found");
  const settings = await getSettings(env);
  const mail = previewEmail(env, cfg, id, service, settings.cancel_window_hours);
  const kind = id === "client_cancellation_by_practice" ? "client_cancellation" : id;
  return json({ subject: mail.subject, to: mail.to, html: mail.html, enabled: cfg.enabled[kind] });
}

export async function getOutbox(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, kind, to_addr, subject, body_html, status, error, attempts, next_attempt_at, sent_at,
            payload IS NOT NULL AS has_payload
     FROM email_log ORDER BY created_at DESC LIMIT 100`,
  ).all<{
    id: string;
    created_at: number;
    kind: string | null;
    to_addr: string;
    subject: string;
    body_html: string | null;
    status: string;
    error: string | null;
    attempts: number;
    next_attempt_at: number | null;
    sent_at: number | null;
    has_payload: number;
  }>();
  return json({
    maxAttempts: MAX_ATTEMPTS,
    items: results.map((r) => ({
      id: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      kind: r.kind,
      to: r.to_addr,
      subject: r.subject,
      html: r.body_html,
      status: r.status,
      error: r.error,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at && r.status !== "sent" ? new Date(r.next_attempt_at).toISOString() : null,
      sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
      canResend: r.status === "failed" && r.has_payload === 1,
    })),
  });
}

export async function resendOutboxEmail(env: Env, id: string): Promise<Response> {
  const result = await resendEmail(env, validateId(id));
  if (!result) throw new HttpError(409, "Diese E-Mail kann nicht erneut gesendet werden.", "not_resendable");
  return json(result);
}
