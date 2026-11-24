// Low stock (stage 37 step 2, ADR 0681): when a write takes a stock record's on hand to or below
// its reorder level (the number field its `stock.reorderAt` names), the staff who keep stock are
// told once, until it rises above the level again. It is the host's notice, worked out for every
// write that changes on hand (opening stock, a correction, a state's `stockMoves`, a paid order's
// sale, a change of the level itself), never a tool's, so a sale, an import and a count tell the
// same people.
//
// Each write notes the records it touched (`watchLow`); once its handler has queued everything
// (`beforeCommit`, ADR 0624), four statements per object are queued at the end of its batch, so
// they judge on hand as the batch leaves it, after every movement and sale before them:
//
//   1. the record's crossing is ended where on hand is now above its level (or it has none);
//   2. a crossing is begun where it is at or below, keeping the one already there
//      (core_stock_low, migration 0931);
//   3. a notice to each keeper for each record in a crossing not yet told (its dedupe key the
//      crossing's);
//   4. the crossing marked told, so a record still low from before tells nobody again, however
//      long it stays low.
//
// The cost is the same for one record as for a count of hundreds. Who is told is `stockKeepers`.
import type { CoreDatabase } from "@composable-os/db";
import { type CompiledQuery, type Kysely, sql } from "kysely";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { parseGrants } from "../pack-roles.ts";

/** Statements a low-stock check queues per object it touched (at most). */
export const LOW_STATEMENTS = 4;

const gatheredBy = new WeakMap<object, Map<string, Set<string>>>();

/**
 * Notes that this call may have changed the on hand of `records` of `object`, for the low-stock
 * check at the end of its batch. Nothing for an object without a reorder level, or a simulated
 * call (nothing it writes commits).
 */
export function watchLow(ctx: HandlerContext, object: string, records: Iterable<string>): void {
  if (!getObject(object)?.stock?.reorderAt) return;
  let gathered = gatheredBy.get(ctx.write);
  if (!gathered) {
    if (!ctx.beforeCommit) return;
    const fresh = new Map<string, Set<string>>();
    gathered = fresh;
    gatheredBy.set(ctx.write, fresh);
    ctx.beforeCommit(async () => {
      for (const [name, ids] of fresh) {
        ctx.write(...(await lowStatements(ctx.db, name, [...ids], ctx.now, ctx.actor)));
      }
    });
  }
  const ids = gathered.get(object) ?? new Set<string>();
  for (const id of records) ids.add(id);
  gathered.set(object, ids);
}

/** The columns of a record's view a check reads: its title, its level and its reorder quantity. */
function columnsOf(object: ObjectDefinition) {
  const column = (field: string | undefined) =>
    field ? object.fields.find((f) => f.name === field)?.column : undefined;
  return {
    level: column(object.stock?.reorderAt),
    quantity: column(object.stock?.reorderQty),
    title: column(object.titleField),
  };
}

/**
 * The statements of a low-stock check of `records` of `object` (see the header), for the
 * end of a batch. None for an object with no reorder level.
 */
export async function lowStatements(
  db: Kysely<CoreDatabase>,
  object: string,
  records: readonly string[],
  now: string,
  actor: string,
): Promise<CompiledQuery[]> {
  const definition = getObject(object);
  const { level, quantity, title } = definition ? columnsOf(definition) : {};
  if (!definition || !level || !records.length) return [];
  const ref = (column: string) => sql.ref(`t.${column}`);
  // A number field is stored as REAL: 5, not 5.0.
  const shown = (column: string) =>
    sql`CASE WHEN ${ref(column)} = CAST(${ref(column)} AS INTEGER) THEN CAST(CAST(${ref(column)} AS INTEGER) AS TEXT) ELSE ${ref(column)} END`;
  const onHand = "coalesce(c.places, 0) - c.taken";
  const ids = JSON.stringify([...new Set(records)]);
  const view = sql.table(definition.source);
  // A record at or below its level, as the batch leaves it.
  const low = (record: string) =>
    sql`SELECT 1 FROM core_capacity c JOIN ${view} t ON t.id = c.record_id WHERE c.object_type = ${object} AND c.record_id = ${sql.raw(record)} AND ${ref(level)} IS NOT NULL AND ${sql.raw(onHand)} <= ${ref(level)}`;
  const statements = [
    sql`DELETE FROM core_stock_low WHERE object_type = ${object} AND record_id IN (SELECT value FROM json_each(${ids})) AND NOT EXISTS (${low("core_stock_low.record_id")})`,
    sql`INSERT INTO core_stock_low (object_type, record_id, crossing, since) SELECT ${object}, j.value, ${idStem("stockLow")} || upper(hex(randomblob(8))), ${now} FROM json_each(${ids}) j WHERE EXISTS (${low("j.value")}) ON CONFLICT (object_type, record_id) DO NOTHING`,
  ];
  const keepers = await stockKeepers(db, definition);
  if (keepers.length) {
    const name = title
      ? sql`coalesce(${ref(title)}, ${definition.label})`
      : sql`${definition.label}`;
    const reorder = quantity
      ? sql`CASE WHEN ${ref(quantity)} IS NULL THEN '' ELSE ' Reorder quantity: ' || ${shown(quantity)} || '.' END`
      : sql`''`;
    statements.push(
      sql`INSERT OR IGNORE INTO core_notifications (id, user_id, type, title, body, link, source, dedupe_key, human_only, read_at, created_at) SELECT ${idStem("notification")} || upper(hex(randomblob(8))), u.value, 'system.message', substr(${name} || ' is low: ' || (${sql.raw(onHand)}) || ' on hand', 1, 200), 'At or below its reorder level of ' || ${shown(level)} || '.' || ${reorder}, json_object('kind', 'record', 'object', l.object_type, 'id', l.record_id), ${JSON.stringify({ actor })}, 'stock_low:' || l.crossing, 0, NULL, ${now} FROM core_stock_low l JOIN core_capacity c ON c.object_type = l.object_type AND c.record_id = l.record_id JOIN ${view} t ON t.id = l.record_id JOIN json_each(${JSON.stringify(keepers)}) u WHERE l.object_type = ${object} AND l.told_at IS NULL AND l.record_id IN (SELECT value FROM json_each(${ids}))`,
    );
  }
  // Each crossing is told once, whoever was a keeper then: kept on the crossing itself, so it
  // outlives the notices (purged after 90 days).
  statements.push(
    sql`UPDATE core_stock_low SET told_at = ${now} WHERE object_type = ${object} AND told_at IS NULL AND record_id IN (SELECT value FROM json_each(${ids}))`,
  );
  return statements.map((statement) => statement.compile(db));
}

/**
 * The first 14 characters of a new id of `kind` (its prefix and millisecond time): with 16
 * random hex characters (all Crockford base32) made by the statement, an id of the usual shape
 * for each row one statement writes.
 */
function idStem(kind: Parameters<typeof newId>[0]): string {
  const id = newId(kind);
  return id.slice(0, id.indexOf("_") + 11);
}

/**
 * Who is told a record of `object` is low: the active people who hold its `stock.notify`
 * permission as a tool naming it would let them (pack-roles.ts, `staffAuthority`): an admin; a
 * member, unless it is restricted (ADR 0625); an account whose pack role of the same pack lists
 * it; an account a human admin granted it, while the pack declares it grantable. An account with
 * a pack role is told only when the role reads `object` without a limit. Without
 * `notify`, the admins.
 */
export async function stockKeepers(
  db: Kysely<CoreDatabase>,
  object: ObjectDefinition,
): Promise<string[]> {
  const permission = object.stock?.notify;
  const users = await db
    .selectFrom("core_user")
    .select(["id", "role", "pack_role", "granted_permissions"])
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .orderBy("id")
    .execute();
  if (!permission || !object.extension) {
    return users.filter((u) => u.role === "admin" && !u.pack_role).map((u) => u.id);
  }
  const row = await db
    .selectFrom("core_extensions")
    .select("manifest")
    .where("id", "=", object.extension)
    .where("status", "=", "active")
    .where("source", "=", "shipped")
    .executeTakeFirst();
  let manifest: {
    grantable?: string[];
    restricted?: string[];
    roles?: Record<
      string,
      {
        permissions?: string[];
        read?: string[];
        today?: Record<string, unknown>;
        looksAfter?: Record<string, unknown>;
      }
    >;
  } = {};
  try {
    manifest = row?.manifest ? JSON.parse(row.manifest) : {};
  } catch {
    // A manifest that does not parse declares nothing: admins only (fail closed).
  }
  const grantable = (manifest.grantable ?? []).includes(permission);
  const restricted = (manifest.restricted ?? []).includes(permission);
  return users
    .filter((u) => {
      if (u.pack_role) {
        // A fixed role's account is told only of what its role reads, with no limit on it
        // (today's records, the People it looks after): the notice names the record and its
        // numbers (the review of #422). A grant opens tools, never reads (ADR 0600).
        const [extension, local] = u.pack_role.split(".");
        const role = extension === object.extension ? manifest.roles?.[local ?? ""] : undefined;
        const reads =
          (role?.read ?? []).includes(object.name) &&
          !Object.hasOwn(role?.today ?? {}, object.name) &&
          !Object.hasOwn(role?.looksAfter ?? {}, object.name);
        if (!reads) return false;
        if (grantable && parseGrants(u.granted_permissions).includes(permission)) return true;
        return !restricted && (role?.permissions ?? []).includes(permission);
      }
      if (grantable && parseGrants(u.granted_permissions).includes(permission)) return true;
      return u.role === "admin" || (u.role === "member" && !restricted);
    })
    .map((u) => u.id);
}
