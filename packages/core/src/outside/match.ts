// Matching the booking system's people and coaches to the host's, by address and never merged
// (stage 65, "Matching"; ADR 0922). The rules are the contract package's `matchPeople`, shared with
// a file's dry run; this reads what only the host knows: which live Persons hold an address (by
// its folded form, ADR 0692, so `a+gym@x` and `a@x` are one person for matching and two Persons
// with them wait for staff), which staff accounts hold one, the erased-address list, the
// suppressed refs and addresses of erased Persons, and the links already held. Nothing here
// writes a Person: a link by address changes no name, address or phone, touches no customer
// account and sends nothing.
import type { CoreDatabase } from "@composable-os/db";
import {
  type HeldLink,
  type MatchOutcome,
  matchPeople,
} from "@composable-os/gatekeeper-booking-system";
import { type Kysely, sql } from "kysely";
import { foldAddress, foldedSql, normaliseCustomerEmail } from "../customers/accounts.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { sha256Ref } from "../records/erase-log.ts";
import { erasedAddressHash } from "../records/erase-subject.ts";
import { erasedAddresses } from "../sync/ingest.ts";

type Db = Kysely<CoreDatabase>;

/** The subject of the one timeline activity a link adds to a Person. It names no address. */
export const LINK_SUBJECT = "Linked to the booking system's list";

/** The Persons with a live address of each folded form (one query, however many addresses). */
export async function personsByFolded(
  db: Db,
  folded: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!folded.length) return out;
  const rows = await db
    .selectFrom("core_person_emails as e")
    .select([foldedSql("e.email").as("folded"), "e.person_id"])
    .where("e.live", "=", 1)
    .where(foldedSql("e.email"), "in", jsonList([...new Set(folded)]))
    .execute();
  for (const r of rows) {
    const list = out.get(r.folded) ?? [];
    if (!list.includes(r.person_id)) list.push(r.person_id);
    out.set(r.folded, list);
  }
  return out;
}

/** The active human staff accounts with each address (lower-cased). */
export async function usersByAddress(
  db: Db,
  addresses: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!addresses.length) return out;
  const rows = await db
    .selectFrom("core_user")
    .select([sql<string>`lower(email)`.as("address"), "id"])
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .where(sql<string>`lower(email)`, "in", jsonList([...new Set(addresses)]))
    .execute();
  for (const r of rows) out.set(r.address, [...(out.get(r.address) ?? []), r.id]);
  return out;
}

/** The hash a suppressed outside ref is kept by. */
export function suppressedRefHash(ref: string): Promise<string> {
  return sha256Ref(`outside-ref:${ref}`);
}

/**
 * What an erased Person left: the refs and the (normalised) addresses among these whose outside
 * copy must keep nothing (`core_outside_suppressed`), and the addresses on the erased-address list
 * (ADR 0320). Two reads.
 */
export async function droppedOf(
  db: Db,
  refs: readonly string[],
  addresses: readonly string[],
): Promise<{ refs: Set<string>; addresses: Set<string> }> {
  const refHashes = await Promise.all(
    [...new Set(refs)].map(async (ref) => ({ ref, hash: await suppressedRefHash(ref) })),
  );
  const addressHashes = await Promise.all(
    [...new Set(addresses)].map(async (a) => ({ address: a, hash: await erasedAddressHash(a) })),
  );
  const hashes = [...refHashes.map((h) => h.hash), ...addressHashes.map((h) => h.hash)];
  const suppressed = hashes.length
    ? new Set(
        (
          await db
            .selectFrom("core_outside_suppressed")
            .select("hash")
            .where("hash", "in", jsonList(hashes))
            .execute()
        ).map((r) => r.hash),
      )
    : new Set<string>();
  const erased = await erasedAddresses(db, [...new Set(addresses)]);
  return {
    refs: new Set(refHashes.filter((h) => suppressed.has(h.hash)).map((h) => h.ref)),
    addresses: new Set([
      ...erased,
      ...addressHashes.filter((h) => suppressed.has(h.hash)).map((h) => h.address),
    ]),
  };
}

/** A link held on an outside row. A staff link with no Person is staff saying "nobody here". */
export interface HeldOutsideLink {
  to: string | null;
  how: "address" | "staff";
  by: string | null;
  why: string | null;
  at: string;
}

export type OutsideOutcome =
  | MatchOutcome
  /** Staff unlinked them: kept, linked to nobody, and never linked by address again. */
  | { ref: string; outcome: "held_none" };

/**
 * The spec's rules 1 to 6 for each outside row, in order. `address` is the normalised address (or
 * null); `fold` gives the form two rows count as one address by; `holders` the Persons (or staff
 * accounts) with each folded address; `dropped` what an erase left.
 */
export function decideMatches(
  rows: readonly { ref: string; address: string | null }[],
  ctx: {
    fold(address: string): string | null;
    holders: ReadonlyMap<string, readonly string[]>;
    held: ReadonlyMap<string, HeldOutsideLink>;
    dropped: { refs: ReadonlySet<string>; addresses: ReadonlySet<string> };
  },
): OutsideOutcome[] {
  const byRef = new Map<string, OutsideOutcome>();
  const matched: { ref: string; email: string | null }[] = [];
  for (const r of rows) {
    if (ctx.dropped.refs.has(r.ref)) {
      byRef.set(r.ref, { ref: r.ref, outcome: "dropped", why: "suppressed" });
    } else if (r.address !== null && ctx.dropped.addresses.has(r.address)) {
      byRef.set(r.ref, { ref: r.ref, outcome: "dropped", why: "erased_address" });
    } else if (ctx.held.get(r.ref)?.how === "staff" && ctx.held.get(r.ref)?.to === null) {
      byRef.set(r.ref, { ref: r.ref, outcome: "held_none" });
    } else {
      matched.push({ ref: r.ref, email: r.address });
    }
  }
  const outcomes = matchPeople(matched, {
    normalise: ctx.fold,
    personsWith: (folded) => ctx.holders.get(folded) ?? [],
    isErased: () => false,
    isSuppressed: () => false,
    linkOf: (ref) => {
      const held = ctx.held.get(ref);
      return held?.to ? ({ person: held.to, how: held.how } satisfies HeldLink) : null;
    },
  });
  for (const o of outcomes) byRef.set(o.ref, o);
  return rows.map((r) => byRef.get(r.ref) as OutsideOutcome);
}

/** The folded form two outside people's addresses count as one by. */
export const foldOutside = (address: string): string | null => foldAddress(address);
/** A coach's address as staff accounts hold it. */
export const normaliseStaff = (address: string): string | null => normaliseCustomerEmail(address);

/**
 * Rule 6 and the dropped link, when a Person's addresses change (`person.create`, `person.update`):
 * an unlinked outside person with one of `emails` (folded) is linked now, by the same rule, without
 * waiting for a load; a link by address to this Person whose address it no longer holds is dropped
 * (and matched again at the next load). One read when no list holds the addresses; two otherwise.
 * Queues its writes and at most one timeline activity on the Person.
 */
export async function matchPersonAddresses(
  ctx: HandlerContext,
  personId: string,
  emails: readonly string[],
): Promise<void> {
  const folded = [...new Set(emails.map(foldAddress).filter((a): a is string => a !== null))];
  const rows = await ctx.db
    .selectFrom("core_outside_person as o")
    .leftJoin("core_outside_match as m", (join) =>
      join.onRef("m.ref", "=", "o.ref").on("m.kind", "=", "person"),
    )
    .select(["o.ref", "o.address_folded", "o.person_id", "o.link_how", "m.ref as waiting"])
    .where((eb) =>
      eb.or([
        ...(folded.length ? [eb("o.address_folded", "in", jsonList(folded))] : []),
        eb.and([eb("o.person_id", "=", personId), eb("o.link_how", "=", "address")]),
      ]),
    )
    .execute();
  if (!rows.length) return;
  for (const r of rows) {
    if (r.person_id !== personId || r.link_how !== "address") continue;
    if (r.address_folded !== null && folded.includes(r.address_folded)) continue;
    ctx.write(
      ctx.db
        .updateTable("core_outside_person")
        .set({ person_id: null, link_how: null, linked_at: null })
        .where("ref", "=", r.ref)
        .where("person_id", "=", personId)
        .where("link_how", "=", "address"),
    );
  }
  const unlinked = rows.filter(
    (r) =>
      r.link_how === null &&
      r.waiting === null &&
      r.address_folded !== null &&
      folded.includes(r.address_folded),
  );
  if (!unlinked.length) return;
  const sharing = new Map<string, number>();
  for (const r of rows) {
    if (r.address_folded) sharing.set(r.address_folded, (sharing.get(r.address_folded) ?? 0) + 1);
  }
  const others = await personsByFolded(
    ctx.db,
    unlinked.map((r) => r.address_folded as string),
  );
  let linked = false;
  for (const r of unlinked) {
    const address = r.address_folded as string;
    if ((sharing.get(address) ?? 0) > 1) continue;
    const persons = (others.get(address) ?? []).filter((id) => id !== personId);
    if (persons.length) {
      ctx.write(
        ctx.db
          .insertInto("core_outside_match")
          .values({
            kind: "person",
            ref: r.ref,
            why: "several_people",
            candidates: JSON.stringify([...persons, personId]),
            created_at: ctx.now,
          })
          .onConflict((oc) => oc.doNothing()),
      );
      continue;
    }
    ctx.write(
      ctx.db
        .updateTable("core_outside_person")
        .set({ person_id: personId, link_how: "address", linked_at: ctx.now })
        .where("ref", "=", r.ref)
        .where("person_id", "is", null)
        .where("link_how", "is", null),
    );
    linked = true;
  }
  if (linked) {
    ctx.postActivity({
      subject: LINK_SUBJECT,
      payload: { kind: "outside_link", how: "address" },
      links: [{ object: "person", id: personId }],
    });
  }
}
