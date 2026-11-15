import { getSettings, getService } from "./data";
import { clientReminderEmail, sendEmail, smtpTransport, type Transport } from "./email";
import { getEmailSettings } from "./email-settings";
import type { Booking, Env } from "./env";

const HOUR = 3_600_000;
/** No reminder if the booking was made shortly before the reminder would be due (the confirmation is still fresh). */
const MIN_GAP_AFTER_BOOKING = 6 * HOUR;

/**
 * Scheduled job: send the reminder e-mail for confirmed appointments starting within the next
 * `reminderHours`. Each booking is claimed atomically, so a reminder is sent at most once.
 */
export async function sendDueReminders(env: Env, now = Date.now(), transport: Transport = smtpTransport): Promise<number> {
  const cfg = await getEmailSettings(env);
  if (!cfg.enabled.client_reminder) return 0;
  const window = cfg.reminderHours * HOUR;
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings
     WHERE status = 'confirmed' AND reminder_sent_at IS NULL
       AND start_at > ? AND start_at <= ?
       AND created_at <= start_at - ?
     ORDER BY start_at LIMIT 50`,
  )
    .bind(now, now + window, window + MIN_GAP_AFTER_BOOKING)
    .all<Booking>();
  if (!results.length) return 0;

  const settings = await getSettings(env);
  let sent = 0;
  for (const booking of results) {
    const claim = await env.DB.prepare("UPDATE bookings SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL")
      .bind(now, booking.id)
      .run();
    if ((claim.meta.changes ?? 0) !== 1) continue;
    const service = await getService(env, booking.service_id);
    if (!service) continue;
    const deadline = booking.start_at - settings.cancel_window_hours * HOUR;
    await sendEmail(env, cfg, clientReminderEmail(cfg, booking, service, deadline, now), transport);
    sent++;
  }
  return sent;
}
