// A discount's terms as a person approves them (stage 34 step 5, ADR 0699). When a call that names
// a discount waits for a person (the assistant asking to make one live, or to change it), the
// queue keeps the discount's terms as they were when it was asked, and says them in words in the
// approval; approving it is refused if they have changed since, so the person never approves one
// set of terms and makes another live. Generic over every object declaring `discount`: the terms
// are the fields the behaviour names.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { ConflictError } from "../errors.ts";
import { listObjects } from "../fields/index.ts";
import type { DiscountDefinition, ObjectDefinition } from "../fields/types.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type AnyRow, orgReader, visibleSource } from "../visibility/index.ts";

/** A discount as a waiting call found it. */
export interface DiscountSnapshot {
  object: string;
  id: string;
  title: string;
  /** Each field the behaviour names, by field name, as stored. */
  terms: Record<string, unknown>;
}

type DiscountObject = ObjectDefinition & { discount: DiscountDefinition };

/** The fields of a discount object that decide what a buyer is charged. */
export function termFields(object: DiscountObject): string[] {
  const d = object.discount;
  const named = [
    d.kind,
    d.percent,
    d.amount,
    d.automatic,
    d.code,
    d.who,
    d.plans,
    d.organisations,
    d.tag,
    d.objects,
    ...(d.records ?? []),
    d.from,
    d.until,
    d.totalUses,
    d.perPerson,
    d.minSpend,
  ];
  return [...new Set(named.filter((f): f is string => typeof f === "string"))];
}

const discountObjects = (): DiscountObject[] =>
  listObjects().filter((o): o is DiscountObject => o.discount !== undefined);

// biome-ignore lint/suspicious/noExplicitAny: registry-driven views, not keys of the typed schema.
const anyDb = (db: Kysely<CoreDatabase>) => db as unknown as Kysely<any>;

async function read(db: Kysely<CoreDatabase>, ids: readonly string[]): Promise<DiscountSnapshot[]> {
  if (!ids.length) return [];
  const found: DiscountSnapshot[] = [];
  for (const object of discountObjects()) {
    const rows = (await anyDb(db)
      .selectFrom(visibleSource(orgReader(db), object))
      .selectAll()
      .where("id", "in", [...ids])
      .execute()) as AnyRow[];
    for (const row of rows) {
      const terms: Record<string, unknown> = {};
      for (const name of termFields(object)) {
        const field = object.fields.find((f) => f.name === name);
        const column = field ? viewColumnOf(field) : null;
        terms[name] = column && Object.hasOwn(row, column) ? normal(row[column]) : null;
      }
      const titleField = object.fields.find((f) => f.name === object.titleField);
      const titleColumn = titleField ? viewColumnOf(titleField) : null;
      const title = titleColumn ? row[titleColumn] : null;
      found.push({
        object: object.name,
        id: String(row.id),
        title: title == null || title === "" ? object.label : String(title),
        terms,
      });
    }
  }
  return found;
}

/** A stored value as compared: empty is null, a JSON list its sorted values. */
function normal(value: unknown): unknown {
  if (value === undefined || value === "") return null;
  if (typeof value === "string" && value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).sort();
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(String).sort();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(normal(a)) === JSON.stringify(normal(b));

/** The discounts among `ids` (the ids a waiting call's input names), with their terms now. */
export function snapshotDiscounts(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
): Promise<DiscountSnapshot[]> {
  return read(db, ids);
}

function labelOf(object: string, name: string): string {
  return (
    listObjects()
      .find((o) => o.name === object)
      ?.fields.find((f) => f.name === name)?.label ?? name
  );
}

function shown(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "empty";
  return String(value);
}

/** The terms in words, for the person who approves: every field the behaviour names. */
export function describeDiscount(snapshot: DiscountSnapshot): string {
  const parts = Object.entries(snapshot.terms)
    .filter(([, value]) => value !== null && !(Array.isArray(value) && !value.length))
    .map(([name, value]) => `${labelOf(snapshot.object, name)}: ${shown(value)}`);
  return (
    `It names the discount "${snapshot.title}" as it is now: ${parts.join("; ") || "no terms set"}. ` +
    "If its terms change before this is approved, approving it is refused."
  );
}

/**
 * Refuses an approval when a discount it names has terms other than those it was asked with
 * (ADR 0699): the person would be approving terms they were not shown.
 */
export async function assertDiscountsUnchanged(
  db: Kysely<CoreDatabase>,
  snapshots: readonly DiscountSnapshot[],
): Promise<void> {
  if (!snapshots.length) return;
  const now = await read(
    db,
    snapshots.map((s) => s.id),
  );
  for (const then of snapshots) {
    const current = now.find((n) => n.id === then.id && n.object === then.object);
    if (!current) continue;
    const changed = Object.keys(then.terms).filter(
      (name) => !same(then.terms[name], current.terms[name]),
    );
    if (changed.length) {
      const what = changed
        .map(
          (name) =>
            `${labelOf(then.object, name)} ${shown(then.terms[name])} → ${shown(current.terms[name])}`,
        )
        .join(", ");
      throw new ConflictError(
        `The discount "${then.title}" changed after this was asked for (${what}), so approving it ` +
          "would apply terms nobody approved. Reject it and ask again.",
        { rule: "discount_changed", object: then.object, id: then.id, fields: changed },
      );
    }
  }
}
