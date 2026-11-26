// Erase, merge and purge reaching the booking system's copy (stage 65 step 10, ADR 0926).
//
// - **Erase** (`person.erase`, through `queueErase`): the erased Person's own outside rows (below)
//   go in the erase's own batch, with their memberships, passes, bookings, To match rows and
//   staff's decisions on them, and the refs and addresses of those rows are suppressed by keyed
//   hash (`core_outside_suppressed`), so no later load, link by address or link by hand brings
//   them back. Those rows' addresses and names join the erase's terms and names; their refs do
//   not (a booking system's numeric ids collide with ordinary text), and are scrubbed only where
//   the copy keeps them (its own rows, deleted here; the outside operations' audit, which never
//   keeps one).
// - **Merge** (`person.merge`): links move to the survivor, the duplicate leaves To match's
//   candidates (the survivor takes its place), and an outside person who waited only because the
//   two were two Persons is linked now, by address.
// - **Purge** (`trash.purge`): a purged Person's links go (an outside person stays in the copy,
//   unlinked, as the booking system lists them: a purge is not an erasure request).
//
// **Which outside rows are the erased Person's** (the rule):
// - an outside person linked to them (by address or by staff); or
// - an outside person linked to nobody, listed with one of their addresses exactly (normalised),
//   when it can only be theirs: no other outside person is on that address (folded), and no other
//   live Person holds it;
// - a coach listed with one of their addresses and linked to no staff account (a coach linked to
//   one is that staff account's, as the spec ties coaches to staff accounts).
// Never a row linked to another live Person or a staff account, whatever address it lists. An
// address one of those rows still lists is not suppressed and its `email:` bookings stay: it is
// theirs too, and the erased Person's own address is on the erased-address list anyway (ADR 0320).
// Every statement binds at most a few parameters (lists go as one JSON parameter), and their
// number does not grow with the copy.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, type SqlBool, sql } from "kysely";
import { normaliseCustomerEmail } from "../customers/accounts.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import {
  foldOutside,
  linkActivityStatements,
  outsideAddressHash,
  outsideRefHash,
  saltFingerprint,
  unlinkedOf,
} from "./match.ts";
import { onCurrentList } from "./settings.ts";

type Db = Kysely<CoreDatabase>;

const raw = (text: string, params: unknown[] = []) => CompiledQuery.raw(text, params);
const json = (values: readonly string[]) => JSON.stringify([...new Set(values)]);

/** Names scrubbed from the copy's free text (class titles, class types), each a statement. */
export const MAX_SCRUBBED_NAMES = 20;
/** A name shorter than this is not scrubbed from free text (it would hit ordinary words). */
const MIN_SCRUBBED_NAME = 6;

/** What of the booking system's copy is an erased Person's. */
export interface OutsideSubject {
  /** Their outside people's refs (the members list). */
  refs: string[];
  /** Their coaches' refs (the timetable list). */
  staffRefs: string[];
  /** The addresses their rows list (normalised), each also listed by no row that stays. */
  addresses: string[];
  /** Addresses their rows list that a row that stays lists too: not suppressed, not terms. */
  shared: string[];
  /** Bookings' person refs that are theirs: their refs, and `email:<address>` of theirs. */
  bookingRefs: string[];
  /** Their rows' given and family names and coaches' display names, as listed. */
  names: string[];
  /** Full names (a person's "given family", a coach's display name) scrubbed from free text. */
  fullNames: string[];
  /** Coaches with one of their addresses, linked to a staff account: kept as that account's. */
  coachesOfStaff: number;
}

/** A suppression row as the erase log carries it. */
export interface SuppressedHash {
  hash: string;
  kind: "ref" | "address";
}

/** What an erase removed from the copy, for its result and the erase log. */
export interface OutsideErased {
  people: number;
  coaches: number;
  coachesOfStaff: number;
  /** Classes and class types whose free text named them, scrubbed. */
  textScrubbed: number;
  /** Hashes now in `core_outside_suppressed`, the erase they came from and the salt's fingerprint. */
  suppressed: SuppressedHash[];
  eraseId: string;
  fingerprint: string;
}

/**
 * The erased Person's outside rows, by the rule above, for the Persons `recordIds` (they and
 * anyone merged into them) with `addresses` (theirs, current and former): a handful of indexed
 * reads, whatever the copy holds. Read before the erase builds its terms. A removed list's rows
 * still waiting for removal count too.
 */
export async function outsideOf(
  db: Db,
  recordIds: readonly string[],
  addresses: readonly string[],
): Promise<OutsideSubject> {
  const exact = [
    ...new Set(
      addresses.map((a) => normaliseCustomerEmail(a)).filter((a): a is string => a !== null),
    ),
  ];
  const folded = [
    ...new Set(exact.map((a) => foldOutside(a)).filter((a): a is string => a !== null)),
  ];
  const ids = jsonList([...recordIds]);
  const [linked, unlinked, coaches] = await Promise.all([
    db
      .selectFrom("core_outside_person")
      .select(["ref", "address", "address_folded", "given_name", "family_name"])
      .where("person_id", "in", ids)
      .execute(),
    db
      .selectFrom("core_outside_person")
      .select(["ref", "address", "address_folded", "given_name", "family_name"])
      .where("person_id", "is", null)
      // By the folded form's index, then the exact address.
      .where("address_folded", "in", jsonList(folded))
      .where("address", "in", jsonList(exact))
      .execute(),
    db
      .selectFrom("core_outside_staff")
      .select(["ref", "address", "display_name", "user_id"])
      .where("address", "in", jsonList(exact))
      .execute(),
  ]);
  // An unlinked row is theirs only when nobody else can be on its address: one outside person on
  // it (folded), and no other live Person holding it.
  const candidateFolded = [
    ...new Set(unlinked.map((r) => r.address_folded).filter((a): a is string => a !== null)),
  ];
  const [onAddress, heldByOthers] = candidateFolded.length
    ? await Promise.all([
        db
          .selectFrom("core_outside_person")
          .select(["address_folded", (eb) => eb.fn.countAll<number>().as("n")])
          .where("address_folded", "in", jsonList(candidateFolded))
          .groupBy("address_folded")
          .execute(),
        db
          .selectFrom("core_person_emails")
          .select("email")
          .where("live", "=", 1)
          .where(
            "email",
            "in",
            jsonList(unlinked.map((r) => r.address).filter((a): a is string => a !== null)),
          )
          .where("person_id", "not in", ids)
          .execute(),
      ])
    : [[], []];
  const crowded = new Set(onAddress.filter((r) => Number(r.n) > 1).map((r) => r.address_folded));
  const others = new Set(heldByOthers.map((r) => r.email.trim().toLowerCase()));
  const people = [
    ...linked,
    ...unlinked.filter(
      (r) =>
        r.address !== null &&
        !crowded.has(r.address_folded) &&
        !others.has(r.address) &&
        !linked.some((l) => l.ref === r.ref),
    ),
  ];
  const ownCoaches = coaches.filter((c) => c.user_id === null);
  const refs = people.map((p) => p.ref);
  const staffRefs = ownCoaches.map((c) => c.ref);
  const listed = [
    ...new Set(
      [...people.map((p) => p.address), ...ownCoaches.map((c) => c.address)].filter(
        (a): a is string => a !== null,
      ),
    ),
  ];
  // An address a row that stays still lists (a family on one mailbox, a coach linked to staff):
  // theirs as much as the erased Person's.
  const candidates = [...new Set([...listed, ...exact])];
  const [stayPeople, stayStaff] = candidates.length
    ? await Promise.all([
        db
          .selectFrom("core_outside_person")
          .select("address")
          .where(
            "address_folded",
            "in",
            jsonList(candidates.map((a) => foldOutside(a)).filter((a): a is string => a !== null)),
          )
          .where("address", "in", jsonList(candidates))
          .where("ref", "not in", jsonList(refs))
          .execute(),
        db
          .selectFrom("core_outside_staff")
          .select("address")
          .where("address", "in", jsonList(candidates))
          .where("ref", "not in", jsonList(staffRefs))
          .execute(),
      ])
    : [[], []];
  const shared = new Set(
    [...stayPeople, ...stayStaff].map((r) => r.address).filter((a): a is string => a !== null),
  );
  const fullNames = [
    ...new Set(
      [
        ...people.map((p) => [p.given_name, p.family_name].filter(Boolean).join(" ")),
        ...ownCoaches.map((c) => c.display_name),
      ].filter((n) => n.trim().length >= MIN_SCRUBBED_NAME),
    ),
  ].slice(0, MAX_SCRUBBED_NAMES);
  return {
    refs,
    staffRefs,
    addresses: listed.filter((a) => !shared.has(a)),
    shared: [...shared],
    bookingRefs: [...refs, ...candidates.filter((a) => !shared.has(a)).map((a) => `email:${a}`)],
    names: [
      ...new Set(
        [
          ...people.flatMap((p) => [p.given_name, p.family_name]),
          ...ownCoaches.map((c) => c.display_name),
        ].filter((n): n is string => typeof n === "string" && n.trim().length > 0),
      ),
    ],
    fullNames,
    coachesOfStaff: coaches.length - ownCoaches.length,
  };
}

/**
 * Queues the erase of `found` from the copy, and its suppression, for the Persons `recordIds`.
 * About ten statements, and one more per full name scrubbed from free text (at most
 * `MAX_SCRUBBED_NAMES`), whatever the copy holds: each set based, its lists one JSON parameter.
 * Nothing here is held by a guarded state or a hold: the copy is core rows with no states, no
 * Trash and no write guard (ADRs 0863 and 0865 hold record writes, not the host's own removals).
 */
export async function queueEraseOutside(
  ctx: HandlerContext,
  recordIds: readonly string[],
  found: OutsideSubject,
): Promise<OutsideErased> {
  const { refs, staffRefs } = found;
  const [refHashes, staffHashes, addressHashes, fingerprint] = await Promise.all([
    Promise.all(refs.map((ref) => outsideRefHash(ctx.db, "person", ref))),
    Promise.all(staffRefs.map((ref) => outsideRefHash(ctx.db, "staff", ref))),
    Promise.all(found.addresses.map((a) => outsideAddressHash(ctx.db, a))),
    saltFingerprint(ctx.db),
  ]);
  const suppressed: SuppressedHash[] = [
    ...[...refHashes, ...staffHashes].map((hash) => ({ hash, kind: "ref" as const })),
    ...addressHashes.map((hash) => ({ hash, kind: "address" as const })),
  ];
  const eraseId = `ose_${crypto.randomUUID().replaceAll("-", "")}`;
  // Free text the booking system wrote naming them (a class "Strength with <coach>").
  const textScrubbed = found.fullNames.length
    ? Number(
        (
          await ctx.db
            .selectFrom("core_outside_class as c")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where(
              sql<SqlBool>`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(found.fullNames)}) WHERE instr(c.title, value) > 0)`,
            )
            .executeTakeFirst()
        )?.n ?? 0,
      ) +
      Number(
        (
          await ctx.db
            .selectFrom("core_outside_class_type as t")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where(
              sql<SqlBool>`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(found.fullNames)}) WHERE instr(t.name || ' ' || coalesce(t.description, ''), value) > 0)`,
            )
            .executeTakeFirst()
        )?.n ?? 0,
      )
    : 0;
  const ids = json([...recordIds]);
  ctx.write(
    raw(
      "DELETE FROM core_outside_membership WHERE person_ref IN (SELECT value FROM json_each(?))",
      [json(refs)],
    ),
    raw("DELETE FROM core_outside_booking WHERE person_ref IN (SELECT value FROM json_each(?))", [
      json(found.bookingRefs),
    ]),
    raw(
      "DELETE FROM core_outside_match WHERE (kind = 'person' AND ref IN (SELECT value FROM json_each(?))) OR (kind = 'staff' AND ref IN (SELECT value FROM json_each(?)))",
      [json(refs), json(staffRefs)],
    ),
    // They leave every other outside person's candidates in To match.
    raw(
      `UPDATE core_outside_match SET candidates = (
         SELECT json_group_array(c.value) FROM json_each(core_outside_match.candidates) c
         WHERE c.value NOT IN (SELECT value FROM json_each(?1)))
       WHERE kind = 'person' AND EXISTS (
         SELECT 1 FROM json_each(core_outside_match.candidates) c
         WHERE c.value IN (SELECT value FROM json_each(?1)))`,
      [ids],
    ),
    // Staff's "nobody here" about them: the suppression says more.
    raw(
      "DELETE FROM core_outside_unlinked WHERE (kind = 'person' AND hash IN (SELECT value FROM json_each(?))) OR (kind = 'staff' AND hash IN (SELECT value FROM json_each(?)))",
      [json(refHashes), json(staffHashes)],
    ),
    // Their classes name no coach.
    raw(
      "UPDATE core_outside_class SET staff_ref = NULL WHERE staff_ref IN (SELECT value FROM json_each(?))",
      [json(staffRefs)],
    ),
    // Their name in the booking system's own text (a class title, a class type): bounded, one
    // statement a name. A later list brings back whatever the booking system still says.
    ...found.fullNames.flatMap((name) => [
      raw(
        "UPDATE core_outside_class SET title = replace(title, ?1, '[erased]') WHERE instr(title, ?1) > 0",
        [name],
      ),
      raw(
        "UPDATE core_outside_class_type SET name = replace(name, ?1, '[erased]'), description = replace(description, ?1, '[erased]') WHERE instr(name || ' ' || coalesce(description, ''), ?1) > 0",
        [name],
      ),
    ]),
    raw("DELETE FROM core_outside_staff WHERE ref IN (SELECT value FROM json_each(?))", [
      json(staffRefs),
    ]),
    raw("DELETE FROM core_outside_person WHERE ref IN (SELECT value FROM json_each(?))", [
      json(refs),
    ]),
  );
  const statement = suppressStatement(
    suppressed.map((s) => ({ ...s, eraseId, fingerprint })),
    ctx.now,
  );
  if (statement) ctx.write(statement);
  return {
    people: refs.length,
    coaches: staffRefs.length,
    coachesOfStaff: found.coachesOfStaff,
    textScrubbed,
    suppressed,
    eraseId,
    fingerprint,
  };
}

/** Writes suppression hashes (an erase's, or `erasure.reapply`'s from the erase log). */
export function suppressStatement(
  hashes: readonly (SuppressedHash & { eraseId: string | null; fingerprint: string | null })[],
  now: string,
): CompiledQuery | null {
  if (!hashes.length) return null;
  return raw(
    "INSERT INTO core_outside_suppressed (hash, kind, created_at, erase_id, fingerprint) SELECT json_extract(value, '$.hash'), json_extract(value, '$.kind'), ?, json_extract(value, '$.eraseId'), json_extract(value, '$.fingerprint') FROM json_each(?) WHERE json_extract(value, '$.kind') IN ('ref', 'address') ON CONFLICT (hash) DO NOTHING",
    [now, JSON.stringify(hashes)],
  );
}

/**
 * Consent to come back (`erasure.allowAddress`): the address's suppression goes, and with it the
 * refs suppressed by the same erase (they were that Person's; the Person's own consent lifts
 * them). Other addresses of that erase stay until each is allowed. Returns what it lifts.
 */
export async function liftForAddress(
  db: Db,
  address: string,
): Promise<{
  statements: CompiledQuery[];
  addresses: number;
  refs: number;
  hashes: SuppressedHash[];
}> {
  const hash = await outsideAddressHash(db, address);
  const rows = await db
    .selectFrom("core_outside_suppressed")
    .select(["hash", "erase_id"])
    .where("kind", "=", "address")
    .where("hash", "=", hash)
    .execute();
  if (!rows.length) return { statements: [], addresses: 0, refs: 0, hashes: [] };
  const erases = rows.map((r) => r.erase_id).filter((e): e is string => e !== null);
  const refRows = erases.length
    ? await db
        .selectFrom("core_outside_suppressed")
        .select("hash")
        .where("kind", "=", "ref")
        .where("erase_id", "in", erases)
        .execute()
    : [];
  const hashes: SuppressedHash[] = [
    { hash, kind: "address" },
    ...refRows.map((r) => ({ hash: r.hash, kind: "ref" as const })),
  ];
  return {
    statements: [
      raw("DELETE FROM core_outside_suppressed WHERE hash IN (SELECT value FROM json_each(?))", [
        JSON.stringify(hashes.map((h) => h.hash)),
      ]),
    ],
    addresses: 1,
    refs: refRows.length,
    hashes,
  };
}

/**
 * A merge (`person.merge`): the duplicate's outside links move to the survivor, so neither is lost
 * nor doubled (each outside person is one row, by ref; two linked to one Person stay two). In To
 * match the survivor takes the duplicate's place among the candidates, and an outside person who
 * waited only because the two were two Persons with the address is linked now, by address (one
 * timeline activity on the survivor). Nothing else of anyone's outside record moves.
 */
export async function queueMergeOutside(
  ctx: HandlerContext,
  survivorId: string,
  mergedId: string,
): Promise<void> {
  ctx.write(
    raw("UPDATE core_outside_person SET person_id = ? WHERE person_id = ?", [survivorId, mergedId]),
  );
  const waiting = await ctx.db
    .selectFrom("core_outside_match as m")
    .innerJoin("core_outside_person as o", "o.ref", "m.ref")
    .select(["m.ref", "m.why", "m.candidates", "o.person_id", "o.link_how"])
    .where("m.kind", "=", "person")
    // Not a removed list's rows waiting for removal: they are no copy.
    .where(onCurrentList("o.list_id"))
    .where(sql<SqlBool>`EXISTS (SELECT 1 FROM json_each(m.candidates) WHERE value = ${mergedId})`)
    .execute();
  if (!waiting.length) return;
  const nobody = await unlinkedOf(
    ctx.db,
    "person",
    waiting.map((w) => w.ref),
  );
  let linked = false;
  for (const w of waiting) {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(w.candidates) as unknown;
      if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      ids = [];
    }
    const next = [...new Set(ids.map((id) => (id === mergedId ? survivorId : id)))];
    if (
      w.why === "several_people" &&
      next.length === 1 &&
      w.person_id === null &&
      w.link_how === null &&
      !nobody.has(w.ref)
    ) {
      ctx.write(
        ctx.db
          .updateTable("core_outside_person")
          .set({ person_id: survivorId, link_how: "address", linked_at: ctx.now })
          .where("ref", "=", w.ref)
          .where("person_id", "is", null)
          .where("link_how", "is", null),
        ctx.db
          .deleteFrom("core_outside_match")
          .where("kind", "=", "person")
          .where("ref", "=", w.ref),
      );
      linked = true;
    } else {
      ctx.write(
        ctx.db
          .updateTable("core_outside_match")
          .set({ candidates: JSON.stringify(next) })
          .where("kind", "=", "person")
          .where("ref", "=", w.ref),
      );
    }
  }
  if (linked) {
    ctx.write(
      ...linkActivityStatements([survivorId], {
        userId: ctx.user.id,
        actor: ctx.actor,
        now: ctx.now,
        how: "address",
      }),
    );
  }
}

/**
 * A purge (`trash.purge`): the purged Persons' links go and they leave To match's candidates. The
 * outside people stay in the copy, unlinked (the booking system still lists them; a purge is not
 * an erasure request), and are matched again at the next load.
 */
export function queuePurgeOutside(ctx: HandlerContext, personIds: readonly string[]): void {
  if (!personIds.length) return;
  const ids = json([...personIds]);
  ctx.write(
    raw(
      "UPDATE core_outside_person SET person_id = NULL, link_how = NULL, link_by = NULL, link_why = NULL, linked_at = NULL WHERE person_id IN (SELECT value FROM json_each(?))",
      [ids],
    ),
    raw(
      `UPDATE core_outside_match SET candidates = (
         SELECT json_group_array(c.value) FROM json_each(core_outside_match.candidates) c
         WHERE c.value NOT IN (SELECT value FROM json_each(?1)))
       WHERE kind = 'person' AND EXISTS (
         SELECT 1 FROM json_each(core_outside_match.candidates) c
         WHERE c.value IN (SELECT value FROM json_each(?1)))`,
      [ids],
    ),
  );
}
