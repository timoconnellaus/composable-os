// Whether the host has a subscription plan on sale to the public (ADR 0459): the condition under
// which "anyone starting a subscription" lets an address with no account get a sign-in code.
//
// "On sale" is exactly what `subscription.start` would accept from a guest: the same setup
// (`subscriptionSetup`: a return origin, the orders' currency and a payments connection), and the
// plan read with the same function (`priceLines` as the public, `plans: true`): a live record of a
// recurring sellable object the public may read, priced above nothing, inside its sale window.
// SQL only narrows the candidates (price above nothing, inside the window where the public can
// read those fields); `priceLines` decides. Nothing here is the caller's: it is a fact about the
// host, the same for every address.
import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, sql } from "kysely";
import { clientState } from "../client-scope.ts";
import { ValidationError } from "../errors.ts";
import { refreshSchemaRegistry } from "../extensions/schema.ts";
import { listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { priceLines } from "../orders/orders.ts";
import { sellableOf, sellableProblems } from "../orders/sellable.ts";
import { setupComplete, subscriptionSetup } from "../orders/subscription-setup.ts";
import type { PublicPrincipal } from "../principals.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type AnyRow, buyableSource, scopeOf, type VisibleSource } from "../visibility/index.ts";

const PUBLIC: PublicPrincipal = Object.freeze({ kind: "public" });

/**
 * How many candidate records of each plan object are priced. A host with more candidates than
 * this, none of the first on sale, cannot be answered: the answer is `unknown`, which gives no
 * code (errs shut) and tells admins the switch is doing nothing.
 */
export const PLANS_LOOKED_AT = 50;

/** How long a code request may reuse the answer, in this isolate. Account creation never does. */
export const PLAN_ON_SALE_MEMO_MS = 60_000;

export interface PlanOnSaleRef {
  object: string;
  id: string;
  title: string;
}

export type PlanOnSale =
  | { state: "on_sale"; plan: PlanOnSaleRef }
  | { state: "none" }
  /** Not answered: too many candidates, or the plans could not be read. */
  | { state: "unknown"; reason: string };

// One client's each (stage 66 step 5, ADR 0617): what is on sale is its own.
const memos = clientState<{ memo: { at: number; value: PlanOnSale } | null }>(() => ({
  memo: null,
}));

/** Forgets the memoised answer (tests, and after a change this isolate made itself). */
export function forgetPlanOnSale(): void {
  memos.reset();
}

/**
 * The answer, with the plan found. `memo: true` (code requests only) reuses an answer this
 * isolate worked out in the last PLAN_ON_SALE_MEMO_MS; the recheck when an account is made, and
 * every staff read, work it out again.
 */
export async function findPlanOnSale(
  db: Kysely<CoreDatabase>,
  now: string = new Date().toISOString(),
  options: { memo?: boolean } = {},
): Promise<PlanOnSale> {
  const at = Date.now();
  const held = memos.get();
  const memo = held.memo;
  if (options.memo && memo && at - memo.at < PLAN_ON_SALE_MEMO_MS) return memo.value;
  let value: PlanOnSale;
  try {
    value = await compute(db, now);
  } catch (error) {
    value = { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
  held.memo = { at, value };
  return value;
}

/** Whether a guest could start a subscription to some plan now. Unknown is no. */
export async function hasPlanOnSale(
  db: Kysely<CoreDatabase>,
  now: string = new Date().toISOString(),
): Promise<boolean> {
  return (await findPlanOnSale(db, now)).state === "on_sale";
}

async function compute(db: Kysely<CoreDatabase>, now: string): Promise<PlanOnSale> {
  const setup = await subscriptionSetup(db);
  if (!setupComplete(setup)) return { state: "none" };
  // A sign-in request runs outside the pipeline: load the extensions' objects (one stamp query).
  await refreshSchemaRegistry(db);
  let unanswered = false;
  for (const object of listObjects()) {
    const sellable = sellableOf(object);
    if (!sellable?.recurring || sellableProblems(sellable, object).length) continue;
    const scope = scopeOf(PUBLIC, object, false);
    if (scope.kind !== "public") continue; // the public reads nothing of it
    let source: VisibleSource<AnyRow, string>;
    try {
      source = buyableSource({ principal: PUBLIC }, object);
    } catch {
      continue;
    }
    const readable = new Set(scope.columns);
    const columnOf = (name: string | undefined) => {
      const field = name ? object.fields.find((f) => f.name === name) : undefined;
      const column = field ? viewColumnOf(field) : null;
      return column && readable.has(column) ? column : null;
    };
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    let query = (db as any).selectFrom(source).select("id");
    const price = columnOf(sellable.price);
    if (price) query = query.where(sql.ref(price), ">", 0);
    // A date compares as its day: a window that ends today is still open (priceLines decides).
    const day = now.slice(0, 10);
    const from = columnOf(sellable.saleWindow?.from);
    if (from) {
      query = query.where((eb: AnyWhere) =>
        eb.or([eb(sql.ref(from), "is", null), eb(sql.ref(from), "<=", now)]),
      );
    }
    const until = columnOf(sellable.saleWindow?.until);
    if (until) {
      query = query.where((eb: AnyWhere) =>
        eb.or([eb(sql.ref(until), "is", null), eb(sql.ref(until), ">=", day)]),
      );
    }
    const rows = (await query
      .orderBy("id")
      .limit(PLANS_LOOKED_AT + 1)
      .execute()) as { id: string }[];
    for (const { id } of rows.slice(0, PLANS_LOOKED_AT)) {
      const found = await priced(db, object, id, setup.currency, now);
      if (found) return { state: "on_sale", plan: found };
    }
    if (rows.length > PLANS_LOOKED_AT) unanswered = true;
  }
  return unanswered
    ? { state: "unknown", reason: `more than ${PLANS_LOOKED_AT} plans to look at` }
    : { state: "none" };
}

// biome-ignore lint/suspicious/noExplicitAny: Kysely's expression builder over a registry-driven source.
type AnyWhere = any;

async function priced(
  db: Kysely<CoreDatabase>,
  object: ObjectDefinition,
  id: string,
  currency: string,
  now: string,
): Promise<PlanOnSaleRef | null> {
  try {
    const [line] = await priceLines(
      db,
      [{ object: object.name, id, quantity: 1 }],
      currency,
      now,
      PUBLIC,
      { plans: true },
    );
    return line?.recurring && line.unitPrice > 0
      ? { object: object.name, id, title: line.title }
      : null;
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}
