// The file source (owner's decision of 2026-11-24): the read-only contract over files a business
// exported and a member of staff loads. Its CSV reading, column and value mapping, refused rows,
// local times in the site's zone, the dry run with the matching rules, and the conformance suite
// against it. Every name and address here is invented.

import { describe, expect, it } from "vitest";
import { CONFORMANCE_CHECKS, runConformance } from "../src/conformance.js";
import { directSession } from "../src/direct.js";
import {
  dryRunFiles,
  FileBookingSystem,
  type FileSourceInput,
  fitRef,
  loadFiles,
  parseCsv,
} from "../src/file-source.js";
import { type MatchContext, matchPeople } from "../src/match.js";
import { refusalCode } from "../src/refusal.js";

const NOW = "2026-11-20T09:00:00.000Z";

const PEOPLE = [
  "Client ID,First,Last,E-mail,Status,Plan,Type,Plan status,Start,End,Visits,Left,Auto renew",
  "101,Avery,Sample,avery@example.com,Active,Unlimited,Contract,Active,01/06/2026,,,,Yes",
  "101,Avery,Sample,avery@example.com,Active,10 classes,Pack,Active,01/11/2026,01/02/2027,10,4,No",
  "102,Blake,Example,blake@example.com,Expired,Unlimited,Contract,Terminated,01/01/2025,31/12/2025,,,No",
  "103,Cameron,Test,family@example.com,Active,Off-peak,Contract,On hold,01/03/2026,,,,Yes",
  "104,Devon,Test,family@example.com,Lead,,,,,,,,",
  '105,"Emery, Jr",Sample,emery@example.com,Mystery,Drop-in,Pack,,15/11/2026,15/12/2026,1,1,',
  ",No,Address,,Active,,,,,,,,",
  "106,Finley,Example,not-an-address,Active,,,,,,,,",
].join("\n");

const TIMETABLE = [
  "Class;Starts;Ends;Room;Coach;Capacity;Booked",
  "Morning strength;2026-11-20 07:00;08:00;Main room;Riley Coach;12;9",
  "Evening mobility;2026-11-21 18:30;;Studio two;Sky Coach;;3",
  "Broken;sometime;;;;;",
  "Late;2026-11-22T19:00:00+11:00;2026-11-22T20:00:00+11:00;Main room;Riley Coach;10;x",
].join("\r\n");

const INPUT: FileSourceInput = {
  site: { name: "Fake studio", timeZone: "Australia/Sydney" },
  now: NOW,
  people: {
    text: PEOPLE,
    mapping: {
      columns: {
        ref: "Client ID",
        givenName: "First",
        familyName: "Last",
        email: "E-mail",
        memberStatus: "Status",
        membershipType: "Plan",
        membershipKind: "Type",
        membershipStatus: "Plan status",
        from: "Start",
        until: "End",
        usesTotal: "Visits",
        usesLeft: "Left",
        renews: "Auto renew",
      },
      dateFormat: "DD/MM/YYYY",
    },
  },
  timetable: {
    text: TIMETABLE,
    mapping: {
      columns: {
        title: "Class",
        startsAt: "Starts",
        endsAt: "Ends",
        location: "Room",
        staff: "Coach",
        places: "Capacity",
        booked: "Booked",
      },
    },
  },
};

function code(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return refusalCode(error);
  }
  return "accepted";
}

describe("reading a CSV file", () => {
  it("reads quotes, doubled quotes, CRLF, a byte-order mark and semicolons, skipping blank lines", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n1,\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["1", ""],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(code(() => parseCsv('a\n"open'))).toBe("invalid");
  });
});

describe("loading a people file", () => {
  const load = loadFiles(INPUT);

  it("makes one person per id, with each membership and pass, in the contract's words", () => {
    expect(load.people.map((p) => [p.ref, p.memberStatus])).toEqual([
      ["101", "member"],
      ["102", "expired"],
      ["103", "member"],
      ["104", "not_member"],
      ["105", "not_member"],
      ["106", "member"],
    ]);
    const avery = load.memberships.filter((m) => m.person === "101");
    expect(
      avery.map((m) => [
        m.name,
        m.kind,
        m.status,
        m.from,
        m.until,
        m.usesTotal,
        m.usesLeft,
        m.renews,
      ]),
    ).toEqual([
      ["Unlimited", "membership", "live", "2026-06-01", null, null, null, true],
      ["10 classes", "pass", "live", "2026-11-01", "2027-02-01", 10, 4, false],
    ]);
    expect(load.memberships.find((m) => m.person === "103")?.status).toBe("paused");
    expect(load.memberships.find((m) => m.person === "102")?.status).toBe("cancelled");
    expect(load.membershipTypes.map((t) => [t.name, t.kind]).sort()).toEqual([
      ["10 classes", "pass"],
      ["Drop-in", "pass"],
      ["Off-peak", "membership"],
      ["Unlimited", "membership"],
    ]);
  });

  it("names every row left out and every value not understood", () => {
    expect(load.issues).toEqual([
      {
        file: "people",
        row: 6,
        column: "Status",
        problem: '"Mystery" is not a member status this file maps',
      },
      { file: "people", row: 7, problem: "no address and no id: the row is left out" },
      {
        file: "people",
        row: 8,
        column: "E-mail",
        problem: '"not-an-address" is not an address; read without one',
      },
      { file: "timetable", row: 3, problem: '"sometime" is not a time: the row is left out' },
      { file: "timetable", row: 4, column: "Booked", problem: "not a whole number" },
    ]);
    expect(load.people.find((p) => p.ref === "106")?.email).toBeNull();
  });

  it("takes the file's own words, and the address as the ref when there is no id", () => {
    const own = loadFiles({
      site: INPUT.site,
      now: NOW,
      people: {
        text: "mail,state\nRobin@Example.com,Mystery\n",
        mapping: {
          columns: { email: "mail", memberStatus: "state" },
          values: { memberStatus: { mystery: "suspended" } },
        },
      },
    });
    expect(own.people).toEqual([
      expect.objectContaining({
        ref: "email:robin@example.com",
        email: "Robin@Example.com",
        memberStatus: "suspended",
      }),
    ]);
  });

  it("refuses a file without a mapped column, or in a zone that is not one", () => {
    expect(
      code(() =>
        loadFiles({
          ...INPUT,
          people: { text: "a,b\n1,2", mapping: { columns: { email: "E-mail" } } },
        }),
      ),
    ).toBe("invalid");
    expect(code(() => loadFiles({ ...INPUT, site: { name: "x", timeZone: "Nowhere/Here" } }))).toBe(
      "invalid",
    );
  });

  it("derives membership from a live membership when the file has no status column", () => {
    const plain = loadFiles({
      site: INPUT.site,
      now: NOW,
      people: {
        text: "email,plan,end\na@example.com,Unlimited,2026-12-31\nb@example.com,Unlimited,2026-01-31\nc@example.com,,\n",
        mapping: { columns: { email: "email", membershipType: "plan", until: "end" } },
      },
    });
    expect(plain.people.map((p) => p.memberStatus)).toEqual(["member", "not_member", "not_member"]);
  });
});

describe("loading a timetable", () => {
  const { classes, staff, site } = loadFiles(INPUT);

  it("reads local times in the site's zone, an end as a time of day, and a default hour", () => {
    expect(classes.map((c) => [c.title, c.startsAt, c.endsAt, c.places, c.booked])).toEqual([
      ["Morning strength", "2026-11-19T20:00:00.000Z", "2026-11-19T21:00:00.000Z", 12, 9],
      ["Evening mobility", "2026-11-21T07:30:00.000Z", "2026-11-21T08:30:00.000Z", null, 3],
      ["Late", "2026-11-22T08:00:00.000Z", "2026-11-22T09:00:00.000Z", 10, 0],
    ]);
    expect(staff.map((s) => s.displayName)).toEqual(["Riley Coach", "Sky Coach"]);
    expect(site.locations.map((l) => l.name)).toEqual(["Main room", "Studio two"]);
  });

  it("takes the offset in force on each side of a daylight-saving change", () => {
    const { classes: around } = loadFiles({
      ...INPUT,
      timetable: {
        text: "c,s\nBefore,2026-10-03 09:00\nAfter,2026-10-05 09:00\n",
        mapping: { columns: { title: "c", startsAt: "s" } },
      },
    });
    expect(around.map((c) => c.startsAt)).toEqual([
      "2026-10-02T23:00:00.000Z",
      "2026-10-04T22:00:00.000Z",
    ]);
  });
});

function context(
  personsByAddress: Record<string, string[]>,
  extra: Partial<MatchContext> = {},
): MatchContext {
  return {
    normalise: (a) => a.trim().toLowerCase(),
    personsWith: (a) => personsByAddress[a] ?? [],
    isErased: () => false,
    isSuppressed: () => false,
    linkOf: () => null,
    ...extra,
  };
}

describe("matching by address, never merged", () => {
  it("links one Person, leaves none unlinked, and holds several or a shared address for staff", () => {
    const outcomes = matchPeople(
      [
        { ref: "a", email: "Avery@example.com" },
        { ref: "b", email: "blake@example.com" },
        { ref: "c", email: "family@example.com" },
        { ref: "d", email: "family@example.com" },
        { ref: "e", email: "nobody@example.com" },
        { ref: "f", email: null },
      ],
      context({
        "avery@example.com": ["P1"],
        "blake@example.com": ["P2", "P3"],
        "family@example.com": ["P4"],
      }),
    );
    expect(outcomes).toEqual([
      { ref: "a", outcome: "linked", person: "P1" },
      { ref: "b", outcome: "waiting", why: "several_people", candidates: ["P2", "P3"] },
      { ref: "c", outcome: "waiting", why: "shared_address", candidates: ["P4"] },
      { ref: "d", outcome: "waiting", why: "shared_address", candidates: ["P4"] },
      { ref: "e", outcome: "unlinked" },
      { ref: "f", outcome: "waiting", why: "no_address", candidates: [] },
    ]);
  });

  it("keeps nothing of a suppressed ref or an erased address, and they share with no one", () => {
    const outcomes = matchPeople(
      [
        { ref: "gone", email: "family@example.com" },
        { ref: "kept", email: "family@example.com" },
        { ref: "erased", email: "erased@example.com" },
      ],
      context(
        { "family@example.com": ["P4"], "erased@example.com": ["P9"] },
        {
          isSuppressed: (ref) => ref === "gone",
          isErased: (a) => a === "erased@example.com",
        },
      ),
    );
    expect(outcomes).toEqual([
      { ref: "gone", outcome: "dropped", why: "suppressed" },
      { ref: "kept", outcome: "linked", person: "P4" },
      { ref: "erased", outcome: "dropped", why: "erased_address" },
    ]);
  });

  it("keeps a staff link whatever the address, and matches again a link whose Person moved", () => {
    const links: Record<string, { person: string; how: "address" | "staff" }> = {
      s: { person: "P7", how: "staff" },
      moved: { person: "P8", how: "address" },
      held: { person: "P1", how: "address" },
    };
    const outcomes = matchPeople(
      [
        { ref: "s", email: "else@example.com" },
        { ref: "moved", email: "new@example.com" },
        { ref: "held", email: "avery@example.com" },
      ],
      context(
        { "new@example.com": ["P2"], "avery@example.com": ["P1"] },
        { linkOf: (ref) => links[ref] ?? null },
      ),
    );
    expect(outcomes).toEqual([
      { ref: "s", outcome: "kept", person: "P7", how: "staff" },
      { ref: "moved", outcome: "linked", person: "P2" },
      { ref: "held", outcome: "kept", person: "P1", how: "address" },
    ]);
  });
});

describe("the dry run", () => {
  it("says what would be loaded, which rows are refused, and who would be linked", () => {
    const run = dryRunFiles(
      INPUT,
      context({ "avery@example.com": ["P1"], "blake@example.com": ["P2", "P3"] }),
    );
    expect(run.rows).toEqual({ people: 8, timetable: 4 });
    expect(run.counts).toEqual({
      people: 6,
      members: 3,
      memberships: 3,
      passes: 2,
      membershipTypes: 4,
      classes: 3,
      staff: 2,
    });
    expect(run.issueCount).toBe(5);
    expect(run.sample[0]?.memberships).toHaveLength(2);
    expect(run.matching).toMatchObject({
      linked: 1,
      kept: 0,
      waiting: { several_people: 1, shared_address: 2, no_address: 1 },
      unlinked: 1,
      dropped: 0,
    });
  });

  it("refuses nothing and keeps nothing: the same files load the same records", () => {
    expect(dryRunFiles(INPUT).counts).toEqual(dryRunFiles(INPUT).counts);
    expect(loadFiles(INPUT)).toEqual(loadFiles(INPUT));
  });
});

describe("the contract over loaded files", () => {
  it("passes the conformance suite, the checks needing the fake's controls skipped", async () => {
    const system = new FileBookingSystem(loadFiles(INPUT));
    const results = await runConformance(
      { session: directSession(system), declaredActions: async () => [] },
      { now: NOW },
    );
    expect(results.filter((r) => r.status === "failed")).toEqual([]);
    expect(results.filter((r) => r.status === "skipped").map((r) => r.name)).toEqual(
      CONFORMANCE_CHECKS.filter((c) => c.needsControl).map((c) => c.name),
    );
  });

  it("says it is a file: no calls, no hints, no change times", async () => {
    const session = directSession(new FileBookingSystem(loadFiles(INPUT)));
    const site = await session.describeSite();
    expect(site.offers).toEqual({
      source: "file",
      modifiedSince: { people: false, classes: false },
      hints: "none",
      largestPage: 200,
    });
    await session.listStaff();
    expect((await session.describeSite()).calls.used).toBe(0);
    expect(await session.listBookings({ classes: ["x"] })).toEqual([]);
  });
});

describe("a timetable of bookings, and a file read as hostile input (stage 65 step 4)", () => {
  const BOOKINGS = [
    "Class ID,Class,Starts,Coach,Coach email,Client ID,Email,Status",
    "c1,Strength,2026-11-20 07:00,Riley Coach,riley@example.com,101,,Booked",
    "c1,Strength,2026-11-20 07:00,Riley Coach,riley@example.com,,robin@example.com,Checked in",
    "c1,Strength,2026-11-20 07:00,Riley Coach,riley@example.com,103,,Mystery",
    "c2,Mobility,2026-11-21 18:00,Sky Coach,,,,",
  ].join("\n");
  const timetable = {
    text: BOOKINGS,
    mapping: {
      columns: {
        ref: "Class ID",
        title: "Class",
        startsAt: "Starts",
        staff: "Coach",
        staffEmail: "Coach email",
        person: "Client ID",
        personEmail: "Email",
        bookingState: "Status",
      },
    },
  };

  it("reads one row per booking, a class once, its counts from its bookings, and the coach's address", async () => {
    const load = loadFiles({ site: INPUT.site, now: NOW, timetable });
    expect(load.people).toEqual([]);
    expect(load.classes.map((c) => [c.ref, c.booked, c.waiting])).toEqual([
      ["c1", 2, 0],
      ["c2", 0, 0],
    ]);
    expect(load.bookings.map((b) => [b.class, b.person, b.state])).toEqual([
      ["c1", "101", "booked"],
      ["c1", "email:robin@example.com", "attended"],
    ]);
    expect(load.issues).toEqual([
      expect.objectContaining({
        row: 3,
        column: "Status",
        problem: expect.stringMatching(/left out/),
      }),
    ]);
    expect(load.staff.find((s) => s.ref === "staff:riley-coach")?.email).toBe("riley@example.com");
    const session = directSession(new FileBookingSystem(loadFiles({ ...INPUT, timetable })));
    expect(await session.listBookings({ classes: ["c1"] })).toHaveLength(2);
    const results = await runConformance(
      { session, declaredActions: async () => [] },
      { now: NOW },
    );
    expect(results.filter((r) => r.status === "failed")).toEqual([]);
  });

  it("keeps refs the contract takes, text without hidden characters, and a formula as text", () => {
    expect(fitRef("abc-1")).toBe("abc-1");
    expect(fitRef("Ö 12")).toMatch(/^-12~[0-9a-f]{16}$/);
    expect(fitRef("x".repeat(300))).toHaveLength(217);
    expect(fitRef("Ö 12")).toBe(fitRef("Ö 12"));
    const load = loadFiles({
      site: INPUT.site,
      now: NOW,
      people: {
        text: 'id,mail,first\nÖ1,a@example.com,"=1+1"\n2,b@example.com,"Al‮ice\r\nB"\n',
        mapping: { columns: { ref: "id", email: "mail", givenName: "first" } },
      },
    });
    expect(load.people.map((p) => [p.ref, p.givenName])).toEqual([
      [expect.stringMatching(/^1~[0-9a-f]{16}$/), "=1+1"],
      ["2", "Alice B"],
    ]);
    expect(load.formulaLike).toBe(1);
  });

  it("refuses a file past its limits while reading it, naming no value", () => {
    expect(code(() => parseCsv(`a\n${"b\n".repeat(11)}`, { maxRows: 10 }))).toBe("invalid");
    expect(code(() => parseCsv(`${"a,".repeat(5)}a\n`, { maxColumns: 5 }))).toBe("invalid");
    expect(code(() => parseCsv(`a\n"${"s".repeat(20)}"\n`, { maxCell: 10 }))).toBe("invalid");
    expect(code(() => parseCsv("a,b\n1,\u00002\n"))).toBe("invalid");
    expect(
      code(() =>
        loadFiles({
          site: INPUT.site,
          people: { text: "mail,Mail\na@example.com,b\n", mapping: { columns: { email: "mail" } } },
        }),
      ),
    ).toBe("invalid");
    const types = [
      "mail,plan",
      ...Array.from({ length: 501 }, (_, i) => `p${i}@example.com,Plan ${i}`),
    ];
    expect(
      code(() =>
        loadFiles({
          site: INPUT.site,
          people: {
            text: types.join("\n"),
            mapping: { columns: { email: "mail", membershipType: "plan" } },
          },
        }),
      ),
    ).toBe("invalid");
  });
});
