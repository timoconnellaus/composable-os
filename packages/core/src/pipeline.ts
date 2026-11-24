// The invocation pipeline (ADR 0016, ADR 0011, ADR 0017, ADR 0018, ADR 0022):
//
//   audience → validate input → actor + role (+ token scope) check → gate → handler → timeline → audit
//
// The handler's queued writes, the timeline activities and the audit rows commit together in one
// D1 batch (one transaction). Refusals (role, actor, gate) and failures are audited separately.
// A gate `review` dry-runs the handler and queues a pending action instead (approvals/queue.ts);
// reads by an MCP session see its pending actions applied (approvals/simulation.ts).

import type { AuditChangeAction, CrmDb, ReviewSource } from "@composable-os/db";
import { checkGrant } from "@composable-os/sdk";
import { type Compilable, type CompiledQuery, sql } from "kysely";
import { ADJUDICATOR_PRINCIPAL } from "./adjudicator/review.ts";
import type { AiAdmin } from "./ai/admin.ts";
import type { AiEnv } from "./ai/client.ts";
import { embeddingQueueStatement, SELF_ENQUEUEING } from "./ai/embedding.ts";
import type { VectorStore } from "./ai/vectors.ts";
import { matchesPreviewValue } from "./approvals/caps.ts";
import {
  dryRunHosts,
  isDryRunRefusal,
  notRunPlaceholder,
  readOnlyCrm,
  runsInDryRun,
} from "./approvals/dry-run.ts";
import { type DryRunResult, prepareQueuedAction } from "./approvals/queue.ts";
import {
  isSimulatedRead,
  LayeredOverlay,
  loadSessionOverlay,
  type Overlay,
  overlayRead,
  simulatedTitle,
} from "./approvals/simulation.ts";
import { isAssignmentConflict } from "./assignment/index.ts";
import type { AgentJobHost } from "./assistant/agent-jobs.ts";
import { type GrantGuard, outsideSession } from "./assistant/grants.ts";
import type { AssistantThreadStore } from "./assistant/threads.ts";
import { allowsAudience, isOpenOutside, OUTSIDE_RISK_CLASSES } from "./audiences.ts";
import { eventOriginOf, isBulkOperation, recordEventMessages } from "./automations/events.ts";
import {
  deliverOutbox,
  type OutboxEntry,
  outboxEntries,
  outboxInserts,
} from "./automations/outbox.ts";
import { createTestSimulation, type TestSimulation } from "./automations/simulate.ts";
import type { AutomationHost, EventSink } from "./automations/types.ts";
import { contentGenerationWrites } from "./content/cache.ts";
import { loadCustomerSignIn } from "./customers/accounts.ts";
import { checkOutsideRateLimit } from "./customers/limits.ts";
import type { WidgetCache } from "./dashboards/cache.ts";
import { diffRecords, type FieldDiff } from "./diff.ts";
import {
  type AllowanceRefusalDetails,
  allowanceMessage,
  ConflictError,
  ForbiddenError,
  GateDeniedError,
  NeedsOwnApprovalError,
  OperationError,
  type PendingApproval,
  PendingApprovalError,
  RunsOnApprovalError,
  toOperationError,
  UnknownOperationError,
  ValidationError,
} from "./errors.ts";
import type { ExtensionHost } from "./extensions/host.ts";
import { refreshSchemaRegistry } from "./extensions/schema.ts";
import { loadOpenTool } from "./extensions/tools.ts";
import { getObject, isCoreObject } from "./fields/index.ts";
import {
  evaluateGate,
  evaluateOutsideGate,
  type GateDecision,
  type GateFloor,
  type GateResult,
} from "./gate.ts";
import { findProvisionalIds, newId } from "./ids.ts";
import type { BlobStore, IntegrationRuntime } from "./integrations/runtime.ts";
import type { HostMail } from "./invites.ts";
import type { Judge } from "./judge/types.ts";
import { errorForLog } from "./log.ts";
import type { ModelRunner } from "./models.ts";
import { notifyStatements } from "./notifications/send.ts";
import type { MediaUpload } from "./operation.ts";
import {
  type AnyOperation,
  type ApplyingApproval,
  type AssistantTurn,
  afterCommit,
  type ExtensionCaller,
  type HandlerContext,
  isAfterCommit,
  isHostTool,
  type NestedInvocation,
  type OperationOutput,
  type RecordChange,
  runAfterCommit,
  type SystemActivityInput,
} from "./operation.ts";
import type { VoiceRuntime } from "./operations/voice.ts";
import { holdRoleToday, type TodayLimits } from "./pack-role-today.ts";
import {
  type HeldPackRole,
  loadStaffRights,
  roleLimitsFor,
  type StaffRights,
  staffMayCall,
  staffRightsReach,
} from "./pack-roles.ts";
import {
  ACTORS,
  type ActingUser,
  type Actor,
  type Origin,
  type OutsideActor,
  type OutsidePrincipal,
  originSchema,
  type Permission,
  staffPrincipal,
} from "./principals.ts";
import type { RateLimitBinding } from "./rate-limit.ts";
import type { MediaStore } from "./records/media.ts";
import { touchesPersonApproves } from "./records/person-approves.ts";
import { ALWAYS_REVIEWED_PUBLISHERS } from "./records/publish.ts";
import { resolveInputFilter } from "./relative.ts";
import { type MarkedChange, markStatements, type Standing } from "./routine-mail/marks.ts";
import { loadApprovalPolicy } from "./settings.ts";
import type { UpdaterRuntime } from "./updates.ts";
import { SYSTEM_USER } from "./users.ts";
import { orgReader } from "./visibility/index.ts";
import { recordAccess } from "./visibility/records.ts";
import {
  assertVisibleWrites,
  createVisible,
  type SeamWriter,
  updateVisible,
} from "./visibility/writes.ts";

/** What a call made while an approved action is applied checks against, and reports to. */
export interface AppliedPreview {
  preview: ApplyingApproval["preview"];
  report(changes: readonly RecordChange[]): void;
}

/** Everything an adapter supplies for one call. */
export interface InvocationContext {
  /** Never set on a staff call: a customer's or the public's call is an OutsideInvocationContext. */
  principal?: undefined;
  actor: Actor;
  /** The CRM user the call acts for (see resolveActingUser). */
  user: ActingUser;
  origin: Origin;
  db: CrmDb;
  /** The deploy-time floor, parsed from env APPROVAL_FLOOR by the adapter (parseFloor). */
  floor?: GateFloor;
  /** Clock override for tests. */
  clock?: () => Date;
  /**
   * What the caller's credential allows (an MCP token's scopes, ADR 0021). The call needs its
   * permission in both the user's role and this list. Omitted means the role alone decides.
   */
  grantedPermissions?: readonly Permission[] | undefined;
  /** Why the caller wants this change. Stored on the pending action when it is queued. */
  reason?: string | undefined;
  /**
   * Set by platform code only (a tool run, for the staff account that started it, ADR 0553): the
   * caller's pack role limit to today, held on this call as on the account's own.
   */
  roleToday?: TodayLimits | undefined;
  /**
   * Set by platform code only (a tool run, ADR 0590): who stands behind what the tool writes, from
   * the verified caller that started it (a person, a customer, an AI). Absent: the host.
   */
  markStanding?: Standing | undefined;
  /**
   * Set by platform code only (a tool a person ran, ADR 0590): the normal forms of the values the
   * person gave it. What the run writes stands as the host's, except a value equal to one of these.
   */
  markGiven?: ReadonlySet<string> | undefined;
  /** Days before a pending action expires (env APPROVAL_EXPIRY_DAYS). Default 7. */
  approvalExpiryDays?: number | undefined;
  /** Set when this call applies an approved pending action. */
  approval?: ApplyingApproval | undefined;
  /** Looks up other operations by name, for approvals that re-run queued actions. */
  resolveOperation?: ((name: string) => AnyOperation | undefined) | undefined;
  /** The extension runtime (extension.* and x.* operations need it). */
  extensionHost?: ExtensionHost;
  /** The integration host (connection.*, integration.*, outbound approvals). */
  integrations?: IntegrationRuntime;
  /** Blob storage (R2) for email bodies. */
  blobs?: BlobStore;
  /** Where media originals are kept (R2, stage 28, ADR 0444). */
  media?: MediaStore;
  /**
   * The bytes of a file a person uploaded, for `media.upload`: set by the upload route from the
   * request's body, never from an operation's input. Not passed to nested calls.
   */
  upload?: MediaUpload;
  /** Actor `extension` only: the calling extension and its declared permissions (ADR 0025). */
  extension?: ExtensionCaller;
  /** Model roles (ADR 0009); absent when the deployment has no AI binding. */
  models?: ModelRunner;
  /**
   * The judge (ADR 0230), built by `judgeFor`. Absent, or off without a key: every placement
   * behaves as it did before stage 11. Nested invocations inherit it.
   */
  judge?: Judge;
  /**
   * The person's own words in this conversation, passed by code (the assistant's Durable Object
   * takes them from the person's turns), never by a model. `authoring.intent` checks an
   * automation against them. Not inherited by nested invocations.
   */
  personsWords?: string | undefined;
  /** The chat turn the call is part of (ADR 0342). Passed by code. Not inherited when nested. */
  assistantTurn?: AssistantTurn | undefined;
  /** Widget result cache (ADR 0057); absent means the Workers Cache API. */
  widgetCache?: WidgetCache;
  /** The self-updater (ADR 0164): GitHub Releases and the Cloudflare API. */
  updater?: UpdaterRuntime;
  /**
   * Where committed record changes go as automation events (ADR 0130): cos-app and cos-runner
   * pass a Queue producer. Absent: no events (tests, scripts). Nested invocations inherit it.
   */
  events?: EventSink;
  /** cos-runner's automation host (automation.test, run, retry, replay, cancel). */
  automationHost?: AutomationHost;
  /** The assistant threads (cos-app): thread.* operations and erase reach them (ADR 0340). */
  assistantThreads?: AssistantThreadStore;
  /** Speech providers (ADR 0349). Absent: voice is off. */
  voice?: VoiceRuntime;
  /** The agents' Durable Objects (ADR 0344). Nested invocations inherit it. */
  agentJobs?: AgentJobHost;
  /** The host's own mail for staff (ADR 0455). Not inherited when nested. */
  hostMail?: HostMail;
  /**
   * Set on an agent's calls (ADR 0344): what its grant allows, checked on every call. Passed by the
   * AgentJob object, never by a model. Not inherited when nested, which is why operations that run
   * others can never be granted (grants.ts).
   */
  grantGuard?: GrantGuard | undefined;
  /**
   * Set by the pipeline on a call an approved action's handler makes (never by an adapter): the
   * preview the reviewer approved, which this call's changes are checked against before it
   * commits, and where it reports what it committed (ADR 0022 amendment, 2026-11-22).
   */
  applying?: AppliedPreview;
  /**
   * Test mode (ADR 0133): the call is simulated against this in-memory overlay. The gate is
   * evaluated and recorded, writes are dry-run, nothing is written and no events are sent.
   */
  simulate?: TestSimulation;
  /** Record embeddings (Vectorize, ADR 0154); absent: semantic search is off. */
  vectors?: VectorStore;
  /**
   * Set where the automation events consumer embeds committed changes (a Vectorize binding on
   * cos-runner, ADR 0154 amendment): with `events`, the pipeline then writes no embedding queue
   * row, so every write is embedded exactly once, from its event.
   */
  embedViaEvents?: boolean;
  /** Cloudflare API access for Settings → AI (keys, usage; ADR 0151, 0152). */
  aiAdmin?: AiAdmin;
  /** The Worker's AI environment, for provider readiness in Settings → AI. */
  aiEnv?: AiEnv;
  /**
   * Called after a successful commit (ADR 0154): the post-commit hook. cos-app uses it to drain
   * the embedding queue in the background when the call queued anything (only without an event
   * sink, and for operations that queue themselves: erase, sync).
   */
  onCommitted?: (event: CommitEvent) => void;
  /**
   * Called after a gate `review` committed a pending action (ADR 0204), with this context. cos-app
   * runs the policy adjudicator on it in the background (`waitUntil`): never awaited, so the
   * caller gets `pending_approval` exactly as before. Not called in test mode.
   */
  onQueued?: (event: QueuedEvent, ctx: InvocationContext) => void;
  /** Statements the adapter commits in the call's own batch (the HTTP surface's keys, ADR 0416). */
  inBatch?: InBatch | undefined;
}

/** How a write is about to commit: applied, or queued for review (staff only). */
export type BatchOutcome =
  | { kind: "applied"; output: unknown; deferred: boolean }
  | { kind: "queued"; pending: PendingApproval };

/**
 * An adapter's statements for the batch that commits a call (ADR 0416): they commit with its
 * writes or not at all, and one that fails aborts them. Called once per batch, never for a read,
 * and not inherited by nested invocations.
 */
export type InBatch = (outcome: BatchOutcome) => (Compilable | CompiledQuery)[];

/** A pending action the pipeline just queued, for the post-queue hook. */
export interface QueuedEvent {
  actionId: string;
  changeSetId: string;
  operation: string;
  reviewSource: ReviewSource;
}

/** What a committed call changed, for post-commit hooks. */
export interface CommitEvent {
  operation: string;
  changes: { object: string; id: string; action: string }[];
  /** The batch queued records in core_embedding_queue for (re-)embedding. */
  embeddingsQueued: boolean;
}

/** The installed extension whose principal is `userId`, with its declared permissions. */
async function loadExtensionCaller(db: CrmDb, userId: string): Promise<ExtensionCaller | null> {
  const row = await db.query
    .selectFrom("core_extensions")
    .select(["id", "manifest", "status"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (row?.status !== "active") return null;
  const manifest = JSON.parse(row.manifest) as { permissions: ExtensionCaller["permissions"] };
  return { id: row.id, permissions: manifest.permissions };
}

/** What an account with a pack role is told when the role does not allow a call. */
function packRoleRefusal(role: HeldPackRole, op: AnyOperation): ForbiddenError {
  return new ForbiddenError(`The ${role.label} role cannot ${op.name}`, {
    packRole: role.name,
    ...(op.packPermissions ? { permission: op.packPermissions.join(" or ") } : {}),
  });
}

/** The object an operation reads or writes, for extension permission checks. */
export function operationObject(op: AnyOperation, input: unknown): string | null {
  // state.resolve reads one object's record as the write would (ADR 0507): granted by object.
  if (op.name.startsWith("record.") || op.name.startsWith("my.") || op.name === "state.resolve") {
    const object = (input as { object?: unknown } | null)?.object;
    return typeof object === "string" ? object : null;
  }
  const prefix = op.name.split(".")[0] ?? "";
  return isCoreObject(prefix) ? prefix : null;
}

type AuditOutcome = "ok" | "forbidden" | "denied" | "review" | "error";

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authori[sz]ation|cookie/i;
const REDACTED = "[redacted]";

/** Deep-copies `value` with secret-looking keys (and `extra` keys) replaced by "[redacted]". */
export function redactInput(value: unknown, extra: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => redactInput(item, extra));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        SECRET_KEY.test(key) || extra.includes(key) ? REDACTED : redactInput(v, extra),
      ]),
    );
  }
  return value;
}

/**
 * Reads by humans are not audited; every write, refusal and non-human call is. A non-human read
 * that succeeds is counted in core_audit_read_counts instead of getting its own row (ADR 0090);
 * one that fails or is refused still gets a full audit row.
 */
function isAudited(op: AnyOperation, actor: Actor): boolean {
  return op.risk !== "read" || actor !== "human" || op.auditReads === true;
}

/** The UTC hour a read is counted in: 'YYYY-MM-DDTHH:00:00.000Z'. */
export function readCountHour(at: string): string {
  return `${at.slice(0, 13)}:00:00.000Z`;
}

/** Who, within the actor, a read is counted against: the connected app, extension or automation. */
function readCaller(ctx: InvocationContext): string {
  const o = ctx.origin;
  return o.sessionId ?? o.extensionId ?? ctx.extension?.id ?? o.automationId ?? o.clientId ?? "";
}

/** Counts one successful non-human read (an upsert of one row). Never throws. */
async function countRead(
  op: AnyOperation,
  ctx: InvocationContext,
  at: string,
  simulated: boolean,
): Promise<void> {
  try {
    await ctx.db.batch([
      ctx.db.query
        .insertInto("core_audit_read_counts")
        .values({
          hour: readCountHour(at),
          actor: ctx.actor,
          user_id: ctx.user.id,
          caller: readCaller(ctx),
          operation: op.name,
          count: 1,
          simulated: simulated ? 1 : 0,
          first_at: at,
          last_at: at,
        })
        .onConflict((oc) =>
          oc.columns(["hour", "actor", "user_id", "caller", "operation"]).doUpdateSet((eb) => ({
            count: eb("core_audit_read_counts.count", "+", 1),
            simulated: eb("core_audit_read_counts.simulated", "+", eb.ref("excluded.simulated")),
            last_at: sql<string>`max(core_audit_read_counts.last_at, excluded.last_at)`,
          })),
        ),
    ]);
  } catch (error) {
    console.error("failed to count read", op.name, errorForLog(error));
  }
}

function defaultSummary(output: unknown, changes: RecordChange[]): unknown {
  if (changes.length) {
    return {
      count: changes.length,
      // A shift's warnings are recorded with its write (stage 45, ADR 0622).
      records: changes.slice(0, 50).map(({ object, id, action, warnings }) => ({
        object,
        id,
        action,
        ...(warnings?.length
          ? { warnings: warnings.map(({ code, account }) => ({ code, account })) }
          : {}),
      })),
    };
  }
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.id === "string") return { id: o.id };
    if (Array.isArray(o.items)) return { count: o.items.length };
  }
  return null;
}

interface AuditRow {
  id: string;
  op: AnyOperation;
  ctx: InvocationContext;
  input: unknown;
  at: string;
  gate: GateDecision;
  outcome: AuditOutcome;
  result?: unknown;
  error?: OperationError;
  pendingActionId?: string | null;
}

function auditInsert(db: CrmDb, row: AuditRow): Compilable {
  return db.query.insertInto("core_audit").values({
    id: row.id,
    at: row.at,
    operation: row.op.name,
    risk: row.op.risk,
    actor: row.ctx.actor,
    user_id: row.ctx.user.id,
    origin: JSON.stringify(originSchema.parse(row.ctx.origin)),
    input: JSON.stringify(redactInput(row.input, row.op.redact) ?? null),
    result:
      row.result === undefined
        ? null
        : JSON.stringify(
            row.op.redactResult ? redactInput(row.result, row.op.redactResult) : row.result,
          ),
    gate_decision: row.gate,
    outcome: row.outcome,
    error: row.error ? JSON.stringify(row.error.toJSON()) : null,
    pending_action_id: row.pendingActionId ?? null,
  });
}

/** Bytes of JSON per audit-changes statement; D1 caps one bound value at 2 MB. */
const CHANGES_CHUNK_BYTES = 500_000;

/**
 * core_audit_changes rows as few statements as possible: each inserts a chunk from one JSON
 * parameter via json_each, so bulk operations touching thousands of records stay within D1's
 * statements-per-invocation and bound-parameter limits. Rows keep their order.
 */
function auditChangeInserts(
  db: CrmDb,
  auditId: string,
  at: string,
  rows: { o: string; r: string; a: string; d: string }[],
): Compilable[] {
  const statements: Compilable[] = [];
  let chunk: typeof rows = [];
  let bytes = 0;
  const flush = () => {
    if (!chunk.length) return;
    const json = JSON.stringify(chunk);
    statements.push(
      db.query
        .insertInto("core_audit_changes")
        .columns(["audit_id", "object_type", "record_id", "action", "diff", "at"])
        .expression(
          db.query
            .selectFrom(sql<{ value: string }>`json_each(${json})`.as("j"))
            .select([
              sql<string>`${auditId}`.as("audit_id"),
              sql<string>`json_extract(j.value, '$.o')`.as("object_type"),
              sql<string>`json_extract(j.value, '$.r')`.as("record_id"),
              sql<AuditChangeAction>`json_extract(j.value, '$.a')`.as("action"),
              sql<string>`json_extract(j.value, '$.d')`.as("diff"),
              sql<string>`${at}`.as("at"),
            ])
            .orderBy(sql`j.key`),
        ),
    );
    chunk = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = row.d.length + row.r.length + 64;
    if (bytes + size > CHANGES_CHUNK_BYTES) flush();
    chunk.push(row);
    bytes += size;
  }
  flush();
  return statements;
}

/** Writes a standalone audit row (refusals and failures). Never throws. Not in test mode. */
async function auditAlone(row: AuditRow): Promise<void> {
  if (row.ctx.simulate) return;
  try {
    await row.ctx.db.batch([auditInsert(row.ctx.db, row)]);
  } catch (error) {
    console.error("failed to write audit row", row.op.name, errorForLog(error));
  }
}

function activityStatements(
  db: CrmDb,
  author: { userId: string | null; actor: Actor | OutsideActor },
  now: string,
  id: string,
  activity: SystemActivityInput,
): Compilable[] {
  const statements: Compilable[] = [
    db.query.insertInto("core_activity").values({
      id,
      type: "system",
      subject: activity.subject,
      body: activity.body ?? null,
      payload: JSON.stringify(activity.payload),
      occurred_at: activity.occurredAt ?? now,
      author_user_id: author.userId,
      // core_activity.author_actor predates the extension actor; extension posts are `system`,
      // and so are posts from a customer's or the public's call (no staff user wrote them).
      author_actor:
        author.actor === "extension" || author.actor === "customer" || author.actor === "public"
          ? "system"
          : author.actor,
      created_at: now,
      updated_at: now,
    }),
  ];
  const links = [
    ...new Map(activity.links.map((l) => [`${l.object}:${l.id}`, l] as const)).values(),
  ];
  if (links.length) {
    statements.push(
      db.query
        .insertInto("core_activity_links")
        .values(links.map((l) => ({ activity_id: id, object_type: l.object, record_id: l.id }))),
    );
  }
  return statements;
}

/** Field changes flagged `track: "timeline"` become a system activity on the record. */
function timelineActivity(
  operation: string,
  change: RecordChange,
  diff: FieldDiff,
): SystemActivityInput | null {
  if (change.action !== "update") return null;
  const object = getObject(change.object);
  if (!object) return null;
  const tracked = object.fields.filter((f) => f.track === "timeline" && f.name in diff);
  if (!tracked.length) return null;
  const labels = tracked.map((f) => f.label);
  const display = change.timeline?.labels ?? {};
  return {
    subject: change.timeline?.subject ?? `${labels.join(", ")} changed`,
    payload: {
      kind: "field_change",
      operation,
      object: change.object,
      recordId: change.id,
      changes: tracked.map((f) => ({
        field: f.name,
        label: f.label,
        before: diff[f.name]?.before ?? null,
        after: diff[f.name]?.after ?? null,
        ...(display[f.name]
          ? {
              beforeLabel: display[f.name]?.before ?? null,
              afterLabel: display[f.name]?.after ?? null,
            }
          : {}),
      })),
    },
    links: change.timeline?.links ?? [{ object: change.object, id: change.id }],
  };
}

/**
 * When applying an approved action: fails with ConflictError if a record the human approved a
 * change to has changed meanwhile (a previewed field's current value is not its preview `before`).
 */
function assertUnchangedSincePreview(
  approval: Pick<ApplyingApproval, "preview">,
  changes: readonly RecordChange[],
): void {
  for (const change of changes) {
    if (change.action === "create" || !change.before) continue;
    const previewed = approval.preview.find(
      (p) => p.object === change.object && p.id === change.id,
    );
    if (!previewed) continue;
    for (const [field, values] of Object.entries(previewed.diff)) {
      if (!(field in change.before)) continue;
      if (!matchesPreviewValue(change.before[field], values.before)) {
        throw new ConflictError(
          `The ${change.object} ${change.id} changed after this was queued (${field}), so the ` +
            "approved change no longer matches what was reviewed",
          { object: change.object, id: change.id, field },
        );
      }
    }
  }
}

/** Provisional id → real id, matching the action's creates in order. */
function bindProvisional(
  approval: ApplyingApproval,
  changes: RecordChange[],
): Record<string, string> {
  const creates = changes.filter((c) => c.action === "create");
  const used = new Set<RecordChange>();
  const bindings: Record<string, string> = {};
  for (const p of approval.provisional) {
    const match = creates.find((c) => c.object === p.object && !used.has(c));
    if (!match) continue;
    used.add(match);
    bindings[p.id] = match.id;
  }
  return bindings;
}

/**
 * Runs one operation for one caller. Throws typed OperationErrors: ValidationError,
 * ForbiddenError, GateDeniedError, PendingApprovalError (queued for review), NotFoundError,
 * ConflictError.
 */
/** How many times a call is re-run when an assignment rule's round-robin state moved under it. */
const ASSIGNMENT_RETRIES = 5;

class AssignmentRetry extends Error {
  override name = "AssignmentRetry";
}

export async function invokeOperation<O extends AnyOperation>(
  op: O,
  rawInput: unknown,
  ctx: AnyInvocationContext,
): Promise<OperationOutput<O>> {
  // A call for a customer or the public takes its own short path: no role, no queue, no
  // staff capabilities (invokeOutside below). Which path is decided by the context's shape,
  // set by the adapter from the session it verified, never by anything in the input.
  if (isOutside(ctx)) return invokeOutside(op, rawInput, ctx);
  if ((ctx as { principal?: unknown }).principal !== undefined || !ctx.user) {
    throw new OperationError("internal", "An invocation is for staff or for a principal, not both");
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await invokeOnce(op, rawInput, ctx, attempt);
    } catch (error) {
      if (!(error instanceof AssignmentRetry)) throw error;
    }
  }
}

async function invokeOnce<O extends AnyOperation>(
  op: O,
  rawInput: unknown,
  ctx: InvocationContext,
  attempt: number,
): Promise<OperationOutput<O>> {
  const now = (ctx.clock?.() ?? new Date()).toISOString();
  // Audience first (ADR 0402, ADR 0411): a caller the operation is not open to gets the answer
  // an unknown name gets, before the input is looked at, so nothing tells them it exists.
  // The audit log holds any text as its actor since migration 0400: it is checked here instead.
  if (!(ACTORS as readonly string[]).includes(ctx.actor)) {
    throw new OperationError("internal", "Unknown actor");
  }
  if (!allowsAudience(op, staffPrincipal(ctx.user))) throw new UnknownOperationError(op.name);
  // A staff-only tool-only operation (ADR 0621) is reached only from a tool's run. One open to
  // customers too is tool-only for them alone (ADR 0414): staff call it directly.
  if (op.toolOnly && !isOpenOutside(op) && !(ctx.actor === "extension" && ctx.extension?.tool)) {
    throw new UnknownOperationError(op.name);
  }
  const parsed = op.input.safeParse(rawInput);
  // A staff account with a pack role (ADR 0436) may call only what the role lists. Read from the
  // account on every call, not from what the adapter resolved (beside the registry's own read,
  // so it adds no round trip), and refused whatever the input: such an account learns nothing
  // about any other operation, not even whether its input was valid.
  // The same statement reads the permissions a human admin granted the account (ADR 0449).
  const [rights] = await Promise.all([
    ctx.user.id === SYSTEM_USER.id
      ? ({ packRole: null, grants: [] } as StaffRights)
      : loadStaffRights(ctx.db.query, ctx.user.id),
    // Extension objects and fields join the field registry (ADR 0023); cheap when unchanged.
    parsed.success ? refreshSchemaRegistry(ctx.db.query) : null,
  ]);
  const { packRole, grants } = rights;
  // The limit to today: the account's pack role's when the role is what allows this call (not a
  // pack permission granted to it, ADR 0600), or one a tool run carries for its caller.
  const roleToday: TodayLimits | undefined = roleLimitsFor(rights, op) ?? ctx.roleToday;
  if (packRole && !staffRightsReach(rights, op)) {
    const error = packRoleRefusal(packRole, op);
    const gate = evaluateGate(
      { actor: ctx.actor, risk: op.risk, bulkSize: 1 },
      await loadApprovalPolicy(ctx.db.query),
      ctx.floor,
    );
    await auditAlone({
      id: newId("audit"),
      op,
      ctx,
      input: rawInput,
      at: now,
      pendingActionId: ctx.approval?.actionId ?? null,
      gate: gate.decision,
      outcome: "forbidden",
      error,
    });
    throw error;
  }
  if (!parsed.success) {
    throw new ValidationError(`Invalid input for ${op.name}`, { issues: parsed.error.issues });
  }
  // Relative filter values ({ $relative: "me" }, "startOfMonth", …) resolve per call (ADR 0103).
  const input: unknown = resolveInputFilter(op.name, parsed.data, ctx.user.id, now);
  const audited = isAudited(op, ctx.actor);
  const auditId = newId("audit");
  const pendingActionId = ctx.approval?.actionId ?? null;
  const base = { id: auditId, op, ctx, input, at: now, pendingActionId } as const;

  // Gate first (pure, after one settings read) so refusals record what it would have decided.
  const policy = await loadApprovalPolicy(ctx.db.query);
  const bulkSize = op.bulkSize ? op.bulkSize(input) : 1;
  const gate: GateResult = evaluateGate(
    { actor: ctx.actor, risk: op.risk, bulkSize },
    policy,
    ctx.floor,
  );
  let decision: GateDecision = gate.decision;
  // Bookkeeping (opening a change set, revoking a token) is never queued; deny still applies.
  if (op.bookkeeping && decision === "review") decision = "auto";
  // The host's own system step (ADR 0520): never queued from the system origin; deny applies.
  if (op.hostStep && ctx.origin.surface === "system" && decision === "review") decision = "auto";
  // Some changes always wait for a person (extension installs and upgrades, ADR 0041).
  // A person's own fields and settings (a gym's booking rules, ADR 0507): anyone else's write of
  // one waits for a person, as an AI's publish does (ADR 0480).
  const forced =
    op.alwaysReview === true ||
    (Array.isArray(op.alwaysReview) && op.alwaysReview.includes(ctx.actor)) ||
    (!ctx.approval &&
      ALWAYS_REVIEWED_PUBLISHERS.includes(ctx.actor) &&
      (await touchesPersonApproves(ctx.db.query, op.name, input)));
  if (forced && decision === "auto" && !ctx.approval) decision = "review";
  // Applied by the adjudicator, asked again: what a person approves may have joined the action
  // since it was queued (a family link on a merge, ADR 0540). Then it is a person's to apply.
  if (
    ctx.approval?.approvedBy === ADJUDICATOR_PRINCIPAL &&
    ALWAYS_REVIEWED_PUBLISHERS.includes(ctx.actor) &&
    (await touchesPersonApproves(ctx.db.query, op.name, input))
  ) {
    throw new ConflictError(
      "This now changes something only a person approves, so it waits for a person.",
      { rule: "person_approves" },
    );
  }
  // What routed it to review (ADR 0204): the adjudicator never approves floor or forced reviews.
  let reviewSource: ReviewSource = forced
    ? "always"
    : gate.floorDecision === "review"
      ? "floor"
      : gate.policyDecision === "review"
        ? "policy"
        : "dependency";
  // A write that refers to a record still pending creation can only be queued after it.
  const provisionalRefs = op.risk === "read" ? [] : findProvisionalIds(rawInput);
  // (Test mode reports what the gate decides: its provisional ids stand for real ones.)
  if (decision === "auto" && provisionalRefs.length && !ctx.approval && !ctx.simulate) {
    decision = "review";
  }

  if (op.actors && !op.actors.includes(ctx.actor)) {
    const error = new ForbiddenError(`${op.name} cannot be called by ${ctx.actor} actors`, {
      actor: ctx.actor,
      allowed: op.actors,
    });
    await auditAlone({ ...base, gate: decision, outcome: "forbidden", error });
    throw error;
  }
  let extensionCaller = ctx.extension;
  if (ctx.actor === "extension" || (ctx.actor === "automation" && ctx.extension)) {
    // The runtime passes the caller; an approved pending action re-run by an admin does not, so
    // it is loaded from the extension principal's installed manifest.
    const caller = ctx.extension ?? (await loadExtensionCaller(ctx.db, ctx.user.id));
    if (caller) extensionCaller = caller;
    const grant = caller
      ? checkGrant(caller.id, caller.permissions, {
          operation: op.name,
          risk: op.risk,
          object: operationObject(op, input),
        })
      : { ok: false as const, reason: "Extension calls need the calling extension" };
    if (!grant.ok) {
      const error = new ForbiddenError(grant.reason, {
        extension: caller?.id ?? null,
        operation: op.name,
      });
      await auditAlone({ ...base, gate: decision, outcome: "forbidden", error });
      throw error;
    }
  }
  // A pack role replaces what the account's own role grants (ADR 0436); pack permissions granted
  // to it add up with it (ADR 0600).
  if (!staffMayCall(ctx.user, rights, op, input)) {
    const error = packRole
      ? packRoleRefusal(packRole, op)
      : op.packRestricted
        ? // A restricted tool (ADR 0625): admins hold it, anyone else by an admin's grant.
          new ForbiddenError(
            `${op.name} needs ${(op.packPermissions ?? []).join(" or ") || "an admin"}, which admins hold and an admin may grant`,
            {
              role: ctx.user.role,
              permission: (op.packPermissions ?? []).join(" or ") || op.permission,
              restricted: true,
            },
          )
        : new ForbiddenError(`Your role (${ctx.user.role}) cannot ${op.name}`, {
            role: ctx.user.role,
            permission: op.permission,
          });
    await auditAlone({ ...base, gate: decision, outcome: "forbidden", error });
    throw error;
  }
  if (ctx.grantedPermissions && !ctx.grantedPermissions.includes(op.permission)) {
    const error = new ForbiddenError(
      `This connection was not granted the scope ${op.name} needs (${op.permission}). ` +
        "Reconnect the app with a wider scope, if your role allows it.",
      { permission: op.permission, granted: ctx.grantedPermissions },
    );
    await auditAlone({ ...base, gate: decision, outcome: "forbidden", error });
    throw error;
  }
  if (decision === "deny") {
    const error = new GateDeniedError(`The approval policy does not allow ${op.name}`, gate);
    await auditAlone({ ...base, gate: "deny", outcome: "denied", error });
    throw error;
  }

  const writes: (Compilable | CompiledQuery)[] = [];
  // Work a handler's helpers asked to do once its writes are all queued (HandlerContext.beforeCommit).
  const beforeCommits: (() => Promise<void>)[] = [];
  const changes: RecordChange[] = [];
  const activities: Compilable[] = [];
  // Applying an approved action, or a call it makes (ADR 0022 amendment, 2026-11-22): every
  // change in the order it was made, this call's own and those its calls committed, for binding
  // the preview's provisional ids, which the dry run assigned in the same order.
  const applyingLog: RecordChange[] = [];
  const applyingFor =
    (ctx.approval || ctx.applying) && !ctx.simulate
      ? {
          preview: ctx.approval?.preview ?? ctx.applying?.preview ?? [],
          report: (made: readonly RecordChange[]) => {
            applyingLog.push(...made);
          },
        }
      : undefined;
  let preChecked = false;
  const liveCtx: HandlerContext = {
    operation: op.name,
    actor: ctx.actor,
    user: ctx.user,
    principal: staffPrincipal(ctx.user),
    records: recordAccess({ db: ctx.db.query, principal: staffPrincipal(ctx.user) }),
    origin: ctx.origin,
    now,
    auditId,
    db: ctx.db.query,
    floor: ctx.floor ?? {},
    grantedPermissions: ctx.grantedPermissions,
    permissionGrants: packRole ? [] : grants,
    ...(roleToday ? { roleToday } : {}),
    ...(ctx.markStanding ? { markStanding: ctx.markStanding } : {}),
    ...(ctx.markGiven ? { markGiven: ctx.markGiven } : {}),
    reason: ctx.reason,
    ...(ctx.approval
      ? {
          approval: {
            actionId: ctx.approval.actionId,
            approvedBy: ctx.approval.approvedBy,
            preview: ctx.approval.preview,
          },
        }
      : {}),
    write: (...statements) => {
      writes.push(...statements);
    },
    beforeCommit: (fn) => {
      beforeCommits.push(fn);
    },
    recordChange: (change) => {
      changes.push(change);
      applyingLog.push(change);
    },
    postActivity: (activity) => {
      const id = newId("activity");
      activities.push(
        // The system user is not a core_user row (users.ts): its posts have no author (stage 25:
        // an order paid or expired by the host posts on the buyer's timeline).
        ...activityStatements(
          ctx.db,
          { userId: ctx.user.id === SYSTEM_USER.id ? null : ctx.user.id, actor: ctx.actor },
          now,
          id,
          activity,
        ),
      );
      return id;
    },
    afterCommit,
    ...(ctx.extensionHost ? { extensionHost: ctx.extensionHost } : {}),
    ...(ctx.integrations ? { integrations: ctx.integrations } : {}),
    ...(ctx.blobs ? { blobs: ctx.blobs } : {}),
    ...(ctx.media ? { media: ctx.media } : {}),
    ...(ctx.upload ? { upload: ctx.upload } : {}),
    ...(extensionCaller ? { extension: extensionCaller } : {}),
    ...(ctx.models ? { models: ctx.models } : {}),
    ...(ctx.judge ? { judge: ctx.judge } : {}),
    ...(ctx.personsWords ? { personsWords: ctx.personsWords } : {}),
    ...(ctx.assistantTurn ? { assistantTurn: ctx.assistantTurn } : {}),
    ...(ctx.widgetCache ? { widgetCache: ctx.widgetCache } : {}),
    ...(ctx.updater ? { updater: ctx.updater } : {}),
    ...(ctx.vectors ? { vectors: ctx.vectors } : {}),
    ...(ctx.aiAdmin ? { aiAdmin: ctx.aiAdmin } : {}),
    ...(ctx.aiEnv ? { aiEnv: ctx.aiEnv } : {}),
    ...(ctx.events && !ctx.simulate ? { events: ctx.events } : {}),
    ...(ctx.automationHost ? { automationHost: ctx.automationHost } : {}),
    ...(ctx.assistantThreads ? { assistantThreads: ctx.assistantThreads } : {}),
    ...(ctx.voice ? { voice: ctx.voice } : {}),
    ...(ctx.agentJobs ? { agentJobs: ctx.agentJobs } : {}),
    ...(ctx.hostMail ? { hostMail: ctx.hostMail } : {}),
    pipeline: {
      crm: ctx.db,
      resolve: (name) => ctx.resolveOperation?.(name),
      invoke: async (name, nestedInput, nested) => {
        // An approved action is applied whole or not at all: before its first call commits,
        // the same dry run shows whether a call it makes would need its own approval.
        if (ctx.approval && !preChecked) {
          preChecked = true;
          await assertAppliesWhole();
        }
        return invokeNested(name, nestedInput, nested);
      },
    },
  };
  // A simulated call (test mode, or one a dry-run handler made) reads with the dry run's
  // read-only database and guarded runtimes too (approvals/dry-run.ts); its writes are dry-run
  // with `dryRunCtx`, which builds on this.
  const simRefused: string[] = [];
  const handlerCtx: HandlerContext = ctx.simulate
    ? readOnlyContext(liveCtx, (uses) => simRefused.push(uses))
    : liveCtx;

  /**
   * A simulated read that reached something a simulation does not touch (a gatekeeper, a model):
   * it answers the not-run placeholder, and the test report (or the dry run's notes) say so,
   * rather than failing the automation step or the dry run.
   */
  function notRunRead(error: unknown): unknown {
    const sim = ctx.simulate as TestSimulation;
    const uses = error instanceof RunsOnApprovalError ? error.uses : "the database (a write)";
    const note = `${op.name} was not run in ${sim.dryRun ? "the dry run" : "test mode"}: it uses ${uses}, and it would run for real.`;
    if (sim.dryRun) sim.notes?.push(runsOnApprovalNote([uses]));
    else sim.notRun?.push({ operation: op.name, note });
    return notRunPlaceholder(op.name, note);
  }

  /** A simulated read that caught a refusal itself: answered, and the refusal still noted. */
  function noteCaughtRefusals(): void {
    const sim = ctx.simulate;
    if (!sim || !simRefused.length) return;
    if (sim.dryRun) sim.notes?.push(runsOnApprovalNote(simRefused));
    else {
      sim.notRun?.push({
        operation: op.name,
        note: `Part of ${op.name} was not run in test mode: it uses ${[...new Set(simRefused)].join(", ")}.`,
      });
    }
  }

  /**
   * Runs another operation through the full pipeline for a handler (`pipeline.invoke`). In a dry
   * run (`simulate` given) the nested call is simulated too, never committed or queued.
   */
  function invokeNested(
    name: string,
    nestedInput: unknown,
    nested: NestedInvocation,
    simulate: TestSimulation | undefined = ctx.simulate,
  ): Promise<unknown> {
    const target = ctx.resolveOperation?.(name);
    if (!target) throw new UnknownOperationError(name);
    return invokeOperation(target, nestedInput, {
      db: ctx.db,
      ...(ctx.floor ? { floor: ctx.floor } : {}),
      ...(ctx.clock ? { clock: ctx.clock } : {}),
      approvalExpiryDays: ctx.approvalExpiryDays,
      resolveOperation: ctx.resolveOperation,
      actor: nested.actor,
      user: nested.user,
      origin: nested.origin,
      grantedPermissions: nested.grantedPermissions,
      approval: nested.approval,
      reason: nested.reason,
      ...(ctx.extensionHost ? { extensionHost: ctx.extensionHost } : {}),
      ...(ctx.integrations ? { integrations: ctx.integrations } : {}),
      ...(ctx.blobs ? { blobs: ctx.blobs } : {}),
      ...(ctx.models ? { models: ctx.models } : {}),
      ...(ctx.judge ? { judge: ctx.judge } : {}),
      ...(ctx.widgetCache ? { widgetCache: ctx.widgetCache } : {}),
      ...(ctx.vectors ? { vectors: ctx.vectors } : {}),
      ...(ctx.aiAdmin ? { aiAdmin: ctx.aiAdmin } : {}),
      ...(ctx.aiEnv ? { aiEnv: ctx.aiEnv } : {}),
      ...(ctx.onCommitted ? { onCommitted: ctx.onCommitted } : {}),
      ...(ctx.onQueued ? { onQueued: ctx.onQueued } : {}),
      ...(ctx.embedViaEvents ? { embedViaEvents: true } : {}),
      ...(ctx.events ? { events: ctx.events } : {}),
      ...(ctx.automationHost ? { automationHost: ctx.automationHost } : {}),
      ...(ctx.assistantThreads ? { assistantThreads: ctx.assistantThreads } : {}),
      ...(ctx.voice ? { voice: ctx.voice } : {}),
      ...(ctx.agentJobs ? { agentJobs: ctx.agentJobs } : {}),
      // An approved update or rollback is applied through here (approval.approve).
      ...(ctx.updater ? { updater: ctx.updater } : {}),
      // A call an approved action makes: checked against the reviewed preview, and its changes
      // reported back for binding provisional ids.
      ...(applyingFor && !simulate ? { applying: applyingFor } : {}),
      ...(simulate ? { simulate } : {}),
    });
  }

  /** The handler's context for a dry run (approvals/dry-run.ts): nothing it does is real. */
  const dryRunCtx = (overlay: Overlay, sink: DrySink): HandlerContext =>
    dryRunContext(handlerCtx, overlay, sink, invokeNested, ctx.simulate);

  /**
   * Applying an approved action whose handler makes calls (ADR 0022 amendment, 2026-11-22): the
   * dry run is run again, now, before any of its calls commits. If one would need its own
   * approval, nothing of the action is applied: it waits (approval.ts), rather than applying the
   * calls before that one and stopping there.
   */
  async function assertAppliesWhole(): Promise<void> {
    if (!runsInDryRun(op)) return;
    const overlay = await loadSessionOverlay(ctx.db.query, ctx.origin.sessionId, now);
    let held: string | undefined;
    try {
      held = (await dryRunHandler(op, input, (sink) => dryRunCtx(overlay, sink))).held;
    } catch {
      // The check could not tell (a dry run that fails): the real run decides, as before.
      return;
    }
    if (held) throw new NeedsOwnApprovalError(op.name, held);
  }

  const fail = async (error: unknown, gateDecision: GateDecision = "auto"): Promise<never> => {
    const typed = toOperationError(error);
    if (audited) await auditAlone({ ...base, gate: gateDecision, outcome: "error", error: typed });
    throw typed;
  };

  // An agent's grant (ADR 0344). It can only tighten: `auto` stays what the gate said. The handler
  // is dry-run first, because whether a write fills a field or changes a value decides where it
  // goes; a write that changes nothing has nothing to route.
  const guard = ctx.approval || ctx.simulate ? undefined : ctx.grantGuard;
  let origin = ctx.origin;
  let guardRouted = false;
  if (guard && (op.risk === "read" || op.bookkeeping)) {
    // Neither can wait for review: bookkeeping is never queued, so it needs the grant as a read does.
    if (!guard.allowsRead(op)) {
      const error = new ForbiddenError(
        `${op.name} is not part of this agent's grant. Carry on without it, or say what you need in your report.`,
        { operation: op.name },
      );
      await auditAlone({ ...base, gate: decision, outcome: "forbidden", error });
      throw error;
    }
  } else if (guard) {
    let planned: RecordChange[] = [];
    if (op.risk !== "outbound" && !op.name.startsWith("x.") && guard.needsChanges(op)) {
      try {
        const overlay = await loadSessionOverlay(ctx.db.query, ctx.origin.sessionId, now);
        planned = await dryRunChanges(op, input, (sink) => dryRunCtx(overlay, sink));
      } catch (error) {
        return fail(error, decision);
      }
    }
    const route = await guard.route(op, planned, now, ctx.db.query);
    if (route === "auto") {
      guardRouted = true;
    } else {
      // A person looks at it: never the adjudicator.
      decision = "review";
      reviewSource = "always";
      if (route === "outside") {
        origin = { ...ctx.origin, sessionId: outsideSession(guard.jobId, newId("changeSet")) };
      }
    }
  }

  if (ctx.simulate && op.risk !== "read") {
    return simulateWrite(op, rawInput, input, ctx, dryRunCtx, {
      now,
      bulkSize,
      decision,
      reason: gate,
    }) as Promise<OperationOutput<O>>;
  }

  if (decision === "review" && !ctx.approval) {
    let queued: Awaited<ReturnType<typeof prepareQueuedAction>>;
    let notices: Compilable[] = [];
    try {
      const overlay = await loadSessionOverlay(ctx.db.query, origin.sessionId, now);
      queued = await prepareQueuedAction({
        op,
        rawInput,
        input,
        db: ctx.db,
        actor: ctx.actor,
        user: ctx.user,
        origin,
        grantedPermissions: ctx.grantedPermissions,
        reason: ctx.reason,
        bulkSize,
        now,
        expiryDays: ctx.approvalExpiryDays,
        overlay,
        reviewSource,
        dryRun: () => dryRunHandler(op, input, (sink) => dryRunCtx(overlay, sink)),
      });
      if (queued.changeSetCreated && ctx.actor !== "human") {
        notices = await pendingApprovalNotice(ctx, queued.pending.changeSetId, now);
      }
    } catch (error) {
      return fail(error, "review");
    }
    try {
      await ctx.db.batch([
        ...queued.statements,
        ...notices,
        ...(op.risk !== "read" && ctx.inBatch
          ? ctx.inBatch({ kind: "queued", pending: queued.pending })
          : []),
        auditInsert(ctx.db, {
          ...base,
          pendingActionId: queued.actionId,
          gate: "review",
          outcome: "review",
          result: { pendingActionId: queued.actionId, changeSetId: queued.pending.changeSetId },
        }),
      ]);
    } catch (error) {
      return fail(error, "review");
    }
    if (ctx.onQueued) {
      try {
        ctx.onQueued(
          {
            actionId: queued.actionId,
            changeSetId: queued.pending.changeSetId,
            operation: op.name,
            reviewSource,
          },
          ctx,
        );
      } catch (error) {
        console.error("post-queue hook failed", op.name, errorForLog(error));
      }
    }
    throw new PendingApprovalError(queued.pending);
  }

  // Reads by an MCP session see its pending actions applied (ADR 0022); reads in test mode see
  // the run's simulated writes (ADR 0133).
  if (op.risk === "read" && (ctx.origin.sessionId || ctx.simulate) && isSimulatedRead(op.name)) {
    const overlay =
      ctx.simulate?.overlay ?? (await loadSessionOverlay(ctx.db.query, ctx.origin.sessionId, now));
    if (!overlay.empty) {
      let output: unknown;
      try {
        output = await overlayRead(op.name, input as Record<string, unknown>, overlay, async () => {
          const checked = op.output.safeParse(await op.handler(input, handlerCtx));
          if (!checked.success) {
            throw new OperationError("invalid_output", `${op.name} returned an invalid result`, {
              issues: checked.error.issues,
            });
          }
          return checked.data;
        });
      } catch (error) {
        if (ctx.simulate && isDryRunRefusal(error)) return notRunRead(error) as OperationOutput<O>;
        return fail(error);
      }
      noteCaughtRefusals();
      if (audited && !ctx.simulate) await countRead(op, ctx, now, true);
      return output as OperationOutput<O>;
    }
  }

  let result: unknown;
  try {
    // A pack role limited to today reaches only today's records of its objects (ADR 0553):
    // held before the operation runs, a list's in its own query.
    const limited = roleToday
      ? await holdRoleToday(ctx.db.query, roleToday, op.name, input, Date.parse(now))
      : input;
    result = await op.handler(limited as typeof input, handlerCtx);
    // What the handler's helpers gathered over the whole call (one notice per person, not one per
    // record a bulk write touched), queued last, in this same batch.
    for (let i = 0; i < beforeCommits.length; i++)
      await (beforeCommits[i] as () => Promise<void>)();
  } catch (error) {
    if (ctx.simulate && op.risk === "read" && isDryRunRefusal(error)) {
      return notRunRead(error) as OperationOutput<O>;
    }
    return fail(error, decision);
  }
  if (op.risk === "read") noteCaughtRefusals();

  if (op.risk === "read" && (writes.length || changes.length || activities.length)) {
    return fail(new OperationError("internal", `${op.name} is a read but queued writes`));
  }

  let bindings: Record<string, string> = {};
  if (ctx.approval || ctx.applying) {
    // Its own changes against what the reviewer saw (a call it made checks its own, before it
    // commits). An approved action binds its provisional ids to every create in the order the
    // dry run made them: its own and those its calls made.
    try {
      assertUnchangedSincePreview(ctx.approval ?? (ctx.applying as AppliedPreview), changes);
    } catch (error) {
      return fail(error, decision);
    }
    if (ctx.approval) bindings = bindProvisional(ctx.approval, applyingLog);
  }

  const deferred = isAfterCommit(result) ? result : null;
  let output: unknown;
  if (!deferred) {
    const checked = op.output.safeParse(result);
    if (!checked.success) {
      return fail(
        new OperationError("invalid_output", `${op.name} returned an invalid result`, {
          issues: checked.error.issues,
        }),
      );
    }
    output = checked.data;
  }

  const statements: (Compilable | CompiledQuery)[] = [...writes];
  const changeRows: { o: string; r: string; a: string; d: string }[] = [];
  const marked: MarkedChange[] = [];
  for (const change of changes) {
    const diff = change.diff ?? diffRecords(change.before, change.after);
    const assigned = change.assignment ? diff[change.assignment.field] : undefined;
    if (assigned && change.assignment) assigned.assignedBy = change.assignment.rule;
    const timeline = timelineActivity(op.name, change, diff);
    if (timeline) handlerCtx.postActivity(timeline);
    changeRows.push({ o: change.object, r: change.id, a: change.action, d: JSON.stringify(diff) });
    marked.push(markedChange(change, diff));
  }
  // Who stands behind each value written (ADR 0590), in this batch: what routine mail reads.
  if (op.risk !== "read" && marked.length && !ctx.simulate) {
    statements.push(
      ...(await markStatements(
        ctx.db.query,
        marked,
        staffStanding(ctx),
        ctx.user.id,
        now,
        ctx.markGiven,
      )),
    );
  }
  statements.push(...activities);
  // Records whose text changed must be re-embedded exactly once (ADR 0154 amendment): where the
  // stage 5 events consumer embeds (`embedViaEvents`), it does so from the record events this call
  // emits and no queue row is written; otherwise (no Vectorize, local dev, tests, scripts) they
  // are queued in this batch for the post-commit drain and the cron.
  // Operations that queue their own embeddings (erase, sync) decide exactly what to queue.
  const embedding =
    op.risk === "read" ||
    SELF_ENQUEUEING.has(op.name) ||
    (ctx.events && ctx.embedViaEvents && !ctx.simulate)
      ? null
      : embeddingQueueStatement(ctx.db.query, changes, now);
  if (embedding) statements.push(embedding);
  // What the public reads of content moved on (stage 28, ADR 0442): a cached public read is
  // keyed by its object's generation, bumped here in the change's own batch.
  if (op.risk !== "read") statements.push(...contentGenerationWrites(changes, now));

  const summary =
    op.auditSummary && !deferred ? op.auditSummary(output, input) : defaultSummary(output, changes);
  if (audited && op.risk === "read" && !op.auditReads) {
    // A successful non-human read: counted, not audited row by row (ADR 0090).
    if (!ctx.simulate) await countRead(op, ctx, now, false);
  } else if (audited) {
    statements.push(
      auditInsert(ctx.db, { ...base, gate: decision, outcome: "ok", result: summary ?? null }),
      ...auditChangeInserts(ctx.db, auditId, now, changeRows),
    );
  }
  if (ctx.approval) {
    // Applied: the pending action and its audit row commit with the change itself.
    statements.push(
      ctx.db.query
        .updateTable("core_pending_action")
        .set({
          status: "applied",
          status_reason: null,
          applied_audit_id: audited ? auditId : null,
          bindings: JSON.stringify(bindings),
          result: JSON.stringify(summary ?? null),
          decided_by: ctx.approval.approvedBy,
          decided_at: now,
        })
        .where("id", "=", ctx.approval.actionId)
        .where("status", "=", "pending"),
    );
  }

  // The record changes become automation events (ADR 0130), written to the outbox in this same
  // batch (ADR 0171) and sent after commit: a failed send is retried by cos-runner's cron.
  let outbox: OutboxEntry[] = [];
  if (ctx.events && changes.length) {
    const origin = eventOriginOf({
      actor: ctx.actor,
      userId: ctx.user.id,
      origin: ctx.origin,
      operation: op.name,
      auditId,
      bulk: isBulkOperation(op.name, bulkSize),
    });
    outbox = outboxEntries(recordEventMessages(auditId, now, origin, changes));
    statements.push(...outboxInserts(ctx.db, outbox, now));
  }
  if (op.risk !== "read" && ctx.inBatch) {
    statements.push(...ctx.inBatch({ kind: "applied", output, deferred: Boolean(deferred) }));
  }

  if (statements.length) {
    try {
      await ctx.db.batch(statements);
    } catch (error) {
      // A round-robin assignment state moved under this call (ADR 0246): nothing was written,
      // so the call runs again from the start with fresh state.
      if (isAssignmentConflict(error) && attempt < ASSIGNMENT_RETRIES) {
        throw new AssignmentRetry();
      }
      // A race the database decided: the operation may read again and say what happened.
      if (op.explainFailure) {
        const explained = await op
          .explainFailure(toOperationError(error), input, handlerCtx)
          .catch(() => null);
        if (explained) return fail(explained, decision);
      }
      return fail(error, decision);
    }
  }

  if (guardRouted) guard?.applied(changes);
  // Committed: a call an approved action made reports what it made, for that action's bindings.
  ctx.applying?.report(applyingLog);

  if (statements.length && ctx.onCommitted) {
    try {
      ctx.onCommitted({
        operation: op.name,
        changes: changes.map(({ object, id, action }) => ({ object, id, action })),
        embeddingsQueued: Boolean(embedding) || SELF_ENQUEUEING.has(op.name),
      });
    } catch (error) {
      console.error("post-commit hook failed", op.name, errorForLog(error));
    }
  }

  // Committed: send the events (one send per outbox row, usually one per operation).
  if (ctx.events && outbox.length) await deliverOutbox(ctx.db, ctx.events, outbox);

  if (deferred) {
    const checked = op.output.safeParse(await runAfterCommit(deferred));
    if (!checked.success) {
      throw new OperationError("invalid_output", `${op.name} returned an invalid result`, {
        issues: checked.error.issues,
      });
    }
    output = checked.data;
  }
  return output as OperationOutput<O>;
}

/** What a dry run collects (approvals/dry-run.ts). */
interface DrySink {
  changes: RecordChange[];
  /** A call the handler made would itself wait for review. */
  held: { operation: string } | null;
  /** What the dry run refused to touch (another runtime, a direct write). */
  refused: string[];
  /** Notes for the reviewer, from this dry run and the calls it simulated. */
  notes: string[];
}

/** The reviewer's note for a call that runs, at least in part, only once approved. */
function runsOnApprovalNote(uses: readonly string[]): string {
  return (
    `Runs on approval: it uses ${[...new Set(uses)].join(", ")}, which a dry run does not ` +
    "touch, so what that part does is not shown here. Nothing has been done yet."
  );
}

/** What a handler would change, with its writes discarded (an agent grant's dry run). */
async function dryRunChanges(
  op: AnyOperation,
  input: unknown,
  dryCtx: (sink: DrySink) => HandlerContext,
): Promise<RecordChange[]> {
  return (await dryRunHandler(op, input, dryCtx)).changes;
}

/**
 * Dry-runs a handler (ADR 0022): its output and what it would change, with nothing written, sent
 * or run for real (approvals/dry-run.ts). An extension tool that may write is not run at all. A
 * handler that reaches something a dry run cannot simulate is stopped there: the call is queued
 * with no preview and a note that it runs on approval (`refused`).
 */
async function dryRunHandler(
  op: AnyOperation,
  input: unknown,
  dryCtx: (sink: DrySink) => HandlerContext,
): Promise<DryRunResult> {
  if (!runsInDryRun(op)) return { output: null, changes: [], notRun: true };
  const sink: DrySink = { changes: [], held: null, refused: [], notes: [] };
  let result: unknown;
  try {
    result = await op.handler(input, dryCtx(sink));
  } catch (error) {
    if (isDryRunRefusal(error)) {
      sink.refused.push(
        error instanceof RunsOnApprovalError ? error.uses : "the database (a direct write)",
      );
      return {
        output: null,
        changes: [],
        notes: [...sink.notes, runsOnApprovalNote(sink.refused)],
        refused: [...new Set(sink.refused)],
      };
    }
    // A call the handler makes would itself wait for review: the dry run ends there, and this
    // call is queued with what it would change so far. On approval it runs for real, and that
    // call goes through the gate again (approval.ts: this one then waits for it).
    if (sink.held && error instanceof PendingApprovalError) {
      return {
        output: null,
        changes: sink.changes,
        held: sink.held.operation,
        notes: [
          ...sink.notes,
          `It calls ${sink.held.operation}, which needs its own approval. While it does, ` +
            "approving this is refused and nothing of it is applied: ask for " +
            `${sink.held.operation} on its own, or reject this.`,
        ],
      };
    }
    throw error;
  }
  let output: unknown = null;
  if (!isAfterCommit(result)) {
    const checked = op.output.safeParse(result);
    output = checked.success ? checked.data : null;
  }
  // Refused but caught by the handler: the preview leaves that part out, and says so.
  const notes = sink.refused.length
    ? [...sink.notes, runsOnApprovalNote(sink.refused)]
    : sink.notes;
  return { output, changes: sink.changes, ...(notes.length ? { notes } : {}) };
}

/**
 * The context any simulated call's handler runs with (approvals/dry-run.ts): its database handle
 * and `pipeline.crm` are read-only and every other runtime answers reads only. A test-mode or
 * nested read gets this; a dry-run write gets `dryRunContext`, which builds on it.
 */
function readOnlyContext(
  handlerCtx: HandlerContext,
  refused: (uses: string) => void,
): HandlerContext {
  const crm = readOnlyCrm(handlerCtx.pipeline.crm);
  const db = crm.query;
  return {
    ...handlerCtx,
    ...dryRunHosts(handlerCtx, refused),
    db,
    records: recordAccess({ db, principal: handlerCtx.principal }),
    pipeline: { ...handlerCtx.pipeline, crm },
    // Nothing gathered for a commit that never happens.
    beforeCommit: undefined,
  };
}

/**
 * The context a handler is dry-run with (approvals/dry-run.ts). On top of `readOnlyContext`: its
 * writes, changes and posts are collected or discarded, and the operations it runs through
 * `pipeline.invoke` are simulated (test mode's path) over their own overlay layered on this dry
 * run's, so a nested call is neither committed nor queued and nothing it would do leaks into the
 * session's overlay. What they would change joins this dry run's preview.
 */
function dryRunContext(
  handlerCtx: HandlerContext,
  overlay: Overlay,
  sink: DrySink,
  invokeNested: (
    name: string,
    input: unknown,
    nested: NestedInvocation,
    simulate: TestSimulation,
  ) => Promise<unknown>,
  simulate: TestSimulation | undefined,
): HandlerContext {
  const base = readOnlyContext(handlerCtx, (uses) => sink.refused.push(uses));
  const nestedSimulation: TestSimulation = simulate ?? {
    ...createTestSimulation(),
    overlay: new LayeredOverlay(overlay),
    dryRun: true,
    collect: (changes) => sink.changes.push(...changes),
    notes: sink.notes,
  };
  return {
    ...base,
    write: () => {},
    recordChange: (change) => {
      sink.changes.push(change);
    },
    ...(base.recordHostChange
      ? {
          recordHostChange: (change: RecordChange) => {
            sink.changes.push(change);
          },
        }
      : {}),
    postActivity: () => newId("activity"),
    simulation: overlay,
    pipeline: {
      ...base.pipeline,
      invoke: async (name, input, nested) => {
        try {
          return await invokeNested(name, input, nested, nestedSimulation);
        } catch (error) {
          // Only this dry run's own simulation: in test mode a pending call is the run's answer.
          if (!simulate && error instanceof PendingApprovalError) {
            sink.held = { operation: error.pending.operation };
          }
          throw error;
        }
      },
    },
  };
}

/** One line on why the gate decided what it did, for test-mode reports. */
function gateReason(gate: GateResult, op: AnyOperation, actor: Actor, bulkSize: number): string {
  const what = `${op.risk}${bulkSize > 1 ? ` of ${bulkSize} records` : ""}`;
  const floor = gate.floorDecision ? `; the deployment floor says ${gate.floorDecision}` : "";
  return `${gate.preset} policy: ${actor} ${what} → ${gate.policyDecision}${floor}`;
}

/** The title a create or change would give its record, from the overlay or the diff. */
function writeTitle(
  object: string,
  record: { object: string; id: string; record: Record<string, unknown> | null } | undefined,
  diff: FieldDiff,
): string | null {
  if (record?.record) {
    const title = simulatedTitle({ ...record, state: "live", actionId: "", changeSetId: "" });
    if (title) return title;
  }
  const titleField = getObject(object)?.titleField;
  const value =
    (titleField ? diff[titleField]?.after : undefined) ??
    diff.title?.after ??
    diff.name?.after ??
    diff.displayName?.after ??
    diff.subject?.after;
  return typeof value === "string" ? value : null;
}

/**
 * Test mode (ADR 0133): records the gate's decision, dry-runs the handler as the approval queue
 * does, adds the simulated records to the run's overlay and returns the simulated output (or
 * throws PendingApprovalError when the gate would queue it). Nothing is written.
 */
async function simulateWrite(
  op: AnyOperation,
  rawInput: unknown,
  input: unknown,
  ctx: InvocationContext,
  dryCtx: (overlay: Overlay, sink: DrySink) => HandlerContext,
  info: { now: string; bulkSize: number; decision: GateDecision; reason: GateResult },
): Promise<unknown> {
  const sim = ctx.simulate as TestSimulation;
  const review = info.decision === "review" && !ctx.approval;
  sim.gates.push({
    operation: op.name,
    gate: info.decision,
    bulkSize: info.bulkSize,
    reason: gateReason(info.reason, op, ctx.actor, info.bulkSize),
  });
  const overlay = sim.overlay;
  let dry: DryRunResult | undefined;
  const queued = await prepareQueuedAction({
    op,
    rawInput,
    input,
    db: ctx.db,
    actor: ctx.actor,
    user: ctx.user,
    origin: ctx.origin,
    grantedPermissions: ctx.grantedPermissions,
    reason: ctx.reason,
    bulkSize: info.bulkSize,
    now: info.now,
    expiryDays: ctx.approvalExpiryDays,
    overlay,
    dryRun: async () => {
      dry = await dryRunHandler(op, input, (sink) => dryCtx(overlay, sink));
      if (sim.dryRun) {
        // A call a dry-run handler made: what cannot be simulated stops the outer dry run too,
        // and what it would change joins the outer preview.
        if (dry.notRun) throw new RunsOnApprovalError(`the extension tool ${op.name}`);
        if (dry.refused) throw new RunsOnApprovalError(dry.refused.join(", "));
        sim.collect?.(dry.changes);
        if (dry.notes) sim.notes?.push(...dry.notes);
      }
      return dry;
    },
  });
  overlay.add(queued.actionId, queued.pending.changeSetId, queued.records);
  for (const p of queued.preview) {
    sim.writes.push({
      object: p.object,
      id: p.id,
      action: p.action,
      title: writeTitle(
        p.object,
        queued.records.find((r) => r.object === p.object && r.id === p.id),
        p.diff,
      ),
      operation: op.name,
    });
  }
  if (op.name === "notification.send") {
    const out = (queued.pending.simulated ?? {}) as { userIds?: unknown };
    const userIds = Array.isArray(out.userIds) ? out.userIds.map(String) : [];
    const names = userIds.length
      ? await ctx.db.query
          .selectFrom("core_user")
          .select(["id", "name"])
          .where("id", "in", userIds)
          .execute()
      : [];
    const sent = input as { title?: string; type?: string };
    sim.notifications.push({
      to: userIds,
      toNames: userIds.map((id) => names.find((n) => n.id === id)?.name ?? id),
      type: sent.type ?? (ctx.actor === "automation" ? "automation.message" : "system.message"),
      title: String(sent.title ?? ""),
    });
  }
  if (review) {
    throw new PendingApprovalError({
      ...queued.pending,
      message: `${sim.dryRun ? "Dry run" : "Test mode"}: ${op.name} would wait for approval (${gateReason(info.reason, op, ctx.actor, info.bulkSize)}). Nothing was queued.`,
    });
  }
  // Test mode cannot run this (an extension tool that may write, or a call that reaches another
  // runtime): the report says so, and the step gets a placeholder it can read instead of null.
  const ran = dry as DryRunResult | undefined;
  if (ran?.notRun || ran?.refused) {
    const note = ran.notRun
      ? `${op.name} was not run in test mode: it is an extension tool, and it would run for real.`
      : `${op.name} was not run in test mode: it uses ${ran.refused?.join(", ")}, and it would run for real.`;
    sim.notRun?.push({ operation: op.name, note });
    return notRunPlaceholder(op.name, note);
  }
  return queued.pending.simulated;
}

/**
 * The `approval.pending` notice for a change set a non-human actor just opened (ADR 0130): its
 * user for MCP and the assistant, the admins for automations and extensions. Committed with the
 * pending action; a failure to plan it never blocks the queueing.
 */
async function pendingApprovalNotice(
  ctx: InvocationContext,
  changeSetId: string,
  now: string,
): Promise<Compilable[]> {
  const toAdmins = ctx.actor === "automation" || ctx.actor === "extension";
  const who =
    ctx.actor === "automation"
      ? `The automation ${ctx.origin.automationId ?? ""}`.trim()
      : ctx.actor === "extension"
        ? `The extension ${ctx.extension?.id ?? ctx.origin.extensionId ?? ""}`.trim()
        : (ctx.origin.clientName ?? "An AI agent");
  try {
    const plan = await notifyStatements(
      ctx.db.query,
      {
        to: toAdmins ? [{ role: "admin" }] : [{ userId: ctx.user.id }],
        type: "approval.pending",
        title: `${who} is waiting for your approval`,
        body: "Review the changes in the Approvals inbox.",
        link: { kind: "approval", changeSetId },
        dedupeKey: `approval:${changeSetId}`,
        source: {
          actor: ctx.actor,
          userId: ctx.user.id,
          ...(ctx.origin.automationId ? { automationId: ctx.origin.automationId } : {}),
          ...(ctx.origin.runId ? { runId: ctx.origin.runId } : {}),
        },
      },
      now,
    );
    return plan.statements;
  } catch (error) {
    console.error("pending approval notice failed", error);
    return [];
  }
}

// --- Calls from outside the org (ADR 0402, ADR 0412) ----------------------------------------------

/**
 * Everything an adapter supplies for one call by a customer or the public. It has no `user` and
 * no `actor`: the principal is the whole identity, resolved by the adapter from a customer
 * session (or the lack of one), and it carries no role and no staff capability.
 */
export interface OutsideInvocationContext {
  principal: OutsidePrincipal;
  db: CrmDb;
  /** Where the call came from. Default `{ surface: "client" }`. */
  origin?: Origin;
  /** The deploy-time floor. It can only refuse: a floor that asks for review refuses. */
  floor?: GateFloor;
  clock?: () => Date;
  /** As for staff calls: committed changes become automation events and embeddings. */
  events?: EventSink;
  embedViaEvents?: boolean;
  onCommitted?: (event: CommitEvent) => void;
  /**
   * Set by the runner, and only by it, when the call is made by a pack's tool that this
   * principal called (ADR 0414). The tool's operation calls are then the caller's own: the same
   * principal, the same seam. The host reads what the tool may do from its installed manifest.
   */
  tool?: { extension: string; tool: string };
  /** The extension runtime, so a tool open to this caller can run. */
  extensionHost?: ExtensionHost;
  /**
   * The Workers Rate Limiting binding for calls from outside the org: a customer is limited per
   * account and per operation (customers/limits.ts). Absent: not limited here.
   */
  rateLimit?: RateLimitBinding;
  /**
   * The integration host, given only to a `hostInternal` core operation's handler (stage 25,
   * ADR 0429: `order.checkout` opens the payment provider's page for a buyer).
   */
  integrations?: IntegrationRuntime;
  /** As for staff calls: the adapter's statements in the call's own batch (ADR 0416). */
  inBatch?: InBatch | undefined;
  /** Never set: these make a context a staff one. */
  user?: undefined;
  actor?: undefined;
}

export type AnyInvocationContext = InvocationContext | OutsideInvocationContext;

/** The plain members of a host context, without its throwing getters. */
function pick(host: HandlerContext) {
  const { origin, now, auditId, db, floor, grantedPermissions, write, recordChange, postActivity } =
    host;
  return {
    operation: host.operation,
    origin,
    now,
    auditId,
    db,
    floor,
    grantedPermissions,
    write,
    recordChange,
    postActivity,
    afterCommit,
  };
}

function isOutside(ctx: AnyInvocationContext): ctx is OutsideInvocationContext {
  const c = ctx as { principal?: unknown; user?: unknown; actor?: unknown };
  if (c.principal === undefined) return false;
  // Fail closed on a context that claims both: it is never treated as staff.
  if (c.user !== undefined || c.actor !== undefined) {
    throw new OperationError("internal", "An invocation is for staff or for a principal, not both");
  }
  return true;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The principal as a plain, frozen value of a known kind, or a refusal. */
function outsidePrincipal(value: unknown): OutsidePrincipal {
  const p = (value ?? {}) as { kind?: unknown; customerId?: unknown; personId?: unknown };
  if (p.kind === "public") return Object.freeze({ kind: "public" });
  if (
    p.kind === "customer" &&
    typeof p.customerId === "string" &&
    typeof p.personId === "string" &&
    ID.test(p.customerId) &&
    ID.test(p.personId)
  ) {
    return Object.freeze({ kind: "customer", customerId: p.customerId, personId: p.personId });
  }
  throw new OperationError("internal", "Not a customer or public principal");
}

/**
 * What a caller outside the org is told when something fails. An error an operation raised on
 * purpose goes out as it is. Anything else (a database error, a bug) goes out with its code and
 * nothing more: no SQL, no column or constraint names.
 */
/**
 * An allowance refusal as a customer is told it (stage 32b, ADR 0493), whether the host or the
 * database refused: the reason in words, and for no uses left the period's numbers, which are of
 * their own holder; never which record refused (a holder not theirs is someone else's), and never
 * a field name beyond the one they wrote.
 */
function outsideAllowance(error: OperationError): OperationError | null {
  const details = error.details as Partial<AllowanceRefusalDetails> & { field?: unknown };
  if (details?.rule !== "allowance") return null;
  const reason = details.reason;
  if (!reason) {
    // A rule of the write itself (a holder that cannot be changed under a use, a missing time).
    return new ValidationError(error.message, {
      rule: "allowance",
      ...(typeof details.field === "string" ? { field: details.field } : {}),
    });
  }
  const safe: AllowanceRefusalDetails = {
    rule: "allowance",
    reason,
    ...(reason === "no_uses_left" || reason === "spent_meanwhile"
      ? { period: details.period, uses: details.uses, used: details.used }
      : {}),
  };
  return error.code === "conflict"
    ? new ConflictError(allowanceMessage(safe), safe)
    : new ValidationError(allowanceMessage(safe), safe);
}

function outsideError(error: unknown): OperationError {
  const internal = () => new OperationError("internal", "Internal error");
  const allowance = outsideAllowance(
    error instanceof OperationError ? error : toOperationError(error),
  );
  if (allowance) return allowance;
  if (error instanceof OperationError) {
    // Even one the host raised itself: an internal error's words are for the log, not the caller.
    if (error.code !== "internal" && error.code !== "invalid_output") return error;
    console.error("outside call failed", error.message);
    return internal();
  }
  const typed = toOperationError(error);
  // Sold out (stage 26, a claim the database refused as an order commits): the buyer is told
  // there are not enough places, and no more than that (ADR 0433 decides what numbers to show).
  if (
    typed.code === "invalid_input" &&
    (typed.details as { rule?: unknown })?.rule === "capacity"
  ) {
    return new ValidationError("There are not enough places left", { rule: "capacity" });
  }
  // A free trial another start took a moment before (migration 0531, ADR 0489): the caller's own
  // start, so they are told to start again (which gives them that page), and no more than that.
  if (typed.code === "conflict" && (typed.details as { rule?: unknown })?.rule === "trial_held") {
    return typed;
  }
  // Their own second order for something sold once per Person, started at the same moment
  // (migration 0581, ADR 0512): told it is held, and no more than that.
  if (
    typed.code === "conflict" &&
    (typed.details as { rule?: unknown })?.rule === "once_per_person"
  ) {
    return typed;
  }
  // The same for a continuation offer's page (migration 0532, ADR 0491): the caller's own offer.
  const offerRule = (typed.details as { rule?: unknown })?.rule;
  if (typed.code === "conflict" && (offerRule === "offer_held" || offerRule === "offer_changed")) {
    return typed;
  }
  // A guardian's write whose link ended before it committed (migration 0650's guard, ADR 0540):
  // the Person is not there for them, as the seam would have said a moment later.
  if (typed.code === "not_found") return typed;
  // A class a booking was for cancelled while it was being made (migration 0670), and a class
  // carrying as many unpaid holds as it may (migration 0690, ADR 0560): what the caller is told
  // is the class's own state, or "try again shortly", the same whatever the cause.
  if (typed.code === "conflict" && (typed.details as { rule?: unknown })?.rule === "state_closed") {
    return typed;
  }
  if (typed.code === "rate_limited") return typed;
  // What must be agreed to changed while this was being planned (the `agreements` guard, stage
  // 44, ADR 0644): the caller looks again and is asked for what is due now. The counter is one
  // for the whole host, so this says nothing about any Person.
  if (
    typed.code === "conflict" &&
    (typed.details as { rule?: unknown })?.rule === "agreements_changed"
  ) {
    return typed;
  }
  console.error("outside call failed", errorForLog(error));
  if (typed.code === "conflict")
    return new ConflictError("A record with that value already exists");
  if (typed.code === "invalid_input") return new ValidationError("A value is not allowed");
  if (typed.code === "plan_limit") return typed;
  return internal();
}

interface OutsideAudit {
  id: string;
  op: AnyOperation;
  actor: OutsideActor;
  /** The customer account, or null for the public. */
  subjectId: string | null;
  origin: Origin;
  input: unknown;
  at: string;
  gate: GateDecision;
  outcome: AuditOutcome;
  result?: unknown;
  error?: OperationError;
}

function outsideAuditInsert(db: CrmDb, row: OutsideAudit): Compilable {
  return db.query.insertInto("core_audit").values({
    id: row.id,
    at: row.at,
    operation: row.op.name,
    risk: row.op.risk,
    actor: row.actor,
    user_id: row.subjectId,
    origin: JSON.stringify(row.origin),
    input: JSON.stringify(redactInput(row.input, row.op.redact) ?? null),
    result:
      row.result === undefined
        ? null
        : JSON.stringify(
            row.op.redactResult ? redactInput(row.result, row.op.redactResult) : row.result,
          ),
    gate_decision: row.gate,
    outcome: row.outcome,
    error: row.error ? JSON.stringify(row.error.toJSON()) : null,
    pending_action_id: null,
  });
}

/**
 * Runs one operation for a customer or the public:
 *
 *   audience → validate → gate (allow or refuse) → handler → write check at the seam → audit
 *
 * What it leaves out is the point. There is no role check, because a customer has no role: the
 * audience is the permission, and the visibility seam decides which records. Nothing is queued
 * for review. The handler gets no staff user, no staff actor, no nested invocation, and none of
 * the model, integration or extension capabilities.
 *
 * Writes are audited with field diffs like any write. Successful reads are counted, not audited
 * row by row (ADR 0090). A read that fails writes nothing: anyone can cause one.
 */
async function invokeOutside<O extends AnyOperation>(
  op: O,
  rawInput: unknown,
  ctx: OutsideInvocationContext,
): Promise<OperationOutput<O>> {
  const principal = outsidePrincipal(ctx.principal);
  const now = (ctx.clock?.() ?? new Date()).toISOString();
  // The same answer as a name that is not registered, before the input is looked at.
  if (!allowsAudience(op, principal)) throw new UnknownOperationError(op.name);
  // Some operations exist for a customer only inside a tool they called (ADR 0414).
  if (op.toolOnly && !ctx.tool) throw new UnknownOperationError(op.name);
  // A call made by a pack's tool: what the tool may do comes from its installed manifest. A tool
  // that is not installed, not shipped or not open to this caller can make no call at all, and a
  // tool does not start another tool.
  const tool = ctx.tool
    ? await loadOpenTool(ctx.db.query, ctx.tool.extension, ctx.tool.tool)
    : null;
  if (ctx.tool && (!tool?.audiences.includes(principal.kind) || isHostTool(op))) {
    throw new UnknownOperationError(op.name);
  }
  // An operation kept to a person (`actors`, as on the staff path) is not a tool's to call for
  // its caller: a pack's tool is the extension acting (ending subscriptions, deleting an account).
  if (ctx.tool && op.actors && !op.actors.includes("extension")) {
    throw new ForbiddenError(`${op.name} is for a person, not a pack's tool`, {
      operation: op.name,
      rule: "actor",
      allowed: op.actors,
    });
  }
  // Counted once the call is one this caller may make at all, and before any work is done for it.
  // A tool's own calls are part of the one call that started the tool.
  if (!ctx.tool) await checkOutsideRateLimit(ctx.rateLimit, principal, op.name);
  // An option only staff may pass is not the customer's or the public's to send (it is not in
  // their contract either).
  const staffKeys = (op.staffInput ?? []).filter(
    (key) =>
      rawInput !== null &&
      typeof rawInput === "object" &&
      (rawInput as Record<string, unknown>)[key] !== undefined,
  );
  if (staffKeys.length) {
    throw new ValidationError(
      `Invalid input for ${op.name}: ${staffKeys.join(", ")} is for staff`,
      {
        field: staffKeys[0],
        rule: "staff_input",
      },
    );
  }
  const parsed = op.input.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(`Invalid input for ${op.name}`, { issues: parsed.error.issues });
  }
  if (ctx.tool && tool) {
    // And only within the extension's own declared permissions, as for any of its calls.
    const grant = checkGrant(ctx.tool.extension, tool.permissions, {
      operation: op.name,
      risk: op.risk,
      object: operationObject(op, parsed.data),
    });
    if (!grant.ok) throw new ForbiddenError(grant.reason, { operation: op.name });
  }
  const actor: OutsideActor = principal.kind;
  const subjectId = principal.kind === "customer" ? principal.customerId : null;
  const origin = originSchema.parse(ctx.origin ?? { surface: "client" });
  // `{ $relative: "me" }` in a customer's filter is their own Person.
  const me = principal.kind === "customer" ? principal.personId : "";
  const input: unknown = resolveInputFilter(op.name, parsed.data, me, now);
  await refreshSchemaRegistry(ctx.db.query);

  const isRead = op.risk === "read";
  const auditId = newId("audit");
  const base = { id: auditId, op, actor, subjectId, origin, input, at: now } as const;
  const auditAloneOutside = async (row: OutsideAudit): Promise<void> => {
    // Failed reads are not written down: a caller with no account could make any number.
    if (isRead) return;
    try {
      await ctx.db.batch([outsideAuditInsert(ctx.db, row)]);
    } catch (error) {
      console.error("failed to write audit row", op.name, errorForLog(error));
    }
  };

  // The gate allows or refuses (ADR 0402). The registry already refuses to load an operation
  // above the risk floor that is open to these callers; this holds even if one got through.
  const decision = evaluateOutsideGate(op.risk, ctx.floor);
  if (decision !== "auto" || !OUTSIDE_RISK_CLASSES.includes(op.risk) || op.alwaysReview) {
    const error = new GateDeniedError(`${op.name} is not available`);
    await auditAloneOutside({ ...base, gate: "deny", outcome: "denied", error });
    throw error;
  }

  const writes: (Compilable | CompiledQuery)[] = [];
  const changes: RecordChange[] = [];
  const activities: Compilable[] = [];
  const staffOnly = (what: string): never => {
    throw new OperationError(
      "internal",
      `${op.name} read ctx.${what}, which a call by a ${actor} caller does not have`,
    );
  };
  const reader = { db: ctx.db.query, principal };
  // What the host itself writes with, on the caller's behalf: the real database and write queue.
  // It is given to the seam's write helpers and to `hostInternal` operations, and to nothing else.
  const checkedBySeam = new Set<RecordChange>();
  const host: HandlerContext = {
    operation: op.name,
    get actor() {
      return staffOnly("actor");
    },
    get pipeline() {
      return staffOnly("pipeline");
    },
    // Record code stamps who wrote a row: the customer account, or `public`.
    user: { id: subjectId ?? "public", email: "", name: actor, role: "viewer" },
    // The host's own reads while it writes (the row before, a relation's target) are org-wide.
    principal: orgReader(ctx.db.query).principal,
    // Who the write is really for: the lifecycle engine names them as the mover (ADR 0426).
    onBehalfOf: principal,
    origin,
    now,
    auditId,
    db: ctx.db.query,
    floor: ctx.floor ?? {},
    grantedPermissions: [],
    records: recordAccess(orgReader(ctx.db.query)),
    write: (...statements) => {
      writes.push(...statements);
    },
    recordChange: (change) => {
      changes.push(change);
    },
    postActivity: (activity) => {
      const id = newId("activity");
      activities.push(...activityStatements(ctx.db, { userId: null, actor }, now, id, activity));
      return id;
    },
    afterCommit,
  };
  const seam: SeamWriter = {
    reader,
    host,
    widened: tool?.widened,
    mark: (change) => {
      checkedBySeam.add(change);
    },
  };
  const records = recordAccess(reader, {
    create: (object, values, options) => createVisible(seam, object, values, options),
    update: (object, id, values, options) => updateVisible(seam, object, id, values, options),
  });
  // The caller's own account's sign-in address: read for the verified principal, never for an
  // id from the input, so no handler can learn another account's.
  const signIn =
    principal.kind === "customer"
      ? () => loadCustomerSignIn(ctx.db.query, principal.customerId, principal.personId)
      : undefined;
  // What the operation's own handler gets. Unless the operation is `hostInternal` (core
  // bookkeeping that is not a record, ADR 0413) it has no database and no write queue: it reads
  // and writes records through `ctx.records`, so it cannot read past the seam or write unseen.
  const closed = (what: string): never => {
    throw new OperationError(
      "internal",
      `${op.name} used ctx.${what} on a call by a ${actor} caller: use ctx.records, or mark a ` +
        "core bookkeeping operation hostInternal",
    );
  };
  // Host code keeps the database: a core bookkeeping operation, and the operation the host
  // itself builds to start an extension tool (the tool's own code runs in the sandbox and calls
  // back through this same path).
  const hostTool = isHostTool(op);
  const hostInternal = (op.hostInternal === true && !op.name.startsWith("x.")) || hostTool;
  // What a core bookkeeping operation records with `recordHostChange` is the host's own change
  // (ADR 0428): the seam does not judge it against the caller's scope. What it records with
  // `recordChange` is still checked in full. Never a tool's: a tool starter gets neither, and
  // what the tool's code then writes comes back through this path as the caller's.
  const madeByHost = new Set<RecordChange>();
  const handlerCtx: HandlerContext = hostInternal
    ? {
        ...pick(host),
        ...(op.hostInternal === true && !op.name.startsWith("x.")
          ? {
              recordHostChange: (change: RecordChange) => {
                madeByHost.add(change);
                host.recordChange(change);
              },
            }
          : {}),
        ...(hostTool && ctx.extensionHost ? { extensionHost: ctx.extensionHost } : {}),
        ...(op.hostInternal === true && !op.name.startsWith("x.") && ctx.integrations
          ? { integrations: ctx.integrations }
          : {}),
        get actor() {
          return staffOnly("actor");
        },
        get user() {
          return staffOnly("user");
        },
        get pipeline() {
          return staffOnly("pipeline");
        },
        principal,
        records,
        signIn,
      }
    : {
        operation: op.name,
        get actor() {
          return staffOnly("actor");
        },
        get user() {
          return staffOnly("user");
        },
        get pipeline() {
          return staffOnly("pipeline");
        },
        get db() {
          return closed("db");
        },
        principal,
        origin,
        now,
        auditId,
        floor: ctx.floor ?? {},
        grantedPermissions: [],
        records,
        signIn,
        write: () => closed("write"),
        recordChange: () => closed("recordChange"),
        postActivity: () => closed("postActivity"),
        afterCommit,
      };

  const fail = async (error: unknown): Promise<never> => {
    const typed = outsideError(error);
    await auditAloneOutside({ ...base, gate: "auto", outcome: "error", error: typed });
    throw typed;
  };

  let result: unknown;
  try {
    result = await op.handler(input, handlerCtx);
    if (isRead && (writes.length || changes.length || activities.length)) {
      throw new OperationError("internal", `${op.name} is a read but queued writes`);
    }
    // The seam has the last word on every record the call would change.
    await assertVisibleWrites(reader, changes, checkedBySeam, madeByHost, (statement) => {
      writes.push(statement);
    });
  } catch (error) {
    return fail(error);
  }

  const deferred = isAfterCommit(result) ? result : null;
  let output: unknown;
  if (!deferred) {
    const checked = op.output.safeParse(result);
    if (!checked.success) return fail(new OperationError("invalid_output", "Internal error"));
    output = checked.data;
  }

  const statements: (Compilable | CompiledQuery)[] = [...writes];
  const changeRows: { o: string; r: string; a: string; d: string }[] = [];
  const marked: MarkedChange[] = [];
  for (const change of changes) {
    const diff = change.diff ?? diffRecords(change.before, change.after);
    const timeline = timelineActivity(op.name, change, diff);
    if (timeline) host.postActivity(timeline);
    changeRows.push({ o: change.object, r: change.id, a: change.action, d: JSON.stringify(diff) });
    marked.push(markedChange(change, diff));
  }
  // A customer's own writes are theirs; the public's, an unauthenticated buyer's (ADR 0590).
  if (!isRead && marked.length) {
    statements.push(
      ...(await markStatements(
        ctx.db.query,
        marked,
        principal.kind === "customer" ? "customer" : "public",
        principal.kind === "customer" ? principal.customerId : null,
        now,
      )),
    );
  }
  statements.push(...activities);
  const embedding =
    isRead || SELF_ENQUEUEING.has(op.name) || (ctx.events && ctx.embedViaEvents)
      ? null
      : embeddingQueueStatement(ctx.db.query, changes, now);
  if (embedding) statements.push(embedding);
  if (!isRead) statements.push(...contentGenerationWrites(changes, now));

  if (!isRead) {
    const summary =
      op.auditSummary && !deferred
        ? op.auditSummary(output, input)
        : defaultSummary(output, changes);
    statements.push(
      outsideAuditInsert(ctx.db, { ...base, gate: "auto", outcome: "ok", result: summary ?? null }),
      ...auditChangeInserts(ctx.db, auditId, now, changeRows),
    );
  }

  let outbox: OutboxEntry[] = [];
  if (ctx.events && changes.length) {
    const eventOrigin = eventOriginOf({
      actor,
      userId: subjectId ?? "",
      origin,
      operation: op.name,
      auditId,
      bulk: false,
    });
    outbox = outboxEntries(recordEventMessages(auditId, now, eventOrigin, changes));
    statements.push(...outboxInserts(ctx.db, outbox, now));
  }
  if (!isRead && ctx.inBatch) {
    statements.push(...ctx.inBatch({ kind: "applied", output, deferred: Boolean(deferred) }));
  }

  if (statements.length) {
    try {
      await ctx.db.batch(statements);
    } catch (error) {
      return fail(error);
    }
  }
  if (isRead) await countOutsideRead(ctx.db, op, actor, subjectId, now);

  if (statements.length && ctx.onCommitted) {
    try {
      ctx.onCommitted({
        operation: op.name,
        changes: changes.map(({ object, id, action }) => ({ object, id, action })),
        embeddingsQueued: Boolean(embedding),
      });
    } catch (error) {
      console.error("post-commit hook failed", op.name, errorForLog(error));
    }
  }
  if (ctx.events && outbox.length) await deliverOutbox(ctx.db, ctx.events, outbox);

  if (deferred) {
    let late: unknown;
    try {
      late = await runAfterCommit(deferred);
    } catch (error) {
      throw outsideError(error);
    }
    const checked = op.output.safeParse(late);
    if (!checked.success) throw new OperationError("invalid_output", "Internal error");
    output = checked.data;
  }
  return output as OperationOutput<O>;
}

/** Counts one successful read by a customer or the public (ADR 0090). Never throws. */
async function countOutsideRead(
  db: CrmDb,
  op: AnyOperation,
  actor: OutsideActor,
  subjectId: string | null,
  at: string,
): Promise<void> {
  try {
    await db.batch([
      db.query
        .insertInto("core_audit_read_counts")
        .values({
          hour: readCountHour(at),
          actor,
          user_id: subjectId ?? "",
          caller: "",
          operation: op.name,
          count: 1,
          simulated: 0,
          first_at: at,
          last_at: at,
        })
        .onConflict((oc) =>
          oc.columns(["hour", "actor", "user_id", "caller", "operation"]).doUpdateSet((eb) => ({
            count: eb("core_audit_read_counts.count", "+", 1),
            last_at: sql<string>`max(core_audit_read_counts.last_at, excluded.last_at)`,
          })),
        ),
    ]);
  } catch (error) {
    console.error("failed to count read", op.name, errorForLog(error));
  }
}

/** A recorded change as its marks need it: each field's value after it. */
function markedChange(change: RecordChange, diff: FieldDiff): MarkedChange {
  const after = Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.after]));
  const before = Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.before]));
  return {
    object: change.object,
    id: change.id,
    action: change.action,
    after,
    before,
    marks: change.marks,
  };
}

/**
 * Who stands behind a staff call's writes (ADR 0590): a person's own call, or an AI's or a tool's
 * a human approved; never one only the adjudicator approved (ADR 0204's principal), an AI's own,
 * or the host's (an automation, the system). A tool's and an automation's writes stand as the
 * runner says (`markStanding`): an AI's for an AI's call, an automation authored in the app, or a
 * run that used a model; otherwise the host's, with a person's own given values (`markGiven`).
 */
function staffStanding(ctx: InvocationContext): Standing {
  if (ctx.approval) return ctx.approval.approvedBy === "adjudicator" ? "ai" : "person";
  if (ctx.actor === "human") return "person";
  if (ctx.actor === "assistant" || ctx.actor === "mcp") return "ai";
  // A tool's caller's (the runner says), and an automation's: the host's only for a shipped pack's
  // own automation, an AI's for one authored in the app (ADR 0590, the third review).
  if (ctx.actor === "extension" || ctx.actor === "automation") return ctx.markStanding ?? "host";
  return "host";
}
