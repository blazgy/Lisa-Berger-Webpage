import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth";
import { escapeHtml } from "../src/http";
import { buildCalendar } from "../src/ics";
import { addDays, formatViennaLong, isoWeekday, mondayOf, viennaDate, viennaTime, viennaToUtc } from "../src/time";
import { validateEmail, validateName, validatePhone } from "../src/validate";

describe("Vienna time conversion", () => {
  it("handles winter time (UTC+1)", () => {
    expect(new Date(viennaToUtc("2027-01-12", "10:00")).toISOString()).toBe("2027-01-12T09:00:00.000Z");
  });

  it("handles summer time (UTC+2)", () => {
    expect(new Date(viennaToUtc("2027-07-12", "10:00")).toISOString()).toBe("2027-07-12T08:00:00.000Z");
  });

  it("handles the DST switch days", () => {
    // 2027-03-28: clocks go forward at 02:00 local; 2027-10-31: back at 03:00 local.
    expect(new Date(viennaToUtc("2027-03-28", "09:00")).toISOString()).toBe("2027-03-28T07:00:00.000Z");
    expect(new Date(viennaToUtc("2027-10-31", "09:00")).toISOString()).toBe("2027-10-31T08:00:00.000Z");
  });

  it("round-trips date and time", () => {
    const t = viennaToUtc("2027-05-03", "16:30");
    expect(viennaDate(t)).toBe("2027-05-03");
    expect(viennaTime(t)).toBe("16:30");
  });

  it("rejects impossible dates", () => {
    expect(() => viennaToUtc("2027-02-30", "10:00")).toThrow();
    expect(() => viennaToUtc("2027-01-01", "24:00")).toThrow();
  });

  it("computes weekdays and Mondays", () => {
    expect(isoWeekday("2026-11-10")).toBe(2); // Tuesday
    expect(mondayOf("2026-11-15")).toBe("2026-11-09"); // Sunday -> previous Monday
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("formats dates in Austrian German", () => {
    expect(formatViennaLong(viennaToUtc("2027-01-12", "10:00"))).toMatch(/Jänner 2027, 10:00 Uhr$/);
  });
});

describe("helpers", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
  });

  it("verifies PBKDF2 passwords", async () => {
    const hash = await hashPassword("correct horse battery", 1000);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", undefined)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("validates contact fields", () => {
    expect(validateName("  Anna   Müller-Öz ")).toBe("Anna Müller-Öz");
    expect(() => validateName("<b>Bob</b>")).toThrow();
    expect(validateEmail("Anna@Example.AT")).toBe("anna@example.at");
    expect(() => validateEmail("anna@example")).toThrow();
    expect(() => validateEmail("a@b.com\r\nBcc: x@y.com")).toThrow();
    expect(validatePhone("+43 677 631 426 87")).toBe("+43 677 631 426 87");
    expect(validatePhone("")).toBeNull();
    expect(() => validatePhone("call me")).toThrow();
  });

  it("builds valid, folded and escaped iCalendar data", () => {
    const ics = buildCalendar([
      {
        uid: "abc@test",
        start: Date.UTC(2027, 0, 12, 9),
        end: Date.UTC(2027, 0, 12, 9, 50),
        summary: "Psychotherapie; Termin, Lisa",
        description: "Zeile 1\nZeile 2 " + "x".repeat(120),
      },
    ]);
    expect(ics).toContain("DTSTART:20270112T090000Z");
    expect(ics).toContain("SUMMARY:Psychotherapie\\; Termin\\, Lisa");
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
