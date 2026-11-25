// The "add to calendar" file (ADR 0571): made by the gatekeeper from a message's `calendar`, valid
// iCalendar (RFC 5545), attached to the email only when the send is applied, shown to the approver
// in one line, and nothing else attachable.
import { env } from "cloudflare:workers";
import type { ActionField } from "@composable-os/gatekeeper-interface/gatekeeper";
import { beforeEach, describe, expect, it } from "vitest";
import { calendarFile, icsTime } from "../src/calendar";
import { isSignInCodeMessage } from "../src/sign-in";
import type { EmailSendReceipt } from "../src/types";
import { resetFakes, sentEmails, submissions } from "./fakes";

const SENDER_URL = "email-send://sender/crm%40example.com";
let seq = 0;

async function host() {
  seq += 1;
  const stub = env.TEST_HOST.getByName(`calendar-${seq}-${crypto.randomUUID()}`);
  await stub.open(SENDER_URL, {});
  return stub;
}

const event = {
  uid: "bkg_01ABC",
  start: "2026-10-05T19:00:00.000Z",
  end: "2026-10-05T20:00:00.000Z",
  title: "Strength, the Tuesday one; bring a towel",
  location: "Studio A",
  url: "https://gym.test/bookings",
};

const message = {
  to: ["ann@members.test"],
  subject: "Booked: Strength",
  text: "You are booked.",
  calendar: event,
};

/** The unfolded content lines of an .ics text, checking the line breaks are CRLF. */
function lines(ics: string): string[] {
  expect(ics.endsWith("\r\n")).toBe(true);
  expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  for (const line of ics.split("\r\n")) {
    expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
  }
  return ics.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
}

beforeEach(resetFakes);

describe("the calendar file", () => {
  it("is one valid event, in UTC, escaped, with a UID on the sender's domain", () => {
    const ics = calendarFile(
      event,
      { address: "crm@example.com", to: ["ann@members.test"] },
      new Date("2026-10-01T00:00:00Z"),
    );
    expect(lines(ics)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Composable OS//Calendar file//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:bkg_01ABC@example.com",
      "ORGANIZER:mailto:crm@example.com",
      "DTSTAMP:20261001T000000Z",
      "DTSTART:20261005T190000Z",
      "DTEND:20261005T200000Z",
      "SEQUENCE:0",
      "STATUS:CONFIRMED",
      "SUMMARY:Strength\\, the Tuesday one\\; bring a towel",
      "LOCATION:Studio A",
      "URL:https://gym.test/bookings",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
  });

  it("folds long lines at 75 octets without splitting a character, and cancels by uid", () => {
    const long = "Ünïcödé class ".repeat(12).trim();
    const ics = calendarFile(
      { ...event, title: long, description: "Line one\nLine two", sequence: 7, cancelled: true },
      { address: "crm@example.com", to: ["ann@members.test"] },
      new Date(),
    );
    const all = lines(ics);
    expect(all).toContain(`SUMMARY:${long}`);
    expect(all).toContain("DESCRIPTION:Line one\\nLine two");
    expect(all).toContain("METHOD:CANCEL");
    expect(all).toContain("STATUS:CANCELLED");
    expect(all).toContain("SEQUENCE:7");
    // RFC 5546: a CANCEL names its organizer and attendees.
    expect(all).toContain("ORGANIZER:mailto:crm@example.com");
    expect(all).toContain("ATTENDEE:mailto:ann@members.test");
    expect(icsTime("2026-04-05T06:30:00+10:00")).toBe("20260404T203000Z");
  });

  it("is never the host's sign-in mail", () => {
    const code = {
      to: ["a@customer.test"],
      subject: "Your Gym sign-in code",
      text: "Your sign-in code for Gym is 123456.\n\nIt works once and expires in five minutes. If you did not ask for it, ignore this email.",
    };
    expect(isSignInCodeMessage(code)).toBe(true);
    expect(isSignInCodeMessage({ ...code, calendar: event })).toBe(false);
  });
});

describe("a send with a calendar file", () => {
  it("shows the approver what it adds, and attaches the file only when applied", async () => {
    const h = await host();
    const { id } = (await h.call("send", [message])) as EmailSendReceipt;
    expect(sentEmails).toEqual([]);
    const fields = submissions[0]?.[1].fields as ActionField[] | undefined;
    expect(fields?.find((f) => f.label === "Calendar file")).toMatchObject({
      kind: "inline",
      value: `Adds "${event.title}" 2026-10-05T19:00:00.000Z to 2026-10-05T20:00:00.000Z at Studio A`,
    });
    // Everything the file will say is in front of the approver: its link and its description.
    expect(fields?.find((f) => f.label === "Calendar link")).toMatchObject({ value: event.url });
    await h.apply(id);
    expect(sentEmails).toHaveLength(1);
    const [attachment, ...others] = sentEmails[0]?.attachments ?? [];
    expect(others).toEqual([]);
    expect(attachment).toMatchObject({
      disposition: "attachment",
      filename: "invite.ics",
      type: "text/calendar; charset=utf-8; method=PUBLISH",
    });
    expect(lines(String(attachment?.content ?? ""))).toContain("UID:bkg_01ABC@example.com");
  });

  const bad: [string, Record<string, unknown>, RegExp][] = [
    ["an end before the start", { end: "2026-10-05T18:00:00.000Z" }, /end after it starts/],
    ["an event longer than a week", { end: "2026-10-15T18:00:00.000Z" }, /within 7 days/],
    ["a link that is not https", { url: "http://gym.test" }, /calendar\.url/],
    ["a uid that is not a record id", { uid: "x\r\nATTACH:evil" }, /calendar\.uid/],
    ["a title over two lines", { title: "a\r\nb" }, /calendar\.title/],
    ["a file of its own", { content: "BEGIN:VCALENDAR" }, /Unrecognized key/],
    ["a time that is not an instant", { start: "next Tuesday" }, /calendar\.start/],
    ["a control character in the title", { title: "Strength\u000bclass" }, /control characters/],
    ["a NUL in the description", { description: "Bring\u0000a towel" }, /control characters/],
  ];
  for (const [name, change, error] of bad) {
    it(`refuses ${name}`, async () => {
      const h = await host();
      await expect(
        h.call("send", [{ ...message, calendar: { ...event, ...change } }]),
      ).rejects.toThrow(error);
      expect(submissions).toEqual([]);
    });
  }

  it("shows the approver the calendar's description in full", async () => {
    const h = await host();
    const description = "Bring a towel.\nThe studio is upstairs.";
    await h.call("send", [{ ...message, calendar: { ...event, description } }]);
    const fields = submissions[0]?.[1].fields as ActionField[] | undefined;
    expect(fields?.find((f) => f.label === "Calendar description")).toMatchObject({
      value: description,
    });
  });

  it("refuses any attachment but the calendar", async () => {
    const h = await host();
    await expect(
      h.call("send", [{ ...message, attachments: [{ filename: "x.exe", content: "MZ" }] }]),
    ).rejects.toThrow(/Unrecognized key/);
  });
});

describe("an idempotency key (ADR 0574)", () => {
  it("answers a retried send with the first one's receipt and queues nothing more", async () => {
    const h = await host();
    const first = (await h.call("send", [
      { ...message, idempotencyKey: "run_1:0" },
    ])) as EmailSendReceipt;
    const again = (await h.call("send", [
      { ...message, idempotencyKey: "run_1:0" },
    ])) as EmailSendReceipt;
    expect(again).toEqual(first);
    expect(submissions).toHaveLength(1);
    // Another key is another email.
    await h.call("send", [{ ...message, idempotencyKey: "run_1:1" }]);
    expect(submissions).toHaveLength(2);
    // The key is not part of what the approver reads or what is sent.
    expect(JSON.stringify(submissions[0]?.[1])).not.toContain("run_1:0");
    await h.apply(first.id);
    expect(JSON.stringify(sentEmails[0])).not.toContain("idempotencyKey");
  });

  it("refuses a malformed key", async () => {
    const h = await host();
    await expect(h.call("send", [{ ...message, idempotencyKey: "has spaces" }])).rejects.toThrow(
      /idempotencyKey/,
    );
    expect(submissions).toEqual([]);
  });
});

describe("room for a day's emails waiting for approval (ADR 0573)", () => {
  it("holds more than the journal's default 50 sends pending", async () => {
    const h = await host();
    for (let i = 0; i < 60; i++) {
      const receipt = (await h.call("send", [
        { ...message, subject: `Booked ${i}`, idempotencyKey: `run_many:${i}` },
      ])) as EmailSendReceipt;
      expect(receipt.status).toBe("pending");
    }
    expect(submissions).toHaveLength(60);
  });
});
