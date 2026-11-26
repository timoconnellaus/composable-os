// Locations (stage 64, ADR 0910): the places the business works from, inside the one
// organisation. Every host has one from migration 1390, the main location, whose zone is the
// organisation's (Settings → General changes both, settings.update).
//
//   location.list     staff                 every location, the main one first
//   location.get      staff                 one location
//   location.create   settings:manage       a new location; an AI's asks, a person applies
//   location.update   settings:manage       its name, address, zone, price; an AI's asks
//   location.close    settings:manage       a person only; never the last open one
//   location.reopen   settings:manage       a person only
//   location.relocate settings:manage       a room with everything using it; an AI's asks
//
// The public reads a location through public.list and public.get (ADR 0916): what the object
// declares, only while it is shown to the public and open. Nothing deletes a location: it is
// closed. What a closed location refuses (a new class, a duty shift) is the located declaration's,
// stage 64 step 2.
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import { LOCATION_STATES, locationObject, MAIN_LOCATION_FALLBACK } from "../fields/location.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import { usersOf } from "../locations/index.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { isTimezone, loadGeneralSettings } from "../settings.ts";
import { type Reader, visibleSource } from "../visibility/index.ts";

/** At most this many locations on one host: the list is one page, never a cursor. */
export const LOCATION_MAX = 100;

const locationId = z.string().min(1).max(64).describe("A location's id (loc_…)");

const name = z.string().trim().min(1).max(120).describe("The location's name, e.g. City studio");
const shortName = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .describe('A short name for a badge, at most 16 characters, e.g. "City"');
const address = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("The location's address, one line per line of the address");
const timezone = z
  .string()
  .max(64)
  .refine(isTimezone, "Unknown IANA timezone")
  .describe("The IANA time zone the location works in, e.g. Europe/London");
const dropInPrice = z
  .number()
  .int()
  .min(0)
  .max(100_000_000)
  .describe(
    "A drop-in's price at this location, in minor units of the deployment's currency (cents). " +
      "Used when the class type sets none; null: the organisation's price",
  );
const notes = z.string().trim().max(5000).describe("Notes for staff; never shown to the public");

export const locationOut = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string().nullable(),
  address: z.string().nullable(),
  timezone: z.string(),
  public: z.boolean().describe("Shown on the website and in the app while open"),
  dropInPrice: z.number().int().nullable(),
  state: z.enum(LOCATION_STATES),
  notes: z.string().nullable(),
  main: z
    .boolean()
    .describe("The main location: the first, whose zone is the organisation's (pay and the books)"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Location = z.infer<typeof locationOut>;

interface LocationRow {
  id: string;
  name: string;
  short_name: string | null;
  address: string | null;
  timezone: string;
  public: number;
  drop_in_price: number | null;
  state: "open" | "closed";
  notes: string | null;
  main: number;
  created_at: string;
  updated_at: string;
}

const out = (row: LocationRow): Location => ({
  id: row.id,
  name: row.name,
  shortName: row.short_name,
  address: row.address,
  timezone: row.timezone,
  public: Number(row.public) === 1,
  dropInPrice: row.drop_in_price === null ? null : Number(row.drop_in_price),
  state: row.state,
  notes: row.notes,
  main: Number(row.main) === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** What the audit diff of a location holds: its fields, by their API names. */
const audited = (l: Location) => ({
  name: l.name,
  shortName: l.shortName,
  address: l.address,
  timezone: l.timezone,
  public: l.public,
  dropInPrice: l.dropInPrice,
  state: l.state,
  notes: l.notes,
});

/** Every location through the seam, the main one first, then by name. */
export async function listLocations(ctx: Reader): Promise<Location[]> {
  const rows = (await ctx.db
    .selectFrom(visibleSource(ctx, locationObject))
    .selectAll()
    .orderBy(sql`main`, "desc")
    .orderBy(sql`name COLLATE NOCASE`)
    .limit(LOCATION_MAX)
    .execute()) as unknown as LocationRow[];
  return rows.map(out);
}

async function findLocation(ctx: Reader, id: string): Promise<Location | null> {
  const row = (await ctx.db
    .selectFrom(visibleSource(ctx, locationObject))
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()) as LocationRow | undefined;
  return row ? out(row) : null;
}

async function requireLocation(ctx: Reader, id: string): Promise<Location> {
  const location = await findLocation(ctx, id);
  if (!location) throw new NotFoundError("location", id);
  return location;
}

const nameTaken = (taken: string) =>
  new ConflictError(`There is already a location called ${taken}.`, { rule: "location_name" });

/** Another location already has this name, whatever the case (the index refuses it too). */
async function assertNameFree(ctx: Reader, wanted: string, except?: string): Promise<void> {
  const same = await ctx.db
    .selectFrom(visibleSource(ctx, locationObject))
    .select(["id", "name"])
    .where(sql<boolean>`name = ${wanted} COLLATE NOCASE`)
    .execute();
  const other = same.find((row) => row.id !== except);
  if (other) throw nameTaken(String(other.name));
}

export const locationList = defineOperation({
  name: "location.list",
  description:
    "Every place the business works from (a studio, a branch), the main location first: each " +
    "one's name, short name, address, time zone, whether the public is shown it, its drop-in " +
    "price, and whether it is open or closed. Read-only.",
  input: z.object({}),
  output: z.object({ items: z.array(locationOut) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    return { items: await listLocations(ctx) };
  },
});

export const locationGet = defineOperation({
  name: "location.get",
  description: "One place the business works from. Read-only.",
  input: z.object({ id: locationId }),
  output: locationOut,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return requireLocation(ctx, input.id);
  },
});

export const locationCreate = defineOperation({
  name: "location.create",
  description:
    "Add a place the business works from (a second studio, a branch), open from now. Its time " +
    "zone defaults to the organisation's. Its name is unique among locations. A request from an " +
    "AI always waits for a person to apply it. Returns the location.",
  input: z.object({
    name,
    shortName: shortName.optional(),
    address: address.optional(),
    timezone: timezone.optional(),
    public: z.boolean().default(true).describe("Show it on the website and in the app"),
    dropInPrice: dropInPrice.optional(),
    notes: notes.optional(),
  }),
  output: locationOut,
  permission: "settings:manage",
  risk: "write",
  actors: ["human", "assistant", "mcp"],
  // What members see and pay changes: an AI drafts, a person applies (ADR 0910).
  alwaysReview: ["assistant", "mcp"],
  async handler(input, ctx) {
    await assertNameFree(ctx, input.name);
    const existing = await listLocations(ctx);
    if (existing.length >= LOCATION_MAX) {
      throw new ValidationError(`A host has at most ${LOCATION_MAX} locations.`, {
        rule: "location_max",
        max: LOCATION_MAX,
      });
    }
    const zone = input.timezone ?? (await loadGeneralSettings(ctx.db)).timezone;
    const row: LocationRow = {
      id: newId("location"),
      name: input.name,
      short_name: input.shortName ?? null,
      address: input.address ?? null,
      timezone: zone,
      public: input.public ? 1 : 0,
      drop_in_price: input.dropInPrice ?? null,
      state: "open",
      notes: input.notes || null,
      main: 0,
      created_at: ctx.now,
      updated_at: ctx.now,
    };
    ctx.write(
      ctx.db
        .insertInto("core_location")
        .values({ ...row, created_by: ctx.user.id, updated_by: ctx.user.id }),
    );
    const location = out(row);
    ctx.recordChange({
      object: "location",
      id: row.id,
      action: "create",
      after: audited(location),
    });
    return location;
  },
});

export const locationUpdate = defineOperation({
  name: "location.update",
  description:
    "Change a location's name, short name, address, time zone, whether the public is shown it, " +
    "its drop-in price or its notes; null clears an optional one. The main location's zone is " +
    "the organisation's, changed in Settings → General (settings.update), not here. Records " +
    "already made keep their own zone. A request from an AI always waits for a person to apply " +
    "it. Returns the location.",
  input: z.object({
    id: locationId,
    name: name.optional(),
    shortName: shortName.nullable().optional(),
    address: address.nullable().optional(),
    timezone: timezone.optional(),
    public: z.boolean().optional().describe("Show it on the website and in the app"),
    dropInPrice: dropInPrice.nullable().optional(),
    notes: notes.nullable().optional(),
  }),
  output: locationOut,
  permission: "settings:manage",
  risk: "write",
  actors: ["human", "assistant", "mcp"],
  // Its name, zone, price and whether it is shown change what members see: an AI drafts.
  alwaysReview: ["assistant", "mcp"],
  async handler(input, ctx) {
    const before = await requireLocation(ctx, input.id);
    if (input.timezone !== undefined && input.timezone !== before.timezone && before.main) {
      throw new ValidationError(
        "The main location's time zone is the organisation's: change it in Settings → General.",
        { rule: "main_location_zone" },
      );
    }
    if (input.name !== undefined && input.name.toLowerCase() !== before.name.toLowerCase()) {
      await assertNameFree(ctx, input.name, before.id);
    }
    const after: Location = {
      ...before,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.shortName !== undefined ? { shortName: input.shortName } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.public !== undefined ? { public: input.public } : {}),
      ...(input.dropInPrice !== undefined ? { dropInPrice: input.dropInPrice } : {}),
      ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
    };
    if (JSON.stringify(audited(after)) === JSON.stringify(audited(before))) return before;
    const changed: Location = { ...after, updatedAt: ctx.now };
    ctx.write(
      ctx.db
        .updateTable("core_location")
        .set({
          name: changed.name,
          short_name: changed.shortName,
          address: changed.address,
          timezone: changed.timezone,
          public: changed.public ? 1 : 0,
          drop_in_price: changed.dropInPrice,
          notes: changed.notes,
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .where("id", "=", before.id),
    );
    ctx.recordChange({
      object: "location",
      id: before.id,
      action: "update",
      before: audited(before),
      after: audited(changed),
    });
    return changed;
  },
});

/** Opens or closes a location; the database refuses closing the last open one. */
async function moveLocation(
  ctx: HandlerContext,
  id: string,
  to: "open" | "closed",
): Promise<Location> {
  const before = await requireLocation(ctx, id);
  if (before.state === to) return before;
  if (to === "closed") {
    const open = (await listLocations(ctx)).filter((l) => l.state === "open");
    if (open.length <= 1) throw lastOpenLocation();
  }
  ctx.write(
    ctx.db
      .updateTable("core_location")
      .set({ state: to, updated_at: ctx.now, updated_by: ctx.user.id })
      .where("id", "=", id),
  );
  ctx.recordChange({
    object: "location",
    id,
    action: "update",
    before: { state: before.state },
    after: { state: to },
  });
  return { ...before, state: to, updatedAt: ctx.now };
}

export const lastOpenLocation = () =>
  new ConflictError("This is the only open location, so it cannot be closed.", {
    rule: "last_open_location",
  });

export const locationClose = defineOperation({
  name: "location.close",
  description:
    "Close a location: it takes no new classes, appointments or shifts. Classes already made " +
    "there are not cancelled (cancel them with the closure or cancel tools, which tell members). " +
    "The last open location cannot be closed. A person only, never an AI. Returns the location.",
  input: z.object({ id: locationId }),
  output: locationOut,
  permission: "settings:manage",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    return moveLocation(ctx, input.id, "closed");
  },
});

export const locationReopen = defineOperation({
  name: "location.reopen",
  description:
    "Open a closed location again: it takes new classes, appointments and shifts. A person only, " +
    "never an AI. Returns the location.",
  input: z.object({ id: locationId }),
  output: locationOut,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    return moveLocation(ctx, input.id, "open");
  },
});

/**
 * The main location follows the organisation (settings.update, ADR 0910): its zone always, and
 * its name while it still has the one it was given (the organisation's earlier name, or the
 * fallback of a host that had none) and no other location has the new one.
 */
export async function followOrganisation(
  ctx: HandlerContext,
  before: { orgName: string | null; timezone: string },
  after: { orgName: string | null; timezone: string },
): Promise<void> {
  const zoneChanged = after.timezone !== before.timezone;
  const nameChanged = after.orgName !== null && after.orgName !== before.orgName;
  if (!zoneChanged && !nameChanged) return;
  const locations = await listLocations(ctx);
  const main = locations.find((l) => l.main);
  if (!main) return;
  const given = [before.orgName ?? MAIN_LOCATION_FALLBACK, MAIN_LOCATION_FALLBACK];
  let rename: string | null = null;
  if (nameChanged && after.orgName && given.includes(main.name)) {
    const wanted = after.orgName.trim().slice(0, 120);
    const taken = locations.some((l) => !l.main && l.name.toLowerCase() === wanted.toLowerCase());
    if (!taken && wanted !== main.name) rename = wanted;
  }
  const set = {
    ...(zoneChanged ? { timezone: after.timezone } : {}),
    ...(rename ? { name: rename } : {}),
  };
  if (!Object.keys(set).length) return;
  ctx.write(
    ctx.db
      .updateTable("core_location")
      .set({ ...set, updated_at: ctx.now, updated_by: ctx.user.id })
      .where("main", "=", 1),
  );
  ctx.recordChange({
    object: "location",
    id: main.id,
    action: "update",
    before: {
      ...(zoneChanged ? { timezone: main.timezone } : {}),
      ...(rename ? { name: main.name } : {}),
    },
    after: set,
  });
}

/**
 * A record filed at the wrong location, moved with everything that names it (ADR 0911): a room the
 * reconciler filed under the main location when its classes were held elsewhere. A room's
 * location never changes on its own while a live record that agrees with it names it; this moves
 * the record and every record of every object whose `agree` passes through it (in the Trash too,
 * past and future alike) in one batch. Each moved record names its relation to it again with the
 * new location in a second statement, so every agree trigger reads the end state: the room at the
 * new location, each class there with it. Zones and times are kept: it says where records are
 * filed, not when anything happens.
 */
export const locationRelocate = defineOperation({
  name: "location.relocate",
  description:
    "Move a located record (a room) to another location together with every record that uses " +
    "it (its classes and series, past and future, in the Trash too), in one change: the way to " +
    "correct a record filed at the wrong location, since a used room's location never changes " +
    "on its own. Times and zones are kept. A request from an AI always waits for a person to " +
    "apply it. Returns how many records of each object moved.",
  input: z.object({
    object: z.string().min(1).max(81).describe("The record's object, e.g. bookings.room"),
    id: z.string().min(1).max(64).describe("The record's id"),
    location: locationId.describe("The location to move it to"),
  }),
  output: z.object({
    object: z.string(),
    id: z.string(),
    location: z.string(),
    moved: z.array(z.object({ object: z.string(), count: z.number().int() })),
  }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human", "assistant", "mcp"],
  // Past records' location changes what every report by location says: an AI drafts.
  alwaysReview: ["assistant", "mcp"],
  async handler(input, ctx) {
    const object = getObject(input.object);
    const located = object?.located;
    const table = object ? objectTableOf(object.name) : undefined;
    const column = object && located ? columnOfField(object, located.field) : undefined;
    if (!object || !located || located.via || !table || !column) {
      throw new ValidationError(`${input.object} is not located by a field of its own`, {
        field: "object",
      });
    }
    const row = (await ctx.db
      .selectFrom(visibleSource(ctx, object))
      .select(sql<string | null>`${sql.ref(column)}`.as("location"))
      .where("id", "=", input.id)
      .executeTakeFirst()) as { location: string | null } | undefined;
    if (!row) throw new NotFoundError(object.name, input.id);
    const to = await requireLocation(ctx, input.location);
    const result = { object: object.name, id: input.id, location: to.id };
    if (row.location === to.id) return { ...result, moved: [] };
    if (to.state === "closed") {
      throw new ValidationError(`${to.name} is closed: nothing new is filed there`, {
        field: "location",
        rule: "location_closed",
        location: to.id,
      });
    }
    const users = usersOf(object.name).map((u) => ({
      ...u,
      table: objectTableOf(u.user.name) as string,
      linkColumn: columnOfField(u.user, u.link) as string,
      locationColumn: columnOfField(u.user, u.location) as string,
    }));
    const moved = await Promise.all(
      users.map(async (u) => {
        const counted = await sql<{
          n: number;
        }>`SELECT count(*) AS n FROM ${sql.table(u.table)} WHERE ${sql.ref(u.linkColumn)} = ${input.id}`.execute(
          ctx.db,
        );
        return { object: u.user.name, count: Number(counted.rows[0]?.n ?? 0) };
      }),
    );
    // A mark no record's id can be: while it stands in the relation, the record names nothing.
    const mark = `relocating:${input.id}`;
    for (const u of users) {
      ctx.write(
        sql`UPDATE ${sql.table(u.table)} SET ${sql.ref(u.linkColumn)} = ${mark} WHERE ${sql.ref(u.linkColumn)} = ${input.id}`.compile(
          ctx.db,
        ),
      );
    }
    ctx.write(
      sql`UPDATE ${sql.table(table)} SET ${sql.ref(column)} = ${to.id}, updated_at = ${ctx.now}, updated_by = ${ctx.user.id} WHERE id = ${input.id}`.compile(
        ctx.db,
      ),
    );
    for (const u of users) {
      ctx.write(
        sql`UPDATE ${sql.table(u.table)} SET ${sql.ref(u.linkColumn)} = ${input.id}, ${sql.ref(u.locationColumn)} = ${to.id}, updated_at = ${ctx.now}, updated_by = ${ctx.user.id} WHERE ${sql.ref(u.linkColumn)} = ${mark}`.compile(
          ctx.db,
        ),
      );
    }
    ctx.recordChange({
      object: object.name,
      id: input.id,
      action: "update",
      before: { [located.field]: row.location },
      after: { [located.field]: to.id, relocatedWith: moved },
    });
    return { ...result, moved };
  },
});

/** A field's column, from the registry. */
const columnOfField = (object: ObjectDefinition, field: string) =>
  object.fields.find((f) => f.name === field)?.column;

export const locationOperations = [
  locationList,
  locationGet,
  locationCreate,
  locationUpdate,
  locationClose,
  locationReopen,
  locationRelocate,
] as const;
