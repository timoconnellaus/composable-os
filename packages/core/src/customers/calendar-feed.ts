// A customer's private calendar feed (stage 62 step 1, ADR 0890): their own live bookings, and those
// of the children they are a live guardian of, as a calendar app polls them with no sign-in, at
// `GET /api/v1/me/feed/<token>.ics`. The staff feed's machine (ADR 0628), shared through
// ../feeds/token.ts and the route's apps/app/src/server/http/calendar-feed.ts.
//
// The token is the only secret: made by the customer's own `me.calendarFeed.rotate`, shown once,
// kept only as its SHA-256 in `core_customer_feed` (its own table: a staff token is never looked up
// here, nor this one on the staff route). Revoked by the customer, by staff
// (`customer.revokeCalendarFeed`), and deleted when the account is disabled, deleted or erased.
//
// Checked on every fetch: the account active and linked to its Person. What it shows is read as
// that customer, through the visibility seam (`visibleSource`), so it never holds a field the
// customer could not read, nor anyone else's record:
// - which records: those of every object a shipped, active pack declares a `calendarEntry` on
//   (ADR 0891), whose customer is the account's Person or a live dependant's (the family link,
//   read live: ending the link drops a child's events on the next fetch, ADR 0540), in one of the
//   declared live states, out of the Trash;
// - each record's declared start, end, title and place, read through the seam on every object the
//   path passes, in the window from 14 days back to 120 days ahead, soonest first, at most 500;
// - a dependant's event begins with the child's given name ("Ava: Junior swim"); an event with no
//   title is "Booking at <business>".
// Nothing else: no other person, no price, no note, no order.
//
// Cost: one statement per declaring object (the customer's own live rows of it, joined to what the
// paths name, bounded by the window and the cap), and the account, the family and the settings.
import type { CoreDatabase } from "@composable-os/db";
import { type Compilable, type Kysely, type RawBuilder, sql } from "kysely";
import { refreshSchemaRegistry } from "../extensions/schema.ts";
import {
  FEED_MAX_EVENTS,
  feedTokenHash,
  feedWindow,
  lookUpFeedToken,
  newFeedToken,
} from "../feeds/token.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import type { CustomerPrincipal } from "../principals.ts";
import { viewColumnOf } from "../records/columns.ts";
import { loadGeneralSettings } from "../settings.ts";
import {
  dependantFirstNames,
  ownReadSource,
  type Reader,
  visibleObject,
  visibleSource,
} from "../visibility/index.ts";

/** The feed's address, before the token. */
export const CUSTOMER_FEED_PATH_PREFIX = "/api/v1/me/feed/";

/** The feed's address for a token: the path; the screen puts the host's own origin before it. */
export function customerFeedPath(token: string): string {
  return `${CUSTOMER_FEED_PATH_PREFIX}${token}.ics`;
}

export { feedTokenHash as customerFeedTokenHash, newFeedToken as newCustomerFeedToken };

/** The statement deleting `customerId`'s feed (its address then answers as a missing path). */
export function revokeCustomerFeed(db: Kysely<CoreDatabase>, customerId: string): Compilable {
  return db.deleteFrom("core_customer_feed").where("customer_id", "=", customerId);
}

/** One event as the feed shows it. */
export interface CustomerFeedEvent {
  /** The record's object and id: its event's UID (`<object>.<id>@<hostname>`), stable. */
  object: string;
  id: string;
  title: string;
  place: string | null;
  startsAt: string;
  endsAt: string;
}

/**
 * The events the feed of `token` shows at `now`, or null when the token opens nothing (unknown,
 * rotated, revoked, malformed) or its account may no longer have one (disabled, deleted, not
 * linked to a Person). Every null is the same answer to the caller.
 */
export async function readCustomerFeed(
  db: Kysely<CoreDatabase>,
  token: string,
  now: Date,
): Promise<{ customerId: string; events: CustomerFeedEvent[] } | null> {
  // Only this feed's own table: a staff token opens nothing here.
  const row = await lookUpFeedToken(token, (hash) =>
    db
      .selectFrom("core_customer_feed")
      .select(["customer_id", "token_hash"])
      .where("token_hash", "=", hash)
      .executeTakeFirst(),
  );
  if (!row) return null;
  const account = await db
    .selectFrom("core_customer")
    .select(["id", "person_id"])
    .where("id", "=", row.customer_id)
    .where("status", "=", "active")
    .where("link_state", "=", "linked")
    .executeTakeFirst();
  if (!account?.person_id) return null;
  await refreshSchemaRegistry(db);
  const principal: CustomerPrincipal = Object.freeze({
    kind: "customer",
    customerId: account.id,
    personId: account.person_id,
  });
  return { customerId: account.id, events: await customerFeedEvents({ db, principal }, now) };
}

/** The objects a shipped, active pack declares calendar entries on. */
async function entryObjects(db: Kysely<CoreDatabase>): Promise<ObjectDefinition[]> {
  const declared = listObjects().filter((o) => o.calendarEntry && o.customer && o.extension);
  if (!declared.length) return [];
  const shipped = new Set(
    (
      await db
        .selectFrom("core_extensions")
        .select("id")
        .where("id", "in", [...new Set(declared.map((o) => o.extension as string))])
        .where("source", "=", "shipped")
        .where("status", "=", "active")
        .execute()
    ).map((r) => r.id),
  );
  return declared.filter((o) => shipped.has(o.extension as string));
}

/** A path compiled against what the customer may read: its SQL and its last field. */
interface Compiled {
  sql: RawBuilder<unknown>;
  field: FieldDefinition;
}

/**
 * One object's query: the customer's own (and live dependants') live records in the window,
 * every path read through the seam. Null when a path names something the customer cannot read
 * (the check refuses that; this fails closed).
 */
function entryQuery(
  reader: Reader,
  object: ObjectDefinition,
  window: { from: number; to: number },
): { query: RawBuilder<EntryRow>; title: Compiled; place: Compiled | null } | null {
  const entry = object.calendarEntry;
  const stateField = object.states?.field;
  if (!entry || !stateField) return null;
  let visible: ObjectDefinition;
  try {
    visible = visibleObject(reader, object);
  } catch {
    return null;
  }
  const joins: RawBuilder<unknown>[] = [];
  const hops = new Map<
    string,
    { alias: string; def: ObjectDefinition; shown: ReadonlySet<string> }
  >();
  // A title or a place past its first field shows only what the related object makes public or
  // signedIn (ADR 0891), never what the customer reads only through their own record (a class's
  // own title may name another member): the check refuses it, and this read holds it too.
  const compile = (path: string, publicOnly = false): Compiled | null => {
    const segments = path.split(".");
    let alias = "r";
    let def = visible;
    let shown: ReadonlySet<string> | null = null;
    let prefix = "";
    for (const [i, segment] of segments.entries()) {
      if (publicOnly && shown && !shown.has(segment)) return null;
      const field = def.fields.find((f) => f.name === segment);
      const column = field ? viewColumnOf(field) : null;
      if (!field || !column) return null;
      if (i === segments.length - 1) return { sql: sql.ref(`${alias}.${column}`), field };
      const to = field.options?.to;
      if (!to || field.options?.many) return null;
      prefix = prefix ? `${prefix}.${segment}` : segment;
      let hop = hops.get(prefix);
      if (!hop) {
        const target = getObject(to);
        if (!target) return null;
        let def: ObjectDefinition;
        try {
          def = visibleObject(reader, target);
        } catch {
          return null;
        }
        const next = `j${hops.size}`;
        joins.push(
          sql`LEFT JOIN ${visibleSource(reader, target, next)} ON ${sql.ref(`${next}.id`)} = ${sql.ref(`${alias}.${column}`)}`,
        );
        hop = {
          alias: next,
          def,
          shown: new Set([...(target.public?.read ?? []), ...(target.signedIn?.read ?? [])]),
        };
        hops.set(prefix, hop);
      }
      alias = hop.alias;
      def = hop.def;
      shown = hop.shown;
    }
    return null;
  };
  const starts = compile(entry.starts);
  const ends = compile(entry.ends);
  const title = compile(entry.title, true);
  const place = entry.place ? compile(entry.place, true) : null;
  const state = compile(stateField);
  if (!starts || !ends || !title || !state || (entry.place && !place)) return null;
  const seconds = (c: Compiled) => sql`CAST(strftime('%s', ${c.sql}) AS INTEGER)`;
  const query = sql<EntryRow>`SELECT r.id AS id, o.owner AS owner, ${starts.sql} AS starts,
      ${ends.sql} AS ends, ${title.sql} AS title, ${place ? place.sql : sql`NULL`} AS place
    FROM ${visibleSource(reader, object, "r")}
    JOIN ${ownReadSource(reader, object, "o")} ON o.id = r.id
    ${sql.join(joins, sql` `)}
    WHERE ${state.sql} IN (${sql.join(entry.live.map((s) => sql`${s}`))})
      AND ${seconds(starts)} < ${window.to}
      AND ${seconds(ends)} > ${window.from}
    ORDER BY ${seconds(starts)}, r.id
    LIMIT ${FEED_MAX_EVENTS}`;
  return { query, title, place };
}

interface EntryRow {
  id: string;
  owner: string;
  starts: unknown;
  ends: unknown;
  title: unknown;
  place: unknown;
}

/** A select's label for its stored value; any other field's text as it is. */
function shown(field: FieldDefinition, value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return field.options?.choices?.find((c) => c.value === value)?.label ?? value;
}

const instant = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** The customer's feed events at `now`, soonest first: a bounded read through the seam. */
export async function customerFeedEvents(reader: Reader, now: Date): Promise<CustomerFeedEvent[]> {
  const principal = reader.principal;
  if (principal.kind !== "customer") return [];
  const objects = await entryObjects(reader.db);
  if (!objects.length) return [];
  const window = feedWindow(now);
  const queries = objects
    .map((object) => ({ object, compiled: entryQuery(reader, object, window) }))
    .filter((q) => q.compiled !== null);
  const [firstNames, ...results] = await Promise.all([
    dependantFirstNames(reader),
    ...queries.map((q) => q.compiled?.query.execute(reader.db)),
  ]);
  // A child's first name (never blank), so a parent tells two children's events apart.
  let business: string | null | undefined;
  const fallback = async () => {
    if (business === undefined) business = (await loadGeneralSettings(reader.db)).orgName;
    return business ? `Booking at ${business}` : "Booking";
  };
  const out: CustomerFeedEvent[] = [];
  for (const [i, q] of queries.entries()) {
    const compiled = q.compiled as NonNullable<typeof q.compiled>;
    for (const row of results[i]?.rows ?? []) {
      const startsAt = instant(row.starts);
      const endsAt = instant(row.ends);
      if (!startsAt || !endsAt || endsAt < startsAt) continue;
      const own = row.owner === principal.personId;
      // A record whose owner is neither the customer nor a live dependant cannot be in the seam's
      // own rows; skip it rather than show it under no name.
      const child = own ? null : firstNames.get(row.owner);
      if (!own && child === undefined) continue;
      const name = shown(compiled.title.field, row.title) ?? (await fallback());
      out.push({
        object: q.object.name,
        id: row.id,
        title: child ? `${child}: ${name}` : name,
        place: compiled.place ? shown(compiled.place.field, row.place) : null,
        startsAt,
        endsAt,
      });
    }
  }
  return out
    .sort(
      (a, b) =>
        a.startsAt.localeCompare(b.startsAt) ||
        a.object.localeCompare(b.object) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, FEED_MAX_EVENTS);
}
