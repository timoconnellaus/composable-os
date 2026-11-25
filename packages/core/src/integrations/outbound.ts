// Outbound actions (ADR 0051): what the integration host's ApprovalQueue does with a gatekeeper's
// `submitAction(n, description)`. The gate decides once, at submit, as risk class `outbound` keyed
// by the action's kind. A `review` decision mirrors the action into the approval queue as an
// `outbound` pending action in the caller's change set; approval later calls the facet's
// `applyAction(n)` (approval.ts), in action order per facet. The gatekeeper journals and replays
// the action itself, so nothing is re-run through the pipeline.
import type { CoreDatabase, CrmDb } from "@composable-os/db";
import type { Compilable, Kysely } from "kysely";
import { OUTBOUND_OPERATION } from "../approvals/describe.ts";
import { addDays, DEFAULT_APPROVAL_EXPIRY_DAYS, targetChangeSet } from "../approvals/queue.ts";
import {
  checkSend,
  PURPOSE_REQUIRED_MESSAGE,
  RECIPIENT_STOPPED_MESSAGE,
  recipientsOfFields,
  type SenderStanding,
  type SendPurpose,
} from "../contact/senders.ts";
import { type PendingApproval, ValidationError } from "../errors.ts";
import { evaluateGate, type GateDecision, type GateFloor } from "../gate.ts";
import { findIds, findProvisionalIds, newId } from "../ids.ts";
import {
  holdsForReview,
  OUTBOUND_PLACEMENT,
  type OutboundCheck,
} from "../judge/questions/outbound-message.ts";
import type { Judge, JudgeCallUsage } from "../judge/types.ts";
import { judgeUsageStatement } from "../judge/usage.ts";
import { type ActingUser, type Actor, type Origin, originSchema } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import { loadApprovalPolicy } from "../settings.ts";
import { checkOutbound, textFromAi } from "./outbound-check.ts";

/** The parts of a gatekeeper `ActionDescription` the CRM stores and shows. */
export interface OutboundDescription {
  title: string;
  /** Markdown. */
  description: string;
  fields?:
    | {
        label: string;
        /** inline, text and json fields. */
        value?: string;
        /** list fields (`To`, `Cc`): one value per row. */
        items?: string[];
        syntax?: string;
        truncated?: unknown;
      }[]
    | undefined;
  descriptionIsComplete?: boolean | undefined;
  implementsRevert?: boolean | undefined;
  awaitDecision?: boolean | undefined;
  autoApprovable?: boolean | undefined;
  actionKind?: { tag: string; label: string } | undefined;
}

export interface OutboundSubmission {
  connectionId: string;
  connectionTitle: string;
  vendor: string;
  facetKey: string;
  resourceTitle: string;
  action: number;
  description: OutboundDescription;
  actor: Actor;
  user: ActingUser;
  origin: Origin;
  reason?: string | undefined;
  floor?: GateFloor | undefined;
  expiryDays?: number | undefined;
  now?: string | undefined;
  /**
   * The judge, for `outbound.message` (ADR 0238): a message an AI actor wrote is checked before it
   * leaves. Absent or off: decided exactly as before.
   */
  judge?: Judge | undefined;
  /** The person's own words the message was written for, passed by code (never a model). */
  asked?: string | undefined;
  /**
   * The host itself submitted it, from platform code (`callAsHost`, ADR 0429): an order's
   * confirmation email, composed from a fixed template to the buyer's own address. It applies
   * unless the floor denies it. Set only by the integration host for its own calls.
   */
  hostMessage?: boolean | undefined;
  /**
   * Routine mail (ADR 0590): the host's own send of a row of `core_routine_mail`, set only by the
   * integration host for its `callAsHost` with purpose `routine-mail`. `routine` is the host's
   * decision that it may go without a person; it applies only when the gatekeeper also gave the
   * send its routine kind (one recipient, plain text, links only to the business's site).
   * Anything else from that queue, a held one included, always waits for a person.
   */
  routineMail?: { routine: boolean; ordinary?: boolean } | undefined;
  /**
   * Consent to be contacted (ADR 0678): how the host checked a caller's message to people when it
   * was submitted (`contactAtSubmit`), kept on a pending one so approving it asks again. Set only
   * by the integration host.
   */
  contact?: OutboundContact | undefined;
}

/** How a caller's message to people was checked for consent (ADR 0678), and is asked again. */
export interface OutboundContact {
  channel: "email";
  sender: SenderStanding;
  purpose: SendPurpose | null;
}

/**
 * Kinds whose recipients the consent check leaves alone: mail only to colleagues (every address
 * at the business's own domains, as the gatekeeper decided it) and drafts, which send nothing.
 */
export const CONTACT_EXEMPT_KINDS: ReadonlySet<string> = new Set([
  "email.internal",
  "fake.internal",
  "draftCreate",
  "draftUpdate",
  "draftDelete",
  "outlook.drafts",
]);

/**
 * The consent check of a caller's outbound action as it is submitted (ADR 0678), at the one place
 * every gatekeeper's send passes. Null when it sends nothing to anyone (or only to colleagues).
 * A send whose recipients the queue's own `contactCheck` vouched for just now (the gatekeeper
 * asked, dropped who may not be contacted and added the stop links) keeps that check's purpose;
 * any other (a gatekeeper that did not ask) is checked here with no purpose, and refused when a
 * recipient may not be contacted: thrown, so the gatekeeper queues nothing.
 */
export async function contactAtSubmit(
  db: CrmDb,
  input: {
    description: OutboundDescription;
    sender: SenderStanding;
    /** The addresses the queue's `contactCheck` allowed in this session, with their purpose. */
    vouched: ReadonlyMap<string, SendPurpose | null>;
    at: string;
  },
): Promise<OutboundContact | null> {
  const tag = input.description.actionKind?.tag;
  if (tag && CONTACT_EXEMPT_KINDS.has(tag)) return null;
  const recipients = recipientsOfFields(input.description.fields ?? []);
  if (!recipients.length) return null;
  const purposes = new Set(recipients.map((r) => input.vouched.get(r)));
  const [purpose] = purposes;
  if (
    purposes.size === 1 &&
    purpose !== undefined &&
    recipients.every((r) => input.vouched.has(r))
  ) {
    return { channel: "email", sender: input.sender, purpose };
  }
  const answer = await checkSend(db.query, {
    channel: "email",
    recipients,
    sender: input.sender,
    purpose: null,
    at: input.at,
  });
  if (answer.purposeRequired) throw new ValidationError(PURPOSE_REQUIRED_MESSAGE);
  if (answer.dropped > 0) throw new ValidationError(RECIPIENT_STOPPED_MESSAGE);
  return { channel: "email", sender: input.sender, purpose: null };
}

/**
 * How many recipients of a waiting outbound action may not be contacted now (ADR 0678): asked
 * when the approvals inbox shows it and again when a person approves it, so a stop taken while it
 * waited holds. 0 for an action the host did not check at submit (not a message to people).
 */
export async function contactBlocked(
  db: Kysely<CoreDatabase>,
  input: Partial<OutboundInput>,
  at: string,
): Promise<number> {
  const contact = input.contact;
  if (!contact || !Array.isArray(input.fields)) return 0;
  const recipients = recipientsOfFields(input.fields);
  if (!recipients.length) return 0;
  const answer = await checkSend(db, {
    channel: contact.channel,
    recipients,
    sender: contact.sender,
    purpose: contact.purpose,
    at,
  });
  return answer.purposeRequired ? recipients.length : answer.dropped;
}

/**
 * Gatekeeper kinds of routine messages (ADR 0590, ADR 0672): email-send's, the fake outbox's, and
 * the text gatekeeper's.
 */
export const ROUTINE_MAIL_KINDS: ReadonlySet<string> = new Set([
  "email.routine",
  "fake.routine",
  "text.routine",
]);

/**
 * A refund sends money back (ADR 0429): a person with `orders:refund` approves each one
 * (approval.ts), and no AI actor can.
 */
export const REFUND_KINDS: ReadonlySet<string> = new Set(["payments.refund"]);

/**
 * A card reader registered to or removed from the payment account (stage 50, ADR 0774): it moves
 * no money, but adds or takes away a device that can take it. Asked only by the host's own call,
 * which the host's message rule would otherwise apply at once: a human admin approves each one
 * (approval.ts), and no AI actor can.
 */
export const READER_KINDS: ReadonlySet<string> = new Set([
  "payments.reader.register",
  "payments.reader.remove",
]);

/**
 * A void of a document the host posted to the books (stage 61, ADR 0881): it takes back an entry
 * the bookkeeper may already have reconciled. Asked only by the host's own accounting call, which
 * the host's message rule would otherwise apply at once: a human admin approves each one
 * (approval.ts), and no AI actor can.
 */
export const ACCOUNTING_VOID_KINDS: ReadonlySet<string> = new Set(["accounting.void"]);

/**
 * Kinds that are always reviewed, whoever submits them and whatever the policy, the floor, an
 * admin's auto-approve or the host say (ADRs 0429, 0774 and 0881).
 */
export const ALWAYS_REVIEWED_KINDS: ReadonlySet<string> = new Set([
  ...REFUND_KINDS,
  ...READER_KINDS,
  ...ACCOUNTING_VOID_KINDS,
]);

export type OutboundDecision =
  /**
   * `judgeUsage`: the outbound.message call made for it, counted in the batch that audits it once
   * applied (`auditOutboundApplied`, ADR 0234).
   */
  | { decision: "auto"; judgeUsage?: JudgeCallUsage | undefined }
  | { decision: "review"; pending: PendingApproval }
  | { decision: "deny"; reason: string };

export { OUTBOUND_OPERATION };

/** What an outbound pending action stores as its `input` (and shows in the approvals inbox). */
export interface OutboundInput {
  vendor: string;
  connectionId: string;
  connectionTitle: string;
  facetKey: string;
  resourceTitle: string;
  action: number;
  title: string;
  description: string;
  fields: { label: string; value: string; syntax?: string; truncated?: boolean }[];
  actionKind: { tag: string; label: string } | null;
  autoApprovable: boolean;
  implementsRevert: boolean;
  descriptionIsComplete: boolean;
  /** How the host checked it for consent at submit (ADR 0678); absent: not a message to people. */
  contact?: OutboundContact;
}

/** Bounds what a gatekeeper can make us store (a description is untrusted input). */
function cap(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function outboundInput(s: OutboundSubmission): OutboundInput {
  const d = s.description;
  return {
    vendor: s.vendor,
    connectionId: s.connectionId,
    connectionTitle: cap(s.connectionTitle, 200),
    facetKey: s.facetKey,
    resourceTitle: cap(s.resourceTitle, 200),
    action: s.action,
    title: cap(d.title, 300),
    description: cap(d.description, 20_000),
    fields: (d.fields ?? []).slice(0, 50).map((f) => ({
      label: cap(f.label, 200),
      // A list field (`To`) keeps one value per line.
      value: cap(f.value ?? (Array.isArray(f.items) ? f.items.join("\n") : ""), 50_000),
      ...(f.syntax ? { syntax: cap(f.syntax, 20) } : {}),
      // The gatekeeper cut the list: counting what is shown would undercount (ADR 0345).
      ...(f.truncated ? { truncated: true } : {}),
    })),
    actionKind: d.actionKind
      ? { tag: cap(d.actionKind.tag, 100), label: cap(d.actionKind.label, 200) }
      : null,
    autoApprovable: d.autoApprovable === true,
    implementsRevert: d.implementsRevert === true,
    descriptionIsComplete: d.descriptionIsComplete === true,
    ...(s.contact ? { contact: s.contact } : {}),
  };
}

/** Records a kind the first time it is seen (and widens auto_approvable when the author did). */
function upsertKind(db: CrmDb, input: OutboundInput, now: string): Compilable | null {
  if (!input.actionKind) return null;
  return db.query
    .insertInto("core_outbound_kind")
    .values({
      tag: input.actionKind.tag,
      vendor: input.vendor,
      label: input.actionKind.label,
      auto_approvable: input.autoApprovable ? 1 : 0,
      auto_approve: 0,
      first_seen_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column("tag").doUpdateSet((eb) => ({
        auto_approvable: eb.fn("max", [
          eb.ref("core_outbound_kind.auto_approvable"),
          eb.ref("excluded.auto_approvable"),
        ]),
      })),
    );
}

function auditRow(
  db: CrmDb,
  s: OutboundSubmission,
  input: OutboundInput,
  now: string,
  gate: GateDecision,
  outcome: "ok" | "review" | "denied" | "error",
  extra: { pendingActionId?: string; error?: { code: string; message: string } } = {},
): Compilable {
  return db.query.insertInto("core_audit").values({
    id: newId("audit"),
    at: now,
    operation: OUTBOUND_OPERATION,
    risk: "outbound",
    actor: s.actor,
    user_id: s.user.id,
    origin: JSON.stringify(originSchema.parse(s.origin)),
    // The description is what a person reviews; its field values may be long, so the audit row
    // keeps the title, kind and target only.
    input: JSON.stringify({
      vendor: input.vendor,
      connectionId: input.connectionId,
      facetKey: input.facetKey,
      action: input.action,
      actionKind: input.actionKind?.tag ?? null,
      title: input.title,
    }),
    result: null,
    gate_decision: gate,
    outcome,
    error: extra.error ? JSON.stringify(extra.error) : null,
    pending_action_id: extra.pendingActionId ?? null,
  });
}

/** Pending actions that create any of these provisional ids (the outbound item depends on them). */
async function creatorsOf(db: CrmDb, provisional: readonly string[], now: string) {
  if (!provisional.length) return [];
  const rows = await db.query
    .selectFrom("core_pending_action")
    .select(["id", "provisional"])
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .execute();
  return rows.filter((r) => provisional.some((id) => r.provisional.includes(id))).map((r) => r.id);
}

/**
 * Decides one submitted gatekeeper action. `auto`: the host applies it now (and audits the
 * outcome with `auditOutboundApplied`). `review`: it is now a pending action in the caller's
 * change set. `deny`: the host rejects it on the facet.
 */
export async function submitOutbound(db: CrmDb, s: OutboundSubmission): Promise<OutboundDecision> {
  const now = s.now ?? new Date().toISOString();
  const input = outboundInput(s);
  const policy = await loadApprovalPolicy(db.query);
  // Routine mail (ADR 0590): the host decided it, and the gatekeeper confirmed its shape.
  const routine =
    s.routineMail?.routine === true &&
    input.actionKind !== null &&
    ROUTINE_MAIL_KINDS.has(input.actionKind.tag);
  const kind = input.actionKind
    ? await db.query
        .selectFrom("core_outbound_kind")
        .select(["auto_approve", "auto_approvable"])
        .where("tag", "=", input.actionKind.tag)
        .executeTakeFirst()
    : undefined;
  const gate = evaluateGate(
    {
      actor: s.actor,
      risk: "outbound",
      outbound: {
        autoApprovable: input.autoApprovable,
        enabled: kind?.auto_approve === 1 && kind.auto_approvable === 1,
        routine,
      },
    },
    policy,
    s.floor,
  );
  const kindRow = upsertKind(db, input, now);
  // A description that mentions a record still pending creation can never apply before it.
  const provisional = findProvisionalIds([input.title, input.description, input.fields]);
  let decision = gate.decision;
  // The host's own message (a confirmation) is not a person's or an agent's: only the floor's
  // deny stops it.
  if (s.hostMessage && decision !== "deny") decision = "auto";
  if (decision === "auto" && provisional.length) decision = "review";
  // An agent's email or post always waits for the person, whatever the policy (ADR 0344).
  if (decision === "auto" && s.origin.jobId) decision = "review";
  // Routine mail the host held (over the daily cap, a value not routine, an AI's change no person
  // approved), or that the gatekeeper did not confirm: a person decides, whatever the preset.
  // A pack whose routine email is not turned on yet (D1) sends as before: the policy decides.
  if (decision === "auto" && s.routineMail && !routine && !s.routineMail.ordinary) {
    decision = "review";
  }

  // outbound.message (ADR 0238): a message an AI actor wrote is read before it leaves. A finding,
  // or no answer, turns an automatic send into a review; Jev never lets one through.
  let check: OutboundCheck | null = null;
  let judgeUsage: JudgeCallUsage | undefined;
  // Routine mail's words are the shipped pack's declaration, not an AI's: not read here.
  if (decision !== "deny" && s.judge && !routine && textFromAi(s.actor, s.origin)) {
    const checked = await checkOutbound({
      judge: s.judge,
      db: db.query,
      outbound: input,
      asked: s.asked,
      now,
    });
    if (checked.status !== "off") {
      const hold = decision === "auto" && holdsForReview(checked);
      if (hold) decision = "review";
      check = { ...checked.check, turnedToReview: hold };
      judgeUsage = checked.usage;
    }
  }
  // Whatever said otherwise above, a refund, a card reader's change and a void of an entry in the
  // books wait for a person.
  if (decision === "auto" && input.actionKind && ALWAYS_REVIEWED_KINDS.has(input.actionKind.tag)) {
    decision = "review";
  }

  if (decision === "deny") {
    await db.batch([
      ...(kindRow ? [kindRow] : []),
      auditRow(db, s, input, now, "deny", "denied", {
        error: { code: "denied", message: "The approval policy does not allow this action" },
      }),
    ]);
    return { decision: "deny", reason: "The approval policy does not allow this action" };
  }
  if (decision === "auto") {
    if (kindRow) await db.batch([kindRow]);
    return { decision: "auto", ...(judgeUsage ? { judgeUsage } : {}) };
  }

  const dependsOn = await creatorsOf(db, provisional, now);
  const changeSet = await targetChangeSet({
    db,
    origin: s.origin,
    user: s.user,
    actor: s.actor,
    now,
  });
  const actionId = newId("pendingAction");
  const expiresAt = addDays(now, s.expiryDays ?? DEFAULT_APPROVAL_EXPIRY_DAYS);
  const referenced = findIds([input.title, input.description, input.fields]).slice(0, 40);
  const statements: Compilable[] = [
    ...(kindRow ? [kindRow] : []),
    ...changeSet.statements,
    db.query.insertInto("core_pending_action").values({
      id: actionId,
      change_set_id: changeSet.id,
      operation: OUTBOUND_OPERATION,
      risk: "outbound",
      input: JSON.stringify(input),
      reason: s.reason?.trim() || "No reason given",
      actor: s.actor,
      user_id: s.user.id,
      origin: JSON.stringify(s.origin),
      granted_permissions: null,
      bulk_size: 1,
      preview: "[]",
      simulated: JSON.stringify({ output: null, records: [] }),
      provisional: "[]",
      depends_on: JSON.stringify(dependsOn),
      status: "pending",
      created_at: now,
      expires_at: expiresAt,
      connection_id: s.connectionId,
      facet_key: s.facetKey,
      gk_action: s.action,
      action_kind: input.actionKind?.tag ?? null,
      outbound_check: check ? JSON.stringify(check) : null,
    }),
    auditRow(db, s, input, now, "review", "review", { pendingActionId: actionId }),
    // The judge's spend (ADR 0234), in the batch that writes the pending action.
    ...(judgeUsage ? [judgeUsageStatement(db.query, OUTBOUND_PLACEMENT, judgeUsage, now)] : []),
  ];
  // Record badges: the CRM records the action mentions.
  for (let i = 0; i < referenced.length; i += 20) {
    statements.push(
      db.query.insertInto("core_pending_action_records").values(
        referenced.slice(i, i + 20).map((id) => ({
          action_id: actionId,
          object_type: objectFromPrefix(id),
          record_id: id,
          action: "reference",
        })),
      ),
    );
  }
  await db.batch(statements);
  return {
    decision: "review",
    pending: {
      status: "pending_approval",
      changeSetId: changeSet.id,
      actionId,
      operation: OUTBOUND_OPERATION,
      provisionalIds: [],
      dependsOn,
      expiresAt,
      simulated: null,
      message:
        `Queued for approval, NOT done yet: "${input.title}" (${input.actionKind?.label ?? input.vendor}) ` +
        `is pending action ${actionId} in change set ${changeSet.id}. A person must approve it in ` +
        `the CRM's Approvals inbox. Until then the ${input.connectionTitle} connection simulates it ` +
        "for its users. Tell the user it is waiting for approval.",
    },
  };
}

const PREFIX_OBJECTS: Record<string, string> = {
  per: "person",
  org: "organisation",
  act: "activity",
  tsk: "task",
  rec: "record",
};

function objectFromPrefix(id: string): string {
  return PREFIX_OBJECTS[id.slice(0, id.indexOf("_"))] ?? "unknown";
}

/** Audits an auto-approved outbound action once the host has applied it (or failed to). */
export async function auditOutboundApplied(
  db: CrmDb,
  s: OutboundSubmission,
  outcome: { ok: true } | { ok: false; message: string },
  /** The outbound.message call `submitOutbound` made for it, counted here (ADR 0234). */
  judgeUsage?: JudgeCallUsage,
): Promise<void> {
  const now = s.now ?? new Date().toISOString();
  const input = outboundInput(s);
  await db.batch([
    ...(judgeUsage ? [judgeUsageStatement(db.query, OUTBOUND_PLACEMENT, judgeUsage, now)] : []),
    auditRow(
      db,
      s,
      input,
      now,
      "auto",
      outcome.ok ? "ok" : "error",
      outcome.ok ? {} : { error: { code: "outbound_failed", message: outcome.message } },
    ),
  ]);
}

/** Audits the application of an approved outbound item (gate `review`, linked to the action). */
export function outboundAppliedAudit(
  db: CrmDb,
  row: { id: string; actor: Actor; user_id: string; origin: string; input: string },
  now: string,
  outcome: { ok: true } | { ok: false; message: string },
): Compilable {
  let parsed: Partial<OutboundInput> = {};
  try {
    parsed = JSON.parse(row.input) as Partial<OutboundInput>;
  } catch {
    parsed = {};
  }
  return db.query.insertInto("core_audit").values({
    id: newId("audit"),
    at: now,
    operation: OUTBOUND_OPERATION,
    risk: "outbound",
    actor: row.actor,
    user_id: row.user_id,
    origin: row.origin,
    input: JSON.stringify({
      vendor: parsed.vendor ?? null,
      connectionId: parsed.connectionId ?? null,
      facetKey: parsed.facetKey ?? null,
      action: parsed.action ?? null,
      actionKind: parsed.actionKind?.tag ?? null,
      title: parsed.title ?? null,
    }),
    result: null,
    gate_decision: "review",
    outcome: outcome.ok ? "ok" : "error",
    error: outcome.ok
      ? null
      : JSON.stringify({ code: "outbound_failed", message: outcome.message }),
    pending_action_id: row.id,
  });
}

/** Outbound pending actions on one facet, still pending, queued before `action`. */
export async function earlierPendingOnFacet(
  db: CrmDb,
  item: { connectionId: string; facetKey: string; action: number },
  now: string,
): Promise<{ id: string; gk_action: number | null }[]> {
  return db.query
    .selectFrom("core_pending_action")
    .select(["id", "gk_action"])
    .where("connection_id", "=", item.connectionId)
    .where("facet_key", "=", item.facetKey)
    .where("gk_action", "<", item.action)
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .execute();
}

/** Pending outbound items per connection (the "simulated" badge on org connections). */
export async function pendingOutboundCounts(
  db: CrmDb,
  connectionIds: readonly string[],
  now: string,
): Promise<Map<string, number>> {
  if (!connectionIds.length) return new Map();
  const rows = await db.query
    .selectFrom("core_pending_action")
    .select(["connection_id", (eb) => eb.fn.countAll<number>().as("n")])
    .where("connection_id", "in", jsonList([...connectionIds]))
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .groupBy("connection_id")
    .execute();
  return new Map(rows.map((r) => [r.connection_id ?? "", Number(r.n)]));
}
