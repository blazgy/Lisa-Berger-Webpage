# Online-Terminbuchung (Cloudflare)

Replaces the earlier Firebase prototype (`booking-dev` branch). One Cloudflare Worker serves the
website plus the booking API; data lives in a D1 database restricted to the **EU jurisdiction**.

```
booking/
  src/            Worker (TypeScript): API, admin auth, e-mails, .ics, cleanup cron
  migrations/     D1 schema + seed data (services, default rules)
  public/         booking.js/.css (modal on index.html), termin.html (client self-service),
                  admin.html/.js/.css (Praxis-Dashboard)
  scripts/        build-site.mjs (copies the allow-listed site files into .site/), hash-password.mjs
  test/           Vitest tests running inside the Workers runtime
```

## Features

- Psychotherapie, Paartherapie, Spieltherapie – names, duration, price and "online bookable" editable in the dashboard
- Erstgespräch or Folgetermin chosen by the client
- Client confirmation e-mail with `.ics` attachment and a private link to view/cancel (`termin.html`)
- Self-service cancellation until a configurable number of hours before the appointment (default 48 h)
- Practice notification e-mails, admin cancellation (optionally re-releasing the slot)
- Weekly template applied to 1–12 weeks, overlap protection, atomic double-booking protection
- Private iCal subscription feed for the practice calendar + per-booking `.ics` download
- Cloudflare Turnstile, per-IP rate limits, escaped e-mail content, CSP/noindex headers
- Automatic deletion of booking data N days after the appointment (default 90)

## Local development

```bash
cd booking
npm install
npm run hash-password            # → put the output into .dev.vars as ADMIN_PASSWORD_HASH='…'
# .dev.vars also needs SESSION_SECRET='<32+ random chars>' and
# TURNSTILE_SECRET='1x0000000000000000000000000000000AA' (Cloudflare test key)
npm run db:migrate:local
npm run dev                      # http://localhost:8787 (admin: /admin.html)
npm test
```

In development and staging `EMAIL_MODE` is `log`: e-mails are not sent but shown in the dashboard
("E-Mail-Ausgang").

## Staging

`https://lisa-berger-booking-staging.blazgyoha.workers.dev` – separate Worker and database
(`lisa-berger-booking-staging`, jurisdiction `eu`), `noindex`, visible "TESTUMGEBUNG" badge.

```bash
npm run db:migrate:staging
npm run deploy:staging
npx wrangler secret put ADMIN_PASSWORD_HASH --env staging   # to change the staging password
```

## Going live – checklist

1. Decide where production runs (Lisa's own Cloudflare account is recommended for GDPR – she is the controller).
2. Create the production D1 with `--jurisdiction eu`, add an `env.production` block (copy of staging with `ENVIRONMENT: "production"`, `EMAIL_MODE: "smtp"`).
3. Create a real Turnstile widget for the production hostname; set `TURNSTILE_SITE_KEY` (var) and `TURNSTILE_SECRET` (secret).
4. Secrets: `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `SMTP_USER`, `SMTP_PASSWORD` (netcup mailbox).
5. Hosting: either move the domain's DNS to Cloudflare and serve the whole site from the Worker, or keep netcup
   for the site, run the API on a subdomain and set `ALLOWED_ORIGINS` + `data-api` on the `booking.js` script tag.
6. Review/approve the Datenschutzerklärung text, sign the DPAs (Cloudflare, netcup).
