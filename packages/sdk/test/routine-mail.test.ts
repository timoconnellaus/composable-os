// Routine mail's declaration (ADR 0590): the contract refuses words that hold a link or an address,
// slots that are not declared, a slot that may be empty outside an optional part, paths that leave
// the extension's own objects, and the host fills or checks everything else. The templates render
// with optional parts left out when their slot is empty, and a value with a link, an address,
// markup or a hidden character is never routine.
import { describe, expect, it } from "vitest";
import {
  formatMoment,
  parseTemplate,
  renderTemplate,
  unroutineText,
  validateManifest,
} from "../src/index.ts";

function gym(routineMail: object, modules = ["ops", "routine-mail"]) {
  return {
    id: "gym",
    version: "1.0.0",
    contractVersion: 1,
    permissions: { modules },
    settings: {
      url: { type: "text", label: "Bookings page" },
      size: { type: "number", label: "N" },
    },
    objects: {
      room: {
        label: "Room",
        plural: "Rooms",
        titleField: "name",
        fields: { name: { type: "text", label: "Name", required: true } },
      },
      class: {
        label: "Class",
        plural: "Classes",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          startsAt: { type: "datetime", label: "Starts" },
          zone: { type: "timezone", label: "Zone" },
          room: { type: "relation", label: "Room", to: "gym.room" },
          coachEmail: { type: "email", label: "Coach's email" },
          owner: { type: "relation", label: "Owner", to: "person" },
        },
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          class: { type: "relation", label: "Class", to: "gym.class" },
          person: { type: "relation", label: "Person", to: "person" },
        },
      },
    },
    routineMail,
  };
}

const kind = (over: object = {}) => ({
  label: "Confirmations",
  description: "When a booking is made.",
  about: "booking",
  slots: {
    class: { field: "class.title" },
    when: { field: "class.startsAt", format: "datetime", zone: "class.zone" },
    room: { field: "class.room.name", optional: true },
    link: { link: "url" },
  },
  messages: {
    booked: {
      subject: "Booked: {class}",
      text: "You are booked into {class} on {when}[, in {room}].\n[Your bookings: {link}]",
      guardian: { subject: "Booked: {class} ({member})", text: "{member} is booked into {class}." },
    },
  },
  ...over,
});

const issues = (routineMail: object, modules?: string[]) =>
  validateManifest(gym(routineMail, modules)).issues.map((i) => `${i.path}: ${i.message}`);

describe("the declaration", () => {
  it("accepts a kind whose words are fixed and whose slots the host fills", () => {
    expect(issues({ confirmation: kind() })).toEqual([]);
  });

  it("needs the routine-mail module, and the module needs a declaration", () => {
    expect(issues({ confirmation: kind() }, ["ops"]).join("\n")).toMatch(/routine-mail/);
    expect(issues({}, ["ops", "routine-mail"]).join("\n")).toMatch(
      /sends routine mail it declares/,
    );
  });

  it("refuses words that hold a link, an address or markup", () => {
    for (const text of [
      "Pay at https://evil.test now",
      "Visit www.evil.test",
      "Write to help@evil.test",
      "See evil.com for more",
      "<b>Hi</b>",
    ]) {
      const found = issues({
        confirmation: kind({ messages: { booked: { subject: "Booked", text } } }),
      });
      expect(found.join("\n"), text).toMatch(/link, an address or markup/);
    }
    const choice = issues({
      confirmation: kind({
        slots: { why: { choice: { a: "Claim it at https://evil.test" } } },
        messages: { booked: { subject: "Booked", text: "{why}" } },
      }),
    });
    expect(choice.join("\n")).toMatch(/link, an address or markup/);
  });

  it("refuses a slot it does not declare, and the member's name outside a guardian's email", () => {
    expect(
      issues({
        confirmation: kind({ messages: { booked: { subject: "{nope}", text: "Hi {member}" } } }),
      }).join("\n"),
    ).toMatch(/\{nope\} is not a slot[\s\S]*\{member\} is only for what a guardian is sent/);
  });

  it("puts a value that may be empty (a link, a flag, an optional field) only in an optional part", () => {
    expect(
      issues({
        confirmation: kind({
          messages: { booked: { subject: "Booked", text: "Your bookings: {link} in {room}" } },
        }),
      }).join("\n"),
    ).toMatch(/\{link\} may be empty[\s\S]*\{room\} may be empty/);
  });

  it("reads only this extension's own objects, and never an address field", () => {
    const found = issues({
      confirmation: kind({
        slots: {
          owner: { field: "class.owner.displayName" },
          coach: { field: "class.coachEmail" },
          missing: { field: "class.nothing" },
        },
        messages: { booked: { subject: "{owner}", text: "{coach} {missing}" } },
      }),
    }).join("\n");
    expect(found).toMatch(/class\.owner is not a relation to one of this extension's objects/);
    expect(found).toMatch(/A email field cannot be written as text/);
    expect(found).toMatch(/class\.nothing is not a field/);
  });

  it("is about one of the extension's objects, or an order; a link is one of its text settings", () => {
    expect(issues({ confirmation: kind({ about: "person" }) }).join("\n")).toMatch(
      /not an object of this extension, nor order/,
    );
    expect(
      issues({ confirmation: kind({ slots: { link: { link: "size" } } }) }).join("\n"),
    ).toMatch(/not a text setting/);
  });
});

describe("rendering", () => {
  it("fills slots and leaves out an optional part whose slot is empty, and a line left empty", () => {
    const template = "You are booked into {class}[, in {room}].\n[Your bookings: {link}]\nBye";
    expect(
      renderTemplate(template, { class: "Yoga", room: "Studio", link: "https://g.test/b" }),
    ).toBe("You are booked into Yoga, in Studio.\nYour bookings: https://g.test/b\nBye");
    expect(renderTemplate(template, { class: "Yoga", room: null, link: null })).toBe(
      "You are booked into Yoga.\nBye",
    );
  });

  it("never reads a slot's value as a template", () => {
    expect(renderTemplate("Hi {name}", { name: "{link} [x]" })).toBe("Hi {link} [x]");
  });

  it("reports a template that cannot be parsed", () => {
    expect(parseTemplate("a [b [c] d]").error).toMatch(/cannot hold another/);
    expect(parseTemplate("a {b").error).toMatch(/not a slot name/);
    expect(parseTemplate("a [b").error).toMatch(/not closed/);
  });

  it("writes a moment in the class's own zone", () => {
    expect(formatMoment("2026-12-07T19:00:00.000Z", "Australia/Sydney", "datetime")).toBe(
      "Tuesday 8 December at 06:00 (Australia/Sydney time)",
    );
    expect(formatMoment("2026-12-07T19:00:00.000Z", "Australia/Sydney", "time")).toBe("06:00");
  });
});

describe("what a value may hold", () => {
  it("allows a plain name or title", () => {
    for (const value of ["Strength", "Kai O'Neill", "Yoga & Pilates: level 2", "5.30pm HIIT"]) {
      expect(unroutineText(value, 120), value).toBeNull();
    }
  });

  it("refuses a link, an address, markup, hidden characters and anything too long", () => {
    for (const value of [
      "Visit https://evil.test",
      "Visit http://evil.test",
      "www.evil.test",
      "evil.com",
      "evil。com",
      "Sam (sam@evil.test)",
      "<a href=x>Sam</a>",
      "Sam\nClick here",
      "Sam‮etis.live",
      "Sam​",
      "xn--80ak6aa92e",
      "[Click](x)",
      "x".repeat(121),
    ]) {
      expect(unroutineText(value, 120), value).not.toBeNull();
    }
  });
});
