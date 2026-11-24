// Ingest: a list read through the booking-system contract written into the host's copy (stage 65
// step 3, ADR 0922). Whatever the source (a loaded file's session, the fake, a system connected
// later), the host reads it through `BookingSystemSession` and plans one batch that **replaces**
// the copy of that kind: rows not in the new list go, with their links and matches. A staff link is
// kept across loads by ref (a file with no ref of its own uses the address as the ref).
//
// What is kept is the least the first wave uses. From a `members` list, an outside person is kept
// only while they are a member, hold a live pass, are booked in the current timetable, or are
// staff-linked; anyone else is dropped here. Nothing is ever written to a Person, an order, a
// membership or booking here, or an allowance. No text over 500 characters is copied.
//
// In budget (ADR 0500: 1,000 statements an invocation, 100 bound parameters a statement): every
// write is set based, a list of rows as one `json_each(?)` parameter, at most 100 rows a statement,
// and removing what a new list drops is one statement per table. The reads are a handful,
// whatever the list holds.
import type { CoreDatabase } from "@composable-os/db";
import {
  type BookingSystemBooking,
  type BookingSystemClass,
  type BookingSystemClassType,
  type BookingSystemLocation,
  type BookingSystemMembership,
  type BookingSystemMembershipType,
  type BookingSystemPerson,
  type BookingSystemSession,
  type BookingSystemStaff,
  MAX_CLASS_DAYS,
  MAX_CLASSES,
  MAX_PEOPLE,
  MAX_PEOPLE_ROWS,
  MAX_TEXT,
} from "@composable-os/gatekeeper-booking-system";
import { CompiledQuery, type Kysely } from "kysely";
import { normaliseCustomerEmail } from "../customers/accounts.ts";
import { ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { chunk, jsonList } from "../records/common.ts";
import { orgReader, visibleTable } from "../visibility/index.ts";
import {
  decideMatches,
  droppedOf,
  foldOutside,
  type HeldOutsideLink,
  linkActivityStatements,
  normaliseStaff,
  type OutsideOutcome,
  personsByFolded,
  unlinkedOf,
  usersByAddress,
} from "./match.ts";
import { businessToday, type ListKind } from "./settings.ts";

type Db = Kysely<CoreDatabase>;

/** Rows in one insert: one JSON parameter each, so the 100-parameter limit never binds. */
export const INGEST_CHUNK = 100;
/** The widest timetable window one list holds, read 35 days at a time. */
export const MAX_TIMETABLE_DAYS = 92;
/** The most classes one timetable list holds. */
export const MAX_LIST_CLASSES = 5_000;
/**
 * The most statements one load's batch may hold: D1 allows 1,000 an invocation, and the operation
 * that runs it (step 4) needs a few of its own (its reads, the audit row).
 */
export const MAX_PLAN_STATEMENTS = 900;

/** Refuses a list too big for one load's batch, before anything is written. */
function checkBudget(statements: readonly CompiledQuery[]): void {
  if (statements.length > MAX_PLAN_STATEMENTS) {
    throw new ValidationError(
      `This list is too big to load at once (${statements.length} writes; at most ${MAX_PLAN_STATEMENTS}).`,
      { rule: "outside_list_too_big" },
    );
  }
}

/** What a `members` list says, in the contract's shape. */
export interface MembersData {
  people: BookingSystemPerson[];
  membershipTypes: BookingSystemMembershipType[];
  memberships: BookingSystemMembership[];
}

/** What a `timetable` list says, in the contract's shape. */
export interface TimetableData {
  locations: BookingSystemLocation[];
  classTypes: BookingSystemClassType[];
  classes: BookingSystemClass[];
  bookings: BookingSystemBooking[];
  staff: BookingSystemStaff[];
}

/** Who loaded the list and what it was: never a name or an address. */
export interface ListMeta {
  /** The date the file was exported (`YYYY-MM-DD`): what the list's age is counted from. */
  exportedOn: string;
  /** The staff account loading it (a person with bookingSystem:manage). */
  by: string;
  now: string;
  /** Rows the file had, and how many it refused (step 4's file source counts them). */
  rows: number;
  refused: number;
  /** The column mapping used: headers only. */
  mapping?: Record<string, unknown>;
}

export interface IngestCounts {
  /** Outside people or coaches kept. */
  kept: number;
  /** People not kept: not a member, no live pass, not booked, not staff-linked. */
  notKept: number;
  /** Kept nothing of them: an erased Person's ref or address. */
  dropped: number;
  /** Linked now by address. */
  linked: number;
  /** A link already held, kept. */
  links: number;
  /** Waiting for staff in To match. */
  waiting: number;
  unlinked: number;
  /** Members: memberships and passes, and types. Timetable: classes and bookings. */
  items: Record<string, number>;
}

export interface IngestPlan {
  listId: string;
  kind: ListKind;
  statements: CompiledQuery[];
  counts: IngestCounts;
  /** The Persons linked now by address (each gets one timeline activity). */
  linkedPersons: string[];
}

const cut = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : value.slice(0, MAX_TEXT) || null;

/** An insert of `rows` as one JSON parameter: `INSERT INTO t (cols) SELECT … FROM json_each(?)`. */
function insertJson(
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  fixed: Record<string, unknown> = {},
): CompiledQuery[] {
  const fixedCols = Object.keys(fixed);
  const select = [
    ...fixedCols.map(() => "?"),
    ...columns.map((c) => `json_extract(value, '$.${c}')`),
  ].join(", ");
  const sqlText = `INSERT INTO ${table} (${[...fixedCols, ...columns].join(", ")}) SELECT ${select} FROM json_each(?)`;
  return chunk(rows, INGEST_CHUNK).map((part) =>
    CompiledQuery.raw(sqlText, [...Object.values(fixed), JSON.stringify(part)]),
  );
}

const raw = (sqlText: string, params: unknown[] = []) => CompiledQuery.raw(sqlText, params);

// --- Reading a source. -----------------------------------------------------------------------------

/** Every person, membership type and membership a source holds, in the contract's limits. */
export async function readMembers(session: BookingSystemSession): Promise<MembersData> {
  const people: BookingSystemPerson[] = [];
  let cursor: string | undefined;
  do {
    const page = await session.listPeople(cursor === undefined ? {} : { cursor });
    people.push(...page.items);
    if (people.length > MAX_PEOPLE_ROWS) {
      throw new ValidationError(`A members list holds at most ${MAX_PEOPLE_ROWS} people.`, {
        rule: "outside_list_too_big",
      });
    }
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  const membershipTypes = await session.listMembershipTypes();
  const memberships: BookingSystemMembership[] = [];
  for (const part of chunk(
    people.map((p) => p.ref),
    MAX_PEOPLE,
  )) {
    memberships.push(...(await session.listMemberships({ people: part })));
  }
  return { people, membershipTypes, memberships };
}

/** The classes from `from` to `until` (at most 92 days), their bookings, types and coaches. */
export async function readTimetable(
  session: BookingSystemSession,
  window: { from: string; until: string },
): Promise<TimetableData> {
  const from = Date.parse(window.from);
  const until = Date.parse(window.until);
  if (!(until > from) || until - from > MAX_TIMETABLE_DAYS * 86_400_000) {
    throw new ValidationError(`A timetable list covers 1 to ${MAX_TIMETABLE_DAYS} days.`, {
      rule: "outside_window",
    });
  }
  const site = await session.describeSite();
  const classes: BookingSystemClass[] = [];
  for (let start = from; start < until; start += MAX_CLASS_DAYS * 86_400_000) {
    const end = Math.min(until, start + MAX_CLASS_DAYS * 86_400_000);
    let cursor: string | undefined;
    do {
      const page = await session.listClasses({
        from: new Date(start).toISOString(),
        until: new Date(end).toISOString(),
        ...(cursor === undefined ? {} : { cursor }),
      });
      classes.push(...page.items);
      if (classes.length > MAX_LIST_CLASSES) {
        throw new ValidationError(`A timetable list holds at most ${MAX_LIST_CLASSES} classes.`, {
          rule: "outside_list_too_big",
        });
      }
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
  }
  const bookings: BookingSystemBooking[] = [];
  for (const part of chunk(
    classes.map((c) => c.ref),
    MAX_CLASSES,
  )) {
    bookings.push(...(await session.listBookings({ classes: part })));
  }
  return {
    locations: site.locations,
    classTypes: await session.listClassTypes(),
    classes,
    bookings,
    staff: await session.listStaff(),
  };
}

// --- Planning a load. ------------------------------------------------------------------------------

function heldLinks(
  rows: readonly {
    ref: string;
    to: string | null;
    link_how: "address" | "staff" | null;
    link_by: string | null;
    link_why: string | null;
    linked_at: string | null;
    exists: number | null;
  }[],
): Map<string, HeldOutsideLink> {
  const held = new Map<string, HeldOutsideLink>();
  for (const r of rows) {
    if (r.link_how === null || r.linked_at === null) continue;
    // A link to a Person (or account) that is gone is no link.
    if (r.to !== null && !r.exists) continue;
    held.set(r.ref, { to: r.to, how: r.link_how, by: r.link_by, why: r.link_why, at: r.linked_at });
  }
  return held;
}

function tally(outcomes: readonly OutsideOutcome[]) {
  const n = (o: OutsideOutcome["outcome"]) => outcomes.filter((x) => x.outcome === o).length;
  return {
    dropped: n("dropped"),
    linked: n("linked"),
    links: n("kept"),
    waiting: n("waiting"),
    unlinked: n("unlinked") + n("held_none"),
  };
}

function listStatements(
  kind: ListKind,
  listId: string,
  meta: ListMeta,
  kept: number,
): CompiledQuery[] {
  return [
    raw(
      "UPDATE core_outside_list SET state = 'replaced', ended_at = ? WHERE kind = ? AND state = 'current'",
      [meta.now, kind],
    ),
    raw(
      "INSERT INTO core_outside_list (id, kind, source, exported_on, loaded_by, loaded_at, row_count, refused_count, kept_count, mapping, state) VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, 'current')",
      [
        listId,
        kind,
        meta.exportedOn,
        meta.by,
        meta.now,
        meta.rows,
        meta.refused,
        kept,
        JSON.stringify(meta.mapping ?? {}),
      ],
    ),
  ];
}

function checkMeta(meta: ListMeta): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(meta.exportedOn) ||
    Number.isNaN(Date.parse(`${meta.exportedOn}T00:00:00Z`))
  ) {
    throw new ValidationError("The export date is a date, YYYY-MM-DD.", { field: "exportedOn" });
  }
  // A day's grace: the business's today can be a day ahead of UTC's.
  if (Date.parse(`${meta.exportedOn}T00:00:00Z`) > Date.parse(meta.now) + 86_400_000) {
    throw new ValidationError("The export date cannot be after today.", { field: "exportedOn" });
  }
}

/**
 * The batch that replaces the `members` copy with `data`: who is kept and why, the matching, the
 * memberships and passes of those kept, the membership types, To match, and one timeline activity
 * on each Person linked now. Reads first (six statements, whatever the list holds); writes nothing.
 */
export async function planMembers(db: Db, data: MembersData, meta: ListMeta): Promise<IngestPlan> {
  checkMeta(meta);
  const listId = newId("outsideList");
  // Live by the business's day, as the list's age is.
  const today = await businessToday(db, meta.now);
  const byPerson = new Map<string, BookingSystemMembership[]>();
  for (const m of data.memberships) {
    const held = byPerson.get(m.person);
    if (held) held.push(m);
    else byPerson.set(m.person, [m]);
  }
  const live = (m: BookingSystemMembership) =>
    m.status === "live" && (m.until === null || m.until >= today);

  const [bookedRows, heldRows] = await Promise.all([
    db.selectFrom("core_outside_booking").select("person_ref").distinct().execute(),
    db
      .selectFrom("core_outside_person")
      .select(["ref", "person_id as to", "link_how", "link_by", "link_why", "linked_at"])
      .where("link_how", "is not", null)
      .execute(),
  ]);
  const booked = new Set(bookedRows.map((r) => r.person_ref));
  // A link by address holds only while its Person still has the address (the matching reads
  // that); a staff link holds by ref while its Person is live: one in the Trash, erased or merged
  // away is no link, and the outside person is matched again.
  const linkedTo = [
    ...new Set(heldRows.map((r) => r.to).filter((id): id is string => id !== null)),
  ];
  const livePersons = new Set(
    linkedTo.length
      ? (
          await db
            .selectFrom(visibleTable(orgReader(db), "person"))
            .select("id")
            .where("id", "in", jsonList(linkedTo))
            .where("deleted_at", "is", null)
            .execute()
        ).map((r) => r.id)
      : [],
  );
  const held = heldLinks(
    heldRows.map((r) => ({ ...r, exists: r.to !== null && livePersons.has(r.to) ? 1 : 0 })),
  );
  // Staff's "nobody here", kept by hash so it outlives the row (it keeps no one by itself).
  const nobody = await unlinkedOf(
    db,
    "person",
    data.people.map((p) => p.ref),
  );
  for (const [ref, decision] of nobody) {
    held.set(ref, { to: null, how: "staff", by: decision.by, why: null, at: decision.at });
  }

  // Who is kept, and why: the least the first wave uses.
  const seen = new Set<string>();
  const candidates: {
    person: BookingSystemPerson;
    address: string | null;
    why: "member" | "pass" | "booked" | "staff";
  }[] = [];
  let notKept = 0;
  for (const person of data.people) {
    if (seen.has(person.ref)) continue;
    seen.add(person.ref);
    const held_ = byPerson.get(person.ref) ?? [];
    const why =
      person.memberStatus === "member" || held_.some((m) => m.kind === "membership" && live(m))
        ? "member"
        : held_.some((m) => m.kind === "pass" && live(m))
          ? "pass"
          : booked.has(person.ref)
            ? "booked"
            : held.get(person.ref)?.how === "staff" && held.get(person.ref)?.to
              ? "staff"
              : null;
    if (why === null) {
      notKept += 1;
      continue;
    }
    const address = person.email === null ? null : normaliseCustomerEmail(person.email);
    candidates.push({ person, address, why });
  }

  const addresses = candidates.map((c) => c.address).filter((a): a is string => a !== null);
  const [dropped, holders] = await Promise.all([
    droppedOf(
      db,
      candidates.map((c) => c.person.ref),
      addresses,
    ),
    personsByFolded(
      db,
      addresses.map((a) => foldOutside(a)).filter((a): a is string => a !== null),
    ),
  ]);
  const outcomes = decideMatches(
    candidates.map((c) => ({ ref: c.person.ref, address: c.address })),
    { fold: foldOutside, holders, held, dropped },
  );

  const personRows: Record<string, unknown>[] = [];
  const matchRows: Record<string, unknown>[] = [];
  const keptRefs = new Set<string>();
  const linkedPersons = new Set<string>();
  outcomes.forEach((o, i) => {
    const c = candidates[i] as (typeof candidates)[number];
    if (o.outcome === "dropped") return;
    keptRefs.add(c.person.ref);
    const prior = held.get(c.person.ref);
    let link: Pick<HeldOutsideLink, "to" | "how" | "by" | "why" | "at"> | null = null;
    if (o.outcome === "kept") link = prior ?? null;
    else if (o.outcome === "held_none") link = prior ?? null;
    else if (o.outcome === "linked") {
      link = { to: o.person, how: "address", by: null, why: null, at: meta.now };
      linkedPersons.add(o.person);
    } else if (o.outcome === "waiting") {
      matchRows.push({ ref: c.person.ref, why: o.why, candidates: JSON.stringify(o.candidates) });
    }
    personRows.push({
      ref: c.person.ref,
      address: c.address,
      address_folded: c.address === null ? null : foldOutside(c.address),
      given_name: cut(c.person.givenName),
      family_name: cut(c.person.familyName),
      member_status: c.person.memberStatus,
      active: c.person.active ? 1 : 0,
      why_kept: c.why,
      person_id: link?.to ?? null,
      link_how: link?.how ?? null,
      link_by: link?.how === "staff" ? link.by : null,
      link_why: link?.how === "staff" ? link.why : null,
      linked_at: link?.at ?? null,
    });
  });

  const membershipRows = data.memberships
    .filter((m) => keptRefs.has(m.person))
    .map((m) => ({
      ref: m.ref,
      person_ref: m.person,
      type_ref: m.type,
      name: cut(m.name) ?? m.type.slice(0, MAX_TEXT),
      kind: m.kind,
      status: m.status,
      from_date: m.from,
      until_date: m.until,
      uses_total: m.usesTotal,
      uses_left: m.usesLeft,
      renews: m.renews ? 1 : 0,
    }));
  const typeRows = [...new Map(data.membershipTypes.map((t) => [t.ref, t])).values()].map((t) => ({
    ref: t.ref,
    name: cut(t.name) ?? t.ref.slice(0, MAX_TEXT),
    kind: t.kind,
    active: t.active ? 1 : 0,
  }));
  const persons = [...linkedPersons];

  const statements = [
    ...listStatements("members", listId, meta, personRows.length),
    raw("DELETE FROM core_outside_match WHERE kind = 'person'"),
    raw("DELETE FROM core_outside_membership"),
    raw("DELETE FROM core_outside_membership_type"),
    raw("DELETE FROM core_outside_person"),
    ...insertJson(
      "core_outside_person",
      [
        "ref",
        "address",
        "address_folded",
        "given_name",
        "family_name",
        "member_status",
        "active",
        "why_kept",
        "person_id",
        "link_how",
        "link_by",
        "link_why",
        "linked_at",
      ],
      personRows,
      { list_id: listId },
    ),
    ...insertJson("core_outside_membership_type", ["ref", "name", "kind", "active"], typeRows, {
      list_id: listId,
    }),
    ...insertJson(
      "core_outside_membership",
      [
        "ref",
        "person_ref",
        "type_ref",
        "name",
        "kind",
        "status",
        "from_date",
        "until_date",
        "uses_total",
        "uses_left",
        "renews",
      ],
      membershipRows,
      { list_id: listId },
    ),
    ...insertJson("core_outside_match", ["ref", "why", "candidates"], matchRows, {
      kind: "person",
      created_at: meta.now,
    }),
    ...linkActivityStatements(persons, {
      userId: meta.by,
      actor: "human",
      now: meta.now,
      how: "address",
    }),
  ];
  checkBudget(statements);
  const t = tally(outcomes);
  return {
    listId,
    kind: "members",
    statements,
    linkedPersons: persons,
    counts: {
      kept: personRows.length,
      notKept,
      ...t,
      items: {
        memberships: membershipRows.filter((m) => m.kind === "membership").length,
        passes: membershipRows.filter((m) => m.kind === "pass").length,
        membershipTypes: typeRows.length,
      },
    },
  };
}

/**
 * The batch that replaces the `timetable` copy with `data`: class types, classes (with their
 * location's name), the bookings of those classes (none of an erased Person), the coaches matched
 * to staff accounts by address, and To match for coaches. Outside classes are core rows: no
 * behaviour, no place in `capacity`, no allowance (ADR 0925).
 */
export async function planTimetable(
  db: Db,
  data: TimetableData,
  meta: ListMeta,
): Promise<IngestPlan> {
  checkMeta(meta);
  const listId = newId("outsideList");
  const heldRows = await db
    .selectFrom("core_outside_staff as s")
    .leftJoin("core_user as u", "u.id", "s.user_id")
    .select([
      "s.ref",
      "s.user_id as to",
      "s.link_how",
      "s.link_by",
      "s.link_why",
      "s.linked_at",
      "u.id as exists",
    ])
    .where("s.link_how", "is not", null)
    .execute();
  const held = heldLinks(heldRows.map((r) => ({ ...r, exists: r.exists === null ? 0 : 1 })));
  for (const [ref, decision] of await unlinkedOf(
    db,
    "staff",
    data.staff.map((s) => s.ref),
  )) {
    held.set(ref, { to: null, how: "staff", by: decision.by, why: null, at: decision.at });
  }

  const staff = [...new Map(data.staff.map((s) => [s.ref, s])).values()];
  const staffAddress = (s: BookingSystemStaff) =>
    s.email === null ? null : normaliseStaff(s.email);
  const addresses = staff.map(staffAddress).filter((a): a is string => a !== null);
  const bookingPeople = [...new Set(data.bookings.map((b) => b.person))];
  const [holders, droppedPeople] = await Promise.all([
    usersByAddress(db, addresses),
    // A list with no ids of its own names a person by their address (`email:<address>`): one on
    // the erased-address list keeps no booking either.
    droppedOf(
      db,
      bookingPeople,
      bookingPeople.flatMap((ref) => {
        const address = ref.startsWith("email:") ? normaliseCustomerEmail(ref.slice(6)) : null;
        return address ? [address] : [];
      }),
    ),
  ]);
  const outcomes = decideMatches(
    staff.map((s) => ({ ref: s.ref, address: staffAddress(s) })),
    {
      fold: normaliseStaff,
      holders,
      held,
      dropped: { refs: new Set(), addresses: new Set() },
    },
  );
  const staffRows: Record<string, unknown>[] = [];
  const matchRows: Record<string, unknown>[] = [];
  outcomes.forEach((o, i) => {
    const s = staff[i] as BookingSystemStaff;
    const prior = held.get(s.ref);
    let link: HeldOutsideLink | null = null;
    if (o.outcome === "kept" || o.outcome === "held_none") link = prior ?? null;
    else if (o.outcome === "linked")
      link = { to: o.person, how: "address", by: null, why: null, at: meta.now };
    else if (o.outcome === "waiting")
      matchRows.push({ ref: s.ref, why: o.why, candidates: JSON.stringify(o.candidates) });
    staffRows.push({
      ref: s.ref,
      display_name: cut(s.displayName) ?? s.ref.slice(0, MAX_TEXT),
      address: staffAddress(s),
      active: s.active ? 1 : 0,
      user_id: link?.to ?? null,
      link_how: link?.how ?? null,
      link_by: link?.how === "staff" ? link.by : null,
      link_why: link?.how === "staff" ? link.why : null,
      linked_at: link?.at ?? null,
    });
  });

  const locations = new Map(data.locations.map((l) => [l.ref, l.name]));
  const classes = [...new Map(data.classes.map((c) => [c.ref, c])).values()];
  const classRefs = new Set(classes.map((c) => c.ref));
  const classRows = classes.map((c) => ({
    ref: c.ref,
    class_type_ref: c.classType,
    title: cut(c.title) ?? c.ref.slice(0, MAX_TEXT),
    starts_at: new Date(Date.parse(c.startsAt)).toISOString(),
    ends_at: new Date(Date.parse(c.endsAt)).toISOString(),
    location_name: c.location === null ? null : cut(locations.get(c.location) ?? null),
    staff_ref: c.staff,
    places: c.places,
    booked: c.booked,
    waiting: c.waiting,
    cancelled: c.cancelled ? 1 : 0,
  }));
  const bookings = [...new Map(data.bookings.map((b) => [b.ref, b])).values()];
  const bookingRows = bookings
    .filter(
      (b) =>
        classRefs.has(b.class) &&
        !droppedPeople.refs.has(b.person) &&
        !(
          b.person.startsWith("email:") &&
          droppedPeople.addresses.has(normaliseCustomerEmail(b.person.slice(6)) ?? "")
        ),
    )
    .map((b) => ({ ref: b.ref, class_ref: b.class, person_ref: b.person, state: b.state }));
  const typeRows = [...new Map(data.classTypes.map((t) => [t.ref, t])).values()].map((t) => ({
    ref: t.ref,
    name: cut(t.name) ?? t.ref.slice(0, MAX_TEXT),
    description: cut(t.description),
    active: t.active ? 1 : 0,
  }));

  const statements = [
    ...listStatements("timetable", listId, meta, classRows.length),
    raw("DELETE FROM core_outside_match WHERE kind = 'staff'"),
    raw("DELETE FROM core_outside_booking"),
    raw("DELETE FROM core_outside_class"),
    raw("DELETE FROM core_outside_class_type"),
    raw("DELETE FROM core_outside_staff"),
    ...insertJson("core_outside_class_type", ["ref", "name", "description", "active"], typeRows, {
      list_id: listId,
    }),
    ...insertJson(
      "core_outside_class",
      [
        "ref",
        "class_type_ref",
        "title",
        "starts_at",
        "ends_at",
        "location_name",
        "staff_ref",
        "places",
        "booked",
        "waiting",
        "cancelled",
      ],
      classRows,
      { list_id: listId },
    ),
    ...insertJson(
      "core_outside_booking",
      ["ref", "class_ref", "person_ref", "state"],
      bookingRows,
      {
        list_id: listId,
      },
    ),
    ...insertJson(
      "core_outside_staff",
      [
        "ref",
        "display_name",
        "address",
        "active",
        "user_id",
        "link_how",
        "link_by",
        "link_why",
        "linked_at",
      ],
      staffRows,
      { list_id: listId },
    ),
    ...insertJson("core_outside_match", ["ref", "why", "candidates"], matchRows, {
      kind: "staff",
      created_at: meta.now,
    }),
  ];
  checkBudget(statements);
  return {
    listId,
    kind: "timetable",
    statements,
    linkedPersons: [],
    counts: {
      kept: staffRows.length,
      notKept: 0,
      ...tally(outcomes),
      dropped: bookings.length - bookingRows.length,
      items: {
        classes: classRows.length,
        bookings: bookingRows.length,
        classTypes: typeRows.length,
      },
    },
  };
}
