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
  /** Whether approving the call depends on these terms (false: pausing, ending, voiding). */
  bound?: boolean;
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

/** The record writes whose approval is bound to a discount's terms. */
const RECORD_WRITES = new Set([
  "record.create",
  "record.createMany",
  "record.update",
  "record.restore",
  "record.restoreVersion",
  "record.import",
]);

/**
 * Whether approving `operation` depends on the discount's terms (review of PR #479, M2): a record
 * write of it, or a tool its object names in a move into a live state (making it live). Pausing,
 * ending, voiding codes and the like make nothing reach buyers, so a change to the terms meanwhile
 * never stops a person approving them (ending a leaked discount is always approvable).
 */
export function boundToTerms(operation: string, object: DiscountObject): boolean {
  if (RECORD_WRITES.has(operation)) return true;
  const ext = object.name.split(".")[0];
  const tool = /^x\.([a-z][a-z0-9]*)\.([A-Za-z0-9_]+)$/.exec(operation);
  if (!tool || tool[1] !== ext) return false;
  const live = new Set(object.discount.live);
  return (object.states?.moves ?? []).some(
    (move) => live.has(move.to) && (move.tools ?? []).includes(tool[2] as string),
  );
}

/**
 * The discounts among `ids` (the ids a waiting call's input names), with their terms now, each
 * marked whether approving `operation` is bound to them.
 */
export async function snapshotDiscounts(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
  operation: string,
): Promise<DiscountSnapshot[]> {
  const found = await read(db, ids);
  return found.map((s) => {
    const object = discountObjects().find((o) => o.name === s.object);
    return { ...s, bound: object ? boundToTerms(operation, object) : true };
  });
}

/**
 * Other requests waiting for approval that name the same discounts (review of PR #479, S2): the
 * words say so, since approving them with this one would change the terms it shows.
 */
export async function otherPendingFor(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
  now: string,
): Promise<Map<string, string[]>> {
  const others = new Map<string, string[]>();
  if (!ids.length) return others;
  const rows = await db
    .selectFrom("core_pending_action_records as r")
    .innerJoin("core_pending_action as p", "p.id", "r.action_id")
    .select(["r.record_id as record", "p.id as action"])
    .where("r.record_id", "in", [...ids])
    .where("p.status", "=", "pending")
    .where("p.expires_at", ">", now)
    .execute();
  for (const row of rows) {
    others.set(row.record, [...(others.get(row.record) ?? []), row.action]);
  }
  return others;
}

const fieldOf = (object: string, name: string) =>
  listObjects()
    .find((o) => o.name === object)
    ?.fields.find((f) => f.name === name);

function labelOf(object: string, name: string): string {
  return fieldOf(object, name)?.label ?? name;
}

/** A stored value in words: a choice's label, yes or no, money with its currency. */
function shown(object: string, name: string, value: unknown, currency: string | null): string {
  if (value === null || value === undefined) return "empty";
  const field = fieldOf(object, name);
  const choices = field?.options?.choices;
  const label = (v: unknown) => choices?.find((c) => c.value === String(v))?.label ?? String(v);
  if (Array.isArray(value)) return value.length ? value.map(label).join(", ") : "empty";
  if (field?.fieldType === "boolean") return value === 1 || value === true ? "yes" : "no";
  if (field?.fieldType === "currency" && typeof value === "number" && currency) {
    return `${value.toFixed(2)} ${currency}`;
  }
  return label(value);
}

/** The terms in words, for the person who approves: every field the behaviour names. */
export function describeDiscount(
  snapshot: DiscountSnapshot,
  currency: string | null = null,
  others: readonly string[] = [],
): string {
  const parts = Object.entries(snapshot.terms)
    .filter(([, value]) => value !== null && !(Array.isArray(value) && !value.length))
    .map(
      ([name, value]) =>
        `${labelOf(snapshot.object, name)}: ${shown(snapshot.object, name, value, currency)}`,
    );
  return (
    `It names the discount "${snapshot.title}" as it is now: ${parts.join("; ") || "no terms set"}.` +
    (snapshot.bound === false
      ? ""
      : " If its terms change before this is applied, it is refused.") +
    (others.length
      ? ` Other requests waiting for approval also name this discount (${others.join(", ")}): ` +
        "approved with this one, one that changes its terms applies first and this one is then refused."
      : "")
  );
}

/**
 * Refuses an approval when a discount it is bound to has terms other than those it was asked with
 * (ADR 0699): the person would be approving terms they were not shown. Run before the claim and
 * again just before each action applies, so an action approved with it that changes the terms
 * cannot slip past.
 */
export async function assertDiscountsUnchanged(
  db: Kysely<CoreDatabase>,
  snapshots: readonly DiscountSnapshot[],
): Promise<void> {
  const bound = snapshots.filter((s) => s.bound !== false);
  if (!bound.length) return;
  const now = await read(
    db,
    bound.map((s) => s.id),
  );
  for (const then of bound) {
    const current = now.find((n) => n.id === then.id && n.object === then.object);
    if (!current) continue;
    const changed = Object.keys(then.terms).filter(
      (name) => !same(then.terms[name], current.terms[name]),
    );
    if (changed.length) {
      const what = changed
        .map(
          (name) =>
            `${labelOf(then.object, name)} ${shown(then.object, name, then.terms[name], null)} → ${shown(then.object, name, current.terms[name], null)}`,
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
