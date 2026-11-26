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
import { CompiledQuery, type Kysely, sql } from "kysely";
import { saltedHash } from "../contact/suppression.ts";
import { foldAddress, foldedSql, normaliseCustomerEmail } from "../customers/accounts.ts";
import { ConfigError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { chunk, jsonList } from "../records/common.ts";
import { erasedAddressHash } from "../records/erase-subject.ts";
import { erasedAddresses } from "../sync/ingest.ts";
import { SYSTEM_USER } from "../users.ts";
import { onCurrentList } from "./settings.ts";

type Db = Kysely<CoreDatabase>;

/** The subject of the one timeline activity a link adds to a Person. It names no address. */
export const LINK_SUBJECT = "Linked to the booking system's list";

/**
 * The most a list of values bound as one JSON text may hold, in bytes: well under D1's 100 KB
 * statement and 2 MB string (stage 65 step 4's review, M2), so a large list is read in a few
 * statements, never one too big for D1.
 */
export const MAX_JSON_PARAM = 90_000;

/**
 * More reads than this for one lookup of a small table of erased people (suppressions, the
 * erased-address list, staff's unlink decisions): read the table whole instead, in one.
 */
const WHOLE_TABLE_AFTER = 4;

/** `items` in parts whose JSON is at most `max` bytes (and at most `count` items). */
export function boundedChunks<T>(
  items: readonly T[],
  max = MAX_JSON_PARAM,
  count = Number.POSITIVE_INFINITY,
): T[][] {
  const out: T[][] = [];
  let part: T[] = [];
  let bytes = 2;
  const encoder = new TextEncoder();
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).length + 1;
    if (part.length && (bytes + size > max || part.length >= count)) {
      out.push(part);
      part = [];
      bytes = 2;
    }
    part.push(item);
    bytes += size;
  }
  if (part.length) out.push(part);
  return out;
}

/** The Persons with a live address of each folded form (a read per 90 KB of addresses). */
export async function personsByFolded(
  db: Db,
  folded: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!folded.length) return out;
  const rows = (
    await Promise.all(
      boundedChunks([...new Set(folded)]).map((part) =>
        db
          .selectFrom("core_person_emails as e")
          .select([foldedSql("e.email").as("folded"), "e.person_id"])
          .where("e.live", "=", 1)
          .where(foldedSql("e.email"), "in", jsonList(part))
          .execute(),
      ),
    )
  ).flat();
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

/** An outside person (`person`) or coach (`staff`). */
export type OutsideKind = "person" | "staff";

/**
 * The hash an outside ref is kept by, in `core_outside_suppressed` (an erased Person's) and
 * `core_outside_unlinked` (staff's "nobody here"): keyed with the deployment's salt, as the
 * consent register's suppression list (ADR 0675), never the ref itself. A list with no ids of its
 * own uses the address as the ref, so a plain digest would be one anyone could recompute from an
 * address; the salt keeps one deployment's hashes from matching another's (stage 65 step 10).
 */
export function outsideRefHash(db: Db, kind: OutsideKind, ref: string): Promise<string> {
  return saltedHash(db, `outside:${kind}:ref:${ref}`);
}

/** The hash an outside address is suppressed by: its normalised form, keyed the same way. */
export function outsideAddressHash(db: Db, address: string): Promise<string> {
  return saltedHash(db, `outside:address:${normaliseCustomerEmail(address) ?? address}`);
}

/**
 * A fingerprint of the deployment's salt: a keyed hash of a constant, never the salt. Kept on every
 * suppression row and in the erase log, so a salt lost and remade (a restore without it) is found
 * and refused, never silently matching nothing.
 */
export function saltFingerprint(db: Db): Promise<string> {
  return saltedHash(db, "outside:fingerprint");
}

/**
 * Refuses, loudly, when suppressions were keyed with another salt than the one in use: every
 * suppression would match nothing and erased people would come back with the next list. One
 * statement (the table is small: erased people only).
 */
export async function assertSuppressionSalt(db: Db): Promise<void> {
  const fingerprint = await saltFingerprint(db);
  const other = await db
    .selectFrom("core_outside_suppressed")
    .select("hash")
    .where("fingerprint", "is not", null)
    .where("fingerprint", "!=", fingerprint)
    .limit(1)
    .executeTakeFirst();
  if (other) {
    throw new ConfigError(
      "The booking system's copy cannot be read: erased people's suppressions were kept with another deployment salt than the one in use (the salt was lost, perhaps by a restore). Restore the core_settings row text_number_salt from the backup before loading or linking anything, or erased people would come back.",
    );
  }
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
  kind: OutsideKind = "person",
): Promise<{ refs: Set<string>; addresses: Set<string>; suppressed: Set<string> }> {
  await assertSuppressionSalt(db);
  const refHashes = await Promise.all(
    [...new Set(refs)].map(async (ref) => ({ ref, hash: await outsideRefHash(db, kind, ref) })),
  );
  const addressHashes = await Promise.all(
    [...new Set(addresses)].map(async (a) => ({
      address: a,
      hash: await outsideAddressHash(db, a),
    })),
  );
  const hashes = [...refHashes.map((h) => h.hash), ...addressHashes.map((h) => h.hash)];
  // One JSON parameter a read (D1 binds at most 100), each at most 90 KB. A list too long for a few
  // such reads reads the suppressions whole instead, in one statement: the table holds erased
  // people only (the review, M2: no parameter past D1's limits, and few statements).
  const parts = boundedChunks(hashes);
  const suppressed = new Set(
    (parts.length > WHOLE_TABLE_AFTER
      ? await db.selectFrom("core_outside_suppressed").select("hash").execute()
      : (
          await Promise.all(
            parts.map((part) =>
              db
                .selectFrom("core_outside_suppressed")
                .select("hash")
                .where("hash", "in", jsonList(part))
                .execute(),
            ),
          )
        ).flat()
    ).map((r) => r.hash),
  );
  const unique = [...new Set(addresses)];
  // Each address is looked up by its hash (about 75 bytes of JSON): 1,000 a read, or the
  // erased-address list whole (erased people's only) when that would be more than a few.
  const addressParts = boundedChunks(unique, MAX_JSON_PARAM, 1_000);
  let erased: Set<string>;
  if (addressParts.length > WHOLE_TABLE_AFTER) {
    const all = new Set(
      (await db.selectFrom("core_erased_address").select("hash").execute()).map((r) => r.hash),
    );
    const keyed = await Promise.all(
      unique.map(async (a) => ({ a, hash: await erasedAddressHash(a) })),
    );
    erased = new Set(keyed.filter((k) => all.has(k.hash)).map((k) => k.a));
  } else {
    erased = new Set(
      (await Promise.all(addressParts.map((part) => erasedAddresses(db, part)))).flatMap((s) => [
        ...s,
      ]),
    );
  }
  const suppressedAddresses = addressHashes
    .filter((h) => suppressed.has(h.hash))
    .map((h) => h.address);
  return {
    refs: new Set(refHashes.filter((h) => suppressed.has(h.hash)).map((h) => h.ref)),
    // Either: on the erased-address list, or suppressed in the copy.
    addresses: new Set([...erased, ...suppressedAddresses]),
    // Only the copy's own suppressions (an erase's), which nothing outlives.
    suppressed: new Set(suppressedAddresses),
  };
}

/**
 * THE rule an erase and a load share (ADR 0926), so they cannot drift: an outside row linked to a
 * Person other than the ones being erased (by address or by staff), or a coach linked to a staff
 * account, belongs to that Person or account. An erase never deletes it, and a load never drops it
 * for an address on the erased-address list (an erased member's address their family member, or
 * a staff account, still lists). Only a suppressed ref or a suppressed outside address drops it.
 * `link.to` is the Person or staff account linked (a load passes only links to live Persons and
 * active staff accounts); `erasing` the Persons an erase is removing (none at a load).
 */
export function keptByLink(
  link: { to: string | null } | undefined,
  erasing: ReadonlySet<string> = new Set(),
): boolean {
  return link?.to !== null && link?.to !== undefined && !erasing.has(link.to);
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
    dropped: {
      refs: ReadonlySet<string>;
      addresses: ReadonlySet<string>;
      suppressed?: ReadonlySet<string>;
    };
  },
): OutsideOutcome[] {
  const byRef = new Map<string, OutsideOutcome>();
  const matched: { ref: string; email: string | null }[] = [];
  for (const r of rows) {
    if (ctx.dropped.refs.has(r.ref)) {
      byRef.set(r.ref, { ref: r.ref, outcome: "dropped", why: "suppressed" });
    } else if (
      r.address !== null &&
      (ctx.dropped.suppressed ?? ctx.dropped.addresses).has(r.address)
    ) {
      byRef.set(r.ref, { ref: r.ref, outcome: "dropped", why: "erased_address" });
    } else if (
      r.address !== null &&
      ctx.dropped.addresses.has(r.address) &&
      !keptByLink(ctx.held.get(r.ref))
    ) {
      // On the erased-address list, and linked to nobody else: dropped. One linked to a live
      // Person or an active staff account is theirs, and stays (keptByLink).
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

/** The hashes `core_outside_unlinked` keeps staff's "nobody here" under, for these refs. */
export async function unlinkedOf(
  db: Db,
  kind: OutsideKind,
  refs: readonly string[],
): Promise<Map<string, { by: string; at: string }>> {
  const out = new Map<string, { by: string; at: string }>();
  if (!refs.length) return out;
  const hashes = await Promise.all(
    [...new Set(refs)].map(async (ref) => ({ ref, hash: await outsideRefHash(db, kind, ref) })),
  );
  const parts = boundedChunks(hashes.map((h) => h.hash));
  const rows =
    parts.length > WHOLE_TABLE_AFTER
      ? await db
          .selectFrom("core_outside_unlinked")
          .select(["hash", "unlinked_by", "unlinked_at"])
          .where("kind", "=", kind)
          .execute()
      : (
          await Promise.all(
            parts.map((part) =>
              db
                .selectFrom("core_outside_unlinked")
                .select(["hash", "unlinked_by", "unlinked_at"])
                .where("kind", "=", kind)
                .where("hash", "in", jsonList(part))
                .execute(),
            ),
          )
        ).flat();
  const byHash = new Map(rows.map((r) => [r.hash, r]));
  for (const h of hashes) {
    const row = byHash.get(h.hash);
    if (row) out.set(h.ref, { by: row.unlinked_by, at: row.unlinked_at });
  }
  return out;
}

/**
 * The timeline activity a link adds to each Person linked, naming no address: set based (two
 * statements per 100 Persons), so a load or an import that links hundreds stays in budget.
 */
export function linkActivityStatements(
  persons: readonly string[],
  author: { userId: string | null; actor: string; now: string; how: "address" | "staff" },
): CompiledQuery[] {
  if (!persons.length) return [];
  const rows = persons.map((person) => ({ id: newId("activity"), person }));
  const payload = JSON.stringify({ kind: "outside_link", how: author.how });
  // As the pipeline's own activities: an extension's, a customer's or the public's are `system`.
  const actor = ["human", "assistant", "mcp", "automation"].includes(author.actor)
    ? author.actor
    : "system";
  return [
    ...chunk(rows, 100).map((part) =>
      CompiledQuery.raw(
        "INSERT INTO core_activity (id, type, subject, body, payload, occurred_at, author_user_id, author_actor, created_at, updated_at) SELECT json_extract(value, '$.id'), 'system', ?, NULL, ?, ?, ?, ?, ?, ? FROM json_each(?)",
        [
          LINK_SUBJECT,
          payload,
          author.now,
          author.userId,
          actor,
          author.now,
          author.now,
          JSON.stringify(part.map((a) => ({ id: a.id }))),
        ],
      ),
    ),
    ...chunk(rows, 100).map((part) =>
      CompiledQuery.raw(
        "INSERT INTO core_activity_links (activity_id, object_type, record_id) SELECT json_extract(value, '$.id'), 'person', json_extract(value, '$.person') FROM json_each(?)",
        [JSON.stringify(part)],
      ),
    ),
  ];
}

/** The Persons a write is about to give these live addresses. */
export interface PersonAddresses {
  personId: string;
  emails: readonly string[];
  /**
   * `emails` are all the Person's live addresses after the write (create, update, restore): a link
   * by address to an address it no longer holds is dropped. False: addresses added only (import).
   */
  complete: boolean;
}

/**
 * Rule 6 and the dropped link, when Persons' addresses change (`person.create`, `person.update`,
 * `person.restore`, `import.csv.commit`): an unlinked outside person with one of their addresses
 * (folded) is linked now, by the same rule, without waiting for a load; one that two Persons now
 * hold waits in To match; a link by address to a Person whose address it no longer holds is dropped
 * (and matched again at the next load). Nothing is linked while the copy is off, or for a ref staff
 * unlinked. One indexed read when no list holds the addresses, however many Persons. Queues its
 * writes and one timeline activity per Person linked.
 */
export async function matchPersonAddresses(
  ctx: HandlerContext,
  entries: readonly PersonAddresses[],
): Promise<void> {
  const own = new Map<string, Set<string>>();
  for (const e of entries) {
    const set = own.get(e.personId) ?? new Set<string>();
    for (const email of e.emails) {
      const f = foldAddress(email);
      if (f) set.add(f);
    }
    own.set(e.personId, set);
  }
  const folded = [...new Set([...own.values()].flatMap((s) => [...s]))];
  const complete = entries.filter((e) => e.complete).map((e) => e.personId);
  if (!folded.length && !complete.length) return;
  const rows = await ctx.db
    .selectFrom("core_outside_person as o")
    .leftJoin("core_outside_match as m", (join) =>
      join.onRef("m.ref", "=", "o.ref").on("m.kind", "=", "person"),
    )
    .select(["o.ref", "o.address_folded", "o.person_id", "o.link_how", "m.ref as waiting"])
    .where(onCurrentList("o.list_id"))
    .where((eb) =>
      eb.or([
        ...(folded.length ? [eb("o.address_folded", "in", jsonList(folded))] : []),
        ...(complete.length
          ? [
              eb.and([
                eb("o.person_id", "in", jsonList(complete)),
                eb("o.link_how", "=", "address"),
              ]),
            ]
          : []),
      ]),
    )
    .execute();
  if (!rows.length) return;
  const completeSet = new Set(complete);
  for (const r of rows) {
    if (r.link_how !== "address" || r.person_id === null || !completeSet.has(r.person_id)) continue;
    if (r.address_folded !== null && own.get(r.person_id)?.has(r.address_folded)) continue;
    ctx.write(
      ctx.db
        .updateTable("core_outside_person")
        .set({ person_id: null, link_how: null, linked_at: null })
        .where("ref", "=", r.ref)
        .where("person_id", "=", r.person_id)
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
  const settings = await ctx.db
    .selectFrom("core_outside_settings")
    .select("enabled")
    .where("id", "=", 1)
    .executeTakeFirst();
  if (settings?.enabled === 0) return;
  const sharing = new Map<string, number>();
  for (const r of rows) {
    if (r.address_folded) sharing.set(r.address_folded, (sharing.get(r.address_folded) ?? 0) + 1);
  }
  const writing = new Set(own.keys());
  const [others, staffSaidNobody] = await Promise.all([
    personsByFolded(
      ctx.db,
      unlinked.map((r) => r.address_folded as string),
    ),
    unlinkedOf(
      ctx.db,
      "person",
      unlinked.map((r) => r.ref),
    ),
  ]);
  const linked: string[] = [];
  for (const r of unlinked) {
    const address = r.address_folded as string;
    if ((sharing.get(address) ?? 0) > 1 || staffSaidNobody.has(r.ref)) continue;
    // Who holds the address once this write commits: the others in the database (the Persons
    // written here as they will be), and the Persons written here that take it.
    const holders = new Set((others.get(address) ?? []).filter((id) => !writing.has(id)));
    for (const [id, set] of own) if (set.has(address)) holders.add(id);
    const persons = [...holders];
    if (persons.length !== 1) {
      if (persons.length > 1) {
        ctx.write(
          ctx.db
            .insertInto("core_outside_match")
            .values({
              kind: "person",
              ref: r.ref,
              why: "several_people",
              candidates: JSON.stringify(persons),
              created_at: ctx.now,
            })
            .onConflict((oc) => oc.doNothing()),
        );
      }
      continue;
    }
    const [personId] = persons as [string];
    ctx.write(
      ctx.db
        .updateTable("core_outside_person")
        .set({ person_id: personId, link_how: "address", linked_at: ctx.now })
        .where("ref", "=", r.ref)
        .where("person_id", "is", null)
        .where("link_how", "is", null),
    );
    if (!linked.includes(personId)) linked.push(personId);
  }
  ctx.write(
    ...linkActivityStatements(linked, {
      userId: ctx.user.id === SYSTEM_USER.id ? null : ctx.user.id,
      actor: ctx.actor,
      now: ctx.now,
      how: "address",
    }),
  );
}
