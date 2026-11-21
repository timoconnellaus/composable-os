// What a caller may know of a record's places (stage 26, ADR 0433). Staff see the real numbers.
// A customer or the public is told only what the object's `show` allows, worked out here, in the
// host: `exact` the number left, `low` available, "only N left" at or below the threshold, or
// sold out, `availability` available or sold out. Never held or taken, and never the pool's.
//
// Capacity is its own scope. A ticket type is not a customer's record, so the record seam would
// show them nothing of it; the places left are what a buyer must be able to see. So any live
// record of an object that declares a capacity can be asked about by id, and the answer is
// limited to `show`. When stage 28's `publishable` exists, outside callers should be limited to
// published records as well.
import { NotFoundError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { CapacityDefinition, ObjectDefinition } from "../fields/types.ts";
import { unknownObject } from "./customer.ts";
import { orgReader, type Reader, visibleTable } from "./index.ts";

export type CapacityStatus = "available" | "low" | "sold_out";

/** capacity.get's answer. Outside callers get `status` and at most `available`. */
export interface CapacityView {
  object: string;
  id: string;
  status: CapacityStatus;
  /** Places left (the fewer of the record's and its pool's); null when unlimited. */
  available?: number | null;
  places?: number | null;
  held?: number;
  taken?: number;
  show?: CapacityDefinition["show"];
  lowAt?: number | null;
  pool?: {
    object: string;
    id: string;
    places: number | null;
    held: number;
    taken: number;
    available: number | null;
  } | null;
}

interface Row {
  places: number | null;
  held: number;
  taken: number;
  pool_object_type: string | null;
  pool_record_id: string | null;
  pool_places: number | null;
  pool_held: number | null;
  pool_taken: number | null;
}

const left = (places: number | null, held: number, taken: number) =>
  places === null ? null : Math.max(places - held - taken, 0);

/** The status `show` gives for `available` places left (null: unlimited). */
export function capacityStatus(
  capacity: CapacityDefinition,
  available: number | null,
): CapacityStatus {
  if (available === null) return "available";
  if (available === 0) return "sold_out";
  if (capacity.show === "low" && capacity.lowAt !== undefined && available <= capacity.lowAt) {
    return "low";
  }
  return "available";
}

/** What `show` lets someone outside the organisation know. */
export function outsideView(
  object: ObjectDefinition & { capacity: CapacityDefinition },
  id: string,
  available: number | null,
): CapacityView {
  const status = capacityStatus(object.capacity, available);
  const base = { object: object.name, id, status };
  switch (object.capacity.show) {
    case "exact":
      return { ...base, available };
    case "low":
      return status === "low" ? { ...base, available } : base;
    default:
      return base;
  }
}

/**
 * A record's places for `reader`: everything for staff, what `show` allows for a customer or the
 * public. An object without a capacity, or a record not live, is not found.
 */
export async function readCapacity(
  reader: Reader,
  name: string,
  id: string,
): Promise<CapacityView> {
  const object = getObject(name);
  if (!object?.capacity) throw unknownObject(name);
  const withCapacity = object as ObjectDefinition & { capacity: CapacityDefinition };
  // Whether the record is live, read as the organisation: the caller's own scope would hide a
  // record that is not theirs, which is every record a buyer asks about.
  const live = await orgReader(reader.db)
    .db.selectFrom(visibleTable(orgReader(reader.db), object, "t"))
    .select("t.deleted_at")
    .where("t.id", "=", id)
    .executeTakeFirst();
  if (!live || live.deleted_at !== null) throw new NotFoundError(name, id);
  const row = (await reader.db
    .selectFrom("core_capacity as c")
    .leftJoin("core_capacity as p", (join) =>
      join
        .onRef("p.object_type", "=", "c.pool_object_type")
        .onRef("p.record_id", "=", "c.pool_record_id"),
    )
    .select([
      "c.places",
      "c.held",
      "c.taken",
      "c.pool_object_type",
      "c.pool_record_id",
      "p.places as pool_places",
      "p.held as pool_held",
      "p.taken as pool_taken",
    ])
    .where("c.object_type", "=", name)
    .where("c.record_id", "=", id)
    .executeTakeFirst()) as Row | undefined;
  const own = row ? left(row.places, row.held, row.taken) : null;
  const pool =
    row?.pool_object_type && row.pool_record_id
      ? {
          object: row.pool_object_type,
          id: row.pool_record_id,
          places: row.pool_places,
          held: row.pool_held ?? 0,
          taken: row.pool_taken ?? 0,
          available: left(row.pool_places, row.pool_held ?? 0, row.pool_taken ?? 0),
        }
      : null;
  const available =
    own === null
      ? (pool?.available ?? null)
      : pool?.available == null
        ? own
        : Math.min(own, pool.available);
  if (reader.principal.kind !== "staff") return outsideView(withCapacity, id, available);
  return {
    object: name,
    id,
    status: capacityStatus(object.capacity, available),
    available,
    places: row?.places ?? null,
    held: row?.held ?? 0,
    taken: row?.taken ?? 0,
    show: object.capacity.show,
    lowAt: object.capacity.lowAt ?? null,
    pool,
  };
}
