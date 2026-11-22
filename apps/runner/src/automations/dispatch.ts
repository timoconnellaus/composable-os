// Starting automation runs (ADR 0130). Every way a run starts goes through `startRuns`: the queue
// consumer (record and approval events, and stage 6b's integration events through
// `dispatchAutomationMessages`), the schedule cron, manual runs, retries and replays.
//
//   candidates ─► rails (cascade depth, cycle, debounce, fan-out budget, rate limits) ─►
//   conditions on the current record ─► run rows (INSERT OR IGNORE on the Workflow id: a duplicate
//   delivery is a no-op) ─► Workflow createBatch (≤100 per call; an existing id is ignored)
//
// Kill switch: nothing starts while it is engaged. Disabled, paused and removed automations are
// never loaded (core_automations_trigger_idx), so they never match.
import {
  type AutomationDefinition,
  type AutomationQueueMessage,
  type AutomationSettings,
  automationsFullyBound,
  effectiveRails,
  FAN_OUT_BUDGET,
  idsMatchingConditions,
  integrationTriggerSource,
  jsonList,
  loadAutomationSettings,
  loadEnabledAutomations,
  MAX_CASCADE_DEPTH,
  messageObjects,
  newId,
  notifyStatements,
  type RateLimitBinding,
  type RunCandidate,
  refreshSchemaRegistry,
  registerTriggerSource,
  triggerSourceFor,
  WORKFLOW_BATCH_MAX,
  workflowInstanceId,
} from "@composable-os/core";
import { type CrmDb, createCrmDb } from "@composable-os/db";
import type { AutomationJournalEntry, AutomationTriggerType } from "@composable-os/sdk";
import { sql } from "kysely";
import { deliverNotificationRoutes } from "../notifications/deliver.ts";

// Stage 6b: webhooks and sync events (polled from core_integration_event by the cron).
registerTriggerSource(integrationTriggerSource);

/** What a run's Workflow instance is created with (and what a retry or replay reuses). */
export interface AutomationRunParams {
  runId: string;
  automationId: string;
  extensionId: string;
  key: string;
  commit: string | null;
  trigger: AutomationTriggerType;
  eventId: string;
  record?: { object: string; id: string };
  change?: RunCandidate["change"];
  approval?: RunCandidate["approval"];
  period?: string;
  manual?: { userId: string; recordIds: string[] };
  integration?: RunCandidate["integration"];
  /** Cascade tags: the run's own depth and chain (its writes carry them). */
  depth: number;
  chain: string[];
  rootEventId: string;
  /** Debounce: the Workflow sleeps this long before it reads the record. */
  delaySeconds?: number;
  /** Retry: the steps of the failed run that completed, replayed without running again. */
  journal?: AutomationJournalEntry[];
  /** Retry: the run at the start of the retried chain (ADR 0574: what a send's key is made of). */
  originalRunId?: string;
}

/** Where a batch of candidates came from: the cascade position of the event. */
export interface CandidateOrigin {
  depth: number;
  chain: readonly string[];
  rootEventId: string;
  eventId: string;
  /** Event time (ISO), for the debounce bucket. */
  at: string;
}

export interface DispatchEnv {
  DB: D1Database;
  AUTOMATION_WORKFLOW: Workflow<AutomationRunParams>;
  AUTOMATION_RATE_LIMIT?: RateLimitBinding;
}

export interface StartResult {
  /** Run ids started (or already started, on a redelivery). */
  runIds: string[];
  /** Candidates a rail or the conditions dropped. */
  skipped: number;
  /** Reasons, for logs and tests. */
  dropped: { automationId: string; reason: string }[];
  /** Automations auto-paused by a rate limit in this call. */
  paused: string[];
  /**
   * Runs over the runs-per-minute rail (ADR 0573): recorded `queued` with `wait_until` and drained
   * by the minute cron (`runDeferredDue`) as the rail allows, never dropped.
   */
  deferred: number;
  /** The deferred runs' ids (new, or already recorded for the same key). */
  deferredRunIds: string[];
}

export interface StartOptions {
  /** Retry / replay links and an explicit journal. */
  retryOf?: string;
  replayOf?: string;
  journal?: AutomationJournalEntry[];
  manual?: { userId: string; recordIds: string[] };
  now?: Date;
  /** Retry: the run at the start of the chain (see AutomationRunParams). */
  originalRunId?: string;
}

const emptyResult = (): StartResult => ({
  runIds: [],
  skipped: 0,
  dropped: [],
  paused: [],
  deferred: 0,
  deferredRunIds: [],
});

/** A deferred run's status reason (ADR 0573): a queued row with no Workflow instance yet. */
export const DEFERRED_REASON = "deferred: over the runs-per-minute rail";
/** Deferred runs one automation may hold before it is paused (a runaway), its backlog kept. */
export const DEFERRED_CAP = 5_000;
/** Deferred runs the minute cron starts in one tick, across automations. */
const DRAIN_PER_TICK = 500;

/** A candidate held back by a rail, with when it may start. */
interface Deferred {
  candidate: RunCandidate;
  until: string;
  reason: string;
}

function hourKey(at: string): string {
  return at.slice(0, 13);
}

/**
 * Applies the rails and conditions to `candidates`, writes their run rows and creates their
 * Workflow instances. Idempotent per candidate key.
 */
export async function startRuns(
  env: DispatchEnv,
  candidates: readonly RunCandidate[],
  origin: CandidateOrigin,
  options: StartOptions = {},
  preloaded?: AutomationSettings,
): Promise<StartResult> {
  const result = emptyResult();
  if (!candidates.length) return result;
  const crm = createCrmDb(env.DB);
  const db = crm.query;
  const now = (options.now ?? new Date()).toISOString();
  const settings = preloaded ?? (await loadAutomationSettings(db));
  const drop = (c: RunCandidate, reason: string) => {
    result.skipped += 1;
    result.dropped.push({ automationId: c.automation.id, reason });
  };
  if (settings.killSwitch) {
    for (const c of candidates) drop(c, "kill switch");
    return result;
  }

  // Skipped rows for the rare, interesting drops (depth, cycle): visible in the run history.
  const skippedRows: { candidate: RunCandidate; reason: string }[] = [];
  let kept: RunCandidate[] = [];
  for (const c of candidates) {
    if (origin.depth >= MAX_CASCADE_DEPTH) {
      console.warn(`automation ${c.automation.id}: dropped at cascade depth ${origin.depth}`);
      drop(c, "cascade depth");
      skippedRows.push({ candidate: c, reason: `Cascade depth limit (${MAX_CASCADE_DEPTH})` });
      continue;
    }
    if (c.record && origin.chain.includes(chainKey(c.automation.id, c.record))) {
      console.warn(`automation ${c.automation.id}: cycle on ${c.record.object} ${c.record.id}`);
      drop(c, "cycle");
      skippedRows.push({
        candidate: c,
        reason: "Cycle: it already ran on this record in this cascade",
      });
      continue;
    }
    kept.push(debounced(c, origin, settings));
  }

  // Run-as (ADR 0170): an automation whose declared connections are not all bound waits.
  const needing = new Map(
    kept
      .filter((c) => c.automation.spec.connections?.length)
      .map((c) => [c.automation.id, c.automation.spec]),
  );
  if (needing.size) {
    const bound = await automationsFullyBound(db, needing);
    kept = kept.filter((c) => {
      if (!needing.has(c.automation.id) || bound.has(c.automation.id)) return true;
      drop(c, "waiting for connections");
      return false;
    });
  }

  // Conditions on the current record, one query per automation and object.
  const byAutomation = new Map<string, RunCandidate[]>();
  for (const c of kept) {
    byAutomation.set(c.automation.id, [...(byAutomation.get(c.automation.id) ?? []), c]);
  }
  kept = [];
  for (const group of byAutomation.values()) {
    const spec = (group[0] as RunCandidate).automation.spec;
    if (!spec.conditions) {
      kept.push(...group);
      continue;
    }
    const withRecord = group.filter((c) => c.record);
    for (const c of group) if (!c.record) drop(c, "conditions (no record)");
    const objects = [...new Set(withRecord.map((c) => (c.record as { object: string }).object))];
    for (const object of objects) {
      const ofObject = withRecord.filter((c) => c.record?.object === object);
      const ok = await idsMatchingConditions(
        db,
        object,
        ofObject.map((c) => c.record?.id as string),
        spec.conditions,
        {
          // A routine's "me" is its owner (ADR 0343).
          userId:
            (group[0] as RunCandidate).automation.ownerUserId ??
            `extension:${(group[0] as RunCandidate).automation.extensionId}`,
          now,
        },
      );
      for (const c of ofObject) {
        if (ok.has(c.record?.id as string)) kept.push(c);
        else drop(c, "conditions");
      }
    }
  }

  // Fan-out budget per root event (cost audit U3).
  if (kept.length && origin.depth > 0) {
    const row = await db
      .selectFrom("core_automation_runs")
      .select(sql<number>`count(*)`.as("n"))
      .where("root_event_id", "=", origin.rootEventId)
      .executeTakeFirst();
    const room = Math.max(0, FAN_OUT_BUDGET - Number(row?.n ?? 0));
    if (kept.length > room) {
      console.warn(`automations: fan-out budget reached for ${origin.rootEventId}`);
      for (const c of kept.slice(room)) drop(c, "fan-out budget");
      kept = kept.slice(0, room);
    }
  } else if (kept.length > FAN_OUT_BUDGET) {
    for (const c of kept.slice(FAN_OUT_BUDGET)) drop(c, "fan-out budget");
    kept = kept.slice(0, FAN_OUT_BUDGET);
  }

  // Rate limits (ADR 0573): runs per minute (the Rate Limiting binding, per automation) shape,
  // they do not lose: a run over the rail is recorded and started on a later tick. Writes per hour
  // (core_automation_counters) pause the automation, the runs it held back recorded the same way.
  const limited = await applyRateLimits(env, crm, kept, now, settings, result, drop);
  kept = limited.out;
  const deferred = limited.deferred;
  result.deferred += deferred.length;

  // Run rows, then Workflow instances.
  const rows = await Promise.all(
    [
      ...kept.map((c) => ({ candidate: c, skip: null as string | null, defer: null })),
      ...skippedRows.map((s) => ({ candidate: s.candidate, skip: s.reason, defer: null })),
      ...deferred.map((d) => ({ candidate: d.candidate, skip: null, defer: d })),
    ].map(async ({ candidate, skip, defer }) => ({
      candidate,
      skip,
      defer: defer as Deferred | null,
      workflowId: await workflowInstanceId(candidate.automation.id, candidate.idempotencyKey),
      runId: newId("automationRun"),
    })),
  );
  if (!rows.length) return result;
  await crm.batch(
    rows.map(({ candidate: c, skip, defer, workflowId, runId }) =>
      db
        .insertInto("core_automation_runs")
        .values({
          id: runId,
          automation_id: c.automation.id,
          extension_id: c.automation.extensionId,
          commit_oid: c.automation.commit,
          workflow_id: workflowId,
          trigger: JSON.stringify(triggerJson(c, origin, options)),
          record_object: c.record?.object ?? null,
          record_id: c.record?.id ?? null,
          status: skip ? "skipped" : "queued",
          status_reason: skip ?? (defer ? DEFERRED_REASON : null),
          ...(defer ? { wait_until: defer.until } : {}),
          test: 0,
          depth: origin.depth + 1,
          root_event_id: origin.rootEventId,
          retry_of: options.retryOf ?? null,
          replay_of: options.replayOf ?? null,
          started_at: now,
          updated_at: now,
          ...(skip ? { finished_at: now } : {}),
        })
        .onConflict((oc) => oc.doNothing()),
    ),
  );
  const held = rows.filter((r) => r.defer);
  for (let i = 0; i < held.length; i += 100) {
    const found = await db
      .selectFrom("core_automation_runs")
      .select("id")
      .where("workflow_id", "in", jsonList(held.slice(i, i + 100).map((r) => r.workflowId)))
      .execute();
    result.deferredRunIds.push(...found.map((f) => f.id));
  }
  const toStart = rows.filter((r) => !r.skip && !r.defer);
  if (!toStart.length) return result;
  // On a redelivery the rows already exist: use theirs, and (re)create only queued ones.
  const existing: { id: string; workflow_id: string | null; status: string }[] = [];
  for (let i = 0; i < toStart.length; i += 100) {
    existing.push(
      ...(await db
        .selectFrom("core_automation_runs")
        .select(["id", "workflow_id", "status"])
        .where("workflow_id", "in", jsonList(toStart.slice(i, i + 100).map((r) => r.workflowId)))
        .execute()),
    );
  }
  const byWorkflow = new Map(existing.map((e) => [e.workflow_id as string, e]));
  const instances: { id: string; params: AutomationRunParams }[] = [];
  for (const r of toStart) {
    const row = byWorkflow.get(r.workflowId);
    if (!row) continue;
    result.runIds.push(row.id);
    if (row.status !== "queued") continue;
    instances.push({ id: r.workflowId, params: runParams(r.candidate, row.id, origin, options) });
  }
  for (let i = 0; i < instances.length; i += WORKFLOW_BATCH_MAX) {
    const batch = instances.slice(i, i + WORKFLOW_BATCH_MAX);
    try {
      await env.AUTOMATION_WORKFLOW.createBatch(batch);
    } catch (error) {
      // createBatch reports existing ids rather than throwing; anything else is retried by
      // the caller (the queue redelivers, and the rows are still `queued`).
      if (!/already exists|duplicate|10405|10415/i.test(String(error))) throw error;
    }
  }
  return result;
}

/** The chain entry of a run: `<automationId>:<object>:<recordId>`. */
export function chainKey(automationId: string, record: { object: string; id: string }): string {
  return `${automationId}:${record.object}:${record.id}`;
}

/** `updated` events for one record within the debounce window coalesce into one run. */
function debounced(
  c: RunCandidate,
  origin: CandidateOrigin,
  settings: AutomationSettings,
): RunCandidate {
  if (c.automation.spec.trigger.type !== "record" || c.change?.action !== "updated" || !c.record) {
    return c;
  }
  const window = effectiveRails(c.automation.spec, settings).debounceSeconds;
  if (!window) return c;
  const at = Math.floor(Date.parse(origin.at) / 1000);
  const bucket = Math.floor(at / window);
  return {
    ...c,
    idempotencyKey: `${c.record.id}:debounce:${bucket}`,
    delaySeconds: (bucket + 1) * window - at,
  };
}

function triggerJson(c: RunCandidate, origin: CandidateOrigin, options: StartOptions) {
  return {
    type: c.automation.spec.trigger.type,
    eventId: origin.eventId,
    key: c.idempotencyKey,
    ...(c.record ? { record: c.record } : {}),
    ...(c.change ? { change: c.change } : {}),
    ...(c.approval ? { approval: c.approval } : {}),
    ...(c.period ? { period: c.period } : {}),
    ...(c.integration ? { integration: c.integration } : {}),
    ...(options.manual ? { manual: options.manual } : {}),
    // A deferred retry starts later from this row (ADR 0573): it keeps the steps that completed
    // and the run its chain began with, so it repeats no write and no send.
    ...(options.journal?.length ? { journal: options.journal } : {}),
    ...(options.originalRunId ? { originalRunId: options.originalRunId } : {}),
    chain: origin.chain,
  };
}

function runParams(
  c: RunCandidate,
  runId: string,
  origin: CandidateOrigin,
  options: StartOptions,
): AutomationRunParams {
  return {
    runId,
    automationId: c.automation.id,
    extensionId: c.automation.extensionId,
    key: c.automation.key,
    commit: c.automation.commit,
    trigger: c.automation.spec.trigger.type,
    eventId: origin.eventId,
    ...(c.record ? { record: c.record } : {}),
    ...(c.change ? { change: c.change } : {}),
    ...(c.approval ? { approval: c.approval } : {}),
    ...(c.period ? { period: c.period } : {}),
    ...(c.integration ? { integration: c.integration } : {}),
    ...(options.manual ? { manual: options.manual } : {}),
    depth: origin.depth + 1,
    chain: c.record ? [...origin.chain, chainKey(c.automation.id, c.record)] : [...origin.chain],
    rootEventId: origin.rootEventId,
    ...(c.delaySeconds ? { delaySeconds: c.delaySeconds } : {}),
    ...(options.journal?.length ? { journal: options.journal } : {}),
    ...(options.originalRunId ? { originalRunId: options.originalRunId } : {}),
  };
}

/**
 * Auto-pauses `automationId` (once: a paused one is not re-paused) and notifies the admins with
 * one `automation.paused` notification per pause. Returns true when this call paused it.
 */
export async function pauseAutomation(
  crm: CrmDb,
  automation: AutomationDefinition,
  reason: string,
  now: string,
): Promise<boolean> {
  const paused = await crm.query
    .updateTable("core_automations")
    .set({ paused_reason: reason, paused_at: now, updated_at: now })
    .where("id", "=", automation.id)
    .where("paused_reason", "is", null)
    .returning("id")
    .execute();
  if (!paused.length) return false;
  console.warn(`automation ${automation.id} auto-paused: ${reason}`);
  try {
    // A routine is its owner's business: they hear about it, and they resume it in My routines.
    const owner = automation.ownerUserId;
    const plan = await notifyStatements(
      crm.query,
      {
        to: owner ? [{ userId: owner }] : [{ role: "admin" }],
        type: "automation.paused",
        title: `“${automation.spec.label}” was paused`,
        body: owner
          ? `${reason}. Resume it in Settings, under My routines.`
          : `${reason}. Resume it on the automation page once you have checked why.`,
        ...(owner ? {} : { link: { kind: "automation", automationId: automation.id } }),
        dedupeKey: `paused:${automation.id}:${now}`,
        source: { actor: "automation", automationId: automation.id },
      },
      now,
    );
    if (plan.statements.length) await crm.batch(plan.statements);
  } catch (error) {
    console.error("automation paused notice failed", error);
  }
  return true;
}

/** Whether an automation's rails let one more run start now (ADR 0573). */
type RailVerdict =
  | { ok: true }
  | { ok: false; kind: "minute" }
  | { ok: false; kind: "writes"; reason: string };

/**
 * The rails one more run of `automation` must pass to start now, the same at the start and when
 * a deferred run is drained: its writes this hour, the runs-per-minute binding, and its own
 * stricter runs-per-minute rail (counting the runs started in the last minute, not those waiting
 * their turn, plus `startedHere` this call has started already).
 */
async function railVerdict(
  env: DispatchEnv,
  crm: CrmDb,
  automation: { id: string; spec: AutomationDefinition["spec"] },
  now: string,
  settings: AutomationSettings,
  startedHere: number,
  writesKnown?: Map<string, boolean>,
): Promise<RailVerdict> {
  const rails = effectiveRails(automation.spec, settings);
  let over = writesKnown?.get(automation.id);
  if (over === undefined) {
    const counter = await crm.query
      .selectFrom("core_automation_counters")
      .select(["writes"])
      .where("automation_id", "=", automation.id)
      .where("hour", "=", hourKey(now))
      .executeTakeFirst();
    over = (counter?.writes ?? 0) >= rails.maxWritesPerHour;
    writesKnown?.set(automation.id, over);
  }
  if (over) {
    return {
      ok: false,
      kind: "writes",
      reason: `More than ${rails.maxWritesPerHour} writes in an hour`,
    };
  }
  if (env.AUTOMATION_RATE_LIMIT) {
    const { success } = await env.AUTOMATION_RATE_LIMIT.limit({ key: automation.id });
    if (!success) return { ok: false, kind: "minute" };
  }
  if (rails.maxRunsPerMinute < 60) {
    const since = new Date(Date.parse(now) - 60_000).toISOString();
    const recent = await crm.query
      .selectFrom("core_automation_runs")
      .select(sql<number>`count(*)`.as("n"))
      .where("automation_id", "=", automation.id)
      .where("started_at", ">=", since)
      .where((eb) =>
        eb.or([eb("status_reason", "is", null), eb("status_reason", "!=", DEFERRED_REASON)]),
      )
      .executeTakeFirst();
    if (Number(recent?.n ?? 0) + startedHere >= rails.maxRunsPerMinute) {
      return { ok: false, kind: "minute" };
    }
  }
  return { ok: true };
}

async function applyRateLimits(
  env: DispatchEnv,
  crm: CrmDb,
  candidates: RunCandidate[],
  now: string,
  settings: AutomationSettings,
  result: StartResult,
  _drop: (c: RunCandidate, reason: string) => void,
): Promise<{ out: RunCandidate[]; deferred: Deferred[] }> {
  const out: RunCandidate[] = [];
  const deferred: Deferred[] = [];
  const blocked = new Map<string, string>();
  const overMinute = new Set<string>();
  const writesKnown = new Map<string, boolean>();
  const nextMinute = new Date(Date.parse(now) + 60_000).toISOString();
  const nextHour = new Date(Date.parse(`${hourKey(now)}:00:00.000Z`) + 3_600_000).toISOString();
  for (const c of candidates) {
    const a = c.automation;
    // Paused for its writes in this call: what it held back starts after it is resumed.
    const pausedFor = blocked.get(a.id);
    if (pausedFor) {
      deferred.push({ candidate: c, until: nextHour, reason: pausedFor });
      continue;
    }
    // Over its runs a minute in this call: the rest wait for the next ticks, in order.
    if (overMinute.has(a.id)) {
      deferred.push({ candidate: c, until: nextMinute, reason: "runs a minute" });
      continue;
    }
    const startedHere = out.filter((o) => o.automation.id === a.id).length;
    const verdict = await railVerdict(env, crm, a, now, settings, startedHere, writesKnown);
    if (!verdict.ok && verdict.kind === "writes") {
      if (await pauseAutomation(crm, a, verdict.reason, now)) result.paused.push(a.id);
      blocked.set(a.id, verdict.reason);
      deferred.push({ candidate: c, until: nextHour, reason: verdict.reason });
      continue;
    }
    if (!verdict.ok) {
      // Shaped, not lost (ADR 0573): this run and the rest of the call wait their turn. Only a
      // backlog past DEFERRED_CAP (a runaway) pauses the automation, its backlog kept.
      overMinute.add(a.id);
      deferred.push({ candidate: c, until: nextMinute, reason: "runs a minute" });
      const backlog = await crm.query
        .selectFrom("core_automation_runs")
        .select(sql<number>`count(*)`.as("n"))
        .where("automation_id", "=", a.id)
        .where("status", "=", "queued")
        .where("status_reason", "=", DEFERRED_REASON)
        .executeTakeFirst();
      if (Number(backlog?.n ?? 0) >= DEFERRED_CAP) {
        const reason = `More than ${DEFERRED_CAP} runs waiting their turn`;
        if (await pauseAutomation(crm, a, reason, now)) result.paused.push(a.id);
      }
      continue;
    }
    out.push(c);
  }
  return { out, deferred };
}

/** A deferred run's stored trigger (triggerJson). */
interface StoredTrigger {
  type: AutomationTriggerType;
  eventId: string;
  record?: { object: string; id: string };
  change?: RunCandidate["change"];
  approval?: RunCandidate["approval"];
  period?: string;
  integration?: RunCandidate["integration"];
  manual?: { userId: string; recordIds: string[] };
  chain?: string[];
  journal?: AutomationJournalEntry[];
  originalRunId?: string;
}

/**
 * The minute cron's drain of deferred runs (ADR 0573). Every automation with runs due gets its
 * share of the tick (a backlog of one never holds another's back), oldest first within it; each
 * run starts only when the automation's rails allow it, the same rails as at the start, with the
 * trigger, cascade tags and (for a retry) the journal it was recorded with. An automation
 * disabled or paused keeps its backlog until it runs again. Returns how many started.
 */
export async function runDeferredDue(
  env: DispatchEnv,
  at: Date = new Date(),
  { perTick = DRAIN_PER_TICK }: { perTick?: number } = {},
): Promise<{ started: number; waiting: number }> {
  const crm = createCrmDb(env.DB);
  const db = crm.query;
  const now = at.toISOString();
  const settings = await loadAutomationSettings(db);
  if (settings.killSwitch) return { started: 0, waiting: 0 };
  const due = await db
    .selectFrom("core_automation_runs as r")
    .innerJoin("core_automations as a", "a.id", "r.automation_id")
    .select([
      "r.automation_id",
      "a.key",
      "a.spec",
      "a.owner_user_id",
      sql<string>`min(r.started_at)`.as("oldest"),
    ])
    .where("r.status", "=", "queued")
    .where("r.status_reason", "=", DEFERRED_REASON)
    .where("r.wait_until", "<=", now)
    .where("a.enabled", "=", 1)
    .where("a.paused_reason", "is", null)
    .where("a.removed_at", "is", null)
    .groupBy(["r.automation_id", "a.key", "a.spec", "a.owner_user_id"])
    .orderBy("oldest")
    .execute();
  if (!due.length) return { started: 0, waiting: 0 };
  const share = Math.max(1, Math.ceil(perTick / due.length));
  const instances: { id: string; params: AutomationRunParams }[] = [];
  const startedIds: string[] = [];
  let waiting = 0;
  for (const automation of due) {
    const spec = JSON.parse(automation.spec) as AutomationDefinition["spec"];
    const rows = await db
      .selectFrom("core_automation_runs")
      .select([
        "id",
        "automation_id",
        "extension_id",
        "commit_oid",
        "workflow_id",
        "trigger",
        "depth",
        "root_event_id",
      ])
      .where("automation_id", "=", automation.automation_id)
      .where("status", "=", "queued")
      .where("status_reason", "=", DEFERRED_REASON)
      .where("wait_until", "<=", now)
      .orderBy("started_at")
      .orderBy("id")
      .limit(share)
      .execute();
    let startedHere = 0;
    for (const [n, row] of rows.entries()) {
      if (!row.workflow_id) continue;
      const verdict = await railVerdict(
        env,
        crm,
        { id: row.automation_id, spec },
        now,
        settings,
        startedHere,
      );
      if (!verdict.ok) {
        // Over a rail: the rest wait for a later tick; writes pause it (its backlog kept).
        if (verdict.kind === "writes") {
          await pauseAutomation(
            crm,
            {
              id: row.automation_id,
              extensionId: row.extension_id,
              key: automation.key,
              commit: row.commit_oid,
              spec,
              ...(automation.owner_user_id ? { ownerUserId: automation.owner_user_id } : {}),
            },
            verdict.reason,
            now,
          );
        }
        waiting += rows.length - n;
        break;
      }
      const t = JSON.parse(row.trigger) as StoredTrigger;
      const chain = t.chain ?? [];
      instances.push({
        id: row.workflow_id,
        params: {
          runId: row.id,
          automationId: row.automation_id,
          extensionId: row.extension_id,
          key: automation.key,
          commit: row.commit_oid,
          trigger: t.type,
          eventId: t.eventId,
          ...(t.record ? { record: t.record } : {}),
          ...(t.change ? { change: t.change } : {}),
          ...(t.approval ? { approval: t.approval } : {}),
          ...(t.period ? { period: t.period } : {}),
          ...(t.integration ? { integration: t.integration } : {}),
          ...(t.manual ? { manual: t.manual } : {}),
          ...(t.journal?.length ? { journal: t.journal } : {}),
          ...(t.originalRunId ? { originalRunId: t.originalRunId } : {}),
          depth: row.depth,
          chain: t.record ? [...chain, chainKey(row.automation_id, t.record)] : [...chain],
          rootEventId: row.root_event_id ?? t.eventId,
        },
      });
      startedIds.push(row.id);
      startedHere += 1;
    }
  }
  for (let i = 0; i < instances.length; i += WORKFLOW_BATCH_MAX) {
    const batch = instances.slice(i, i + WORKFLOW_BATCH_MAX);
    try {
      await env.AUTOMATION_WORKFLOW.createBatch(batch);
    } catch (error) {
      if (!/already exists|duplicate|10405|10415/i.test(String(error))) throw error;
    }
  }
  // After the instances exist: a crash between the two starts them again on the next tick, and
  // an existing instance id is ignored, so each run starts once.
  for (let i = 0; i < startedIds.length; i += 100) {
    await db
      .updateTable("core_automation_runs")
      .set({ status_reason: null, started_at: now, updated_at: now })
      .where("id", "in", jsonList(startedIds.slice(i, i + 100)))
      .where("status_reason", "=", DEFERRED_REASON)
      .execute();
  }
  return { started: startedIds.length, waiting };
}

/**
 * Turns queue messages into runs (the consumer's whole job, and the seam stage 6b uses for
 * integration events polled from core_integration_event): per message, its kind's TriggerSource
 * matches the enabled automations, then `startRuns` applies the rails and conditions. Approval
 * decisions also wake the run waiting on that action (review pause).
 */
export async function dispatchAutomationMessages(
  env: DispatchEnv,
  messages: readonly AutomationQueueMessage[],
  options: { now?: Date } = {},
): Promise<StartResult> {
  const total = emptyResult();
  if (!messages.length) return total;
  const db = createCrmDb(env.DB).query;
  // Trigger sources read extension objects from the field registry (a stage relation's status
  // field for `{ stageType }`); a fresh isolate has only core objects until it is refreshed.
  await refreshSchemaRegistry(db);
  const settings = await loadAutomationSettings(db);
  const cache = new Map<string, AutomationDefinition[]>();
  for (const message of messages) {
    if (message.kind === "approval" && message.actionOrigin.runId) {
      await wakeReviewedRun(env, message.actionOrigin.runId, message.actionId, message.decision);
    }
    const source = triggerSourceFor(message.kind);
    if (!source) continue;
    const objects = messageObjects(message);
    const cacheKey = `${source.kind}|${objects?.join(",") ?? "*"}`;
    let automations = cache.get(cacheKey);
    if (!automations) {
      automations = await loadEnabledAutomations(db, source.triggerTypes, objects);
      cache.set(cacheKey, automations);
    }
    if (!automations.length) continue;
    const candidates = source.match(message, automations);
    const started = await startRuns(
      env,
      candidates,
      {
        depth: message.origin.depth,
        chain: message.origin.chain,
        rootEventId: message.origin.rootEventId,
        eventId: message.id,
        at: message.at,
      },
      options.now ? { now: options.now } : {},
      settings,
    );
    total.runIds.push(...started.runIds);
    total.skipped += started.skipped;
    total.dropped.push(...started.dropped);
    total.paused.push(...started.paused);
    total.deferred += started.deferred;
    total.deferredRunIds.push(...started.deferredRunIds);
  }
  // Admin Slack channel routes (ADR 0172); never throws.
  await deliverNotificationRoutes(env, messages, options);
  return total;
}

/** Sends a pending action's decision to the run waiting on it (Workflow waitForEvent). */
async function wakeReviewedRun(
  env: DispatchEnv,
  runId: string,
  actionId: string,
  decision: string,
): Promise<void> {
  const row = await createCrmDb(env.DB)
    .query.selectFrom("core_automation_runs")
    .select(["workflow_id"])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!row?.workflow_id) return;
  try {
    const instance = await env.AUTOMATION_WORKFLOW.get(row.workflow_id);
    await instance.sendEvent({ type: reviewEventType(actionId), payload: { decision } });
  } catch (error) {
    console.warn(`automation run ${runId}: could not deliver the decision on ${actionId}`, error);
  }
}

/** The Workflow event type a review pause waits for (no dots: `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`). */
export function reviewEventType(actionId: string): string {
  return `approval-${actionId}`;
}
