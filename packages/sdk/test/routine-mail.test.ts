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
  textSegments,
  unroutineText,
  validateManifest,
  wrapText,
} from "../src/index.ts";

function gym(routineMail: object, modules = ["ops", "routine-mail"]) {
  return {
    id: "gym",
    version: "1.0.0",
    contractVersion: 1,
    permissions: { modules },
    settings: {
      url: { type: "text", label: "Bookings page", personApproves: true },
      plain: { type: "text", label: "A page anyone may change" },
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
          health: { type: "text", label: "Health note" },
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
      guest: {
        label: "Guest",
        plural: "Guests",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          booking: { type: "relation", label: "Booking", to: "gym.booking" },
          bookingSet: { type: "relation", label: "Booking", to: "gym.booking", readOnly: true },
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

  it("a link's setting is one a person approves, and an each slot's lines are tied by a host-set field (the fourth review)", () => {
    expect(
      issues({ confirmation: kind({ slots: { link: { link: "plain" } } }) }).join("\n"),
    ).toMatch(/"plain" must be a setting a person approves/);
    const each = (via: string) =>
      kind({
        slots: {
          guests: {
            each: {
              object: "guest",
              via,
              max: 5,
              line: "- {name}",
              slots: { name: { field: "name" } },
            },
          },
        },
        messages: { booked: { subject: "Booked", text: "Guests:\n{guests}" } },
      });
    expect(issues({ confirmation: each("booking") }).join("\n")).toMatch(
      /guest\.booking must be readOnly/,
    );
    expect(issues({ confirmation: each("bookingSet") }).join("\n")).not.toMatch(/readOnly/);
    // An empty value picking a line would go unchecked (the fifth review): refused.
    const picked = (values: string[]) =>
      kind({
        slots: {
          guests: {
            each: {
              object: "guest",
              via: "bookingSet",
              where: { field: "name", in: values },
              max: 5,
              line: "- {name}",
              slots: { name: { field: "name" } },
            },
          },
        },
        messages: { booked: { subject: "Booked", text: "Guests:\n{guests}" } },
      });
    expect(issues({ confirmation: picked(["a", ""]) }).join("\n")).toMatch(
      /where\.in cannot hold an empty value/,
    );
    expect(issues({ confirmation: picked(["a"]) }).join("\n")).not.toMatch(/empty value/);
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
    for (const value of [
      "Strength",
      "Kai O'Neill",
      "Yoga & Pilates: level 2",
      "5.30pm HIIT",
      "Ring work 2",
      "St John's Hall, Studio 3",
      "Data and text in 10 minutes",
      // The second review: ordinary names with a dot are not links.
      "St. John's Hall",
      "Mr. Smith",
      "Dr. Who",
      "Box.Fit",
      "U.S. Open prep",
      "Studio 2.West",
      "Hall St.Kilda",
    ]) {
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
      // The review of PR #267 (B2): phone numbers and instructions to call, spelled-out and
      // look-alike dots, defanged links, IP addresses, schemes, blank and direction characters.
      "Strength - CANCELLED call 0400 123 456 for your refund",
      "Refunds: 0400123456",
      "+61 2 9876 5432",
      "Text 0400 111 for a free class",
      "Visit evil . com",
      "evil(dot)com",
      "evil [.] com",
      "evil dot com",
      "hxxps evil",
      "Studio at 10.0.0.1",
      "Pay\u2024com",
      "Room\u00b7info",
      "mailto:someone",
      "tel:0400",
      "javascript:alert",
      "Sam\u2028Reply now",
      "Sam\u2029x",
      "Sam\u3164",
      "Sam\u202aX",
      "Sam\u2066X",
      // The second review: what the first filter missed.
      "call zero four zero zero one two three",
      "WhatsApp gymhelp",
      "Signal me: gymhelp",
      "Telegram @gymhelp",
      "Visit gymhelp dot xyz",
      "gymhelp,com",
      "gymhelp com",
      "bit ly slash refund",
      "https colon slash slash gymhelp",
      "gymhelp.c0m",
      "gymhelp\u0589com",
      "gymhelp\u06d4com",
      "gymhelp\ua4f8com",
      "gymhelp\u2e33com",
      "gymhelp\u2022com",
      "gymhelp\u2e31com",
    ]) {
      expect(unroutineText(value, 120), value).not.toBeNull();
    }
  });
});

// Routine messages (ADR 0670, stage 30 acceptance criterion 5): text and push words use only
// declared slots and fit with every slot at its longest; a push shows nothing private, no link and
// no list; a follow-up is never essential; and none of it is a runtime extension's (that refusal
// is `outsideDeclarations`, tested in packages/core/test/routine-mail.test.ts).
describe("text and push words", () => {
  const phone = (over: object = {}, message: object = {}) =>
    kind({
      channels: ["email", "text", "push"],
      until: "class.startsAt",
      open: { screen: "timetable" },
      slots: {
        class: { field: "class.title", max: 40 },
        time: { field: "class.startsAt", format: "time", zone: "class.zone" },
        day: { field: "class.startsAt", format: "date", zone: "class.zone" },
        room: { field: "class.room.name", optional: true },
        link: { link: "url" },
        health: { field: "class.health", private: true },
        long: { field: "class.title" },
      },
      messages: {
        booked: {
          subject: "Booked: {class}",
          text: "You are booked into {class}.",
          textMessage: "Booked: {class}, {day} at {time}[, in {room}].",
          push: { title: "Booked for {day}", body: "{class} at {time}." },
          ...message,
        },
      },
      ...over,
    });

  it("accepts words that fit, with the business's name and the stop line counted in", () => {
    expect(issues({ confirmation: phone() })).toEqual([]);
  });

  it("counts a text in segments: 160 plain characters in one, 153 a segment after; 70 and 67 in the longer encoding", () => {
    expect(textSegments("a".repeat(160))).toEqual({ encoding: "gsm", units: 160, segments: 1 });
    expect(textSegments("a".repeat(306)).segments).toBe(2);
    expect(textSegments("a".repeat(307)).segments).toBe(3);
    expect(textSegments("€".repeat(80))).toEqual({ encoding: "gsm", units: 160, segments: 1 });
    expect(textSegments("ł".repeat(70))).toEqual({ encoding: "ucs2", units: 70, segments: 1 });
    expect(textSegments("ł".repeat(134)).segments).toBe(2);
    expect(wrapText("A Very Long Business Name That Goes On", "Booked – see you")).toBe(
      "A Very Long Business Name That: Booked - see you Reply STOP to stop",
    );
  });

  it("refuses text words that could exceed two segments", () => {
    const found = issues({
      confirmation: phone({}, { textMessage: "Booked: {long}, {long}, {day} at {time}." }),
    });
    expect(found.join("\n")).toMatch(/textMessage: With every slot at its longest.*at most 306/);
    // Words that force the longer encoding have far less room.
    const wide = issues({
      confirmation: phone(
        {},
        { textMessage: "Zapisano: {class}, {day} o {time}. Dziękujemy, łączymy się wkrótce." },
      ),
    });
    expect(wide.join("\n")).toMatch(/at most 134/);
  });

  it("refuses push words over the bounds", () => {
    expect(
      issues({
        confirmation: phone({}, { push: { title: "Booked: {long}", body: "{class}" } }),
      }).join("\n"),
    ).toMatch(/push\.title: .*at most 60/);
    expect(
      issues({
        confirmation: phone({}, { push: { title: "Booked", body: "{long} at {time} on {day}" } }),
      }).join("\n"),
    ).toMatch(/push\.body: .*at most 140/);
  });

  it("refuses a slot not declared, a private slot, a link or a list in a push", () => {
    expect(
      issues({ confirmation: phone({}, { textMessage: "Booked: {nope}." }) }).join("\n"),
    ).toMatch(/\{nope\} is not a slot/);
    expect(
      issues({ confirmation: phone({}, { push: { title: "Booked", body: "{health}" } }) }).join(
        "\n",
      ),
    ).toMatch(/\{health\} is private: a push shows on a locked screen/);
    // A text may carry it: only the locked screen is the problem.
    expect(issues({ confirmation: phone({}, { textMessage: "Note: {health}" }) })).toEqual([]);
    expect(
      issues({ confirmation: phone({}, { push: { title: "Booked", body: "[{link}]" } }) }).join(
        "\n",
      ),
    ).toMatch(/\{link\} is a link: a push opens a screen of the app/);
    expect(issues({ confirmation: phone({}, { textMessage: "Booked. [{link}]" }) })).toEqual([]);
  });

  it("refuses words with a link or an address, the member outside a guardian's words, and two lines", () => {
    const found = issues({
      confirmation: phone({}, { textMessage: "Booked {member}. See gym.example.com\nBye" }),
    }).join("\n");
    expect(found).toMatch(/link, an address or markup/);
    expect(found).toMatch(/\{member\} is only for what a guardian is sent/);
    expect(found).toMatch(/One line/);
  });

  it("refuses an essential follow-up", () => {
    expect(
      issues({ confirmation: phone({ purpose: "follow_up", essential: true }) }).join("\n"),
    ).toMatch(/A follow-up is never essential/);
    expect(issues({ confirmation: phone({ purpose: "follow_up" }) })).toEqual([]);
    expect(issues({ confirmation: phone({ purpose: "news_and_offers" }) }).join("\n")).toMatch(
      /purpose/,
    );
  });

  it("needs each channel's words in every message, the channel for its words, a screen for a push, a time for until", () => {
    expect(issues({ confirmation: phone({}, { textMessage: undefined }) }).join("\n")).toMatch(
      /each message needs its text words/,
    );
    expect(
      issues({ confirmation: phone({ channels: ["email"], open: undefined }) }).join("\n"),
    ).toMatch(/textMessage: Declare the text channel[\s\S]*push: Declare the push channel/);
    expect(issues({ confirmation: phone({ open: undefined }) }).join("\n")).toMatch(
      /A push opens a screen of the app/,
    );
    expect(issues({ confirmation: phone({ until: "class.title" }) }).join("\n")).toMatch(
      /until must be a date or datetime field/,
    );
    expect(issues({ confirmation: phone({ urgent: true, until: undefined }) }).join("\n")).toMatch(
      /An urgent kind names its moment/,
    );
    expect(issues({ confirmation: phone({ channels: ["text", "push"] }) }).join("\n")).toMatch(
      /Every kind goes by email/,
    );
  });

  it("a choice's words that force the longer encoding count against 134, not 306 (the review of PR #339)", () => {
    const long = "x".repeat(200);
    const withChoice = (a: string) =>
      issues({
        confirmation: phone({
          slots: {
            why: { choice: { a, b: "ok" } },
            class: { field: "class.title", max: 40 },
            time: { field: "class.startsAt", format: "time", zone: "class.zone" },
            day: { field: "class.startsAt", format: "date", zone: "class.zone" },
          },
          messages: {
            booked: {
              subject: "Booked",
              text: "Booked.",
              textMessage: `${long} {why}`,
              push: { title: "Booked", body: "{class}" },
            },
          },
        }),
      }).join("\n");
    expect(withChoice("recu")).toBe("");
    expect(withChoice("reçu 😀")).toMatch(/at most 134/);
  });

  it("a field private in one slot is private in every slot that reads it (the review of PR #339)", () => {
    const found = issues({
      confirmation: phone({
        slots: {
          class: { field: "class.title", max: 40 },
          time: { field: "class.startsAt", format: "time", zone: "class.zone" },
          day: { field: "class.startsAt", format: "date", zone: "class.zone" },
          health: { field: "class.health", private: true },
          again: { field: "class.health" },
        },
        messages: {
          booked: {
            subject: "Booked",
            text: "Booked.",
            textMessage: "Booked: {class}.",
            push: { title: "Booked", body: "{again}" },
          },
        },
      }),
    }).join("\n");
    expect(found).toMatch(/\{again\} is private: a push shows on a locked screen/);
  });

  it("a kind with only email words behaves as before", () => {
    expect(issues({ confirmation: kind() })).toEqual([]);
  });
});
