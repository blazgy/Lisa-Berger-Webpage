/** Minimal RFC 5545 calendar generation. */

export interface IcsEvent {
  uid: string;
  start: number;
  end: number;
  summary: string;
  description?: string;
  location?: string;
  status?: "CONFIRMED" | "CANCELLED";
  sequence?: number;
}

export const PRACTICE_ADDRESS = "Stadtplatz 36/25, 4840 Vöcklabruck (Galerie Burgstall, 3. Stock)";

function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold lines longer than 75 octets (UTF-8 aware). */
function fold(line: string): string {
  const bytes = new TextEncoder();
  if (bytes.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  for (const ch of line) {
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes.encode(current + ch).length > limit) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.join("\r\n ");
}

export function buildCalendar(events: IcsEvent[], opts: { name?: string; method?: "PUBLISH" | "CANCEL" } = {}): string {
  const now = icsDate(Date.now());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Praxis Lisa Berger//Terminbuchung//DE",
    "CALSCALE:GREGORIAN",
    `METHOD:${opts.method ?? "PUBLISH"}`,
  ];
  if (opts.name) lines.push(`X-WR-CALNAME:${escapeText(opts.name)}`, "X-WR-TIMEZONE:Europe/Vienna");
  for (const ev of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.uid}`,
      `DTSTAMP:${now}`,
      `DTSTART:${icsDate(ev.start)}`,
      `DTEND:${icsDate(ev.end)}`,
      `SUMMARY:${escapeText(ev.summary)}`,
      `STATUS:${ev.status ?? "CONFIRMED"}`,
      `SEQUENCE:${ev.sequence ?? 0}`,
    );
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
