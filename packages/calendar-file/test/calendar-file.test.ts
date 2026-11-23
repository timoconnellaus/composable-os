// The shared iCalendar writer (ADR 0628, amending ADR 0571): valid RFC 5545 whatever text it is
// given, folded at 75 octets, CRLF, escaped, UTC times across a clock change, and the same bytes
// for the same values. The email file's own tests (packages/gatekeeper-email-send/test/
// calendar.test.ts) hold its lines unchanged.
import { describe, expect, it } from "vitest";
import { type CalendarEvent, escapeText, fold, icsTime, writeCalendar } from "../src/index.ts";

const event: CalendarEvent = {
  uid: "shf_01ABC@host.test",
  stamp: "2026-10-01T00:00:00.000Z",
  start: "2026-10-05T19:00:00.000Z",
  end: "2026-10-05T20:00:00.000Z",
  title: "Cleaning",
  location: "Studio A",
};

/**
 * A strict reading of the text as RFC 5545 content lines: CRLF only, no line over 75 octets,
 * unfolded, every line `NAME[;PARAM=VALUE]:value`, components balanced. Answers the unfolded lines.
 */
function parse(ics: string): string[] {
  expect(ics.endsWith("\r\n")).toBe(true);
  expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  for (const line of ics.split("\r\n")) {
    expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
  }
  const lines = ics
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter(Boolean);
  const stack: string[] = [];
  for (const line of lines) {
    expect(line).toMatch(/^[A-Z][A-Z0-9-]*(;[A-Z0-9-]+=[^;:]+)*:/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: no control character may survive.
    expect(line).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f]/);
    if (line.startsWith("BEGIN:")) stack.push(line.slice(6));
    if (line.startsWith("END:")) expect(stack.pop()).toBe(line.slice(4));
  }
  expect(stack).toEqual([]);
  return lines;
}

describe("the calendar writer", () => {
  it("writes a feed of several events, named, with a refresh hint, in UTC", () => {
    const lines = parse(
      writeCalendar({
        prodId: "-//Composable OS//Staff calendar feed//EN",
        method: "PUBLISH",
        name: "Shifts",
        refresh: "PT1H",
        events: [
          event,
          { ...event, uid: "shf_02@host.test", lastModified: "2026-09-30T10:00:00Z" },
        ],
      }),
    );
    expect(lines.slice(0, 9)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Composable OS//Staff calendar feed//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "NAME:Shifts",
      "X-WR-CALNAME:Shifts",
      "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
      "X-PUBLISHED-TTL:PT1H",
    ]);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines).toContain("UID:shf_01ABC@host.test");
    expect(lines).toContain("DTSTART:20261005T190000Z");
    expect(lines).toContain("LAST-MODIFIED:20260930T100000Z");
    expect(lines).toContain("STATUS:CONFIRMED");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
  });

  it("no text can end its line: CR, LF and other control characters never start a property", () => {
    const evil =
      "Clean\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:x\nATTACH:http://x\rDTSTART:1\u0000\u0007\u001b\u007f";
    const ics = writeCalendar({
      prodId: "-//x//y//EN\r\nX-EVIL:1",
      name: evil,
      events: [
        {
          ...event,
          uid: "id\r\nATTACH:evil",
          title: evil,
          location: evil,
          description: evil,
          organizer: "a@b.test\r\nATTENDEE:mailto:c@d.test",
          attendees: ["e@f.test\nX:1"],
          url: "https://x.test/\r\nX-EVIL:1",
        },
      ],
    });
    const lines = parse(ics);
    // One event, one of each property: the injected ones are text inside a value.
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("UID:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("DTSTART:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("ATTACH"))).toHaveLength(0);
    expect(lines.filter((l) => l.startsWith("X-EVIL"))).toHaveLength(0);
    expect(lines.filter((l) => l.startsWith("ATTENDEE"))).toHaveLength(1);
    expect(lines).toContain(
      "SUMMARY:Clean\\nEND:VEVENT\\nBEGIN:VEVENT\\nUID:x\\nATTACH:http://x\\nDTSTART:1",
    );
  });

  it("escapes backslash, semicolon, comma and newlines, and keeps a tab", () => {
    expect(escapeText("a\\b;c,d\ne\tf")).toBe("a\\\\b\\;c\\,d\\ne\tf");
  });

  it("folds at 75 octets without splitting a character", () => {
    const long = `SUMMARY:${"Ünïcödé ✓ 日本 ".repeat(20)}`;
    const folded = fold(long);
    for (const part of folded.split("\r\n")) {
      expect(new TextEncoder().encode(part).byteLength).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("writes the instant, whatever the offset it was given in, across a clock change", () => {
    // Sydney's clocks went forward on 2026-10-04 at 02:00: 06:00 local is 19:00Z before, 20:00Z after.
    expect(icsTime("2026-10-03T06:00:00+10:00")).toBe("20261002T200000Z");
    expect(icsTime("2026-10-05T06:00:00+11:00")).toBe("20261004T190000Z");
    expect(() => icsTime("next Tuesday")).toThrow(TypeError);
  });

  it("is deterministic, and refuses a bad sequence or refresh interval", () => {
    const one = writeCalendar({ prodId: "-//x//y//EN", events: [event] });
    expect(writeCalendar({ prodId: "-//x//y//EN", events: [event] })).toBe(one);
    expect(() => writeCalendar({ prodId: "x", events: [{ ...event, sequence: -1 }] })).toThrow();
    expect(() => writeCalendar({ prodId: "x", refresh: "1 hour", events: [] })).toThrow();
  });

  it("writes an empty calendar as a valid one", () => {
    expect(parse(writeCalendar({ prodId: "-//x//y//EN", events: [] }))).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//x//y//EN",
      "CALSCALE:GREGORIAN",
      "END:VCALENDAR",
    ]);
  });
});
