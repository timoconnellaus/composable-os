// Erase, merge and purge reaching the booking system's copy (stage 65 step 10, ADR 0926).
//
// - **Erase** (`person.erase`, through `queueErase`): see the rule below.
// - **Merge** (`person.merge`): links move to the survivor, the duplicate leaves To match's
//   candidates (the survivor takes its place), and an outside person who waited only because the
//   two were two Persons is linked now, by address.
// - **Purge** (`trash.purge`): a purged Person's links go (an outside person stays in the copy,
//   unlinked, as the booking system lists them: a purge is not an erasure request).
//
// THE RULE, when Person P is erased. Two separate questions.
//
// A. Which rows are DELETED from the copy (`outsideOf`):
//   A.1 every outside person linked to P (by address or by staff);
//   A.2 every outside person linked to nobody, listed with one of P's own addresses (folded, as
//       matching folds them), where no OTHER identified Person or customer account holds that
//       address, however many unlinked rows share it: they can only be P's household's unmatched
//       copies, and the next load would drop them anyway (the erased-address list);
//   A.3 every coach on P's address (folded) linked to no staff account.
//   Never deleted: a row linked to another live Person or to a staff account, whatever address
//   it lists. With each deleted row go its memberships, passes, bookings and To match rows.
//
// B. What is SUPPRESSED and what becomes a SEARCH TERM:
//   - The addresses: P's own and those of every deleted row are suppressed and become terms,
//     EXCEPT a shared address: one another identified Person or customer account holds (A.1 rows
//     included: a husband's staff-linked row listing his wife's address), and one a row kept
//     because it is linked to someone else still lists (a family member staff-linked to their own
//     Person on the same mailbox: suppressing it would drop them at every later load).
//   - Refs are suppressed only for rows linked to P (A.1). For rows deleted under A.2 or A.3 (linked
//     to nobody, possibly a family member's) no ref is suppressed: their address keeps them out.
//   - Names become terms only from rows linked to P. The copy's own free text (class titles, class
//     types) is scrubbed of the full names, two words or more, as whole words in any case, of the
//     rows linked to P and the coaches deleted as P's.
//   - Refs never become free-text terms (a booking system's numeric ids collide with ordinary text).
//
// C. The result always has the `bookingSystem` block when the copy exists (a list is current or
// anything was found): rows deleted by link, deleted as unlinked on P's own address, coaches
// deleted, rows kept because linked to someone else, rows left waiting in To match because another
// Person holds the address, addresses not suppressed because shared (a count, never the address),
// and `copyRemains: true` with its note.
//
// Every statement binds at most a few parameters (lists go as one JSON parameter), and their
// number does not grow with the copy, but for the free-text scrub (at most 100 rows a statement).
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, type SqlBool, sql } from "kysely";
import { normaliseCustomerEmail } from "../customers/accounts.ts";
import type { HandlerContext } from "../operation.ts";
import { chunk, jsonList } from "../records/common.ts";
import { addressesHeldByOthers } from "../records/erase-subject.ts";
import {
  assertSuppressionSalt,
  foldOutside,
  linkActivityStatements,
  outsideAddressHash,
  outsideRefHash,
  personsByFolded,
  saltFingerprint,
  unlinkedOf,
} from "./match.ts";
import { onCurrentList } from "./settings.ts";

type Db = Kysely<CoreDatabase>;

const raw = (text: string, params: unknown[] = []) => CompiledQuery.raw(text, params);
const json = (values: readonly string[]) => JSON.stringify([...new Set(values)]);

/** Full names scrubbed from the copy's free text (class titles, class types). */
export const MAX_SCRUBBED_NAMES = 20;

/** What of the booking system's copy an erase of P deletes, suppresses and reports. */
export interface OutsideSubject {
  /** A.1: refs of outside people linked to P. Deleted, and suppressed. */
  linkedRefs: string[];
  /** A.2: refs of unlinked outside people on P's own address. Deleted, never suppressed. */
  unlinkedRefs: string[];
  /** A.3: refs of coaches on P's address with no staff account. Deleted, never suppressed. */
  staffRefs: string[];
  /** B: the addresses suppressed and made terms (normalised): every one not shared. */
  addresses: string[];
  /** B: how many of P's or the deleted rows' addresses are shared, so neither. */
  sharedAddresses: number;
  /** Bookings' person refs that go: the deleted rows' refs, and `email:<address>` not shared. */
  bookingRefs: string[];
  /** B: names from rows linked to P (A.1) only. */
  names: string[];
  /** Full names (two words or more) of rows linked to P and coaches deleted, scrubbed from text. */
  fullNames: string[];
  /** C: rows on P's addresses kept because linked to another Person or a staff account. */
  keptLinkedToOthers: number;
  /** C: unlinked rows on P's address left waiting, because another Person holds it. */
  keptWaiting: number;
  /** C: whether the copy exists (a current list, or anything found). */
  exists: boolean;
}

/** A suppression row as the erase log carries it. */
export interface SuppressedHash {
  hash: string;
  kind: "ref" | "address";
}

/** What an erase did to the copy, for its result and the erase log. */
export interface OutsideErased {
  deletedLinked: number;
  deletedUnlinked: number;
  coaches: number;
  keptLinkedToOthers: number;
  keptWaiting: number;
  sharedAddresses: number;
  /** Classes and class types whose free text named them, scrubbed. */
  textScrubbed: number;
  exists: boolean;
  /** Hashes now in `core_outside_suppressed`, the erase they came from and the salt's fingerprint. */
  suppressed: SuppressedHash[];
  eraseId: string;
  fingerprint: string;
}

/**
 * Rule A and B for the Persons `recordIds` (P and anyone merged into them) with `addresses`
 * (theirs, current and former): a handful of indexed reads, whatever the copy holds. Read before
 * the erase builds its terms. A removed list's rows still waiting for removal are deleted too, but
 * never count as a row that is kept. Refuses first when the suppressions' salt is not the one in
 * use (an erase then would write rows no restore could match).
 */
export async function outsideOf(
  db: Db,
  recordIds: readonly string[],
  addresses: readonly string[],
): Promise<OutsideSubject> {
  await assertSuppressionSalt(db);
  const own = [
    ...new Set(
      addresses.map((a) => normaliseCustomerEmail(a)).filter((a): a is string => a !== null),
    ),
  ];
  const fold = (a: string) => foldOutside(a) ?? a;
  const ownFolded = [...new Set(own.map(fold))];
  const ids = new Set(recordIds);
  const [linked, onOwn, coaches, current] = await Promise.all([
    db
      .selectFrom("core_outside_person")
      .select(["ref", "address", "given_name", "family_name"])
      .where("person_id", "in", jsonList([...recordIds]))
      .execute(),
    db
      .selectFrom("core_outside_person")
      .select([
        "ref",
        "address",
        "address_folded",
        "person_id",
        "list_id",
        "given_name",
        "family_name",
      ])
      .where("address_folded", "in", jsonList(ownFolded))
      .execute(),
    db
      .selectFrom("core_outside_staff")
      .select(["ref", "address", "display_name", "user_id", "list_id"])
      .where("address", "is not", null)
      .execute(),
    db.selectFrom("core_outside_list").select("id").where("state", "=", "current").execute(),
  ]);
  const currentIds = new Set(current.map((l) => l.id));
  const linkedRefs = linked.map((r) => r.ref);
  const coachesOnOwn = coaches.filter(
    (c) => c.address !== null && ownFolded.includes(fold(c.address)),
  );
  const ownCoaches = coachesOnOwn.filter((c) => c.user_id === null);

  // Who else holds an address, folded as matching folds it: another live Person (by its folded
  // form), or a customer account not P's (the erase's own rule for sign-in addresses, #302).
  const listedByLinked = linked.map((r) => r.address).filter((a): a is string => a !== null);
  const candidates = [...new Set([...own, ...listedByLinked])];
  const [persons, accounts] = await Promise.all([
    personsByFolded(db, [...new Set(candidates.map(fold))]),
    addressesHeldByOthers(db, candidates, recordIds),
  ]);
  const accountsFolded = new Set([...accounts].map((a) => fold(a.trim().toLowerCase())));
  const heldByOthers = (address: string) =>
    (persons.get(fold(address)) ?? []).some((id) => !ids.has(id)) ||
    accountsFolded.has(fold(address));

  // A.2: unlinked rows on one of P's own addresses that no other Person or account holds.
  const unlinked = onOwn.filter(
    (r) => r.person_id === null && r.address_folded !== null && !heldByOthers(r.address_folded),
  );
  const unlinkedRefs = unlinked.map((r) => r.ref).filter((ref) => !linkedRefs.includes(ref));
  // C: rows on P's own address that stay: linked to another Person, or waiting for staff because
  // another Person holds the address. Only a current list's rows count.
  const staying = onOwn.filter(
    (r) =>
      currentIds.has(r.list_id) && !linkedRefs.includes(r.ref) && !unlinkedRefs.includes(r.ref),
  );
  const keptLinkedToOthers =
    staying.filter((r) => r.person_id !== null && !ids.has(r.person_id)).length +
    coachesOnOwn.filter((c) => c.user_id !== null && currentIds.has(c.list_id)).length;
  const keptWaiting = staying.filter((r) => r.person_id === null).length;

  // B: an address a row kept because it is linked to someone else still lists is shared too.
  const deletedAddresses = [
    ...listedByLinked,
    ...unlinked.map((r) => r.address).filter((a): a is string => a !== null),
    ...ownCoaches.map((c) => c.address).filter((a): a is string => a !== null),
  ];
  const all = [...new Set([...own, ...deletedAddresses])];
  const deletedRefs = new Set([...linkedRefs, ...unlinkedRefs]);
  // Rows the erase keeps that are linked to someone else (a current list's): their addresses.
  const keptRows = all.length
    ? await db
        .selectFrom("core_outside_person")
        .select(["ref", "address_folded", "person_id"])
        .where("address_folded", "in", jsonList([...new Set(all.map(fold))]))
        .where("person_id", "is not", null)
        .where(onCurrentList("list_id"))
        .execute()
    : [];
  const sharedByKeptRow = new Set(
    keptRows
      .filter((r) => !deletedRefs.has(r.ref) && r.person_id !== null && !ids.has(r.person_id))
      .map((r) => r.address_folded),
  );
  for (const c of coachesOnOwn) {
    if (c.user_id !== null && c.address !== null) sharedByKeptRow.add(fold(c.address));
  }
  const isShared = (a: string) => heldByOthers(a) || sharedByKeptRow.has(fold(a));
  const suppressedAddresses = all.filter((a) => !isShared(a));

  // B: names only from rows linked to P (never a row linked to nobody: it may be a family
  // member's). The one list both the terms and the free-text scrub take them from.
  const named = linked;
  // The copy's free text is scrubbed of the full names (two words or more, never one word: it
  // would hit ordinary words) of the rows linked to P and of the coaches deleted as P's.
  const fullNames = [
    ...new Set(
      [
        ...named.map((p) => [p.given_name, p.family_name].filter(Boolean).join(" ")),
        ...ownCoaches.map((c) => c.display_name),
      ]
        .map((n) => n.trim())
        .filter((n) => /\S\s+\S/.test(n)),
    ),
  ].slice(0, MAX_SCRUBBED_NAMES);
  return {
    linkedRefs,
    unlinkedRefs,
    staffRefs: ownCoaches.map((c) => c.ref),
    addresses: suppressedAddresses,
    sharedAddresses: all.length - suppressedAddresses.length,
    bookingRefs: [...deletedRefs, ...suppressedAddresses.map((a) => `email:${a}`)],
    names: [
      ...new Set(
        named
          .flatMap((p) => [p.given_name, p.family_name])
          .filter((n): n is string => typeof n === "string" && n.trim().length > 0),
      ),
    ],
    fullNames,
    keptLinkedToOthers,
    keptWaiting,
    exists:
      current.length > 0 || linked.length > 0 || unlinked.length > 0 || coachesOnOwn.length > 0,
  };
}

/** `name` as a whole word or words, any case: never inside a longer word. */
function wholeName(name: string): RegExp {
  const escaped = name
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, "giu");
}

/** Text with each of `names` replaced by `[erased]` as a whole word; null when nothing matched. */
function scrubNames(text: string | null, names: readonly RegExp[]): string | null {
  if (text === null) return null;
  let out = text;
  for (const re of names) out = out.replace(re, (_m, pre: string) => `${pre}[erased]`);
  return out === text ? null : out;
}

/**
 * Queues the erase of `found` from the copy, and its suppression, for the Persons `recordIds`:
 * about ten set-based statements whatever the copy holds, and the free-text scrub's rows at most
 * 100 a statement. Nothing here is held by a guarded state or a hold: the copy is core rows with
 * no states, no Trash and no write guard (ADRs 0863 and 0865 hold record writes, not the host's
 * own removals).
 */
export async function queueEraseOutside(
  ctx: HandlerContext,
  recordIds: readonly string[],
  found: OutsideSubject,
): Promise<OutsideErased> {
  const refs = [...found.linkedRefs, ...found.unlinkedRefs];
  const { staffRefs } = found;
  const [refHashes, addressHashes, fingerprint, linkedStaffHashes, unlinkedHashes] =
    await Promise.all([
      // B: refs only of rows linked to P.
      Promise.all(found.linkedRefs.map((ref) => outsideRefHash(ctx.db, "person", ref))),
      Promise.all(found.addresses.map((a) => outsideAddressHash(ctx.db, a))),
      saltFingerprint(ctx.db),
      Promise.all(staffRefs.map((ref) => outsideRefHash(ctx.db, "staff", ref))),
      Promise.all(refs.map((ref) => outsideRefHash(ctx.db, "person", ref))),
    ]);
  const suppressed: SuppressedHash[] = [
    ...refHashes.map((hash) => ({ hash, kind: "ref" as const })),
    ...addressHashes.map((hash) => ({ hash, kind: "address" as const })),
  ];
  const eraseId = `ose_${crypto.randomUUID().replaceAll("-", "")}`;

  // Their names in the booking system's own text the copy holds (a class "Strength with <name>"),
  // as whole words, any case; read only where a name might be, written 100 rows a statement.
  let textScrubbed = 0;
  if (found.fullNames.length) {
    const names = found.fullNames.map(wholeName);
    const like = JSON.stringify(found.fullNames.map((n) => n.toLowerCase()));
    const [classes, types] = await Promise.all([
      ctx.db
        .selectFrom("core_outside_class as c")
        .select(["c.ref", "c.title"])
        .where(
          sql<SqlBool>`EXISTS (SELECT 1 FROM json_each(${like}) WHERE instr(lower(c.title), value) > 0)`,
        )
        .execute(),
      ctx.db
        .selectFrom("core_outside_class_type as t")
        .select(["t.ref", "t.name", "t.description"])
        .where(
          sql<SqlBool>`EXISTS (SELECT 1 FROM json_each(${like}) WHERE instr(lower(t.name || ' ' || coalesce(t.description, '')), value) > 0)`,
        )
        .execute(),
    ]);
    const classRows = classes.flatMap((c) => {
      const title = scrubNames(c.title, names);
      return title === null ? [] : [{ ref: c.ref, title }];
    });
    const typeRows = types.flatMap((t) => {
      const name = scrubNames(t.name, names);
      const description = scrubNames(t.description, names);
      return name === null && description === null
        ? []
        : [{ ref: t.ref, name: name ?? t.name, description: description ?? t.description }];
    });
    textScrubbed = classRows.length + typeRows.length;
    for (const part of chunk(classRows, 100)) {
      ctx.write(
        raw(
          "UPDATE core_outside_class SET title = (SELECT json_extract(value, '$.title') FROM json_each(?1) WHERE json_extract(value, '$.ref') = core_outside_class.ref) WHERE ref IN (SELECT json_extract(value, '$.ref') FROM json_each(?1))",
          [JSON.stringify(part)],
        ),
      );
    }
    for (const part of chunk(typeRows, 100)) {
      ctx.write(
        raw(
          "UPDATE core_outside_class_type SET name = (SELECT json_extract(value, '$.name') FROM json_each(?1) WHERE json_extract(value, '$.ref') = core_outside_class_type.ref), description = (SELECT json_extract(value, '$.description') FROM json_each(?1) WHERE json_extract(value, '$.ref') = core_outside_class_type.ref) WHERE ref IN (SELECT json_extract(value, '$.ref') FROM json_each(?1))",
          [JSON.stringify(part)],
        ),
      );
    }
  }

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
    // Staff's "nobody here" about the rows deleted: no row is left for it to be about.
    raw(
      "DELETE FROM core_outside_unlinked WHERE (kind = 'person' AND hash IN (SELECT value FROM json_each(?))) OR (kind = 'staff' AND hash IN (SELECT value FROM json_each(?)))",
      [json(unlinkedHashes), json(linkedStaffHashes)],
    ),
    // Their classes name no coach.
    raw(
      "UPDATE core_outside_class SET staff_ref = NULL WHERE staff_ref IN (SELECT value FROM json_each(?))",
      [json(staffRefs)],
    ),
    raw("DELETE FROM core_outside_staff WHERE ref IN (SELECT value FROM json_each(?))", [
      json(staffRefs),
    ]),
    raw("DELETE FROM core_outside_person WHERE ref IN (SELECT value FROM json_each(?))", [
      json(refs),
    ]),
  );
  ctx.write(
    ...suppressStatements(
      suppressed.map((s) => ({ ...s, eraseId, fingerprint })),
      ctx.now,
    ),
  );
  return {
    deletedLinked: found.linkedRefs.length,
    deletedUnlinked: found.unlinkedRefs.length,
    coaches: staffRefs.length,
    keptLinkedToOthers: found.keptLinkedToOthers,
    keptWaiting: found.keptWaiting,
    sharedAddresses: found.sharedAddresses,
    textScrubbed,
    exists: found.exists,
    suppressed,
    eraseId,
    fingerprint,
  };
}

/**
 * Writes suppression hashes (an erase's, or `erasure.reapply`'s from the erase log): the hash once,
 * and a row per erase that suppressed it (`core_outside_suppressed_erase`), so consent lifts
 * exactly one erase's refs.
 */
export function suppressStatements(
  hashes: readonly (SuppressedHash & { eraseId: string | null; fingerprint: string | null })[],
  now: string,
): CompiledQuery[] {
  if (!hashes.length) return [];
  const rows = JSON.stringify(hashes);
  return [
    raw(
      "INSERT INTO core_outside_suppressed (hash, kind, created_at, fingerprint) SELECT json_extract(value, '$.hash'), json_extract(value, '$.kind'), ?, json_extract(value, '$.fingerprint') FROM json_each(?) WHERE json_extract(value, '$.kind') IN ('ref', 'address') ON CONFLICT (hash) DO NOTHING",
      [now, rows],
    ),
    raw(
      "INSERT INTO core_outside_suppressed_erase (hash, erase_id, kind) SELECT json_extract(value, '$.hash'), json_extract(value, '$.eraseId'), json_extract(value, '$.kind') FROM json_each(?) WHERE json_extract(value, '$.eraseId') IS NOT NULL AND json_extract(value, '$.kind') IN ('ref', 'address') ON CONFLICT (hash, erase_id) DO NOTHING",
      [rows],
    ),
  ];
}

/**
 * Consent to come back (`erasure.allowAddress`): the address's suppression goes. The refs of the
 * erase that suppressed it go too, when exactly one erase did (they were that Person's; their own
 * consent lifts them). When several erases suppressed the address, whose consent this is cannot be
 * told, so no ref is lifted and they are counted (`refsLeft`): a person with records:erase lifts
 * the right one with `outside.suppression.lift`. A ref another erase also suppressed stays.
 */
export async function liftForAddress(
  db: Db,
  address: string,
): Promise<{
  statements: CompiledQuery[];
  addresses: number;
  refs: number;
  refsLeft: number;
  hashes: SuppressedHash[];
}> {
  const hash = await outsideAddressHash(db, address);
  const row = await db
    .selectFrom("core_outside_suppressed")
    .select("hash")
    .where("kind", "=", "address")
    .where("hash", "=", hash)
    .executeTakeFirst();
  if (!row) return { statements: [], addresses: 0, refs: 0, refsLeft: 0, hashes: [] };
  const erases = (
    await db
      .selectFrom("core_outside_suppressed_erase")
      .select("erase_id")
      .where("hash", "=", hash)
      .execute()
  ).map((r) => r.erase_id);
  const refsOf = erases.length
    ? await db
        .selectFrom("core_outside_suppressed_erase as e")
        .select(["e.hash", "e.erase_id"])
        .where("e.kind", "=", "ref")
        .where("e.erase_id", "in", erases)
        .execute()
    : [];
  // Only one erase's refs, and only a ref no other erase suppressed.
  const lifting = erases.length === 1 ? refsOf.map((r) => r.hash) : [];
  const others = lifting.length
    ? new Set(
        (
          await db
            .selectFrom("core_outside_suppressed_erase")
            .select("hash")
            .where("hash", "in", lifting)
            .where("erase_id", "not in", erases)
            .execute()
        ).map((r) => r.hash),
      )
    : new Set<string>();
  const refs = lifting.filter((h) => !others.has(h));
  const hashes: SuppressedHash[] = [
    { hash, kind: "address" },
    ...refs.map((h) => ({ hash: h, kind: "ref" as const })),
  ];
  const all = JSON.stringify(hashes.map((h) => h.hash));
  return {
    statements: [
      raw("DELETE FROM core_outside_suppressed WHERE hash IN (SELECT value FROM json_each(?))", [
        all,
      ]),
      raw(
        "DELETE FROM core_outside_suppressed_erase WHERE hash IN (SELECT value FROM json_each(?))",
        [all],
      ),
    ],
    addresses: 1,
    refs: refs.length,
    refsLeft: refsOf.length - refs.length,
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
