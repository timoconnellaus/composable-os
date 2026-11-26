// Erase, merge and purge reaching the booking system's copy (stage 65 step 10, ADR 0926).
//
// - **Erase** (`person.erase`, through `queueErase`): every outside person, coach, membership,
//   pass, booking, match and staff decision of the erased Person goes in the erase's own batch,
//   and their outside refs and addresses are suppressed by keyed hash (`core_outside_suppressed`),
//   so no later load, link by address or link by hand brings them back. The ids, refs, addresses
//   and names found here join the erase's terms, so the audit, approvals and conversations lose
//   them as they lose the Person's own.
// - **Merge** (`person.merge`): links move to the survivor, the duplicate leaves To match's
//   candidates (the survivor takes its place), and an outside person who waited only because the
//   two were two Persons is linked now, by address.
// - **Purge** (`trash.purge`): a purged Person's links go (an outside person stays in the copy,
//   unlinked, as the booking system lists them: a purge is not an erasure request).
//
// Which outside rows are a Person's: those linked to them (by address or by staff), and those
// listed with one of their addresses (exactly, as normalised): the erased-address list would drop
// those at the next load anyway (ADR 0320). Every statement binds at most a few parameters (lists
// go as one JSON parameter), and their number does not grow with the copy.
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
  unlinkedOf,
} from "./match.ts";

type Db = Kysely<CoreDatabase>;

const raw = (text: string, params: unknown[] = []) => CompiledQuery.raw(text, params);
const json = (values: readonly string[]) => JSON.stringify([...new Set(values)]);

/** What of the booking system's copy is an erased Person's. */
export interface OutsideSubject {
  /** Outside people's refs (the members list). */
  refs: string[];
  /** Coaches' refs (the timetable list). */
  staffRefs: string[];
  /** The addresses the copy holds for them (normalised), and the Person's own. */
  addresses: string[];
  /** Given and family names, and coaches' display names, as listed. */
  names: string[];
}

/** What an erase removed from the copy, for its result. */
export interface OutsideErased {
  people: number;
  coaches: number;
  /** Hashes now in `core_outside_suppressed` (for the erase log). */
  suppressed: { hash: string; kind: "ref" | "address" }[];
}

/**
 * The outside rows of the Persons `recordIds` (they and anyone merged into them) with
 * `addresses` (theirs, current and former): three indexed reads, whatever the copy holds. Read
 * before the erase builds its terms. Every row counts, a removed list's rows still waiting for
 * removal included.
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
  const [people, staff] = await Promise.all([
    db
      .selectFrom("core_outside_person")
      .select(["ref", "address", "given_name", "family_name"])
      .where((eb) =>
        eb.or([
          eb("person_id", "in", jsonList([...recordIds])),
          // By the folded form's index, then the exact address.
          eb.and([
            eb("address_folded", "in", jsonList(folded)),
            eb("address", "in", jsonList(exact)),
          ]),
        ]),
      )
      .execute(),
    db
      .selectFrom("core_outside_staff")
      .select(["ref", "address", "display_name"])
      .where("address", "in", jsonList(exact))
      .execute(),
  ]);
  return {
    refs: people.map((p) => p.ref),
    staffRefs: staff.map((s) => s.ref),
    addresses: [
      ...new Set([
        ...exact,
        ...[...people, ...staff].map((r) => r.address).filter((a): a is string => a !== null),
      ]),
    ],
    names: [
      ...new Set(
        [
          ...people.flatMap((p) => [p.given_name, p.family_name]),
          ...staff.map((s) => s.display_name),
        ].filter((n): n is string => typeof n === "string" && n.trim().length > 0),
      ),
    ],
  };
}

/**
 * Queues the erase of `found` from the copy, and its suppression, for the Persons `recordIds`.
 * About ten statements, whatever the copy holds: each is set based, with its lists as one JSON
 * parameter. Nothing here is held by a guarded state or a hold: the copy is core rows with no
 * states, no Trash and no write guard (ADRs 0863 and 0865 hold record writes, not the host's own
 * removals).
 */
export async function queueEraseOutside(
  ctx: HandlerContext,
  recordIds: readonly string[],
  found: OutsideSubject,
): Promise<OutsideErased> {
  const { refs, staffRefs } = found;
  // Bookings name a person by ref, or by address in a list with no ids (`email:<address>`).
  const bookingRefs = [...refs, ...found.addresses.map((a) => `email:${a}`)];
  // An address the copy still holds for someone else (a family on one mailbox) is not suppressed:
  // that would drop the others at the next load. It is theirs as much as the erased Person's.
  const sharedBy = found.addresses.length
    ? await Promise.all([
        ctx.db
          .selectFrom("core_outside_person")
          .select("address")
          .where(
            "address_folded",
            "in",
            jsonList(
              found.addresses.map((a) => foldOutside(a)).filter((a): a is string => a !== null),
            ),
          )
          .where("address", "in", jsonList(found.addresses))
          .where("ref", "not in", jsonList(refs))
          .where((eb) =>
            eb.or([
              eb("person_id", "is", null),
              eb("person_id", "not in", jsonList([...recordIds])),
            ]),
          )
          .execute(),
        ctx.db
          .selectFrom("core_outside_staff")
          .select("address")
          .where("address", "in", jsonList(found.addresses))
          .where("ref", "not in", jsonList(staffRefs))
          .execute(),
      ])
    : [[], []];
  const shared = new Set(sharedBy.flat().map((r) => r.address));
  const [refHashes, staffHashes, addressHashes] = await Promise.all([
    Promise.all(refs.map((ref) => outsideRefHash(ctx.db, "person", ref))),
    Promise.all(staffRefs.map((ref) => outsideRefHash(ctx.db, "staff", ref))),
    Promise.all(
      found.addresses.filter((a) => !shared.has(a)).map((a) => outsideAddressHash(ctx.db, a)),
    ),
  ]);
  const suppressed = [
    ...[...refHashes, ...staffHashes].map((hash) => ({ hash, kind: "ref" as const })),
    ...addressHashes.map((hash) => ({ hash, kind: "address" as const })),
  ];
  const ids = json([...recordIds]);
  ctx.write(
    raw(
      "DELETE FROM core_outside_membership WHERE person_ref IN (SELECT value FROM json_each(?))",
      [json(refs)],
    ),
    raw("DELETE FROM core_outside_booking WHERE person_ref IN (SELECT value FROM json_each(?))", [
      json(bookingRefs),
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
    raw("DELETE FROM core_outside_staff WHERE ref IN (SELECT value FROM json_each(?))", [
      json(staffRefs),
    ]),
    raw("DELETE FROM core_outside_person WHERE ref IN (SELECT value FROM json_each(?))", [
      json(refs),
    ]),
  );
  if (suppressed.length) {
    ctx.write(
      raw(
        "INSERT INTO core_outside_suppressed (hash, kind, created_at) SELECT json_extract(value, '$.hash'), json_extract(value, '$.kind'), ? FROM json_each(?) WHERE true ON CONFLICT (hash) DO NOTHING",
        [ctx.now, JSON.stringify(suppressed)],
      ),
    );
  }
  return { people: refs.length, coaches: staffRefs.length, suppressed };
}

/** Puts suppression hashes back after a restore (`erasure.reapply`, from the erase log). */
export function suppressStatement(
  hashes: readonly { hash: string; kind: "ref" | "address" }[],
  now: string,
): CompiledQuery | null {
  if (!hashes.length) return null;
  return raw(
    "INSERT INTO core_outside_suppressed (hash, kind, created_at) SELECT json_extract(value, '$.hash'), json_extract(value, '$.kind'), ? FROM json_each(?) WHERE json_extract(value, '$.kind') IN ('ref', 'address') ON CONFLICT (hash) DO NOTHING",
    [now, JSON.stringify(hashes)],
  );
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
