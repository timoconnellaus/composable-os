// Needs your attention (stage 48 step 4, ADR 0711): what a signed-in customer, or a child they act
// for, has to do now, worked out by the host from core records and behaviours only (agreements,
// orders, subscriptions and the `allowance` behaviour). No pack code runs and no client names a
// pack: a pack's records reach this list only through the behaviours it declares.
//
// The kinds are a fixed vocabulary in core (decision 2 of the stage's interview):
//
//   agree            a document to agree to, for them or a live dependant (as me.agreements.due)
//   card_failing     a subscription they pay in past_due or unpaid, or with failing_since
//   confirm_payment  a subscription they pay in incomplete: their bank waits for them
//   balance_due      an order of theirs part paid, with the balance's due date
//   finish_paying    an order of theirs pending, holding places, with an expiry
//   pass_expiring    a pass (a holder of N uses in all) ending within `account.attentionDays`
//                    with uses left: theirs, or a dependant's where the object opens to guardians
//   pass_used_up     the same kind of holder with no uses left while still valid
//   trial_ending     a subscription they pay whose free trial ends within the days
//
// A subscription is the payer's (ADR 0487); a pass is its holder's and their live guardians'. A
// membership's per-period limit used up renews by itself and is never `pass_used_up`. A
// subscription set to end (cancelled by them) is not listed for its ending.
//
// Cost: a fixed number of statements whatever the packs installed: the setting, the family, the
// agreements (two for the documents, one per Person for their facts, one for the acceptances),
// one for subscriptions, orders through the seam (the open ones, their held places, their first
// lines), one for allowance holders, and one seam read per holder object that has a pass in the
// list (titles, and the guardians rule, through the seam). Each binds at most about 50 ids.
import { sql } from "kysely";
import {
  acceptanceKey,
  acceptancesOf,
  appliesTo,
  attachedDocuments,
  countingAcceptance,
  personFacts,
} from "../agreements/due.ts";
import { boundOf } from "../allowance/periods.ts";
import { OperationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { ORDER_CLAIM_TYPE } from "../orders/holds.ts";
import { dependantsSql } from "../visibility/guardians.ts";
import { loadAttentionDays } from "./settings.ts";

export const ATTENTION_KINDS = [
  "agree",
  "card_failing",
  "confirm_payment",
  "balance_due",
  "finish_paying",
  "pass_expiring",
  "pass_used_up",
  "trial_ending",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export interface AttentionItem {
  /** Stable for the same cause: kind, record and Person. */
  key: string;
  kind: AttentionKind;
  /** Whose it is: the caller, or a live dependant by name. */
  person: { id: string; name: string; self: boolean };
  /** The record it is about. `object` is a core name (agreement, subscription, order) or a pack's. */
  record: { object: string; id: string; title: string };
  /**
   * The moment it is about: when the document's version took effect, when the card first
   * failed, when the payment was started, when the balance is due, when the held order expires,
   * when the pass ends, when the trial ends.
   */
  at: string | null;
  /** Money, in the currency's minor unit, where there is some: what is due or what is charged. */
  amount: number | null;
  currency: string | null;
  /** A pass's uses left (pass_expiring and pass_used_up). */
  usesLeft: number | null;
}

const DAY_MS = 86_400_000;

/** The most pass holders of one object read back through the seam (a list's page). */
const PASSES_PER_OBJECT = 50;

/** The most open orders read (soonest made first): each id is a bound variable later. */
const ORDERS_READ = 50;

/** What needs the signed-in customer's attention, soonest first. */
export async function attentionOf(
  ctx: HandlerContext,
): Promise<{ days: number; items: AttentionItem[] }> {
  if (ctx.principal.kind !== "customer") {
    throw new OperationError("internal", `${ctx.operation} is for a customer's call`);
  }
  const me = ctx.principal.personId;
  const now = ctx.now;
  const days = await loadAttentionDays(ctx.db);
  const horizon = new Date(new Date(now).getTime() + days * DAY_MS).toISOString();

  const family = await ctx.records.family();
  const people = new Map<string, { id: string; name: string; self: boolean }>([
    [me, { id: me, name: family.self?.name ?? "", self: true }],
  ]);
  for (const d of family.dependants) {
    if (!people.has(d.personId)) {
      people.set(d.personId, { id: d.personId, name: d.name, self: false });
    }
  }
  const self = people.get(me) as { id: string; name: string; self: boolean };

  const items: AttentionItem[] = [];
  const add = (item: Omit<AttentionItem, "key" | "usesLeft"> & { usesLeft?: number | null }) =>
    items.push({
      ...item,
      usesLeft: item.usesLeft ?? null,
      key: `${item.kind}:${item.record.object}:${item.record.id}:${item.person.id}`,
    });

  // --- agree: what me.agreements.due answers, for the caller and each live dependant ----------
  const docs = await attachedDocuments(ctx.db, null);
  if (docs.length) {
    const ids = [...people.keys()];
    const accepted = await acceptancesOf(
      ctx.db,
      ids,
      docs.map((d) => d.id),
    );
    for (const person of people.values()) {
      const facts = await personFacts(ctx.db, person.id);
      for (const doc of docs) {
        if (!appliesTo(doc, facts)) continue;
        const { acceptance } = countingAcceptance(
          doc,
          facts,
          accepted.get(acceptanceKey(person.id, doc.id)) ?? [],
          now,
        );
        if (acceptance) continue;
        add({
          kind: "agree",
          person,
          record: { object: "agreement", id: doc.id, title: doc.title },
          at: doc.current.effectiveFrom,
          amount: null,
          currency: null,
        });
      }
    }
  }

  // --- subscriptions the caller pays -----------------------------------------------------------
  const subscriptions = await sql<{
    id: string;
    plan_title: string;
    amount: number;
    currency: string;
    state: string;
    trial_end: string | null;
    cancel_at_period_end: number;
    cancel_at: string | null;
    failing_since: string | null;
    current_period_end: string | null;
    created_at: string;
  }>`SELECT id, plan_title, amount, currency, state, trial_end, cancel_at_period_end, cancel_at,
      failing_since, current_period_end, created_at
    FROM core_subscription
    WHERE payer_person_id = ${me} AND state NOT IN ('ended', 'expired')
      AND (state IN ('incomplete', 'past_due', 'unpaid', 'trialing') OR failing_since IS NOT NULL)
    ORDER BY created_at, id`.execute(ctx.db);
  for (const row of subscriptions.rows) {
    const record = { object: "subscription", id: row.id, title: row.plan_title };
    const money = { amount: row.amount, currency: row.currency };
    if (row.state === "incomplete") {
      add({ kind: "confirm_payment", person: self, record, at: row.created_at, ...money });
      continue;
    }
    if (row.state === "past_due" || row.state === "unpaid" || row.failing_since !== null) {
      add({
        kind: "card_failing",
        person: self,
        record,
        at: row.failing_since ?? row.current_period_end,
        ...money,
      });
    }
    // A trial they chose to cancel ends as they asked: not listed (decision 2).
    const cancelled = row.cancel_at_period_end === 1 || row.cancel_at !== null;
    if (
      row.state === "trialing" &&
      !cancelled &&
      row.trial_end !== null &&
      row.trial_end > now &&
      row.trial_end <= horizon
    ) {
      add({ kind: "trial_ending", person: self, record, at: row.trial_end, ...money });
    }
  }

  // --- the caller's own orders, through the seam (a child's orders stay the child's) -----------
  const { items: orders } = await ctx.records.list("order", {
    filter: {
      or: [
        {
          and: [
            { field: "state", op: "eq", value: "part_paid" },
            { field: "balanceDueAt", op: "is_not_null" },
          ],
        },
        {
          and: [
            { field: "state", op: "eq", value: "pending" },
            { field: "expiresAt", op: "gt", value: now },
          ],
        },
      ],
    },
    sort: { field: "createdAt", direction: "asc" },
    limit: ORDERS_READ,
  });
  if (orders.length) {
    const orderIds = orders.map((o) => o.id);
    // An unpaid order counts only while it holds places (a class they started paying for).
    const holding = new Set(
      (
        await ctx.db
          .selectFrom("core_capacity_claim")
          .select("for_id")
          .where("for_type", "=", ORDER_CLAIM_TYPE)
          .where("for_id", "in", orderIds)
          .where("state", "=", "held")
          .execute()
      ).map((row) => row.for_id),
    );
    // Each order's first line names it.
    const { items: firstLines } = await ctx.records.list("orderLine", {
      filter: {
        and: [
          { field: "orderId", op: "in", value: orderIds },
          { field: "position", op: "eq", value: 0 },
        ],
      },
      limit: ORDERS_READ,
    });
    const titles = new Map(
      firstLines.map((line) => [String(line.values.orderId), String(line.values.title ?? "")]),
    );
    for (const order of orders) {
      const v = order.values;
      const partPaid = v.state === "part_paid";
      if (!partPaid && !holding.has(order.id)) continue;
      const total = Number(v.total ?? 0);
      const paid = Number(v.paid ?? 0);
      add({
        kind: partPaid ? "balance_due" : "finish_paying",
        person: self,
        record: { object: "order", id: order.id, title: titles.get(order.id) || "Order" },
        at: String((partPaid ? v.balanceDueAt : v.expiresAt) ?? "") || null,
        amount: Math.max(total - paid, 0),
        currency: typeof v.currency === "string" ? v.currency : null,
      });
    }
  }

  // --- passes: holders of N uses in all, the caller's and their live dependants' ---------------
  // The keying in force now (a change of period applies from `applies_from`, ADR 0494).
  const holders = await sql<{
    object_type: string;
    record_id: string;
    person_id: string;
    uses: number;
    zone: string;
    valid_until: string | null;
    until_date: string | null;
    used: number;
  }>`SELECT a.object_type, a.record_id, a.person_id, a.uses, a.zone, a.valid_until, a.until_date,
      coalesce((SELECT p.used FROM core_allowance_period p
        WHERE p.object_type = a.object_type AND p.record_id = a.record_id AND p.period = 'total'
          AND p.zone = CASE WHEN a.applies_from IS NOT NULL AND a.applies_from > ${now}
            THEN a.prev_zone ELSE a.zone END), 0) AS used
    FROM core_allowance a
    WHERE (a.person_id = ${me} OR a.person_id IN (${dependantsSql(me)}))
      AND a.live = 1 AND a.trashed = 0 AND a.uses IS NOT NULL
      AND (CASE WHEN a.applies_from IS NOT NULL AND a.applies_from > ${now}
        THEN a.prev_per ELSE a.per END) = 'total'
    ORDER BY a.object_type, a.record_id`.execute(ctx.db);
  const passes = holders.rows
    .map((row) => {
      const ends = row.valid_until ?? boundOf(row.until_date, "until", "date", row.zone);
      return { ...row, ends, left: Math.max(row.uses - Number(row.used), 0) };
    })
    // Still valid now: a pass that has lapsed needs nothing.
    .filter((pass) => pass.ends === null || pass.ends > now);
  const listed = passes.filter(
    (pass) => pass.left === 0 || (pass.ends !== null && pass.ends <= horizon && pass.left > 0),
  );
  // Through the seam, per object: what the caller may see (their own, a child's only where the
  // object opens to guardians) and its title.
  const visible = new Map<string, string>();
  for (const object of [...new Set(listed.map((p) => p.object_type))]) {
    const definition = getObject(object);
    if (!definition?.customer) continue;
    const ids = listed.filter((p) => p.object_type === object).map((p) => p.record_id);
    const { items: records } = await ctx.records.list(object, {
      filter: { field: "id", op: "in", value: ids.slice(0, PASSES_PER_OBJECT) },
      limit: PASSES_PER_OBJECT,
    });
    for (const record of records) {
      const titled = definition.titleField ? record.values[definition.titleField] : undefined;
      visible.set(
        `${object}\u0000${record.id}`,
        typeof titled === "string" && titled ? titled : definition.label,
      );
    }
  }
  for (const pass of listed) {
    const title = visible.get(`${pass.object_type}\u0000${pass.record_id}`);
    const person = people.get(pass.person_id);
    if (title === undefined || !person) continue;
    // A pass used up is shown until it lapses or a newer holder of the same object takes over:
    // one made after it (ids sort by when they were made, ADR 0015), valid with uses left. A pass
    // expiring is shown until it lapses, is used up or its own end moves (renewed).
    const replaced =
      pass.left === 0 &&
      passes.some(
        (other) =>
          other.object_type === pass.object_type &&
          other.person_id === pass.person_id &&
          other.record_id > pass.record_id &&
          other.left > 0,
      );
    if (replaced) continue;
    add({
      kind: pass.left === 0 ? "pass_used_up" : "pass_expiring",
      person,
      record: { object: pass.object_type, id: pass.record_id, title },
      at: pass.ends,
      amount: null,
      currency: null,
      usesLeft: pass.left,
    });
  }

  // Soonest first; an item with no moment last; then a fixed order.
  items.sort((a, b) => {
    if (a.at !== b.at) {
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return a.at < b.at ? -1 : 1;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return { days, items };
}
