-- Booking system schema. All timestamps are UTC epoch milliseconds.

CREATE TABLE services (
  id           TEXT PRIMARY KEY,
  name         TEXT    NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 10 AND 240),
  price_eur    INTEGER NOT NULL CHECK (price_eur >= 0),
  description  TEXT    NOT NULL DEFAULT '',
  icon         TEXT    NOT NULL DEFAULT 'user',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1
);

INSERT INTO services (id, name, duration_min, price_eur, description, icon, sort_order) VALUES
  ('psychotherapie', 'Psychotherapie', 50, 90,  'Einzeltherapie für Jugendliche und Erwachsene', 'user',  1),
  ('paartherapie',   'Paartherapie',   90, 190, 'Paar- und Partner*innentherapie',               'users', 2),
  ('spieltherapie',  'Spieltherapie',  50, 90,  'Personzentrierte Spieltherapie für Kinder',     'puzzle', 3);

CREATE TABLE slots (
  id         TEXT PRIMARY KEY,
  service_id TEXT    NOT NULL REFERENCES services(id),
  start_at   INTEGER NOT NULL,
  end_at     INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'booked')),
  booking_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_slots_status_start ON slots (status, start_at);
CREATE INDEX idx_slots_start_end ON slots (start_at, end_at);

CREATE TABLE bookings (
  id                TEXT PRIMARY KEY,
  slot_id           TEXT    NOT NULL,
  service_id        TEXT    NOT NULL,
  session_kind      TEXT    NOT NULL CHECK (session_kind IN ('erstgespraech', 'folgetermin')),
  start_at          INTEGER NOT NULL,
  end_at            INTEGER NOT NULL,
  name              TEXT    NOT NULL,
  email             TEXT    NOT NULL,
  phone             TEXT,
  notes             TEXT,
  status            TEXT    NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  cancelled_by      TEXT CHECK (cancelled_by IN ('client', 'admin')),
  cancelled_at      INTEGER,
  cancel_token_hash TEXT    NOT NULL,
  consent_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
-- A slot can only ever have one confirmed booking.
CREATE UNIQUE INDEX idx_bookings_confirmed_slot ON bookings (slot_id) WHERE status = 'confirmed';
CREATE UNIQUE INDEX idx_bookings_token ON bookings (cancel_token_hash);
CREATE INDEX idx_bookings_start ON bookings (start_at);

CREATE TABLE template_items (
  id         TEXT PRIMARY KEY,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- 1 = Monday
  time       TEXT    NOT NULL,                                -- HH:MM, Vienna local time
  service_id TEXT    NOT NULL REFERENCES services(id)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('cancel_window_hours', '48'),
  ('min_notice_hours', '24'),
  ('booking_horizon_days', '90'),
  ('retention_days', '90');

CREATE TABLE email_log (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  to_addr    TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  body_html  TEXT,
  status     TEXT    NOT NULL,
  error      TEXT
);
CREATE INDEX idx_email_log_created ON email_log (created_at);
