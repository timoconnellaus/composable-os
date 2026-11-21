// The `capacity` behaviour (stage 26, ADR 0430, ADR 0431): an object declares that its records
// have a limited number of places, and the host never gives out more than there are, for every
// actor. Its declaration, its manifest schema and its contract checks live here; the host's side
// is packages/core/src/capacity/.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/**
 * What customers and the public are told about a record's places (staff always see the real
 * numbers): `exact`, the number left; `low`, available, "only N left" at or below `lowAt`, or sold
 * out; `availability`, available or sold out.
 */
export const CAPACITY_SHOW = ["exact", "low", "availability"] as const;
export type CapacityShow = (typeof CAPACITY_SHOW)[number];

/**
 * The read-only values the host adds to every record of an object with a capacity: places held
 * while someone pays, places taken, and places left (the record's and its pool's, whichever is
 * fewer; null when unlimited). An object with a capacity cannot have fields of these names.
 */
export const CAPACITY_VALUES = ["held", "taken", "available"] as const;

/**
 * A limited number of places (ADR 0430). The host keeps a counter per record and refuses, in the
 * database, any claim past the places: a hold while an order is unpaid, confirmed when it is paid.
 * A hold has no clock of its own: it lasts as long as what it was taken for.
 *
 * - `places` is this object's number field holding how many places there are. Empty means
 *   unlimited. Staff edit it; lowering it below what is held and taken is refused with the
 *   numbers, for every actor, and nothing ever sells beyond it.
 * - `pool` is a relation field (one record) to another of this extension's objects that itself
 *   declares a capacity, and no pool: a claim on this record also claims on that record, in the
 *   same batch (a ticket type's places within its event's). One level only.
 * - `show` is what customers and the public are told (default `availability`); `lowAt` is the
 *   threshold for `low`.
 * - `releaseOnRefund` (default true): a refunded order's places go back on sale.
 */
export interface CapacitySpec {
  places: string;
  pool?: string;
  show?: CapacityShow;
  lowAt?: number;
  releaseOnRefund?: boolean;
}

const fieldName = z.string().max(40);

export const capacityManifestSchema = z
  .object({
    places: fieldName,
    pool: fieldName.optional(),
    show: z.enum(CAPACITY_SHOW).optional(),
    lowAt: z.number().int().min(1).max(1_000_000).optional(),
    releaseOnRefund: z.boolean().optional(),
  })
  .strict();
export type CapacityManifest = z.infer<typeof capacityManifestSchema>;

/** Reports problems with `objects.<name>.capacity` through `contract`. */
export function checkObjectCapacity(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const capacity = object.capacity;
  if (!capacity) return;
  const path = `objects.${name}.capacity`;
  const fieldOf = (local: string): FieldManifest | undefined =>
    Object.hasOwn(object.fields, local) ? object.fields[local] : undefined;

  const places = fieldOf(capacity.places);
  if (places?.type !== "number" || places.many) {
    contract(`${path}.places`, `"${capacity.places}" must be a number field of ${name}`);
  }
  for (const reserved of CAPACITY_VALUES) {
    if (Object.hasOwn(object.fields, reserved)) {
      contract(
        `objects.${name}.fields.${reserved}`,
        `"${reserved}" is a value the host adds to an object with a capacity; rename the field`,
      );
    }
  }
  if (capacity.pool !== undefined) {
    const pool = fieldOf(capacity.pool);
    const target = pool?.type === "relation" && !pool.many ? pool.to : undefined;
    const local = target?.startsWith(`${m.id}.`) ? target.slice(m.id.length + 1) : undefined;
    const targetObject =
      local !== undefined && Object.hasOwn(m.objects, local) ? m.objects[local] : undefined;
    if (!targetObject) {
      contract(
        `${path}.pool`,
        `"${capacity.pool}" must be a relation field (one record) to another of this extension's objects`,
      );
    } else if (local === name) {
      contract(`${path}.pool`, "An object cannot be its own pool");
    } else if (!targetObject.capacity) {
      contract(`${path}.pool`, `The pool's object ${target} must declare a capacity`);
    } else if (targetObject.capacity.pool !== undefined) {
      contract(
        `${path}.pool`,
        `The pool's object ${target} has a pool of its own; capacity has one level of pool`,
      );
    }
  }
  if (capacity.lowAt !== undefined && capacity.show !== "low") {
    contract(`${path}.lowAt`, 'lowAt is the threshold of show: "low"');
  }
  if (capacity.show === "low" && capacity.lowAt === undefined) {
    contract(`${path}.lowAt`, 'show: "low" needs lowAt, the number at or below which it says so');
  }
}
