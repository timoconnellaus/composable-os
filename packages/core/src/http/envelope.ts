// The HTTP surface's one envelope (stage 23, ADR 0403, ADR 0415). A success is `{ "data": … }`
// with status 200. A failure is `{ "error": { "code", "message", "details"? } }` with the
// existing error codes and the `details` operations already return, and a status chosen from
// the code. A queued staff write is `pending_approval` with status 202.
import { type OperationError, type OperationErrorCode, toOperationError } from "../errors.ts";
import { errorForLog } from "../log.ts";

/** What one call sends back: a status and a JSON body, as stored for an idempotency key. */
export interface HttpReply {
  status: number;
  body: string;
}

const STATUS: Record<OperationErrorCode, number> = {
  unknown_operation: 404,
  invalid_input: 400,
  invalid_output: 500,
  forbidden: 403,
  denied: 403,
  pending_approval: 202,
  second_step_required: 403,
  rate_limited: 429,
  plan_limit: 402,
  not_found: 404,
  conflict: 409,
  config: 503,
  timeout: 504,
  extension_error: 502,
  integration_error: 502,
  internal: 500,
};

export function statusOf(error: OperationError): number {
  const override = (error.details as { httpStatus?: unknown } | undefined)?.httpStatus;
  return typeof override === "number" ? override : STATUS[error.code];
}

export function dataReply(data: unknown): HttpReply {
  return { status: 200, body: JSON.stringify({ data: data ?? null }) };
}

/**
 * The envelope for a failure. `outside` is true for a customer's or the public's call: the
 * pipeline has already cleaned its errors (ADR 0412), and anything raised before it that is not
 * an operation error goes out as its code alone. A staff call's internal errors keep their
 * message and lose their details, as the server functions do.
 */
export function errorReply(error: unknown, outside: boolean): HttpReply {
  const typed = toOperationError(error);
  const status = statusOf(typed);
  let body: { code: OperationErrorCode; message: string; details?: unknown };
  if (typed.code === "internal" || typed.code === "config" || typed.code === "invalid_output") {
    console.error("http call failed", errorForLog(error));
    body = { code: typed.code, message: outside ? "Internal error" : typed.message };
  } else {
    const details = withoutStatus(typed.details);
    body = {
      code: typed.code,
      message: typed.message,
      ...(details === undefined ? {} : { details }),
    };
  }
  return { status, body: JSON.stringify({ error: body }) };
}

/** An error's details without the status the surface chose from them. */
function withoutStatus(details: unknown): unknown {
  if (!details || typeof details !== "object" || !("httpStatus" in details)) return details;
  const { httpStatus: _status, ...rest } = details as Record<string, unknown>;
  return rest;
}

/** The headers a rate-limited reply carries, so a client knows when to retry. */
export function retryAfter(reply: HttpReply): Record<string, string> {
  if (reply.status !== 429 && reply.status !== 409) return {};
  try {
    const seconds = (
      JSON.parse(reply.body) as { error?: { details?: { retryAfterSeconds?: unknown } } }
    ).error?.details?.retryAfterSeconds;
    return typeof seconds === "number" ? { "retry-after": String(seconds) } : {};
  } catch {
    return {};
  }
}
