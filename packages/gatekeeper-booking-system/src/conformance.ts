// The conformance suite every booking-system gatekeeper passes (stage 65, ADR 0920): every read of
// the contract, paging to the end, `modifiedSince` answering what changed and nothing older, refs
// stable across reads, the 200-people and 50-classes limits refused above them, every refusal
// code, no outbound action declared, no field outside the contract (checked by key), and the call
// counter matching the calls made. It runs against any target: the fake in memory, the fake
// gatekeeper through its session, and, by hand, a real system's sandbox site. It writes nothing
// anywhere; against a real site it spends calls (reading every person once, and the window's
// classes), so run it against a sandbox, never a business's site. Checks that need the fake's
// controls are skipped without them.

import type { FakeAccess, FakeFailMethod, FakeKind } from "./fake.js";
import { REFUSAL_CODES, refusalCode } from "./refusal.js";
import type {
  BookingSystemBooking,
  BookingSystemClass,
  BookingSystemPage,
  BookingSystemPerson,
  BookingSystemRefusalCode,
  BookingSystemSession,
  BookingSystemSite,
} from "./types.js";
import { CONTRACT_KEYS, MAX_CLASSES, MAX_PEOPLE, parseTime } from "./validate.js";

/** What the fake lets a test do to its site. A real system has none. */
export interface ConformanceControl {
  failNext(method: FakeFailMethod, code: BookingSystemRefusalCode): Promise<void>;
  setAccess(access: FakeAccess): Promise<void>;
  setBudget(budget: number | null): Promise<void>;
  spendBudget(): Promise<void>;
  change(kind: FakeKind, ref: string, patch: Record<string, unknown>): Promise<unknown>;
  /** Moves the fake's clock on, and answers the new time. */
  advance(seconds: number): Promise<string>;
  shareAddress(from: string, to: string): Promise<void>;
  callCount(): Promise<{ used: number; byMethod: Record<string, number> }>;
}

/** What the suite drives: the session, the action kinds its gatekeeper declares, the controls. */
export interface ConformanceTarget {
  session: BookingSystemSession;
  /** The outbound action kinds the gatekeeper declares (`getAutoApprovableActions` and the rest). */
  declaredActions(): Promise<string[]>;
  control?: ConformanceControl;
}

export interface ConformanceOptions {
  /** The time the class window is around; by default now. A fake with its own clock passes it. */
  now?: string;
}

export type ConformanceResult = {
  name: string;
  status: "passed" | "failed" | "skipped";
  error?: string;
};

type Context = {
  target: ConformanceTarget;
  session: BookingSystemSession;
  site: BookingSystemSite;
  /** Every person, read once to the end. */
  people: BookingSystemPerson[];
  /** 7 days before `now` to 28 after: the class window the host reads. */
  from: string;
  until: string;
  now: number;
};

export type ConformanceCheck = {
  name: string;
  /** Needs the fake's controls: skipped against a real system. */
  needsControl?: boolean;
  run(ctx: Context, control: ConformanceControl): Promise<void>;
};

class Skip extends Error {}

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEMBER_STATUSES = ["member", "not_member", "suspended", "expired", "ended", "declined"];
const MEMBERSHIP_STATUSES = ["live", "paused", "ended", "cancelled"];
const BOOKING_STATES = ["booked", "waiting", "attended", "late_cancelled", "no_show", "cancelled"];
const FINAL_STATES = ["attended", "late_cancelled", "no_show", "cancelled"];
const HINT_KINDS = ["person", "membership", "class", "booking", "staff", "site"];
/** What a read-only contract must not have: none may be a method of the session. */
const WRITE_METHODS = [
  "book",
  "cancel",
  "createBooking",
  "cancelBooking",
  "updateBooking",
  "markAttended",
  "createPerson",
  "updatePerson",
  "deletePerson",
  "mergePeople",
  "createMembership",
  "updateMembership",
  "cancelMembership",
  "sell",
  "createClass",
  "updateClass",
  "cancelClass",
  "updateStaff",
  "submit",
  "write",
  "delete",
];

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${what}: expected ${e}, got ${a}`);
}

function keys(item: unknown, expected: readonly string[], what: string): void {
  same(Object.keys(item as object).sort(), [...expected].sort(), `${what}'s keys`);
}

function time(value: unknown, what: string): number {
  try {
    return parseTime(value, what).ms;
  } catch {
    throw new Error(`${what} is not an ISO 8601 time with an offset: ${JSON.stringify(value)}`);
  }
}

function optionalTime(value: unknown, what: string): void {
  if (value !== null) time(value, what);
}

function count(value: unknown, what: string): void {
  check(Number.isInteger(value) && (value as number) >= 0, `${what} is a whole number`);
}

/** The read failed; its refusal code, or `null` for a failure without one. */
async function failure(promise: Promise<unknown>): Promise<BookingSystemRefusalCode | null> {
  try {
    await promise;
  } catch (error) {
    return refusalCode(error);
  }
  throw new Error("expected the read to be refused, and it answered");
}

async function refused(promise: Promise<unknown>, code: BookingSystemRefusalCode, what: string) {
  same(await failure(promise), code, `${what}: the refusal's code`);
}

/** Every item of a paged read, following cursors to the end; checks each page as it goes. */
async function all<T extends { ref: string }>(
  ctx: Context,
  read: (cursor?: string) => Promise<BookingSystemPage<T>>,
  what: string,
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 0; ; pages++) {
    check(pages < 10_000, `${what}: paging ends`);
    const page = await read(cursor);
    keys(page, ["cursor", "items"], `a page of ${what}`);
    check(
      page.items.length <= ctx.site.offers.largestPage,
      `a page of ${what} holds at most the largest page`,
    );
    for (const item of page.items) {
      check(!seen.has(item.ref), `${what}: ${item.ref} comes once across pages`);
      seen.add(item.ref);
      out.push(item);
    }
    if (page.cursor === null) return out;
    check(typeof page.cursor === "string" && page.cursor.length > 0, `${what}: a cursor or null`);
    cursor = page.cursor;
  }
}

function checkPerson(p: BookingSystemPerson): void {
  keys(p, CONTRACT_KEYS.person, `person ${p.ref}`);
  check(typeof p.ref === "string" && p.ref.length > 0, "a person has a ref");
  check(p.email === null || (typeof p.email === "string" && p.email.includes("@")), "an address");
  check(MEMBER_STATUSES.includes(p.memberStatus), `person ${p.ref}'s member status`);
  check(typeof p.active === "boolean", `person ${p.ref} says whether active`);
  optionalTime(p.modifiedAt, `person ${p.ref}'s modifiedAt`);
}

function checkClass(ctx: Context, c: BookingSystemClass, from: string, until: string): void {
  keys(c, CONTRACT_KEYS.class, `class ${c.ref}`);
  const starts = time(c.startsAt, `class ${c.ref}'s startsAt`);
  check(starts >= Date.parse(from) && starts < Date.parse(until), `class ${c.ref} starts inside`);
  check(time(c.endsAt, `class ${c.ref}'s endsAt`) > starts, `class ${c.ref} ends after it starts`);
  check(c.places === null || Number.isInteger(c.places), `class ${c.ref}'s places`);
  count(c.booked, `class ${c.ref}'s booked`);
  count(c.waiting, `class ${c.ref}'s waiting`);
  check(typeof c.cancelled === "boolean", `class ${c.ref} says whether cancelled`);
  check(
    c.location === null || ctx.site.locations.some((l) => l.ref === c.location),
    `class ${c.ref}'s location is one of the site's`,
  );
  optionalTime(c.modifiedAt, `class ${c.ref}'s modifiedAt`);
}

function checkBooking(b: BookingSystemBooking): void {
  keys(b, CONTRACT_KEYS.booking, `booking ${b.ref}`);
  check(BOOKING_STATES.includes(b.state), `booking ${b.ref}'s state`);
  optionalTime(b.modifiedAt, `booking ${b.ref}'s modifiedAt`);
}

function classesIn(ctx: Context, from = ctx.from, until = ctx.until, modifiedSince?: string) {
  return all(
    ctx,
    (cursor) =>
      ctx.session.listClasses({
        from,
        until,
        ...(modifiedSince ? { modifiedSince } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    "classes",
  );
}

function peopleSince(ctx: Context, modifiedSince: string) {
  return all(
    ctx,
    (cursor) => ctx.session.listPeople({ modifiedSince, ...(cursor ? { cursor } : {}) }),
    "people",
  );
}

/** The median of the times given: a point with something on each side. */
function middle(times: (string | null)[]): string | null {
  const sorted = times
    .filter((t): t is string => t !== null)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

export const CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  {
    name: "describes the site: name, time zone, locations, what it offers and this month's calls",
    async run({ site }) {
      keys(site, CONTRACT_KEYS.site, "the site");
      check(typeof site.name === "string" && site.name.length > 0, "a name");
      check(
        (() => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: site.timeZone });
            return true;
          } catch {
            return false;
          }
        })(),
        `an IANA time zone, not ${site.timeZone}`,
      );
      for (const l of site.locations) keys(l, ["name", "ref"], "a location");
      keys(
        site.offers,
        ["hints", "largestPage", "modifiedSince", "source"],
        "what the site offers",
      );
      check(["api", "file"].includes(site.offers.source), "the source is api or file");
      keys(site.offers.modifiedSince, ["classes", "people"], "modifiedSince");
      check(["webhooks", "none"].includes(site.offers.hints), "hints are webhooks or none");
      check(
        Number.isInteger(site.offers.largestPage) && site.offers.largestPage > 0,
        "a page size",
      );
      keys(site.calls, ["budget", "byMethod", "month", "used"], "the calls");
      check(/^\d{4}-\d{2}$/.test(site.calls.month), "the month is YYYY-MM");
      count(site.calls.used, "calls used");
      check(site.calls.budget === null || Number.isInteger(site.calls.budget), "a budget or none");
      same(
        Object.values(site.calls.byMethod).reduce((sum, n) => sum + n, 0),
        site.calls.used,
        "the calls by method add up to the calls used",
      );
    },
  },
  {
    name: "pages through people to the end, each ref once, with the contract's fields only",
    async run(ctx) {
      const people = await all(
        ctx,
        (cursor) => ctx.session.listPeople(cursor ? { cursor } : {}),
        "people",
      );
      check(people.length > 0, "the site has people to test with");
      for (const p of people) checkPerson(p);
    },
  },
  {
    name: "reads people changed since a time, and nothing older",
    async run(ctx, control) {
      if (!ctx.site.offers.modifiedSince.people) {
        await refused(
          ctx.session.listPeople({ modifiedSince: new Date(ctx.now).toISOString() }),
          "invalid",
          "modifiedSince where the site does not offer it",
        );
        return;
      }
      let t: string;
      let expected: string[];
      if (ctx.target.control) {
        const person = ctx.people[0] as BookingSystemPerson;
        t = await control.advance(60);
        await control.change("person", person.ref, { givenName: person.givenName });
        expected = [person.ref];
      } else {
        const median = middle(ctx.people.map((p) => p.modifiedAt));
        if (median === null) throw new Skip("no person has a modifiedAt");
        t = median;
        expected = ctx.people
          .filter((p) => p.modifiedAt !== null && Date.parse(p.modifiedAt) >= Date.parse(t))
          .map((p) => p.ref);
      }
      const changed = await peopleSince(ctx, t);
      for (const p of changed) {
        checkPerson(p);
        check(
          p.modifiedAt !== null && Date.parse(p.modifiedAt) >= Date.parse(t),
          `${p.ref} was modified at or after ${t}`,
        );
      }
      const refs = new Set(changed.map((p) => p.ref));
      for (const ref of expected) check(refs.has(ref), `${ref}, changed since ${t}, is read`);
      if (ctx.target.control) same([...refs], expected, "only the person changed");
    },
  },
  {
    name: "keeps refs stable: the same people under the same refs, and refs reads exactly those",
    async run(ctx) {
      const chosen = ctx.people.slice(0, 3);
      const again = await ctx.session.listPeople({ refs: chosen.map((p) => p.ref) });
      same(
        again.items.map((p) => [p.ref, p.email]).sort(),
        chosen.map((p) => [p.ref, p.email]).sort(),
        "the people read again by ref",
      );
      same(again.cursor, null, "one page for refs");
    },
  },
  {
    name: "refuses more than 200 people, no people, and a ref named twice",
    async run(ctx) {
      const many = Array.from({ length: MAX_PEOPLE + 1 }, (_, i) => `conformance-${i}`);
      await refused(ctx.session.listPeople({ refs: many }), "invalid", "201 people by ref");
      await refused(
        ctx.session.listMemberships({ people: many }),
        "invalid",
        "201 people's memberships",
      );
      await refused(ctx.session.listMemberships({ people: [] }), "invalid", "no people");
      const ref = (ctx.people[0] as BookingSystemPerson).ref;
      await refused(ctx.session.listMemberships({ people: [ref, ref] }), "invalid", "a ref twice");
    },
  },
  {
    name: "lists membership types, each a membership or a pass",
    async run({ session }) {
      for (const t of await session.listMembershipTypes()) {
        keys(t, CONTRACT_KEYS.membershipType, `membership type ${t.ref}`);
        check(["membership", "pass"].includes(t.kind), `type ${t.ref}'s kind`);
        check(typeof t.active === "boolean", `type ${t.ref} says whether active`);
      }
    },
  },
  {
    name: "lists memberships and passes only for the people asked",
    async run(ctx) {
      const asked = ctx.people.slice(0, MAX_PEOPLE).map((p) => p.ref);
      const memberships = await ctx.session.listMemberships({ people: asked });
      const set = new Set(asked);
      for (const m of memberships) {
        keys(m, CONTRACT_KEYS.membership, `membership ${m.ref}`);
        check(set.has(m.person), `membership ${m.ref} is of a person asked for`);
        check(["membership", "pass"].includes(m.kind), `membership ${m.ref}'s kind`);
        check(MEMBERSHIP_STATUSES.includes(m.status), `membership ${m.ref}'s status`);
        for (const d of [m.from, m.until]) {
          check(d === null || DATE.test(d), `membership ${m.ref}'s dates are YYYY-MM-DD`);
        }
        for (const n of [m.usesTotal, m.usesLeft]) {
          check(n === null || (Number.isInteger(n) && n >= 0), `membership ${m.ref}'s uses`);
        }
        check(
          m.usesTotal === null || m.usesLeft === null || m.usesLeft <= m.usesTotal,
          `membership ${m.ref} has no more uses left than it had`,
        );
        check(typeof m.renews === "boolean", `membership ${m.ref} says whether it renews`);
      }
    },
  },
  {
    name: "lists class types",
    async run({ session }) {
      for (const t of await session.listClassTypes()) {
        keys(t, CONTRACT_KEYS.classType, `class type ${t.ref}`);
        check(t.description === null || t.description.length <= 500, "a short description");
        check(typeof t.active === "boolean", `class type ${t.ref} says whether active`);
      }
    },
  },
  {
    name: "pages through the window's classes to the end, each starting inside it",
    async run(ctx) {
      const classes = await classesIn(ctx);
      if (classes.length === 0) throw new Skip("no classes in the window");
      for (const c of classes) checkClass(ctx, c, ctx.from, ctx.until);
    },
  },
  {
    name: "reads classes changed since a time, and nothing older",
    async run(ctx, control) {
      if (!ctx.site.offers.modifiedSince.classes) {
        await refused(
          ctx.session.listClasses({ from: ctx.from, until: ctx.until, modifiedSince: ctx.from }),
          "invalid",
          "modifiedSince where the site does not offer it",
        );
        return;
      }
      const classes = await classesIn(ctx);
      if (classes.length === 0) throw new Skip("no classes in the window");
      let t: string;
      let expected: string[];
      if (ctx.target.control) {
        const one = classes[0] as BookingSystemClass;
        t = await control.advance(60);
        await control.change("class", one.ref, { title: one.title });
        expected = [one.ref];
      } else {
        const median = middle(classes.map((c) => c.modifiedAt));
        if (median === null) throw new Skip("no class has a modifiedAt");
        t = median;
        expected = classes
          .filter((c) => c.modifiedAt !== null && Date.parse(c.modifiedAt) >= Date.parse(t))
          .map((c) => c.ref);
      }
      const changed = await classesIn(ctx, ctx.from, ctx.until, t);
      for (const c of changed) {
        checkClass(ctx, c, ctx.from, ctx.until);
        check(
          c.modifiedAt !== null && Date.parse(c.modifiedAt) >= Date.parse(t),
          `${c.ref} was modified at or after ${t}`,
        );
      }
      const refs = new Set(changed.map((c) => c.ref));
      for (const ref of expected) check(refs.has(ref), `${ref}, changed since ${t}, is read`);
      if (ctx.target.control) same([...refs], expected, "only the class changed");
    },
  },
  {
    name: "refuses a window over 35 days, one that ends before it starts, and a time with no offset",
    async run(ctx) {
      const from = Date.parse(ctx.from);
      const over = new Date(from + 35 * DAY_MS + 1000).toISOString();
      await refused(ctx.session.listClasses({ from: ctx.from, until: over }), "invalid", "36 days");
      await refused(
        ctx.session.listClasses({ from: ctx.until, until: ctx.from }),
        "invalid",
        "a window that ends first",
      );
      await refused(
        ctx.session.listClasses({
          from: ctx.from.replace(/(Z|[+-]\d{2}:\d{2})$/, ""),
          until: ctx.until,
        }),
        "invalid",
        "a time with no offset",
      );
    },
  },
  {
    name: "lists bookings only for the classes asked, and refuses more than 50 classes",
    async run(ctx) {
      const classes = await classesIn(ctx);
      if (classes.length === 0) throw new Skip("no classes in the window");
      const asked = classes.slice(0, MAX_CLASSES).map((c) => c.ref);
      const set = new Set(asked);
      for (const b of await ctx.session.listBookings({ classes: asked })) {
        checkBooking(b);
        check(set.has(b.class), `booking ${b.ref} is in a class asked for`);
      }
      const many = Array.from({ length: MAX_CLASSES + 1 }, (_, i) => `conformance-${i}`);
      await refused(ctx.session.listBookings({ classes: many }), "invalid", "51 classes");
    },
  },
  {
    name: "lists staff with a display name and an address only",
    async run({ session }) {
      for (const s of await session.listStaff()) {
        keys(s, CONTRACT_KEYS.staff, `staff ${s.ref}`);
        check(typeof s.displayName === "string" && s.displayName.length > 0, "a display name");
        check(s.email === null || s.email.includes("@"), `staff ${s.ref}'s address`);
        check(typeof s.active === "boolean", `staff ${s.ref} says whether active`);
      }
    },
  },
  {
    name: "reads one person's past visits in their final states only",
    async run(ctx) {
      const from = new Date(ctx.now - 7 * DAY_MS).toISOString();
      const until = new Date(ctx.now).toISOString();
      for (const person of ctx.people.slice(0, 5)) {
        const visits = await all(
          ctx,
          (cursor) =>
            ctx.session.listVisits({
              person: person.ref,
              from,
              until,
              ...(cursor ? { cursor } : {}),
            }),
          "visits",
        );
        for (const v of visits) {
          checkBooking(v);
          same(v.person, person.ref, `visit ${v.ref}'s person`);
          check(FINAL_STATES.includes(v.state), `visit ${v.ref} is in a final state`);
        }
      }
      const longAgo = new Date(ctx.now - 367 * DAY_MS).toISOString();
      await refused(
        ctx.session.listVisits({
          person: (ctx.people[0] as BookingSystemPerson).ref,
          from: longAgo,
          until,
        }),
        "invalid",
        "visits over 366 days",
      );
    },
  },
  {
    name: "takes each hint once, and none from a system without them",
    async run(ctx, control) {
      await refused(ctx.session.takeHints({ max: 0 }), "invalid", "max 0");
      await refused(ctx.session.takeHints({ max: 101 }), "invalid", "max 101");
      const taken = await ctx.session.takeHints({ max: 100 });
      for (const h of taken) {
        keys(h, CONTRACT_KEYS.hint, "a hint");
        check(HINT_KINDS.includes(h.kind), `a hint's kind, not ${h.kind}`);
        check(Array.isArray(h.refs), "a hint's refs");
      }
      if (ctx.site.offers.hints === "none") {
        same(taken, [], "no hints from a system without them");
        return;
      }
      if (!ctx.target.control) return;
      // Drained; a change brings exactly one hint, and it is taken once.
      while ((await ctx.session.takeHints({ max: 100 })).length > 0) {}
      const person = ctx.people[0] as BookingSystemPerson;
      await control.change("person", person.ref, { givenName: person.givenName });
      same(
        await ctx.session.takeHints({ max: 10 }),
        [{ kind: "person", refs: [person.ref] }],
        "the hint",
      );
      same(await ctx.session.takeHints({ max: 10 }), [], "taken once");
    },
  },
  {
    name: "declares no outbound action, and has no write of any kind",
    async run(ctx) {
      same(await ctx.target.declaredActions(), [], "the action kinds declared");
      const session = ctx.session as unknown as Record<string, (input: unknown) => unknown>;
      for (const method of WRITE_METHODS) {
        let threw = false;
        try {
          await session[method]?.({ ref: "conformance" });
          threw = typeof session[method] !== "function";
        } catch {
          threw = true;
        }
        check(threw, `the session has no ${method}`);
      }
    },
  },
  {
    name: "counts its calls: a read adds to this month's count, and a file makes none",
    async run(ctx, control) {
      const before = (await ctx.session.describeSite()).calls;
      await ctx.session.listStaff();
      await ctx.session.listClassTypes();
      const after = (await ctx.session.describeSite()).calls;
      if (after.month !== before.month) throw new Skip("the month turned during the check");
      if (ctx.site.offers.source === "file") {
        same(after.used, before.used, "a file source makes no calls");
        return;
      }
      check(after.used >= before.used + 2, "two reads are at least two calls");
      if (ctx.target.control) {
        same(after.used, before.used + 2, "one call a read, at the fake");
        const counted = await control.callCount();
        same(
          [after.used, after.byMethod],
          [counted.used, counted.byMethod],
          "the system's own count",
        );
      }
    },
  },
  {
    name: "says why it refused, with every refusal code",
    needsControl: true,
    async run(ctx, control) {
      for (const code of REFUSAL_CODES) {
        await control.failNext("listStaff", code);
        await refused(ctx.session.listStaff(), code, `a call failed as ${code}`);
      }
      await ctx.session.listStaff();
    },
  },
  {
    name: "a revoked key or a site not activated refuses every read until put right",
    needsControl: true,
    async run(ctx, control) {
      try {
        for (const [access, code] of [
          ["revoked", "unauthorised"],
          ["not_activated", "not_activated"],
        ] as const) {
          await control.setAccess(access);
          await refused(ctx.session.describeSite(), code, `describeSite, ${access}`);
          await refused(ctx.session.listPeople({}), code, `listPeople, ${access}`);
          await refused(ctx.session.listStaff(), code, `listStaff, ${access}`);
        }
      } finally {
        await control.setAccess("ok");
      }
      await ctx.session.listStaff();
    },
  },
  {
    name: "over budget: every read refused, the site still described, and nothing counted",
    needsControl: true,
    async run(ctx, control) {
      const { budget } = ctx.site.calls;
      try {
        await control.spendBudget();
        const before = await control.callCount();
        await refused(ctx.session.listStaff(), "over_budget", "a read over budget");
        await refused(ctx.session.listPeople({}), "over_budget", "a page of people over budget");
        const site = await ctx.session.describeSite();
        same(site.calls.used, site.calls.budget, "the budget is reached");
        same((await control.callCount()).used, before.used, "nothing counted over budget");
      } finally {
        await control.setBudget(budget);
      }
    },
  },
  {
    name: "two people on one address are both read, under their own refs",
    needsControl: true,
    async run(ctx, control) {
      const [a, b] = ctx.people.filter((p) => p.email !== null);
      if (!a || !b) throw new Skip("fewer than two people with an address");
      await control.shareAddress(a.ref, b.ref);
      const { items } = await ctx.session.listPeople({ refs: [a.ref, b.ref] });
      same(
        items.map((p) => [p.ref, p.email]).sort(),
        [
          [a.ref, a.email],
          [b.ref, a.email],
        ].sort(),
        "both people, one address",
      );
    },
  },
];

/** Reads the site and every person, and sets the class window. */
export async function prepareConformance(
  target: ConformanceTarget,
  options: ConformanceOptions = {},
): Promise<Context> {
  const site = await target.session.describeSite();
  const now = options.now ? Date.parse(options.now) : Date.now();
  if (Number.isNaN(now)) throw new Error("now must be an ISO 8601 time.");
  const ctx: Context = {
    target,
    session: target.session,
    site,
    people: [],
    from: new Date(now - 7 * DAY_MS).toISOString(),
    until: new Date(now + 28 * DAY_MS).toISOString(),
    now,
  };
  ctx.people = await all(
    ctx,
    (cursor) => target.session.listPeople(cursor ? { cursor } : {}),
    "people",
  );
  if (ctx.people.length === 0) throw new Error("The site has no people to test with.");
  return ctx;
}

/** Runs every check in order; one that fails does not stop the others. */
export async function runConformance(
  target: ConformanceTarget,
  options: ConformanceOptions = {},
): Promise<ConformanceResult[]> {
  const ctx = await prepareConformance(target, options);
  const results: ConformanceResult[] = [];
  for (const c of CONFORMANCE_CHECKS) results.push(await runCheck(c, ctx));
  return results;
}

/** One check against a prepared context: passed, failed with why, or skipped with why. */
export async function runCheck(c: ConformanceCheck, ctx: Context): Promise<ConformanceResult> {
  const { control } = ctx.target;
  if (c.needsControl && !control) {
    return { name: c.name, status: "skipped", error: "needs the fake's controls" };
  }
  try {
    await c.run(ctx, control ?? NO_CONTROL);
    return { name: c.name, status: "passed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: c.name, status: error instanceof Skip ? "skipped" : "failed", error: message };
  }
}

const unavailable = async (): Promise<never> => {
  throw new Error("This target has no controls.");
};
const NO_CONTROL: ConformanceControl = {
  failNext: unavailable,
  setAccess: unavailable,
  setBudget: unavailable,
  spendBudget: unavailable,
  change: unavailable,
  advance: unavailable,
  shareAddress: unavailable,
  callCount: unavailable,
};

export type { Context as ConformanceContext };
