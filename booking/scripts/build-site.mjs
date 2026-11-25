// Copies the public website (repo root) plus the booking pages into ./.site for the Worker.
// Only an explicit allowlist is published, so docs, configs and git data never go online.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIconsScript, checkIconNames } from "./icons.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bookingDir = join(here, "..");
const siteRoot = join(bookingDir, "..");
const out = join(bookingDir, ".site");

const ROOT_FILES = [
  "index.html",
  "styles.css",
  "robots.txt",
  "sitemap.xml",
  "site.webmanifest",
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "berger-logo.svg",
  "lisa-vector.svg",
];
const ROOT_PATTERNS = [/^Lisa.*\.(avif|webp)$/];

if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });
for (const file of readdirSync(siteRoot)) {
  if (ROOT_FILES.includes(file) || ROOT_PATTERNS.some((re) => re.test(file))) {
    cpSync(join(siteRoot, file), join(out, file));
  }
}
// Self-hosted web fonts
cpSync(join(siteRoot, "fonts"), join(out, "fonts"), { recursive: true });
// Booking front-end files (booking.js, booking.css, admin.html, termin.html, …)
cpSync(join(bookingDir, "public"), out, { recursive: true });
// Icon subset (replaces the Lucide CDN); fails if a page uses an icon that is not in the subset
checkIconNames(
  readdirSync(out).filter((f) => /\.(html|js)$/.test(f)).map((f) => readFileSync(join(out, f), "utf8")),
);
writeFileSync(join(out, "icons.js"), buildIconsScript());
console.log("Site built into", out);
