import type { Booking, Env, Service, Settings, Slot } from "./env";
import { HttpError, newId } from "./http";

const NUMERIC_SETTINGS = {
  cancel_window_hours: { min: 0, max: 336, fallback: 48 },
  min_notice_hours: { min: 0, max: 336, fallback: 24 },
  booking_horizon_days: { min: 7, max: 365, fallback: 90 },
  retention_days: { min: 7, max: 3650, fallback: 90 },
} as const;
export type NumericSettingKey = keyof typeof NUMERIC_SETTINGS;
export const NUMERIC_SETTING_KEYS = Object.keys(NUMERIC_SETTINGS) as NumericSettingKey[];

export function settingBounds(key: NumericSettingKey) {
  return NUMERIC_SETTINGS[key];
}

export async function getSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const out = { calendar_feed_token: map.get("calendar_feed_token") ?? null } as Settings;
  for (const key of NUMERIC_SETTING_KEYS) {
    const n = Number(map.get(key));
    out[key] = Number.isFinite(n) ? n : NUMERIC_SETTINGS[key].fallback;
  }
  return out;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, value)
    .run();
}

export async function listServices(env: Env, onlyActive: boolean): Promise<Service[]> {
  const sql = `SELECT * FROM services ${onlyActive ? "WHERE active = 1" : ""} ORDER BY sort_order, name`;
  return (await env.DB.prepare(sql).all<Service>()).results;
}

export async function getService(env: Env, id: string): Promise<Service | null> {
  return env.DB.prepare("SELECT * FROM services WHERE id = ?").bind(id).first<Service>();
}

export async function getBooking(env: Env, id: string): Promise<Booking | null> {
  return env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first<Booking>();
}

export async function getBookingByTokenHash(env: Env, hash: string): Promise<Booking | null> {
  return env.DB.prepare("SELECT * FROM bookings WHERE cancel_token_hash = ?").bind(hash).first<Booking>();
}

export async function hasOverlap(env: Env, start: number, end: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM slots WHERE start_at < ? AND end_at > ? LIMIT 1")
    .bind(end, start)
    .first();
  return row !== null;
}

/** Create one available slot; rejects past times and overlaps with any existing slot. */
export async function createSlot(env: Env, service: Service, start: number): Promise<Slot> {
  if (start <= Date.now()) throw new HttpError(400, "Der Termin liegt in der Vergangenheit.", "past");
  const end = start + service.duration_min * 60_000;
  if (await hasOverlap(env, start, end)) {
    throw new HttpError(409, "Dieser Termin überschneidet sich mit einem bestehenden Slot.", "overlap");
  }
  const slot: Slot = {
    id: newId(),
    service_id: service.id,
    start_at: start,
    end_at: end,
    status: "available",
    booking_id: null,
    created_at: Date.now(),
  };
  await env.DB.prepare(
    "INSERT INTO slots (id, service_id, start_at, end_at, status, booking_id, created_at) VALUES (?, ?, ?, ?, 'available', NULL, ?)",
  )
    .bind(slot.id, slot.service_id, slot.start_at, slot.end_at, slot.created_at)
    .run();
  return slot;
}

/**
 * Cancel a confirmed booking. Optionally makes the slot bookable again (only if it is
 * still in the future). Returns false if the booking was not in the confirmed state.
 */
export async function cancelBooking(
  env: Env,
  booking: Booking,
  by: "client" | "admin",
  releaseSlot: boolean,
): Promise<boolean> {
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      "UPDATE bookings SET status = 'cancelled', cancelled_by = ?, cancelled_at = ? WHERE id = ? AND status = 'confirmed'",
    ).bind(by, now, booking.id),
  ];
  if (releaseSlot && booking.start_at > now) {
    statements.push(
      env.DB.prepare("UPDATE slots SET status = 'available', booking_id = NULL WHERE id = ? AND booking_id = ?").bind(
        booking.slot_id,
        booking.id,
      ),
    );
  } else {
    // Remove the slot so the time is not offered again (e.g. the practice is closed).
    statements.push(
      env.DB.prepare("DELETE FROM slots WHERE id = ? AND booking_id = ?").bind(booking.slot_id, booking.id),
    );
  }
  const results = await env.DB.batch(statements);
  return (results[0].meta.changes ?? 0) === 1;
}
