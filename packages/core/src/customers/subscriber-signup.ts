// Watching "anyone starting a subscription" (ADR 0459). The switch is a human admin's, but what it
// does depends on data other writes change: publishing or pricing a plan (which staff, an
// automation or an approved AI change may do) opens customer sign-up to anyone. So the host
// remembers whether a plan was on sale the last time it looked, and when that goes from no to yes
// while the switch is on it tells every admin once and writes an audit entry, naming who last
// changed the plan when it knows. It also tells admins when new visitors are not getting codes
// (the host-wide limit), and when the switch cannot be answered and so does nothing.
//
// Looked at on every code request the switch could answer (with the memoised answer) and on the
// runner's minute tick, so a plan put on sale is reported within a minute even before anyone asks.
import type { CoreDatabase, CrmDb } from "@composable-os/db";
import type { Compilable, Kysely } from "kysely";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import { findPlanOnSale, type PlanOnSale, type PlanOnSaleRef } from "./plan-on-sale.ts";
import { loadCustomerSignupSubscribers } from "./settings.ts";

/** The last answer the host saw while the switch was on: `{ onSale, plan, at }`. */
export const CUSTOMER_SIGNUP_SUBSCRIBERS_STATE = "customer_signup_subscribers_state";
/** The operation name the opening is audited under. Not in the registry: nobody can call it. */
export const SIGNUP_OPENED_AUDIT = "customer.signupOpened";

interface WatchState {
  onSale: boolean;
  plan: PlanOnSaleRef | null;
  at: string;
}

async function loadState(db: Kysely<CoreDatabase>): Promise<WatchState | null> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", CUSTOMER_SIGNUP_SUBSCRIBERS_STATE)
    .executeTakeFirst();
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as Partial<WatchState>;
    return typeof value.onSale === "boolean" && typeof value.at === "string"
      ? { onSale: value.onSale, plan: value.plan ?? null, at: value.at }
      : null;
  } catch {
    return null;
  }
}

/** The statement that records `state`, for a caller's batch. */
export function signupStateStatement(
  db: Kysely<CoreDatabase>,
  state: WatchState,
  by: string | null = null,
): Compilable {
  const value = JSON.stringify(state);
  return db
    .insertInto("core_settings")
    .values({
      key: CUSTOMER_SIGNUP_SUBSCRIBERS_STATE,
      value,
      updated_at: state.at,
      updated_by: by,
    })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: state.at }));
}

/** Who last changed the plan record, in words ("by Pat Lee, through the assistant"), or null. */
async function lastChangedBy(db: Kysely<CoreDatabase>, plan: PlanOnSaleRef) {
  const row = await db
    .selectFrom("core_audit_changes as c")
    .innerJoin("core_audit as a", "a.id", "c.audit_id")
    .leftJoin("core_user as u", "u.id", "a.user_id")
    .select(["a.actor", "a.user_id", "u.name", "u.email"])
    .where("c.record_id", "=", plan.id)
    .orderBy("c.id", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  const who = row.name || row.email || row.user_id || "someone";
  const how =
    row.actor === "human"
      ? ""
      : row.actor === "assistant"
        ? ", through the assistant"
        : row.actor === "mcp"
          ? ", through an AI app (MCP)"
          : `, as ${row.actor}`;
  return { text: `by ${who}${how}`, userId: row.user_id, actor: row.actor };
}

export interface WatchResult {
  /** What was found now; null while the switch is off. */
  found: PlanOnSale | null;
  /** True when this call reported that sign-up opened. */
  opened: boolean;
}

/**
 * Looks at whether a plan is on sale while the switch is on, and reports a change from not on
 * sale to on sale once. `memo` reuses a code request's recent answer (findPlanOnSale).
 */
export async function watchSubscriberSignup(
  crm: CrmDb,
  now: Date = new Date(),
  options: { memo?: boolean } = {},
): Promise<WatchResult> {
  const db = crm.query;
  if (!(await loadCustomerSignupSubscribers(db))) return { found: null, opened: false };
  const at = now.toISOString();
  const found = await findPlanOnSale(db, at, options);
  if (found.state === "unknown") {
    await tellAdmins(crm, at, {
      title: "Anyone starting a subscription is doing nothing",
      body:
        "Customer sign-in is set to let anyone starting a subscription sign in, but the host " +
        `cannot tell whether a plan is on sale (${found.reason}), so new visitors get no ` +
        "sign-in code. Check your plans, or turn the setting off in Settings → Users.",
      dedupeKey: `customer.signup_unknown:${at.slice(0, 10)}`,
    });
    return { found, opened: false };
  }
  const before = await loadState(db);
  const onSale = found.state === "on_sale";
  if (before?.onSale === onSale) return { found, opened: false };
  const plan = found.state === "on_sale" ? found.plan : null;
  const statements: Compilable[] = [signupStateStatement(db, { onSale, plan, at })];
  if (plan) {
    const by = await lastChangedBy(db, plan);
    const notice = await notifyStatements(
      db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title: "Customer sign-up is now open to anyone",
        body:
          `${plan.title} went on sale${by ? ` (last changed ${by.text})` : ""}, and "anyone ` +
          'starting a subscription" is on: anyone can now get a sign-in code and a customer ' +
          "account, including people already in your records. Turn it off in Settings → Users " +
          "if that is not what you want.",
        link: { kind: "record", object: plan.object, id: plan.id },
        // Once per change: the key names the state it changed from.
        dedupeKey: `customer.signup_opened:${plan.id}:${before?.at ?? "never"}`,
        source: { actor: "system" },
      },
      at,
    );
    statements.push(...notice.statements);
    statements.push(
      db.insertInto("core_audit").values({
        id: newId("audit"),
        at,
        operation: SIGNUP_OPENED_AUDIT,
        risk: "write",
        // The host's own finding, as an automation of the system (no staff member did it).
        actor: "automation",
        user_id: null,
        origin: JSON.stringify({ surface: "system", automationId: SIGNUP_OPENED_AUDIT }),
        input: JSON.stringify({ plan: { object: plan.object, id: plan.id } }),
        result: JSON.stringify({
          plan,
          changedBy: by ? { userId: by.userId, actor: by.actor } : null,
          previous: before ? { onSale: before.onSale, at: before.at } : null,
        }),
        gate_decision: "auto",
        outcome: "ok",
        error: null,
      }),
    );
  }
  await crm.batch(statements);
  return { found, opened: Boolean(plan) };
}

/** Admins are told once an hour while codes to new visitors are over the host-wide limit. */
export async function reportCodeLimitReached(crm: CrmDb, now: Date = new Date()): Promise<void> {
  const at = now.toISOString();
  await tellAdmins(crm, at, {
    title: "New visitors are not getting sign-in codes",
    body:
      "So many sign-in codes were asked for by new addresses that the host stopped sending " +
      'them for now ("anyone starting a subscription" has a limit for the whole host). People ' +
      "with an account, invitees and buyers still get theirs. If it goes on, someone may be " +
      "asking for codes for addresses that are not theirs.",
    dedupeKey: `customer.code_new_limit:${at.slice(0, 13)}`,
  });
}

async function tellAdmins(
  crm: CrmDb,
  at: string,
  message: { title: string; body: string; dedupeKey: string },
): Promise<void> {
  const notice = await notifyStatements(
    crm.query,
    { to: [{ role: "admin" }], type: "system.message", source: { actor: "system" }, ...message },
    at,
  );
  if (notice.statements.length) await crm.batch(notice.statements);
}
