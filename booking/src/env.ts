export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BOOKING_LIMITER: RateLimit;
  READ_LIMITER: RateLimit;
  LOGIN_LIMITER: RateLimit;

  ENVIRONMENT: "development" | "staging" | "production";
  EMAIL_MODE: "log" | "smtp";
  PUBLIC_BASE_URL: string;
  PRACTICE_EMAIL: string;
  MAIL_FROM: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  ALLOWED_ORIGINS: string;

  // Secrets (wrangler secret put / .dev.vars)
  ADMIN_PASSWORD_HASH: string;
  SESSION_SECRET: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
}

export interface Service {
  id: string;
  name: string;
  duration_min: number;
  price_eur: number;
  description: string;
  icon: string;
  sort_order: number;
  active: number;
}

export interface Slot {
  id: string;
  service_id: string;
  start_at: number;
  end_at: number;
  status: "available" | "booked";
  booking_id: string | null;
  created_at: number;
}

export interface Booking {
  id: string;
  slot_id: string;
  service_id: string;
  session_kind: "erstgespraech" | "folgetermin";
  start_at: number;
  end_at: number;
  name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  status: "confirmed" | "cancelled";
  cancelled_by: "client" | "admin" | null;
  cancelled_at: number | null;
  cancel_token_hash: string;
  consent_at: number;
  created_at: number;
}

export interface Settings {
  cancel_window_hours: number;
  min_notice_hours: number;
  booking_horizon_days: number;
  retention_days: number;
  max_bookings_per_day: number;
  calendar_feed_token: string | null;
}
