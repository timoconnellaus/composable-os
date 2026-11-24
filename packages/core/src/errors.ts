// Typed errors every adapter (server functions now, MCP and host modules later) maps to its own
// wire format. `code` is stable and safe to show; `details` is JSON-serialisable.

export type OperationErrorCode =
  | "unknown_operation"
  | "invalid_input"
  | "invalid_output"
  | "forbidden"
  | "denied"
  | "pending_approval"
  | "second_step_required"
  | "rate_limited"
  | "plan_limit"
  | "not_found"
  | "conflict"
  | "config"
  | "timeout"
  | "extension_error"
  | "integration_error"
  | "runs_on_approval"
  | "internal";

export class OperationError extends Error {
  override name = "OperationError";
  constructor(
    readonly code: OperationErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  toJSON(): SerializedOperationError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export interface SerializedOperationError {
  code: OperationErrorCode;
  message: string;
  details?: unknown;
}

export class UnknownOperationError extends OperationError {
  override name = "UnknownOperationError";
  constructor(name: string) {
    super("unknown_operation", `No operation named "${name}"`);
  }
}

export class ValidationError extends OperationError {
  override name = "ValidationError";
  constructor(message: string, details?: unknown) {
    super("invalid_input", message, details);
  }
}

/** The caller's role or actor type may not run this operation. */
export class ForbiddenError extends OperationError {
  override name = "ForbiddenError";
  constructor(message: string, details?: unknown) {
    super("forbidden", message, details);
  }
}

/** The approval gate refused the call (policy or floor). */
export class GateDeniedError extends OperationError {
  override name = "GateDeniedError";
  constructor(message: string, details?: unknown) {
    super("denied", message, details);
  }
}

/** What a queued call returns instead of its output (ADR 0022). */
export interface PendingApproval {
  status: "pending_approval";
  changeSetId: string;
  actionId: string;
  operation: string;
  /** Provisional ids of records the action would create (`per_pending_…`). */
  provisionalIds: string[];
  /** Earlier pending actions this one depends on. */
  dependsOn: string[];
  expiresAt: string;
  /** What the output would be once applied (ids are provisional), when it can be simulated. */
  simulated: unknown;
  message: string;
}

/**
 * The gate routed the call to review: it was recorded as a pending action in a change set and
 * has NOT been applied. Adapters that can show a pending result (MCP) catch this and return
 * `details` (a PendingApproval) as the call's result; typed callers see an error.
 */
export class PendingApprovalError extends OperationError {
  override name = "PendingApprovalError";
  readonly pending: PendingApproval;
  constructor(pending: PendingApproval) {
    super("pending_approval", pending.message, pending);
    this.pending = pending;
  }
}

/**
 * A dry run (approvals/dry-run.ts) reached something it cannot simulate: another runtime (the
 * automation host, the updater, a connected app, a model, mail…) or a direct database write.
 * Nothing was done. A queued call that meets it is queued with "runs on approval" instead of a
 * preview; a simulated read that meets it fails with this.
 */
export class RunsOnApprovalError extends OperationError {
  override name = "RunsOnApprovalError";
  constructor(readonly uses: string) {
    super(
      "runs_on_approval",
      `This uses ${uses}, which a dry run does not touch: it runs only when it is approved`,
      { uses },
    );
  }
}

/** Too many calls for this token in the current window. */
/** What a buyer is told when unpaid holds are limited (ADR 0560), whatever the cause. */
export const TRY_LATER = "Too many places are being held for payment just now: try again shortly";

export class RateLimitedError extends OperationError {
  override name = "RateLimitedError";
  constructor(message: string, details?: unknown) {
    super("rate_limited", message, details);
  }
}

/**
 * The hosted plan's entitlements do not allow this (ADR 0211): one user or record too many, or
 * platform AI used up. Self-hosted deployments never see it. The message says how to upgrade.
 */
export class PlanLimitError extends OperationError {
  override name = "PlanLimitError";
  constructor(message: string, details?: unknown) {
    super("plan_limit", message, details);
  }
}

export class NotFoundError extends OperationError {
  override name = "NotFoundError";
  constructor(object: string, id: string) {
    super("not_found", `No ${object} with id ${id}`, { object, id });
  }
}

/** A uniqueness rule was broken, e.g. an email already belongs to another live person. */
export class ConflictError extends OperationError {
  override name = "ConflictError";
  constructor(message: string, details?: unknown) {
    super("conflict", message, details);
  }
}

/**
 * Applying an approved action is refused, before anything of it is applied, because a call it
 * makes would need its own approval (ADR 0022 amendment, 2026-11-22). The action stays pending.
 */
export class NeedsOwnApprovalError extends ConflictError {
  override name = "NeedsOwnApprovalError";
  constructor(operation: string, calls: string) {
    super(
      `${operation} calls ${calls}, which needs its own approval, so it cannot be applied as one ` +
        `change: nothing of it was applied. Ask for ${calls} on its own, or reject this.`,
      { needsOwnApproval: calls, operation },
    );
  }
}

export class ConfigError extends OperationError {
  override name = "ConfigError";
  constructor(message: string) {
    super("config", message);
  }
}

/**
 * The declared uniqueness rules' columns as D1 names them in a refusal (`x_<table>.<column>, ...`),
 * kept by the field registry (ADR 0502), so a declared rule is told apart from a slug or any
 * other unique index, which keep the general message.
 */
let declaredUniqueKeys: ReadonlySet<string> = new Set();

export function setDeclaredUniqueKeys(keys: ReadonlySet<string>): void {
  declaredUniqueKeys = keys;
}

/** Converts D1 constraint failures into typed errors; everything else becomes `internal`. */
export function toOperationError(error: unknown): OperationError {
  if (error instanceof OperationError) return error;
  // ai/client.ts's AiAllowanceError, matched by name so this module stays free of AI imports.
  if (error instanceof Error && error.name === "AiAllowanceError") {
    return new PlanLimitError(error.message, { reason: "platform_ai" });
  }
  const capacity = capacityRefusal(error);
  if (capacity) return capacity;
  const allowance = allowanceRefusal(error);
  if (allowance) return allowance;
  const message = error instanceof Error ? error.message : String(error);
  // An order written from a read that is no longer current (migration 0421): nothing was
  // applied, and the same call made again reads the order as it now is.
  if (message.includes("core_order_stale")) {
    return new ConflictError("The order changed while this was being applied. Try again.", {
      reason: "order_stale",
    });
  }
  // A subscription written from an older read of it (migration 0530): as for an order.
  if (message.includes("core_subscription_stale")) {
    return new ConflictError("The subscription changed while this was being applied. Try again.", {
      reason: "subscription_stale",
    });
  }
  // A second hold of one person's free trial on a plan (migration 0531, ADR 0489): another start
  // took it a moment before. Nothing of this start was recorded; starting again gives that page.
  if (message.includes("core_subscription_trial_taken")) {
    return new ConflictError(
      "A checkout with this free trial was opened at the same moment. Start again to get it.",
      { rule: "trial_held" },
    );
  }
  // A second hold of something sold once per Person (migration 0581, ADR 0512): another order for
  // it was started a moment before. Nothing of this one was recorded.
  if (message.includes("UNIQUE constraint failed: core_sellable_once")) {
    return new ConflictError(
      "This is one per person, and another order for it was started at the same moment",
      { rule: "once_per_person", reason: "held" },
    );
  }
  // Two events for one subscription granting at once (migration 0580, ADR 0510): the other one
  // granted it. Nothing of this one was applied; the provider delivers it again.
  if (message.includes("UNIQUE constraint failed: core_subscription_grant")) {
    return new ConflictError(
      "This subscription's grant was made by another event at the same moment. Try again.",
      { reason: "subscription_grant" },
    );
  }
  // A continuation offer's page held by another take a moment before, or the offer taken or
  // withdrawn meanwhile (migration 0532, ADR 0491). Nothing of this take was recorded.
  if (message.includes("core_subscription_offer_held")) {
    return new ConflictError(
      "A checkout for this offer was opened at the same moment, or the offer was taken or withdrawn. Start again.",
      { rule: "offer_held" },
    );
  }
  // A continuation offer written from an older read of it (migration 0532): another import, a
  // withdrawal or a take changed it first. Nothing of this call was applied; run it again.
  if (message.includes("core_subscription_offer_stale")) {
    return new ConflictError(
      "The offer changed while this was being done, so nothing was changed. Try again.",
      { rule: "offer_changed" },
    );
  }
  // Two imports writing one address's offer at once: the other one's is kept; run again.
  if (message.includes("UNIQUE constraint failed: core_subscription_offer")) {
    return new ConflictError(
      "Another import wrote one of these offers at the same moment. Run the import again.",
      { rule: "offer_key" },
    );
  }
  // A move judged from a position the record has since left (ADR 0437): another write moved it
  // first, and this one's history row would be a second current one. Nothing was applied.
  if (
    message.includes(
      "UNIQUE constraint failed: core_transition_history.object_type, core_transition_history.record_id",
    )
  ) {
    return new ConflictError(
      "The record was moved by another change while this one was being made, so nothing was " +
        "changed. Read it again: it may already be where you wanted it.",
      { reason: "moved_meanwhile" },
    );
  }
  // Two publishes of one record at once (ADR 0446): both took the same next number, and the
  // second one's batch failed on the version's key. Nothing of it was applied.
  if (message.includes("UNIQUE constraint failed: core_publish_version")) {
    return new ConflictError(
      "Another version of this record was published at the same moment, so this one was not. " +
        "Read its versions again before publishing.",
      { reason: "published_meanwhile" },
    );
  }
  // A batch planned from a read that changed before it committed (migration 0560's guard): a
  // series changed under a run, or a class was booked under a change to its series.
  if (message.includes("core_recurrence_stale")) {
    return new ConflictError(
      "The schedule or a booking changed while this was being done, so nothing was changed. Try again.",
      { rule: "recurring_stale" },
    );
  }
  // One staff account on two overlapping shifts (migration 0811, ADR 0621): refused by the
  // database for every writer. A write the host read as free names the other shift itself; this
  // is a race it could not see, or a write by a path that does not read first.
  if (message.includes("core_staff_double_booked")) {
    return new ConflictError(
      "This person is already on another shift at that time, so nothing was changed.",
      { rule: "double_booked" },
    );
  }
  // An offer of a shift left `open` meanwhile (migration 0812, ADR 0623): taken by someone else a
  // moment before, withdrawn, cancelled or lapsed. Of the writes racing for it exactly one landed.
  if (message.includes("core_staff_offer_closed")) {
    return new ConflictError(
      "This offer was taken, withdrawn or closed a moment before, so nothing was changed. Look again.",
      { rule: "offer_closed" },
    );
  }
  if (
    message.includes("core_staff_offer_open") ||
    message.includes("UNIQUE constraint failed: core_staff_offer")
  ) {
    return new ConflictError("This shift is already offered, so nothing was changed.", {
      rule: "offer_open",
    });
  }
  // A batch planned from a read of the roster that changed before it committed (migration 0812,
  // ADR 0624): a leaver's shifts or patterns changed meanwhile. Nothing was applied.
  if (message.includes("core_staff_changed")) {
    return new ConflictError(
      "The roster changed while this was being done, so nothing was changed. Try again.",
      { rule: "roster_changed" },
    );
  }
  if (message.includes("core_staff_offer_fixed") || message.includes("core_staff_offer_replaced")) {
    return new ConflictError("An offer is never changed or replaced, so nothing was changed.", {
      rule: "offer_fixed",
    });
  }
  // A checklist run closed (done, missed or cancelled) never changes (migration 0815, ADR 0650),
  // for any writer: its ticks, its steps and its state stay as they were. The answer names no note.
  if (message.includes("core_checklist_closed")) {
    return new ConflictError(
      "This checklist is closed (done, missed or cancelled), so nothing of it was changed.",
      { rule: "checklist_closed" },
    );
  }
  if (message.includes("core_checklist_incomplete")) {
    return new ValidationError(
      "Not every required step of this checklist is ticked, so it was not marked done.",
      { rule: "checklist_incomplete" },
    );
  }
  if (message.includes("core_checklist_note_needed")) {
    return new ValidationError(
      "This step asks for a note, so it was not ticked done without one.",
      {
        rule: "checklist_note_needed",
      },
    );
  }
  if (message.includes("core_checklist_too_many_ticks")) {
    return new ConflictError("This step has been ticked 50 times, the most one step takes.", {
      rule: "checklist_too_many_ticks",
    });
  }
  if (message.includes("core_checklist_fixed")) {
    return new ConflictError(
      "A checklist run's steps and record never change, so nothing was changed.",
      {
        rule: "checklist_fixed",
      },
    );
  }
  // A locked pay period never changes (migration 0813, ADR 0627): a shift inside one keeps its
  // person, times, kind and whether it is live; its not-worked marks and who was counted stay.
  // The answer names no period's totals.
  if (message.includes("core_pay_period_locked")) {
    return new ConflictError(
      "This is inside a locked pay period, so nothing was changed. Whoever handles pay reopens the period first.",
      { rule: "pay_period_locked" },
    );
  }
  if (
    message.includes("core_pay_period_overlap") ||
    message.includes("core_pay_period_held") ||
    message.includes("UNIQUE constraint failed: core_pay_period")
  ) {
    return new ConflictError(
      "This pay period, or one overlapping it, is already locked, so nothing was changed.",
      { rule: "pay_period_held" },
    );
  }
  if (message.includes("core_pay_period_fixed")) {
    return new ConflictError(
      "A locked pay period and its lines never change, so nothing was changed.",
      {
        rule: "pay_period_fixed",
      },
    );
  }
  // A live shift whose end is not after its start (ADR 0621), written by a path that does not
  // check first: the trigger on the staffed object's table refuses it.
  if (message.includes("core_staff_time_backwards")) {
    return new ValidationError("A shift must end after it starts, so nothing was changed.", {
      rule: "staffed_time",
    });
  }
  // A claimant took a place after it was read as holding none (ADR 0501).
  if (message.includes("core_claim_live")) {
    return new ConflictError(
      "This record took a place while it was being deleted, so it was not. Move it out first.",
      { rule: "capacity", reason: "claim_live" },
    );
  }
  // A record made for another that moved before it committed (migration 0670, ADR 0550): a
  // booking for a class cancelled meanwhile.
  if (message.includes("core_moved_meanwhile")) {
    return new ConflictError(
      "What this is for changed while it was being made (it may have been cancelled), so nothing was changed. Look again.",
      { rule: "state_closed", reason: "moved_meanwhile" },
    );
  }
  // A class carrying as many unpaid drop-in holds as it may (migration 0690, ADR 0560): the same
  // answer as a buyer over their own limit, whatever the cause.
  if (message.includes("core_holds_capped")) {
    return new RateLimitedError(TRY_LATER, { rule: "try_later" });
  }
  // A waiter joining a waitlist after a place came free (migration 0610, ADR 0520).
  if (message.includes("core_waitlist_not_full")) {
    return new ConflictError("A place came free meanwhile: claim it instead of waiting.", {
      rule: "waitlist",
      reason: "not_full",
    });
  }
  // Quotes, invoices and credit notes (migration 1030, ADR 0730): an issued document nobody
  // changes; a draft changed by someone else since it was read; a number given out of turn; a
  // series changed meanwhile; the event log, insert only.
  if (message.includes("core_document_immutable")) {
    return new ForbiddenError(
      "A sent quote, or an issued invoice or credit note, is never changed or deleted: withdraw the quote, or credit the invoice.",
      { rule: "document_immutable" },
    );
  }
  if (message.includes("core_document_stale") || message.includes("core_document_new")) {
    return new ConflictError(
      "The draft changed while you were changing it (someone else saved it). Look at it again; nothing was changed.",
      { rule: "document_changed" },
    );
  }
  if (
    message.includes("core_document_number") ||
    message.includes("core_document_counter_back") ||
    message.includes("UNIQUE constraint failed: core_quote.number_seq") ||
    message.includes("UNIQUE constraint failed: core_invoice.number_seq") ||
    message.includes("UNIQUE constraint failed: core_credit_note.number_seq")
  ) {
    return new ConflictError(
      "The numbering changed meanwhile (a number was given, or the series was changed). Look at it again; no number was used.",
      { rule: "document_numbering" },
    );
  }
  if (message.includes("core_invoice_event_immutable")) {
    return new ForbiddenError("The invoice log is never changed: rows are only added.", {
      rule: "invoice_event_immutable",
    });
  }
  // Agreement documents (migration 0850, ADR 0640): a version nobody changes; a publish of a
  // working copy changed since it was read, or of a retired document; attaching a document that
  // is not live; two publishes of the same number at once.
  if (message.includes("core_agreement_version_immutable")) {
    return new ForbiddenError("A published version of a document is never changed or deleted.", {
      rule: "agreement_version_immutable",
    });
  }
  if (
    message.includes("core_agreement_draft_changed") ||
    message.includes("UNIQUE constraint failed: core_agreement_version")
  ) {
    return new ConflictError(
      "The document changed while you were publishing it. Look at it again; nothing was published.",
      { rule: "agreement_draft_changed" },
    );
  }
  if (message.includes("core_agreement_retired") || message.includes("core_agreement_not_live")) {
    return new ConflictError("This document is not live: it cannot change there.", {
      rule: "agreement_not_live",
    });
  }
  if (
    message.includes("core_agreement_agree_from_back") ||
    message.includes("core_agreement_rev_back")
  ) {
    return new ConflictError("What is in effect moved on meanwhile. Nothing was changed.", {
      rule: "agreement_moved",
    });
  }
  // Acceptances (migration 0851, ADR 0642): what one says never changes; a batch planned from a
  // read of what is due fails when that changed before it committed (the guard's `agreements`
  // kind); the version is no longer open to agree to; a minor's own acceptance.
  if (message.includes("core_agreements_changed")) {
    return new ConflictError(
      "What must be agreed to changed while this was being done, so nothing was changed. Look again.",
      { rule: "agreements_changed" },
    );
  }
  if (message.includes("core_agreement_acceptance_immutable")) {
    return new ForbiddenError("An acceptance is never changed or deleted.", {
      rule: "agreement_acceptance_immutable",
    });
  }
  if (message.includes("core_agreement_version_not_open")) {
    return new ConflictError(
      "This is not the version in effect: read the current one and agree to that.",
      { rule: "agreement_version_replaced" },
    );
  }
  if (message.includes("core_agreement_minor_fixed") || message.includes("core_person_exists")) {
    return new ConflictError("That record already exists; it is changed in place, not replaced.", {
      rule: "no_replace",
    });
  }
  if (message.includes("core_agreement_minor_self")) {
    return new ForbiddenError("A parent or guardian agrees for you.", { rule: "agreement_minor" });
  }
  // An agreement's copy (migration 0854, ADR 0645): where it goes is the host's records', and
  // never changes once written. The message names the rule, never the address.
  if (message.includes("core_agreement_copy_address")) {
    return new ForbiddenError("A copy goes only to the address the host holds for it.", {
      rule: "agreement_copy_address",
    });
  }
  // A hold on a kept acceptance (migration 0855, ADR 0646): only on one kept after an erase.
  if (message.includes("core_agreement_hold_not_kept")) {
    return new OperationError("not_found", "No kept acceptance with that id.", {
      rule: "agreement_not_kept",
    });
  }
  if (message.includes("core_agreement_hold_fixed")) {
    return new ConflictError("That acceptance is already on hold.", { rule: "agreement_held" });
  }
  if (message.includes("core_agreement_copy_fixed")) {
    return new ConflictError("A copy's address is fixed once it is written.", {
      rule: "agreement_copy_fixed",
    });
  }
  // A guardian's write after their link ended, or the dependant went to the Trash (migration
  // 0650, ADR 0540): as if the Person were not there.
  if (message.includes("core_person_link_not_live")) {
    return new OperationError("not_found", "Not found", { object: "person" });
  }
  // A link whose other way round is live (migration 0650): never a two-way link.
  if (message.includes("core_person_link_reverse")) {
    return new ConflictError(
      "The other way round is already linked: a child cannot also be their guardian's guardian.",
      { rule: "person_link_reverse" },
    );
  }
  // Two staff linking the same pair at once (migration 0650): the other one linked them.
  if (message.includes("UNIQUE constraint failed: core_person_link")) {
    return new ConflictError("These two are already linked.", { rule: "person_link" });
  }
  // Two series runs making one date at once (migration 0560, ADR 0500): the other one made it.
  if (message.includes("UNIQUE constraint failed: core_recurrence_occurrence")) {
    return new ConflictError(
      "Another run made these records at the same moment. Nothing was changed.",
      {
        rule: "recurring_occurrence",
      },
    );
  }
  const unique = /UNIQUE constraint failed: ([\w.]+(?:, [\w.]+)*)/.exec(message);
  // A declared uniqueness rule on an extension's table (ADR 0502): another write made the same
  // record a moment before, and this one's batch failed on the rule's index.
  if (unique?.[1] && declaredUniqueKeys.has(unique[1])) {
    return new ConflictError(
      "A record like this one was made at the same moment, so this one was not",
      {
        rule: "unique",
        constraint: unique[1],
      },
    );
  }
  if (unique) {
    return new ConflictError("A record with that value already exists", {
      constraint: unique[1],
    });
  }
  if (/FOREIGN KEY constraint failed/.test(message)) {
    return new ValidationError("A referenced record does not exist");
  }
  if (/CHECK constraint failed/.test(message)) {
    return new ValidationError("A value is not allowed", { reason: message });
  }
  return new OperationError("internal", "Internal error", { reason: message });
}

// Allowance refusals (stage 32b, ADR 0493; migration 0533). A spend past a holder's uses in a
// period fails with `core_allowance_refused {json}` (reason `no_uses_left`, with the numbers), and
// a use the holder cannot pay (not the spender's Person's, not live, not valid at the spender's
// time) with the same prefix and its reason. A second open use of one spender is a conflict.

/** Why a holder could not pay for a spender. */
export type AllowanceRefusalReason =
  | "no_uses_left"
  | "spent_meanwhile"
  | "not_theirs"
  | "not_live"
  | "not_yet_valid"
  | "ended"
  | "no_holder"
  | "not_covered";

export interface AllowanceRefusalDetails {
  rule: "allowance";
  reason: AllowanceRefusalReason;
  object?: string;
  record?: string;
  period?: string;
  uses?: number;
  used?: number;
  at?: string;
}

const ALLOWANCE_REFUSED = /core_allowance_refused (\{[^{}]*\})/;

const ALLOWANCE_MESSAGES: Record<AllowanceRefusalReason, string> = {
  no_uses_left: "No uses left in this period",
  spent_meanwhile: "Another booking took the last use at the same moment. Try again",
  not_theirs: "That pass or membership is not this person's",
  not_live: "That pass or membership cannot be used now (paused, ended or void)",
  not_yet_valid: "That pass or membership is not valid yet at this time",
  ended: "That pass or membership has ended by this time",
  no_holder: "Nothing this person holds can pay for this",
  not_covered: "That pass or membership does not cover this",
};

/** The message for an allowance refusal, with the numbers when it has them. */
export function allowanceMessage(details: AllowanceRefusalDetails): string {
  const base = ALLOWANCE_MESSAGES[details.reason] ?? "The allowance refused this";
  return details.reason === "no_uses_left" && details.uses !== undefined
    ? `${base}: ${details.used ?? details.uses} of ${details.uses} spent`
    : base;
}

/** The error for a batch the allowance rule refused, or null when it failed for another reason. */
export function allowanceRefusal(error: unknown): ValidationError | ConflictError | null {
  if (error instanceof OperationError) return null;
  const message = error instanceof Error ? error.message : String(error);
  const match = ALLOWANCE_REFUSED.exec(message);
  if (match) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(match[1] as string) as Record<string, unknown>;
    } catch {
      return new ValidationError("The allowance refused this", { rule: "allowance" });
    }
    const details: AllowanceRefusalDetails = {
      rule: "allowance",
      reason: String(payload.reason) as AllowanceRefusalReason,
      ...(typeof payload.object === "string" ? { object: payload.object } : {}),
      ...(typeof payload.record === "string" ? { record: payload.record } : {}),
      ...(typeof payload.period === "string" ? { period: payload.period } : {}),
      ...(typeof payload.uses === "number" ? { uses: payload.uses } : {}),
      ...(typeof payload.used === "number" ? { used: payload.used } : {}),
      ...(typeof payload.at === "string" ? { at: payload.at } : {}),
    };
    // The host refuses a spend it can see will not fit before the batch; one the database
    // refused past the limit was raced by another spend in between: try again (ADR 0494).
    if (details.reason === "no_uses_left") {
      return new ConflictError(
        "Another booking took the last use at the same moment, so nothing was changed. Try again.",
        { ...details, reason: "spent_meanwhile" },
      );
    }
    return new ValidationError(allowanceMessage(details), { ...details });
  }
  if (message.includes("UNIQUE constraint failed: core_allowance_use.spender_type")) {
    return new ConflictError(
      "This record spent a use at the same moment in another change, so nothing was changed.",
      { rule: "allowance", reason: "spent_meanwhile" },
    );
  }
  return null;
}

// Capacity refusals (stage 26, ADR 0430; migration 0440). A claim, or a change of places, that
// would put a counter past its places fails its statement with `core_capacity_refused {json}`,
// so every batch that fails on capacity reports the numbers, whichever operation queued it,
// without a read.

/** Details of a refused claim (`invalid_input`). */
export interface CapacityRefusalDetails {
  rule: "capacity";
  object: string;
  record: string;
  asked: number;
  available: number;
}

/** Details of places refused because they are fewer than are already claimed. */
export interface CapacityPlacesDetails {
  rule: "capacity";
  object: string;
  record: string;
  places: number;
  held: number;
  taken: number;
}

interface CapacityRefusalPayload {
  object: string;
  record: string;
  places: number;
  held: number;
  taken: number;
  asked: number;
  available: number;
}

const CAPACITY_REFUSED = /core_capacity_refused (\{[^{}]*\})/;

/** The error for a batch the capacity rule refused, or null when it failed for another reason. */
export function capacityRefusal(error: unknown): ValidationError | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = CAPACITY_REFUSED.exec(message);
  if (match) {
    let payload: CapacityRefusalPayload;
    try {
      payload = JSON.parse(match[1] as string) as CapacityRefusalPayload;
    } catch {
      return new ValidationError("Not enough places", { rule: "capacity" });
    }
    if (payload.asked > 0) {
      const details: CapacityRefusalDetails = {
        rule: "capacity",
        object: payload.object,
        record: payload.record,
        asked: payload.asked,
        available: payload.available,
      };
      return new ValidationError(
        `Not enough places: asked for ${payload.asked}, ${payload.available} left`,
        details,
      );
    }
    const details: CapacityPlacesDetails = {
      rule: "capacity",
      object: payload.object,
      record: payload.record,
      places: payload.places,
      held: payload.held,
      taken: payload.taken,
    };
    return new ValidationError(
      `Places cannot be fewer than are claimed: ${payload.held} held and ${payload.taken} taken`,
      details,
    );
  }
  // The CHECK behind the trigger: reached only if the trigger is missing.
  if (message.includes("core_capacity_within_places")) {
    return new ValidationError("Not enough places", { rule: "capacity" });
  }
  return null;
}
