// A fake booking system (stage 65, ADR 0920): a site with invented people, membership types,
// memberships and passes, class types, classes, bookings and staff, held in one plain state object
// so it runs in memory for the conformance suite and inside a Durable Object for the fake
// gatekeeper. A test can change anything (which records a hint, as a system with webhooks sends
// one), revoke the key, make the next call fail, spend the budget, move the clock and give two
// people one address. It counts every call by method, as a real gatekeeper counts its API calls:
// a failed call counts, a rate-limited one and one refused over budget do not.

import { refuse } from "./refusal.js";
import type { BookingSystem } from "./system.js";
import type {
  BookingSystemBooking,
  BookingSystemBookingState,
  BookingSystemClass,
  BookingSystemClassesQuery,
  BookingSystemClassType,
  BookingSystemHint,
  BookingSystemHintKind,
  BookingSystemLocation,
  BookingSystemMembership,
  BookingSystemMembershipType,
  BookingSystemPage,
  BookingSystemPeopleQuery,
  BookingSystemPerson,
  BookingSystemRefusalCode,
  BookingSystemSite,
  BookingSystemStaff,
  BookingSystemVisitsQuery,
} from "./types.js";

/** The calls the fake counts: each reaches the system's API. */
export const FAKE_CALL_METHODS = [
  "listPeople",
  "listMembershipTypes",
  "listMemberships",
  "listClassTypes",
  "listClasses",
  "listBookings",
  "listStaff",
  "listVisits",
] as const;
export type FakeCallMethod = (typeof FAKE_CALL_METHODS)[number];
/** What `failNext` may name: a counted call, or `describeSite`. */
export type FakeFailMethod = FakeCallMethod | "describeSite" | "any";

/** What a test may change, by the kind of record. */
export type FakeKind =
  | "person"
  | "membershipType"
  | "membership"
  | "classType"
  | "class"
  | "booking"
  | "staff";

/** `revoked`: the key no longer works. `not_activated`: the site has not granted access. */
export type FakeAccess = "ok" | "revoked" | "not_activated";

export type FakeBookingSystemState = {
  site: { name: string; timeZone: string; locations: BookingSystemLocation[] };
  /** The fake's clock, ISO 8601 in UTC. Moves only when a test moves it, or a change is made. */
  now: string;
  hints: "webhooks" | "none";
  pageSize: number;
  budget: number | null;
  access: FakeAccess;
  people: BookingSystemPerson[];
  membershipTypes: BookingSystemMembershipType[];
  memberships: BookingSystemMembership[];
  classTypes: BookingSystemClassType[];
  classes: BookingSystemClass[];
  /** Every booking, past and to come: the past ones are what `listVisits` reads. */
  bookings: BookingSystemBooking[];
  staff: BookingSystemStaff[];
  /** Hints waiting for `takeHints`, oldest first. */
  pendingHints: BookingSystemHint[];
  /** Calls this month, by method. */
  calls: { month: string; byMethod: Record<string, number> };
  failures: { method: FakeFailMethod; code: BookingSystemRefusalCode }[];
  seq: number;
};

export type FakeOptions = {
  /** The clock to start from; by default the start of the current hour. */
  now?: string;
  hints?: "webhooks" | "none";
  pageSize?: number;
  budget?: number | null;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FINAL_STATES: readonly BookingSystemBookingState[] = [
  "attended",
  "late_cancelled",
  "no_show",
  "cancelled",
];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function month(time: string): string {
  return time.slice(0, 7);
}

/**
 * A fresh site: twelve invented people (eight of them members or pass holders), five membership
 * types, three staff, two class types a day for 7 days back and 28 ahead, with bookings.
 */
export function fakeBookingSystemState(options: FakeOptions = {}): FakeBookingSystemState {
  const nowMs = options.now ? Date.parse(options.now) : Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const now = iso(nowMs);
  const modified = (i: number) => iso(nowMs - 30 * DAY_MS + i * HOUR_MS);
  const names: [string, string, BookingSystemPerson["memberStatus"], boolean][] = [
    ["Avery", "Sample", "member", true],
    ["Blake", "Example", "member", true],
    ["Cameron", "Test", "member", true],
    ["Devon", "Sample", "member", true],
    ["Emery", "Example", "suspended", true],
    ["Finley", "Test", "expired", true],
    ["Harper", "Sample", "not_member", true],
    ["Indigo", "Example", "not_member", true],
    ["Jules", "Test", "ended", false],
    ["Kai", "Sample", "declined", true],
    ["Lane", "Example", "member", true],
    ["Morgan", "Test", "not_member", true],
  ];
  const people: BookingSystemPerson[] = names.map(([given, family, status, active], i) => ({
    ref: `fake-person-${String(i + 1).padStart(3, "0")}`,
    email: `${given.toLowerCase()}.${family.toLowerCase()}@example.com`,
    givenName: given,
    familyName: family,
    memberStatus: status,
    active,
    modifiedAt: modified(i),
  }));
  // One person with no address at all, as booking systems have.
  const noAddress = people[11];
  if (noAddress) noAddress.email = null;
  const ref = (i: number) => people[i]?.ref ?? "";
  const day = (offset: number) => iso(nowMs + offset * DAY_MS).slice(0, 10);
  const membershipTypes: BookingSystemMembershipType[] = [
    { ref: "fake-type-unlimited", name: "Unlimited monthly", kind: "membership", active: true },
    { ref: "fake-type-offpeak", name: "Off-peak monthly", kind: "membership", active: true },
    { ref: "fake-type-founding", name: "Founding member", kind: "membership", active: false },
    { ref: "fake-type-ten", name: "Ten-class pass", kind: "pass", active: true },
    { ref: "fake-type-dropin", name: "Drop-in", kind: "pass", active: true },
  ];
  const membership = (
    n: number,
    person: number,
    type: number,
    status: BookingSystemMembership["status"],
    from: number,
    until: number | null,
    uses: [number, number] | null = null,
  ): BookingSystemMembership => {
    const t = membershipTypes[type] as BookingSystemMembershipType;
    return {
      ref: `fake-membership-${n}`,
      person: ref(person),
      type: t.ref,
      name: t.name,
      kind: t.kind,
      status,
      from: day(from),
      until: until === null ? null : day(until),
      usesTotal: uses ? uses[0] : null,
      usesLeft: uses ? uses[1] : null,
      renews: t.kind === "membership" && status === "live",
    };
  };
  const memberships = [
    membership(1, 0, 0, "live", -200, null),
    membership(2, 1, 0, "live", -40, 320),
    membership(3, 2, 1, "live", -90, 275),
    membership(4, 3, 2, "live", -900, null),
    membership(5, 4, 0, "paused", -120, 60),
    membership(6, 5, 1, "ended", -400, -35),
    membership(7, 6, 3, "live", -10, 80, [10, 6]),
    membership(8, 7, 4, "live", -1, 0, [1, 1]),
    membership(9, 8, 0, "cancelled", -300, -100),
    membership(10, 10, 0, "live", -5, 360),
  ];
  const locations = [
    { ref: "fake-location-main", name: "Main room" },
    { ref: "fake-location-studio", name: "Studio two" },
  ];
  const staff: BookingSystemStaff[] = [
    {
      ref: "fake-staff-1",
      displayName: "Riley Coach",
      email: "riley.coach@example.com",
      active: true,
    },
    { ref: "fake-staff-2", displayName: "Sky Coach", email: "sky.coach@example.com", active: true },
    { ref: "fake-staff-3", displayName: "Taylor Coach", email: null, active: false },
  ];
  const classTypes: BookingSystemClassType[] = [
    {
      ref: "fake-class-type-strength",
      name: "Strength",
      description: "Lifting, coached in small groups.",
      active: true,
    },
    { ref: "fake-class-type-mobility", name: "Mobility", description: null, active: true },
    { ref: "fake-class-type-old", name: "Retired format", description: null, active: false },
  ];
  const classes: BookingSystemClass[] = [];
  const bookings: BookingSystemBooking[] = [];
  const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
  for (let d = -7; d < 28; d++) {
    for (const [slot, hour] of [
      [0, 7],
      [1, 18],
    ] as const) {
      const starts = midnight + d * DAY_MS + hour * HOUR_MS;
      const n = classes.length + 1;
      const classRef = `fake-class-${String(n).padStart(4, "0")}`;
      const booked = [0, 1, 2, 6].map((p) => ref((p + n) % 11));
      const past = starts < nowMs;
      booked.forEach((person, i) => {
        const state: BookingSystemBookingState = past
          ? (["attended", "attended", "no_show", "late_cancelled"][i] as BookingSystemBookingState)
          : i === 3
            ? "waiting"
            : "booked";
        bookings.push({
          ref: `fake-booking-${n}-${i + 1}`,
          class: classRef,
          person,
          state,
          modifiedAt: iso(Math.min(starts, nowMs) - HOUR_MS),
        });
      });
      classes.push({
        ref: classRef,
        classType: (classTypes[slot] as BookingSystemClassType).ref,
        title: slot === 0 ? "Morning strength" : "Evening mobility",
        startsAt: iso(starts),
        endsAt: iso(starts + HOUR_MS),
        location: (locations[slot] as BookingSystemLocation).ref,
        staff: (staff[slot] as BookingSystemStaff).ref,
        places: slot === 0 ? 3 : null,
        booked: 3,
        waiting: past ? 0 : 1,
        // One class in the window is cancelled.
        cancelled: d === 3 && slot === 1,
        modifiedAt: iso(nowMs - 14 * DAY_MS + n * 60_000),
      });
    }
  }
  return {
    site: { name: "Fake studio", timeZone: "Australia/Sydney", locations },
    now,
    hints: options.hints ?? "webhooks",
    pageSize: options.pageSize ?? 5,
    budget: options.budget === undefined ? null : options.budget,
    access: "ok",
    people,
    membershipTypes,
    memberships,
    classTypes,
    classes,
    bookings,
    staff,
    pendingHints: [],
    calls: { month: month(now), byMethod: {} },
    failures: [],
    seq: 0,
  };
}

/** A page of `items` from the cursor's offset. */
function page<T>(items: T[], cursor: string | undefined, size: number): BookingSystemPage<T> {
  let offset = 0;
  if (cursor !== undefined) {
    const match = /^fake-page-(\d{1,9})$/.exec(cursor);
    if (!match) throw refuse("invalid", "Not a cursor of this fake booking system.");
    offset = Number(match[1]);
  }
  const next = offset + size;
  return {
    items: structuredClone(items.slice(offset, next)),
    cursor: next < items.length ? `fake-page-${next}` : null,
  };
}

function since(modifiedAt: string | null, modifiedSince: string | undefined): boolean {
  if (modifiedSince === undefined) return true;
  return modifiedAt !== null && Date.parse(modifiedAt) >= Date.parse(modifiedSince);
}

/** The fake system over a state it mutates in place. */
export class FakeBookingSystem implements BookingSystem {
  readonly title: string;
  readonly state: FakeBookingSystemState;

  constructor(
    state: FakeBookingSystemState = fakeBookingSystemState(),
    title = "Fake booking system (development)",
  ) {
    this.state = state;
    this.title = title;
  }

  // --- Controls a test (or the dev seed) uses; not part of the system. --------------------------

  failNext(method: FakeFailMethod, code: BookingSystemRefusalCode): void {
    this.state.failures.push({ method, code });
  }

  setAccess(access: FakeAccess): void {
    this.state.access = access;
  }

  setBudget(budget: number | null): void {
    this.state.budget = budget;
  }

  /** Sets the budget to the calls made so far, so the next counted call is refused. */
  spendBudget(): void {
    this.state.budget = this.#used();
  }

  setHints(hints: "webhooks" | "none"): void {
    this.state.hints = hints;
  }

  setPageSize(size: number): void {
    this.state.pageSize = Math.max(1, Math.floor(size));
  }

  /** Moves the clock on; the month's count starts again when the month turns. */
  advance(seconds: number): string {
    this.state.now = iso(Date.parse(this.state.now) + seconds * 1000);
    if (month(this.state.now) !== this.state.calls.month) {
      this.state.calls = { month: month(this.state.now), byMethod: {} };
    }
    return this.state.now;
  }

  /** The calls counted this month, as the fake saw them. */
  callCount(): { used: number; byMethod: Record<string, number> } {
    return { used: this.#used(), byMethod: { ...this.state.calls.byMethod } };
  }

  /**
   * Changes one record as the business would in the booking system: the clock moves a second,
   * the record's `modifiedAt` is the new time, and a hint is recorded if the system sends them.
   * Answers the record as it now is.
   */
  change(kind: FakeKind, ref: string, patch: Record<string, unknown>): unknown {
    const list = this.#list(kind) as { ref: string }[];
    const item = list.find((r) => r.ref === ref);
    if (!item) throw new Error(`No ${kind} ${ref} in the fake booking system.`);
    this.#touch(kind, Object.assign(item, patch, { ref }));
    return structuredClone(item);
  }

  /** Adds a record as the business would; it gets a ref when it has none. */
  add(kind: FakeKind, item: Record<string, unknown>): unknown {
    this.state.seq += 1;
    const added = { ref: `fake-${kind}-new-${this.state.seq}`, ...item } as { ref: string };
    (this.#list(kind) as unknown[]).push(added);
    this.#touch(kind, added);
    return structuredClone(added);
  }

  /** Gives `to` the address `from` has, as a family sharing one mailbox. */
  shareAddress(from: string, to: string): void {
    const source = this.state.people.find((p) => p.ref === from);
    if (!source) throw new Error(`No person ${from} in the fake booking system.`);
    this.change("person", to, { email: source.email });
  }

  // --- The system. -------------------------------------------------------------------------------

  async describeSite(): Promise<BookingSystemSite> {
    // Answered from what a gatekeeper holds: not counted, and never refused over budget.
    this.#failure("describeSite");
    this.#access();
    return {
      name: this.state.site.name,
      timeZone: this.state.site.timeZone,
      locations: structuredClone(this.state.site.locations),
      offers: {
        source: "api",
        modifiedSince: { people: true, classes: true },
        hints: this.state.hints,
        largestPage: this.state.pageSize,
      },
      calls: {
        month: this.state.calls.month,
        used: this.#used(),
        budget: this.state.budget,
        byMethod: { ...this.state.calls.byMethod },
      },
    };
  }

  async listPeople(
    query: BookingSystemPeopleQuery,
  ): Promise<BookingSystemPage<BookingSystemPerson>> {
    this.#call("listPeople");
    const refs = query.refs ? new Set(query.refs) : null;
    const people = this.state.people
      .filter((p) => (refs === null || refs.has(p.ref)) && since(p.modifiedAt, query.modifiedSince))
      .sort((a, b) => (a.ref < b.ref ? -1 : 1));
    return page(people, query.cursor, this.state.pageSize);
  }

  async listMembershipTypes(): Promise<BookingSystemMembershipType[]> {
    this.#call("listMembershipTypes");
    return structuredClone(this.state.membershipTypes);
  }

  async listMemberships(people: string[]): Promise<BookingSystemMembership[]> {
    this.#call("listMemberships");
    const asked = new Set(people);
    return structuredClone(this.state.memberships.filter((m) => asked.has(m.person)));
  }

  async listClassTypes(): Promise<BookingSystemClassType[]> {
    this.#call("listClassTypes");
    return structuredClone(this.state.classTypes);
  }

  async listClasses(
    query: BookingSystemClassesQuery,
  ): Promise<BookingSystemPage<BookingSystemClass>> {
    this.#call("listClasses");
    const from = Date.parse(query.from);
    const until = Date.parse(query.until);
    const classes = this.state.classes
      .filter((c) => {
        const starts = Date.parse(c.startsAt);
        return starts >= from && starts < until && since(c.modifiedAt, query.modifiedSince);
      })
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.ref < b.ref ? -1 : 1));
    return page(classes, query.cursor, this.state.pageSize);
  }

  async listBookings(classes: string[]): Promise<BookingSystemBooking[]> {
    this.#call("listBookings");
    const asked = new Set(classes);
    return structuredClone(this.state.bookings.filter((b) => asked.has(b.class)));
  }

  async listStaff(): Promise<BookingSystemStaff[]> {
    this.#call("listStaff");
    return structuredClone(this.state.staff);
  }

  async listVisits(
    query: BookingSystemVisitsQuery,
  ): Promise<BookingSystemPage<BookingSystemBooking>> {
    this.#call("listVisits");
    const from = Date.parse(query.from);
    const until = Date.parse(query.until);
    const starts = new Map(this.state.classes.map((c) => [c.ref, Date.parse(c.startsAt)]));
    const visits = this.state.bookings
      .filter((b) => {
        const at = starts.get(b.class);
        return (
          b.person === query.person &&
          FINAL_STATES.includes(b.state) &&
          at !== undefined &&
          at >= from &&
          at < until
        );
      })
      .sort(
        (a, b) =>
          (starts.get(a.class) ?? 0) - (starts.get(b.class) ?? 0) || (a.ref < b.ref ? -1 : 1),
      );
    return page(visits, query.cursor, this.state.pageSize);
  }

  async takeHints(max: number): Promise<BookingSystemHint[]> {
    // Hints arrived as webhooks and are held by the gatekeeper: taking them is not a call.
    this.#access();
    return this.state.pendingHints.splice(0, max);
  }

  // --- Internals. --------------------------------------------------------------------------------

  #used(): number {
    return Object.values(this.state.calls.byMethod).reduce((sum, n) => sum + n, 0);
  }

  #count(method: string): void {
    this.state.calls.byMethod[method] = (this.state.calls.byMethod[method] ?? 0) + 1;
  }

  /** The next failure asked for this method, if any, thrown. */
  #failure(method: FakeFailMethod, counted = false): void {
    const index = this.state.failures.findIndex((f) => f.method === method || f.method === "any");
    if (index === -1) return;
    const code = this.state.failures.splice(index, 1)[0]?.code ?? "unavailable";
    // A rate-limited call is not charged; every other failed call is.
    if (counted && code !== "rate_limited" && code !== "over_budget") this.#count(method);
    throw refuse(code, `The fake booking system refused ${method} (as asked).`);
  }

  #access(): void {
    if (this.state.access === "revoked") {
      throw refuse("unauthorised", "The fake booking system's key was revoked.");
    }
    if (this.state.access === "not_activated") {
      throw refuse("not_activated", "The fake site has not granted access to this key.");
    }
  }

  /** One counted call: refused over budget before it is made; counted once it reaches the API. */
  #call(method: FakeCallMethod): void {
    const { budget } = this.state;
    if (budget !== null && this.#used() >= budget) {
      throw refuse("over_budget", `This month's ${budget} calls are spent.`);
    }
    this.#failure(method, true);
    this.#count(method);
    this.#access();
  }

  #list(kind: FakeKind): unknown[] {
    const lists: Record<FakeKind, unknown[]> = {
      person: this.state.people,
      membershipType: this.state.membershipTypes,
      membership: this.state.memberships,
      classType: this.state.classTypes,
      class: this.state.classes,
      booking: this.state.bookings,
      staff: this.state.staff,
    };
    return lists[kind];
  }

  #touch(
    kind: FakeKind,
    item: { ref: string; modifiedAt?: unknown; person?: unknown; class?: unknown },
  ) {
    const now = this.advance(1);
    if ("modifiedAt" in item) item.modifiedAt = now;
    if (this.state.hints === "none") return;
    // A hint names what to read again: a membership's person, a booking's class.
    const hint: Record<FakeKind, [BookingSystemHintKind, string]> = {
      person: ["person", item.ref],
      membershipType: ["site", ""],
      membership: ["membership", String(item.person)],
      classType: ["site", ""],
      class: ["class", item.ref],
      booking: ["booking", String(item.class)],
      staff: ["staff", item.ref],
    };
    const [hintKind, ref] = hint[kind];
    this.state.pendingHints.push({ kind: hintKind, refs: ref ? [ref] : [] });
  }
}
