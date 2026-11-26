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
//   Never deleted: a row linked to another Person or to a staff account, whatever address it
//   lists (`keptByLink`, the one function a load holds to as well, so a later load does not drop
//   it for P's address either). With each deleted row go its memberships, passes, bookings and To
//   match rows.
//
// B. What is SUPPRESSED and what becomes a SEARCH TERM:
//   - The addresses: P's own and those of every deleted row are suppressed and become terms,
//     EXCEPT a shared address: one another identified Person or customer account holds (A.1 rows
//     included: a husband's staff-linked row listing his wife's address), and one a row kept
//     because it is linked to someone else still lists (a family member staff-linked to their own
//     Person on the same mailbox: suppressing it would drop them at every later load). P's own
//     live addresses go on the core erased-address list and into the erase's terms whatever this
//     says (ADR 0320): "shared" here is about the copy's suppression only.
//   - Refs are suppressed for rows linked to P (A.1), and for coaches deleted under A.3 whose
//     address no one else holds (it can only be P's). For rows deleted under A.2 (linked to
//     nobody, possibly a family member's) no ref is suppressed: their address keeps them out, and
//     if the booking system later gives such a row another address it comes back.
//   - Every address the erase considered is recorded for the erase, suppressed or not
//     (`core_outside_suppressed_erase`), so consent finds that erase's own refs even when the
//     address was shared.
//   - Names become terms only from rows linked to P. The copy's own free text (class titles, class
//     types) is scrubbed of the full names (outside/names.ts) of the rows linked to P, the coaches
//     deleted as P's, and P's own Person record.
//   - Refs never become free-text terms (a booking system's numeric ids collide with ordinary text).
//
// C. The result always has the `bookingSystem` block when the copy exists (a list is current or
// anything was found): rows deleted by link, deleted as unlinked on P's own address, coaches
// deleted, rows kept because linked to someone else, rows left waiting in To match because another
// Person holds the address, rows linked to nobody listing P's name on someone else's address
// (left: they cannot be told apart from a namesake), addresses not suppressed because shared (a
// count, never the address), and `copyRemains: true` with its note.
//
// Every statement binds at most a few parameters (lists go as one JSON parameter), and their
// number does not grow with the copy, but for the free-text scrub (at most 100 rows a statement).
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, type SqlBool, sql } from "kysely";
import { foldedSql, normaliseCustomerEmail } from "../customers/accounts.ts";
import type { HandlerContext } from "../operation.ts";
import { chunk, jsonList } from "../records/common.ts";
import {
  assertSuppressionSalt,
  foldOutside,
  keptByLink,
  linkActivityStatements,
  outsideAddressHash,
  outsideRefHash,
  personsByFolded,
  saltFingerprint,
  unlinkedOf,
} from "./match.ts";
import { isFullName, scrubNames, wholeName } from "./names.ts";
import { onCurrentList } from "./settings.ts";

type Db = Kysely<CoreDatabase>;

const raw = (text: string, params: unknown[] = []) => CompiledQuery.raw(text, params);
const json = (values: readonly string[]) => JSON.stringify([...new Set(values)]);

/** Full names scrubbed from the copy's free text (class titles, class types). */
export const MAX_SCRUBBED_NAMES = 20;

/** A name as two names compare: NFC, any case. */
const nameKey = (name: string) =>
  name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

/** What of the booking system's copy an erase of P deletes, suppresses and reports. */
export interface OutsideSubject {
  /** A.1: refs of outside people linked to P. Deleted, and suppressed. */
  linkedRefs: string[];
  /** A.2: refs of unlinked outside people on P's own address. Deleted, never suppressed. */
  unlinkedRefs: string[];
  /** A.3: refs of coaches on P's address with no staff account. Deleted. */
  staffRefs: string[];
  /** A.3: of those, the refs suppressed: no one else holds their address. */
  staffRefsSuppressed: string[];
  /** B: the addresses suppressed and made terms (normalised): every one not shared. */
  addresses: string[];
  /** B: every address the erase considered (P's own and the deleted rows'), shared or not. */
  considered: string[];
  /** B: how many of P's or the deleted rows' addresses are shared, so not suppressed. */
  sharedAddresses: number;
  /** Bookings' person refs that go: the deleted rows' refs, and `email:<address>` not shared. */
  bookingRefs: string[];
  /** B: names from rows linked to P (A.1) only. */
  names: string[];
  /** Full names scrubbed from the copy's text: linked rows', deleted coaches', P's own. */
  fullNames: string[];
  /** C: rows on P's addresses kept because linked to another Person or a staff account. */
  keptLinkedToOthers: number;
  /** C: unlinked rows on P's address left waiting, because another Person holds it. */
  keptWaiting: number;
  /** C: unlinked rows listing P's full name on an address someone else holds: left. */
  keptNamedElsewhere: number;
  /** C: whether the copy exists (a current list, or anything found). */
  exists: boolean;
}

/** A suppression row as the erase log carries it (`suppressed: false`: considered, left). */
export interface SuppressedHash {
  hash: string;
  kind: "ref" | "address";
  suppressed?: boolean;
}

/** What an erase did to the copy, for its result and the erase log. */
export interface OutsideErased {
  deletedLinked: number;
  deletedUnlinked: number;
  coaches: number;
  keptLinkedToOthers: number;
  keptWaiting: number;
  keptNamedElsewhere: number;
  sharedAddresses: number;
  /** Classes and class types whose free text named them, scrubbed. */
  textScrubbed: number;
  exists: boolean;
  /** Every hash the erase recorded (`suppressed: false` for one it considered and left). */
  suppressed: SuppressedHash[];
  eraseId: string;
  fingerprint: string;
}

/**
 * Rule A and B for the Persons `recordIds` (P and anyone merged into them) with `addresses`
 * (theirs, current and former) and `personNames` (their records' names): a handful of indexed
 * reads, whatever the copy holds. Read before the erase builds its terms. A removed list's rows
 * still waiting for removal are deleted too, but never count as a row that is kept. Refuses first
 * when the suppressions' salt is not the one in use (an erase then would write rows no restore
 * could match).
 */
export async function outsideOf(
  db: Db,
  recordIds: readonly string[],
  addresses: readonly string[],
  personNames: readonly string[] = [],
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
  const ownCoaches = coachesOnOwn.filter((c) => !keptByLink({ to: c.user_id }));

  // Who else holds an address, folded as matching folds it: another live Person, or a customer
  // account that is not P's (the erase's own rule for sign-in addresses, #302), both folded.
  const listedByLinked = linked.map((r) => r.address).filter((a): a is string => a !== null);
  const candidates = [...new Set([...own, ...listedByLinked])];
  const candidateFolded = [...new Set(candidates.map(fold))];
  const [persons, accounts] = await Promise.all([
    personsByFolded(db, candidateFolded),
    candidateFolded.length
      ? db
          .selectFrom("core_customer")
          .select(["email", "person_id"])
          .where(foldedSql("email"), "in", jsonList(candidateFolded))
          .execute()
      : [],
  ]);
  const accountsFolded = new Set(
    accounts
      .filter((a) => a.person_id === null || !ids.has(a.person_id))
      .map((a) => fold(a.email.trim().toLowerCase())),
  );
  const heldByOthers = (address: string) =>
    (persons.get(fold(address)) ?? []).some((id) => !ids.has(id)) ||
    accountsFolded.has(fold(address));

  // A.2: unlinked rows on one of P's own addresses that no other Person or account holds.
  const unlinked = onOwn.filter(
    (r) =>
      !keptByLink({ to: r.person_id }) &&
      r.address_folded !== null &&
      !heldByOthers(r.address_folded),
  );
  const unlinkedRefs = unlinked.map((r) => r.ref).filter((ref) => !linkedRefs.includes(ref));
  // C: rows on P's own address that stay: linked to another Person, or waiting for staff because
  // another Person holds the address. Only a current list's rows count.
  const staying = onOwn.filter(
    (r) =>
      currentIds.has(r.list_id) && !linkedRefs.includes(r.ref) && !unlinkedRefs.includes(r.ref),
  );
  const keptLinkedToOthers =
    staying.filter((r) => keptByLink({ to: r.person_id }, ids)).length +
    coachesOnOwn.filter((c) => keptByLink({ to: c.user_id }) && currentIds.has(c.list_id)).length;
  const keptWaiting = staying.filter((r) => !keptByLink({ to: r.person_id })).length;

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
      .filter((r) => !deletedRefs.has(r.ref) && keptByLink({ to: r.person_id }, ids))
      .map((r) => r.address_folded),
  );
  for (const c of coachesOnOwn) {
    if (keptByLink({ to: c.user_id }) && c.address !== null) sharedByKeptRow.add(fold(c.address));
  }
  const isShared = (a: string) => heldByOthers(a) || sharedByKeptRow.has(fold(a));
  const suppressedAddresses = all.filter((a) => !isShared(a));

  // B: names only from rows linked to P (never a row linked to nobody: it may be a family
  // member's). The one list both the terms and the free-text scrub take them from.
  const named = linked;
  // The copy's free text is scrubbed of the full names (outside/names.ts: two words or more) of
  // the rows linked to P, the coaches deleted as P's, and P's own Person record.
  const fullNames = [
    ...new Map(
      [
        ...named.map((p) => [p.given_name, p.family_name].filter(Boolean).join(" ")),
        ...ownCoaches.map((c) => c.display_name),
        ...personNames,
      ]
        .map((n) => n.normalize("NFC").trim())
        .filter(isFullName)
        .map((n) => [nameKey(n), n] as const),
    ).values(),
  ].slice(0, MAX_SCRUBBED_NAMES);

  // C: rows linked to nobody listing P's own full name on an address that is not theirs (a child
  // on a parent's mailbox): left, as they cannot be told from a namesake; staff are told how many.
  const personKeys = new Set(personNames.filter(isFullName).map(nameKey));
  const unlinkedElsewhere = personKeys.size
    ? await db
        .selectFrom("core_outside_person")
        .select(["ref", "given_name", "family_name"])
        .where("person_id", "is", null)
        .where(onCurrentList("list_id"))
        .execute()
    : [];
  const keptNamedElsewhere = unlinkedElsewhere.filter(
    (r) =>
      !deletedRefs.has(r.ref) &&
      personKeys.has(nameKey([r.given_name, r.family_name].filter(Boolean).join(" "))),
  ).length;

  return {
    linkedRefs,
    unlinkedRefs,
    staffRefs: ownCoaches.map((c) => c.ref),
    // A.3: a coach's ref is suppressed when no one else holds its address: it can only be P's.
    staffRefsSuppressed: ownCoaches
      .filter((c) => c.address !== null && !isShared(c.address))
      .map((c) => c.ref),
    addresses: suppressedAddresses,
    considered: all,
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
    keptNamedElsewhere,
    exists:
      current.length > 0 || linked.length > 0 || unlinked.length > 0 || coachesOnOwn.length > 0,
  };
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
  const suppressedSet = new Set(found.addresses);
  const [
    refHashes,
    staffSuppressedHashes,
    consideredHashes,
    fingerprint,
    unlinkedHashes,
    staffHashes,
  ] = await Promise.all([
    // B: refs only of rows linked to P, and of coaches no one else's.
    Promise.all(found.linkedRefs.map((ref) => outsideRefHash(ctx.db, "person", ref))),
    Promise.all(found.staffRefsSuppressed.map((ref) => outsideRefHash(ctx.db, "staff", ref))),
    Promise.all(
      found.considered.map(async (a) => ({
        hash: await outsideAddressHash(ctx.db, a),
        suppressed: suppressedSet.has(a),
      })),
    ),
    saltFingerprint(ctx.db),
    Promise.all(refs.map((ref) => outsideRefHash(ctx.db, "person", ref))),
    Promise.all(staffRefs.map((ref) => outsideRefHash(ctx.db, "staff", ref))),
  ]);
  const recorded: SuppressedHash[] = [
    ...[...refHashes, ...staffSuppressedHashes].map((hash) => ({ hash, kind: "ref" as const })),
    ...consideredHashes.map((h) => ({
      hash: h.hash,
      kind: "address" as const,
      ...(h.suppressed ? {} : { suppressed: false }),
    })),
  ];
  const eraseId = `ose_${crypto.randomUUID().replaceAll("-", "")}`;

  // Their full names in the booking system's own text the copy holds (a class "Strength with
  // <name>"), matched in code (outside/names.ts), never by SQLite's ASCII-only lower(): every
  // class and class type is read (a timetable holds at most 5,000 classes), and only the rows that
  // change are written, 100 a statement.
  let textScrubbed = 0;
  if (found.fullNames.length) {
    const names = found.fullNames.map(wholeName);
    const [classes, types] = await Promise.all([
      ctx.db.selectFrom("core_outside_class").select(["ref", "title"]).execute(),
      ctx.db.selectFrom("core_outside_class_type").select(["ref", "name", "description"]).execute(),
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
      [json(unlinkedHashes), json(staffHashes)],
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
      recorded.map((s) => ({ ...s, eraseId, fingerprint })),
      ctx.now,
    ),
  );
  return {
    deletedLinked: found.linkedRefs.length,
    deletedUnlinked: found.unlinkedRefs.length,
    coaches: staffRefs.length,
    keptLinkedToOthers: found.keptLinkedToOthers,
    keptWaiting: found.keptWaiting,
    keptNamedElsewhere: found.keptNamedElsewhere,
    sharedAddresses: found.sharedAddresses,
    textScrubbed,
    exists: found.exists,
    suppressed: recorded,
    eraseId,
    fingerprint,
  };
}

/**
 * Writes an erase's hashes (an erase's, or `erasure.reapply`'s from the erase log): a suppression
 * for each one suppressed (once, however many erases), and a row per erase for every hash it
 * recorded, suppressed or only considered (`core_outside_suppressed_erase`), so consent lifts
 * exactly one erase's own.
 */
export function suppressStatements(
  hashes: readonly (SuppressedHash & { eraseId: string | null; fingerprint: string | null })[],
  now: string,
): CompiledQuery[] {
  if (!hashes.length) return [];
  const rows = JSON.stringify(
    hashes.map((h) => ({ ...h, suppressed: h.suppressed === false ? 0 : 1 })),
  );
  return [
    raw(
      "INSERT INTO core_outside_suppressed (hash, kind, created_at, fingerprint) SELECT json_extract(value, '$.hash'), json_extract(value, '$.kind'), ?, json_extract(value, '$.fingerprint') FROM json_each(?) WHERE json_extract(value, '$.kind') IN ('ref', 'address') AND json_extract(value, '$.suppressed') = 1 ON CONFLICT (hash) DO NOTHING",
      [now, rows],
    ),
    raw(
      "INSERT INTO core_outside_suppressed_erase (hash, erase_id, kind, suppressed) SELECT json_extract(value, '$.hash'), json_extract(value, '$.eraseId'), json_extract(value, '$.kind'), json_extract(value, '$.suppressed') FROM json_each(?) WHERE json_extract(value, '$.eraseId') IS NOT NULL AND json_extract(value, '$.kind') IN ('ref', 'address') ON CONFLICT (hash, erase_id) DO NOTHING",
      [rows],
    ),
  ];
}

/**
 * Consent to come back (`erasure.allowAddress`): read from the erases that recorded the address,
 * suppressed or not. When exactly one erase did, consent is that erase's Person's: its refs and
 * its suppression of the address go (a ref another erase also suppressed stays). When several
 * did, whose consent this is cannot be told: nothing of any erase is lifted, and their refs are
 * counted (`refsLeft`) for a person with records:erase to lift the right one with
 * `outside.suppression.lift`. The address's own suppression stays then too, as it may be another
 * erase's.
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
  eraseId: string | null;
}> {
  const hash = await outsideAddressHash(db, address);
  const erases = (
    await db
      .selectFrom("core_outside_suppressed_erase")
      .select(["erase_id", "suppressed"])
      .where("hash", "=", hash)
      .execute()
  ).map((r) => r.erase_id);
  if (!erases.length) {
    return { statements: [], addresses: 0, refs: 0, refsLeft: 0, hashes: [], eraseId: null };
  }
  const refsOf = await db
    .selectFrom("core_outside_suppressed_erase")
    .select(["hash", "erase_id"])
    .where("kind", "=", "ref")
    .where("erase_id", "in", erases)
    .where("suppressed", "=", 1)
    .execute();
  if (erases.length > 1) {
    return {
      statements: [],
      addresses: 0,
      refs: 0,
      refsLeft: refsOf.length,
      hashes: [],
      eraseId: null,
    };
  }
  // A ref another erase also suppressed stays.
  const others = refsOf.length
    ? new Set(
        (
          await db
            .selectFrom("core_outside_suppressed_erase")
            .select("hash")
            .where(
              "hash",
              "in",
              refsOf.map((r) => r.hash),
            )
            .where("erase_id", "not in", erases)
            .execute()
        ).map((r) => r.hash),
      )
    : new Set<string>();
  const refs = refsOf.map((r) => r.hash).filter((h) => !others.has(h));
  const addressRow = await db
    .selectFrom("core_outside_suppressed")
    .select("hash")
    .where("kind", "=", "address")
    .where("hash", "=", hash)
    .executeTakeFirst();
  const hashes: SuppressedHash[] = [
    ...(addressRow ? [{ hash, kind: "address" as const }] : []),
    ...refs.map((h) => ({ hash: h, kind: "ref" as const })),
  ];
  const lifted = JSON.stringify(hashes.map((h) => h.hash));
  return {
    statements: [
      raw("DELETE FROM core_outside_suppressed WHERE hash IN (SELECT value FROM json_each(?))", [
        lifted,
      ]),
      // This erase's record of them, and of the address, goes with them.
      raw(
        "DELETE FROM core_outside_suppressed_erase WHERE erase_id = ? AND (hash = ? OR hash IN (SELECT value FROM json_each(?)))",
        [erases[0], hash, lifted],
      ),
    ],
    addresses: addressRow ? 1 : 0,
    refs: refs.length,
    refsLeft: refsOf.length - refs.length,
    hashes,
    eraseId: erases[0] ?? null,
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
