-- E-mail queue (retries, delivery log) and appointment reminders.
-- E-mail settings live in the existing settings table; defaults are defined in src/email-settings.ts.

ALTER TABLE email_log ADD COLUMN kind TEXT;
ALTER TABLE email_log ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
-- When the next delivery attempt is due (pending), or when a running attempt's lease expires (sending).
ALTER TABLE email_log ADD COLUMN next_attempt_at INTEGER;
-- Full message as JSON, kept only until it was delivered (needed for retries).
ALTER TABLE email_log ADD COLUMN payload TEXT;
ALTER TABLE email_log ADD COLUMN sent_at INTEGER;
CREATE INDEX idx_email_log_due ON email_log (status, next_attempt_at);

ALTER TABLE bookings ADD COLUMN reminder_sent_at INTEGER;
