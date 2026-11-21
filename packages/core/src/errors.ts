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

/** Too many calls for this token in the current window. */
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

export class ConfigError extends OperationError {
  override name = "ConfigError";
  constructor(message: string) {
    super("config", message);
  }
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
  const unique = /UNIQUE constraint failed: ([\w.]+(?:, [\w.]+)*)/.exec(message);
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
