import {
  clientCancellationEmail,
  clientConfirmationEmail,
  kindLabel,
  practiceCancellationEmail,
  practiceNewBookingEmail,
  sendEmail,
} from "../email";
import { getEmailSettings } from "../email-settings";
import type { Booking, Env, Service } from "../env";
import { cancelBooking, getBookingByTokenHash, getService, getSettings, listServices } from "../data";
import { clientIp, enforceRateLimit, HttpError, json, newId, randomToken, readJson, sha256Hex } from "../http";
import { buildCalendar, PRACTICE_ADDRESS } from "../ics";
import { viennaDate, viennaTime } from "../time";
import { checkBookingSpam, createFormToken } from "../spam";
import { optionalString, validateEmail, validateId, validateName, validatePhone } from "../validate";

const HOUR = 3_600_000;

function publicService(s: Service) {
  return {
    id: s.id,
    name: s.name,
    durationMin: s.duration_min,
    priceEur: s.price_eur,
    description: s.description,
    icon: s.icon,
  };
}

export async function getConfig(env: Env): Promise<Response> {
  const settings = await getSettings(env);
  return json({
    environment: env.ENVIRONMENT,
    cancelWindowHours: settings.cancel_window_hours,
  });
}

/** Signed timestamp for the contact form (spam protection, see spam.ts). */
export async function getFormToken(request: Request, env: Env): Promise<Response> {
  await enforceRateLimit(env.READ_LIMITER, `read:${clientIp(request)}`);
  return json({ formToken: await createFormToken(env) });
}

export async function getServices(request: Request, env: Env): Promise<Response> {
  await enforceRateLimit(env.READ_LIMITER, `read:${clientIp(request)}`);
  return json((await listServices(env, true)).map(publicService));
}

export async function getSlots(request: Request, env: Env): Promise<Response> {
  await enforceRateLimit(env.READ_LIMITER, `read:${clientIp(request)}`);
  const serviceId = validateId(new URL(request.url).searchParams.get("service"), "Therapieform");
  const settings = await getSettings(env);
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.start_at, s.end_at FROM slots s JOIN services v ON v.id = s.service_id
     WHERE s.status = 'available' AND v.active = 1 AND s.service_id = ? AND s.start_at >= ? AND s.start_at <= ?
     ORDER BY s.start_at`,
  )
    .bind(serviceId, now + settings.min_notice_hours * HOUR, now + settings.booking_horizon_days * 24 * HOUR)
    .all<{ id: string; start_at: number; end_at: number }>();
  return json(
    results.map((r) => ({
      id: r.id,
      start: new Date(r.start_at).toISOString(),
      end: new Date(r.end_at).toISOString(),
      date: viennaDate(r.start_at),
      time: viennaTime(r.start_at),
    })),
  );
}

export async function createBooking(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ip = clientIp(request);
  await enforceRateLimit(env.BOOKING_LIMITER, `book:${ip}`);
  const body = await readJson(request);

  // Validate everything before touching the database.
  const slotId = validateId(body.slotId, "Termin-Auswahl");
  const serviceId = validateId(body.serviceId, "Therapieform");
  const sessionKind = body.sessionKind;
  if (sessionKind !== "erstgespraech" && sessionKind !== "folgetermin") {
    throw new HttpError(400, "Bitte wählen Sie, ob es sich um ein Erstgespräch oder einen Folgetermin handelt.", "invalid_kind");
  }
  const name = validateName(body.name);
  const email = validateEmail(body.email);
  const phone = validatePhone(body.phone);
  const notes = optionalString(body.notes, "Anmerkungen", 1000);
  if (body.consent !== true) {
    throw new HttpError(400, "Bitte bestätigen Sie die Einwilligung zur Datenverarbeitung.", "consent_missing");
  }
  await checkBookingSpam(env, body);

  const [service, settings, slot] = await Promise.all([
    getService(env, serviceId),
    getSettings(env),
    env.DB.prepare("SELECT * FROM slots WHERE id = ?").bind(slotId).first<{ service_id: string; start_at: number; end_at: number; status: string }>(),
  ]);
  const now = Date.now();
  if (!service || !service.active) throw new HttpError(400, "Diese Therapieform ist derzeit nicht online buchbar.", "service_unavailable");
  if (!slot || slot.service_id !== serviceId || slot.status !== "available" || slot.start_at < now + settings.min_notice_hours * HOUR) {
    throw new HttpError(409, "Dieser Termin ist leider nicht mehr verfügbar. Bitte wählen Sie einen anderen Termin.", "slot_taken");
  }

  const token = randomToken();
  const booking: Booking = {
    id: newId(),
    slot_id: slotId,
    service_id: serviceId,
    session_kind: sessionKind,
    start_at: slot.start_at,
    end_at: slot.end_at,
    name,
    email,
    phone,
    notes,
    status: "confirmed",
    cancelled_by: null,
    cancelled_at: null,
    cancel_token_hash: await sha256Hex(token),
    consent_at: now,
    created_at: now,
  };

  // Atomic: claim the slot only if still available, insert the booking only if the claim succeeded.
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE slots SET status = 'booked', booking_id = ? WHERE id = ? AND status = 'available'").bind(booking.id, slotId),
    env.DB.prepare(
      `INSERT INTO bookings (id, slot_id, service_id, session_kind, start_at, end_at, name, email, phone, notes, status, cancel_token_hash, consent_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM slots WHERE id = ? AND booking_id = ?)`,
    ).bind(
      booking.id, slotId, serviceId, sessionKind, booking.start_at, booking.end_at, name, email, phone, notes,
      booking.cancel_token_hash, now, now, slotId, booking.id,
    ),
  ]);
  if ((results[0].meta.changes ?? 0) !== 1 || (results[1].meta.changes ?? 0) !== 1) {
    throw new HttpError(409, "Dieser Termin wurde soeben vergeben. Bitte wählen Sie einen anderen Termin.", "slot_taken");
  }

  const cancelDeadline = booking.start_at - settings.cancel_window_hours * HOUR;
  ctx.waitUntil(
    (async () => {
      const cfg = await getEmailSettings(env);
      await Promise.all([
        sendEmail(env, cfg, clientConfirmationEmail(env, cfg, booking, service, token, cancelDeadline)),
        sendEmail(env, cfg, practiceNewBookingEmail(env, cfg, booking, service)),
      ]);
    })(),
  );

  return json(
    {
      booking: {
        start: new Date(booking.start_at).toISOString(),
        date: viennaDate(booking.start_at),
        time: viennaTime(booking.start_at),
        service: publicService(service),
        sessionKind: kindLabel(sessionKind),
        cancelDeadline: new Date(cancelDeadline).toISOString(),
      },
    },
    201,
  );
}

async function bookingFromToken(request: Request, env: Env): Promise<{ booking: Booking; service: Service }> {
  await enforceRateLimit(env.BOOKING_LIMITER, `manage:${clientIp(request)}`);
  const { token } = await readJson<{ token?: unknown }>(request);
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    throw new HttpError(404, "Dieser Link ist ungültig oder abgelaufen.", "not_found");
  }
  const booking = await getBookingByTokenHash(env, await sha256Hex(token));
  const service = booking && (await getService(env, booking.service_id));
  if (!booking || !service) throw new HttpError(404, "Dieser Link ist ungültig oder abgelaufen.", "not_found");
  return { booking, service };
}

function manageView(booking: Booking, service: Service, cancelWindowHours: number) {
  const deadline = booking.start_at - cancelWindowHours * HOUR;
  const now = Date.now();
  return {
    status: booking.status,
    cancelledBy: booking.cancelled_by,
    start: new Date(booking.start_at).toISOString(),
    date: viennaDate(booking.start_at),
    time: viennaTime(booking.start_at),
    service: publicService(service),
    sessionKind: kindLabel(booking.session_kind),
    name: booking.name,
    cancelDeadline: new Date(deadline).toISOString(),
    isPast: booking.start_at <= now,
    canCancel: booking.status === "confirmed" && now <= deadline,
  };
}

export async function getManagedBooking(request: Request, env: Env): Promise<Response> {
  const { booking, service } = await bookingFromToken(request, env);
  const settings = await getSettings(env);
  return json(manageView(booking, service, settings.cancel_window_hours));
}

export async function cancelManagedBooking(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { booking, service } = await bookingFromToken(request, env);
  const settings = await getSettings(env);
  const view = manageView(booking, service, settings.cancel_window_hours);
  if (booking.status !== "confirmed") throw new HttpError(409, "Dieser Termin wurde bereits abgesagt.", "already_cancelled");
  if (!view.canCancel) {
    throw new HttpError(
      409,
      `Eine Online-Absage ist nur bis ${settings.cancel_window_hours} Stunden vor dem Termin möglich. Bitte kontaktieren Sie mich telefonisch oder per E-Mail.`,
      "too_late",
    );
  }
  if (!(await cancelBooking(env, booking, "client", true))) {
    throw new HttpError(409, "Dieser Termin wurde bereits abgesagt.", "already_cancelled");
  }
  ctx.waitUntil(
    (async () => {
      const cfg = await getEmailSettings(env);
      await Promise.all([
        sendEmail(env, cfg, clientCancellationEmail(env, cfg, booking, service, false)),
        sendEmail(env, cfg, practiceCancellationEmail(env, cfg, booking, service)),
      ]);
    })(),
  );
  return json({ ...view, status: "cancelled", cancelledBy: "client", canCancel: false });
}

/** Private iCal feed for the practice calendar (secret token in the URL). */
export async function getCalendarFeed(env: Env, token: string): Promise<Response> {
  const settings = await getSettings(env);
  const expected = settings.calendar_feed_token;
  if (!expected || token.length !== expected.length || (await sha256Hex(token)) !== (await sha256Hex(expected))) {
    return new Response("Not found", { status: 404 });
  }
  const { results } = await env.DB.prepare(
    `SELECT b.*, v.name AS service_name FROM bookings b JOIN services v ON v.id = b.service_id
     WHERE b.status = 'confirmed' AND b.start_at >= ? ORDER BY b.start_at`,
  )
    .bind(Date.now() - 30 * 24 * HOUR)
    .all<Booking & { service_name: string }>();
  const ics = buildCalendar(
    results.map((b) => ({
      uid: `${b.id}@psychotherapieberger.at`,
      start: b.start_at,
      end: b.end_at,
      summary: `${b.service_name}: ${b.name}`,
      description: [kindLabel(b.session_kind), b.phone ? `Tel. ${b.phone}` : "", b.email].filter(Boolean).join("\n"),
      location: PRACTICE_ADDRESS,
    })),
    { name: "Praxis – Online-Buchungen" },
  );
  return new Response(ics, {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" },
  });
}
