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
// Cost: a fixed number of statements, whatever the packs installed, the size of the family or the
// number of documents: the setting, the family, the agreements (two for the documents, one for
// the caller's facts, one for the family's acceptances, one for the versions due, checked
// intact), one for subscriptions, three for orders through the seam (the open ones, their held
// places, their first lines), one for allowance holders and one through the seam for the passes
// listed, every holder object in the same statement. No statement binds a list of the family or
// of the documents; the orders and passes read at most 50 ids each.
import { sql } from "kysely";
import { versionIntact } from "../agreements/documents.ts";
import {
  acceptanceKey,
  appliesTo,
  attachedDocuments,
  countingAcceptance,
  familyAcceptances,
  type PersonFacts,
  personFacts,
} from "../agreements/due.ts";
import { boundOf } from "../allowance/periods.ts";
import { holderOf } from "../allowance/records.ts";
import { OperationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { ORDER_CLAIM_TYPE } from "../orders/holds.ts";
import { viewColumnOf } from "../records/columns.ts";
import { dependantsSql } from "../visibility/guardians.ts";
import { visibleSource } from "../visibility/index.ts";
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

/** The most passes read back through the seam: each id is a bound variable. */
const PASSES_READ = 50;

/** The most open orders read (soonest made first): each id is a bound variable later. */
const ORDERS_READ = 50;

/**
 * A live dependant from the seam's family (ADR 0540): in no Trash, and a minor by the link, so a
 * guardian agrees for them. Nothing else of their facts changes what counts.
 */
const DEPENDANT_FACTS: PersonFacts = {
  exists: true,
  inTrash: false,
  marked: false,
  dependant: true,
};

/**
 * Whether a holder object's passes may be listed to a customer, and the view column of its title
 * they may read: its customer is the holder's Person, and they may read its uses and its end (so
 * an item tells them nothing their own record hides). Null when not.
 */
function listablePass(object: ObjectDefinition): { titleColumn: string | null } | null {
  const holder = holderOf(object);
  const customer = object.customer;
  if (!holder || !customer || customer.field !== holder.person) return null;
  const read = new Set(customer.read);
  const readable = (field: string) => !field.includes(".") && read.has(field);
  if (!readable(holder.uses)) return null;
  if (holder.until !== undefined && !readable(holder.until)) return null;
  const titleField =
    object.titleField && read.has(object.titleField)
      ? object.fields.find((f) => f.name === object.titleField)
      : undefined;
  return { titleColumn: titleField ? viewColumnOf(titleField) : null };
}

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
    const accepted = await familyAcceptances(ctx.db, me);
    const own = await personFacts(ctx.db, me);
    const due: { person: typeof self; doc: (typeof docs)[number] }[] = [];
    for (const person of people.values()) {
      const facts = person.self ? own : DEPENDANT_FACTS;
      for (const doc of docs) {
        if (!appliesTo(doc, facts)) continue;
        const { acceptance } = countingAcceptance(
          doc,
          facts,
          accepted.get(acceptanceKey(person.id, doc.id)) ?? [],
          now,
        );
        if (!acceptance) due.push({ person, doc });
      }
    }
    if (due.length) {
      // As me.agreements.due: a version whose stored text does not match its hash is never
      // shown to agree to. The versions in effect of live documents, with no ids bound.
      const versions = await ctx.db
        .selectFrom("core_agreement_version as v")
        .innerJoin("core_agreement_document as d", "d.current_version_id", "v.id")
        .selectAll("v")
        .select("d.kind")
        .where("d.state", "=", "live")
        .execute();
      const intact = new Set<string>();
      for (const v of versions) if (await versionIntact(v, v.kind)) intact.add(v.id);
      for (const { person, doc } of due) {
        if (!intact.has(doc.current.id)) continue;
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
  // Through the seam, every holder object in one statement: what the caller may see (their own,
  // a child's only where the object opens to guardians) and the title they may read.
  const visible = new Map<string, string>();
  const parts = [];
  let budget = PASSES_READ;
  for (const object of [...new Set(listed.map((p) => p.object_type))]) {
    const definition = getObject(object);
    const listable = definition ? listablePass(definition) : null;
    if (!definition || !listable || budget <= 0) continue;
    const ids = listed
      .filter((p) => p.object_type === object)
      .map((p) => p.record_id)
      .slice(0, budget);
    budget -= ids.length;
    const title = listable.titleColumn ? sql.ref(listable.titleColumn) : sql`NULL`;
    parts.push(
      sql`SELECT ${object} AS object_type, id, ${title} AS title
        FROM ${visibleSource(ctx, definition)} WHERE id IN (${sql.join(ids)})`,
    );
  }
  if (parts.length) {
    const { rows } = await sql<{ object_type: string; id: string; title: unknown }>`${sql.join(
      parts,
      sql` UNION ALL `,
    )}`.execute(ctx.db);
    for (const row of rows) {
      const label = getObject(row.object_type)?.label ?? row.object_type;
      visible.set(
        `${row.object_type}\u0000${row.id}`,
        typeof row.title === "string" && row.title ? row.title : label,
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
