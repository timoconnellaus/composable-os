// What a failed call raises (ADR 0418): the surface's envelope as an error, with its code,
// message, details and HTTP status. `upgrade_required` is its own type, so an app can show an
// "update the app" screen; a network failure is `NetworkError`.

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    /** The surface's code: `invalid_input`, `unknown_operation`, `rate_limited`, … */
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** The host no longer serves the version this app was built against: update the app. */
export class UpgradeRequiredError extends ApiError {
  override name = "UpgradeRequiredError";
  constructor(message: string, details?: unknown) {
    super("upgrade_required", message, 426, details);
  }
}

/** The request did not reach the host, or no answer came back. Safe to retry with the same key. */
export class NetworkError extends Error {
  override name = "NetworkError";
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Whether a failure is worth retrying with the same idempotency key. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (error instanceof ApiError) {
    return (
      error.status === 429 ||
      error.status === 503 ||
      error.status === 504 ||
      (error.status === 409 &&
        (error.details as { reason?: unknown } | undefined)?.reason === "idempotency_key_in_flight")
    );
  }
  return false;
}
