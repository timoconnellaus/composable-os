// Read and understood (stage 38 step 3, ADR 0702): the host's rules for an acknowledged object,
// a publishable object that declares `acknowledge { who, manage }`. Every operation that asks
// "who must read this?", "does this person's confirmation count?" or "may this caller see who
// has confirmed?" reads these functions, and nothing in a pack or a block decides it.
//
// **Who must read** is the record's "must read" document (`who`, MUST_READ_SCHEMA), checked on
// the day against each live person's account: `everyone`, or a staff role (only for an account
// without a pack role, whose role grants nothing while it holds one, ADR 0436), a pack role
// (`rostering.team`) or a pack permission granted to the account (`bookings:desk`). An account
// that joins later has the record to read; a deactivated one has nothing to read and keeps its
// confirmations. Nobody is asked while the record is not published.
//
// **Which confirmation counts**: one of a version at or after the latest version that asked
// everyone again (`read_again`; the first always asks, and a version from before the object was
// acknowledged counts as asking). A small fix leaves that version where it was, so earlier
// confirmations still count.
//
// **Who may see who has confirmed**: a person (never an AI actor) who is an admin, or whom an
// admin granted the object's `manage` permission while an installed pack still declares it
// grantable.
import { MUST_READ_ENTRY_RE, MUST_READ_MAX } from "@composable-os/sdk";
import { sql } from "kysely";
import { ForbiddenError, ValidationError } from "../errors.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { parseGrants } from "../pack-roles.ts";
import { ROLES } from "../principals.ts";

export type AcknowledgedObject = ObjectDefinition & {
  titleField: string;
  publishable: NonNullable<ObjectDefinition["publishable"]> & {
    acknowledge: { who: string; manage: string };
  };
};

/** The object, when it is acknowledged. */
export function acknowledgedObject(
  object: ObjectDefinition | string | undefined,
): AcknowledgedObject | null {
  const definition = typeof object === "string" ? getObject(object) : object;
  return definition?.publishable?.acknowledge ? (definition as AcknowledgedObject) : null;
}

/** Every acknowledged object of the installed extensions. */
export function acknowledgedObjects(): AcknowledgedObject[] {
  return listObjects().flatMap((o) => {
    const a = acknowledgedObject(o);
    return a ? [a] : [];
  });
}

/** A record's "must read", as the host reads it: nobody when it is empty or not understood. */
export interface MustRead {
  everyone: boolean;
  roles: readonly string[];
}

export function parseMustRead(value: unknown): MustRead {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      v = null;
    }
  }
  if (!v || typeof v !== "object") return { everyone: false, roles: [] };
  const { everyone, roles } = v as { everyone?: unknown; roles?: unknown };
  return {
    everyone: everyone === true,
    roles: Array.isArray(roles)
      ? roles
          .filter((r): r is string => typeof r === "string" && MUST_READ_ENTRY_RE.test(r))
          .slice(0, MUST_READ_MAX)
      : [],
  };
}

/** A live person's staff account, as "must read" is checked against it. */
export interface StaffAccount {
  id: string;
  name: string;
  email: string;
  role: string;
  packRole: string | null;
  grants: readonly string[];
}

/** Whether "must read" names the account, by its role, pack role or grants today. */
export function mustReadIncludes(must: MustRead, account: StaffAccount): boolean {
  if (must.everyone) return true;
  return must.roles.some((entry) => {
    if ((ROLES as readonly string[]).includes(entry)) {
      return account.packRole === null && account.role === entry;
    }
    if (entry.includes(":")) return account.grants.includes(entry);
    return account.packRole === entry;
  });
}

/** Every live person's account (not deactivated, not an agent or the system). */
export async function liveStaff(ctx: Pick<HandlerContext, "db">): Promise<StaffAccount[]> {
  const rows = await ctx.db
    .selectFrom("core_user")
    .select(["id", "name", "email", "role", "pack_role", "granted_permissions"])
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .orderBy("name")
    .orderBy("id")
    .execute();
  return rows.map(toAccount);
}

/** One account, live or not; null when there is none. */
export async function staffAccount(
  ctx: Pick<HandlerContext, "db">,
  id: string,
): Promise<(StaffAccount & { live: boolean }) | null> {
  const row = await ctx.db
    .selectFrom("core_user")
    .select([
      "id",
      "name",
      "email",
      "role",
      "pack_role",
      "granted_permissions",
      "kind",
      "deactivated_at",
    ])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return { ...toAccount(row), live: row.kind === "human" && !row.deactivated_at };
}

function toAccount(row: {
  id: string;
  name: string;
  email: string;
  role: string;
  pack_role: string | null;
  granted_permissions: string | null;
}): StaffAccount {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    packRole: row.pack_role,
    grants: parseGrants(row.granted_permissions),
  };
}

/** A published record of an acknowledged object, as the rules read it. */
export interface DueRecord {
  object: string;
  id: string;
  title: string | null;
  must: MustRead;
  /** The current version and when it went live. */
  version: number;
  publishedAt: string;
  /** The latest version that asked everyone again, and when it went live. */
  askedVersion: number;
  askedAt: string;
}

/**
 * The live, published records of an acknowledged object (or one of them): their current version,
 * the version from which confirmations count, and who must read them.
 */
export async function dueRecords(
  ctx: Pick<HandlerContext, "db">,
  object: AcknowledgedObject,
  id?: string,
): Promise<DueRecord[]> {
  const column = (name: string) => object.fields.find((f) => f.name === name)?.column;
  const who = column(object.publishable.acknowledge.who);
  const title = column(object.titleField);
  if (!who) return [];
  const rows = await sql<{
    id: string;
    title: string | null;
    who: string | null;
    version: number;
    published_at: string;
    asked_version: number | null;
    asked_at: string | null;
  }>`
    SELECT r.id, ${title ? sql.ref(`r.${title}`) : sql`NULL`} AS title, ${sql.ref(`r.${who}`)} AS who,
      v.version, v.published_at, a.version AS asked_version, a.published_at AS asked_at
    FROM ${sql.table(object.source)} r
    JOIN core_publish_version v
      ON v.object_type = ${object.name} AND v.record_id = r.id AND v.current = 1
    LEFT JOIN core_publish_version a
      ON a.object_type = ${object.name} AND a.record_id = r.id AND a.version = (
        SELECT max(x.version) FROM core_publish_version x
        WHERE x.object_type = ${object.name} AND x.record_id = r.id AND x.version <= v.version
          AND coalesce(x.read_again, 1) = 1)
    WHERE ${id === undefined ? sql`1 = 1` : sql`r.id = ${id}`}
    ORDER BY r.id
  `.execute(ctx.db);
  return rows.rows.map((r) => ({
    object: object.name,
    id: r.id,
    title: r.title,
    must: parseMustRead(r.who),
    version: Number(r.version),
    publishedAt: r.published_at,
    askedVersion: Number(r.asked_version ?? r.version),
    askedAt: r.asked_at ?? r.published_at,
  }));
}

/** A person's latest confirmation of each record (of one object, or of one account). */
export interface LatestConfirmation {
  record: string;
  account: string;
  version: number;
  confirmedAt: string;
}

export async function latestConfirmations(
  ctx: Pick<HandlerContext, "db">,
  object: string,
  by: { account?: string; record?: string },
): Promise<LatestConfirmation[]> {
  const rows = await sql<{
    record_id: string;
    account_id: string;
    version: number;
    confirmed_at: string;
  }>`
    SELECT a.record_id, a.account_id, a.version, a.confirmed_at FROM core_publish_ack a
    WHERE a.object_type = ${object}
      ${by.account === undefined ? sql`` : sql`AND a.account_id = ${by.account}`}
      ${by.record === undefined ? sql`` : sql`AND a.record_id = ${by.record}`}
      AND a.version = (SELECT max(b.version) FROM core_publish_ack b
        WHERE b.object_type = a.object_type AND b.record_id = a.record_id
          AND b.account_id = a.account_id)
  `.execute(ctx.db);
  return rows.rows.map((r) => ({
    record: r.record_id,
    account: r.account_id,
    version: Number(r.version),
    confirmedAt: r.confirmed_at,
  }));
}

/** Whether a confirmation of `version` counts for the record now. */
export const counts = (record: DueRecord, version: number | undefined) =>
  version !== undefined && version >= record.askedVersion;

/** The permissions whose grant lets an account manage acknowledgements, still grantable. */
async function managedGrantable(ctx: Pick<HandlerContext, "db">): Promise<Set<string>> {
  const rows = await sql<{ grantable: string | null }>`
    SELECT json_extract(manifest, '$.grantable') AS grantable FROM core_extensions
    WHERE status = 'active' AND source = 'shipped'
  `.execute(ctx.db);
  return new Set(rows.rows.flatMap((r) => parseGrants(r.grantable)));
}

/**
 * The person a call is for: the person calling, or the person who called a person-only tool of
 * an extension (its verified caller, never its input). Anyone else (an AI actor, an automation,
 * an extension's own run): null.
 */
export function personCalling(
  ctx: Pick<HandlerContext, "actor" | "extension" | "user">,
): string | null {
  if (ctx.actor === "human") return ctx.user.id;
  const tool = ctx.actor === "extension" ? ctx.extension?.tool : undefined;
  if (tool?.humanOnly && tool.calledBy?.actor === "human") return tool.calledBy.account;
  return null;
}

/**
 * The acknowledged objects whose confirmations the caller may read (ADR 0702): all of them for a
 * person who is an admin; for another person, those whose `manage` permission an admin granted
 * them and an installed pack still declares grantable; none for an AI actor or a pack role.
 */
export async function managedObjects(ctx: HandlerContext): Promise<AcknowledgedObject[]> {
  const person = personCalling(ctx);
  if (!person) return [];
  const account = await staffAccount(ctx, person);
  if (!account?.live) return [];
  const objects = acknowledgedObjects();
  if (account.role === "admin" && account.packRole === null) return objects;
  if (!account.grants.length) return [];
  const grantable = await managedGrantable(ctx);
  return objects.filter((o) => {
    const p = o.publishable.acknowledge.manage;
    return account.grants.includes(p) && grantable.has(p);
  });
}

/** Refuses a caller who may not read who has confirmed records of `object`. */
export async function assertManages(ctx: HandlerContext, object: AcknowledgedObject) {
  const mine = await managedObjects(ctx);
  if (mine.some((o) => o.name === object.name)) return;
  throw new ForbiddenError(
    `Reading who has confirmed needs ${object.publishable.acknowledge.manage} (or an admin), and a person`,
    { permission: object.publishable.acknowledge.manage },
  );
}

/**
 * A write of who must read a record (ADR 0702): a person's only, never an AI actor's, and once
 * the record has been published, only one who manages the object's acknowledgements. Changing it
 * takes effect at once: it is not content and waits for no publish.
 */
export async function assertMayChangeMustRead(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string | null,
  values: Record<string, unknown>,
  before: Record<string, unknown> | null,
): Promise<void> {
  const acknowledged = acknowledgedObject(object);
  if (!acknowledged) return;
  const who = acknowledged.publishable.acknowledge.who;
  if (!(who in values)) return;
  if (before && JSON.stringify(before[who] ?? null) === JSON.stringify(values[who] ?? null)) {
    return;
  }
  if (ctx.actor !== "human") {
    throw new ForbiddenError("Who must read is changed by a person, never by an AI actor", {
      field: who,
      actor: ctx.actor,
    });
  }
  if (id === null) return;
  const published = await ctx.db
    .selectFrom("core_publish_version")
    .select("version")
    .where("object_type", "=", object.name)
    .where("record_id", "=", id)
    .limit(1)
    .executeTakeFirst();
  if (!published) return;
  await assertManages(ctx, acknowledged);
}

/**
 * The read-again choice of a publish of `object` (ADR 0702): null on an object that is not
 * acknowledged (where none may be given); true for a record's first version (it always asks);
 * otherwise what the publisher said, which they must say.
 */
export async function readAgainOf(
  ctx: Pick<HandlerContext, "db">,
  object: ObjectDefinition,
  id: string,
  given: boolean | undefined,
): Promise<boolean | null> {
  if (!acknowledgedObject(object)) {
    if (given !== undefined) {
      throw new ValidationError(`${object.label} asks nobody to confirm: leave out readAgain`, {
        field: "readAgain",
        reason: "not_acknowledged",
      });
    }
    return null;
  }
  const ever = await ctx.db
    .selectFrom("core_publish_version")
    .select("version")
    .where("object_type", "=", object.name)
    .where("record_id", "=", id)
    .limit(1)
    .executeTakeFirst();
  if (!ever) {
    if (given === false) {
      throw new ValidationError(
        "The first version always asks everyone who must read it: it cannot be a small fix",
        { field: "readAgain", reason: "first_version_asks" },
      );
    }
    return true;
  }
  if (given === undefined) {
    throw new ValidationError(
      "Say whether this version asks everyone who must read it to confirm again (readAgain: " +
        "true), or is a small fix that keeps their confirmations (readAgain: false)",
      { field: "readAgain", reason: "read_again_required" },
    );
  }
  return given;
}
