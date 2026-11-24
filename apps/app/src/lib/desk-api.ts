// The tablet's calls on the desk origin (stage 44 step 6, ADR 0649): POST /api/desk/<call>, its
// cookies sent by the browser (the device credential, the session token: HttpOnly, never read
// here). Failures are the client's errors, so the Agree block's words read them as anywhere else.
import { ApiError, NetworkError } from "@composable-os/client";

/** How long a call waits before the tablet says it cannot reach the business. */
const TIMEOUT_MS = 10_000;

export async function deskCall<T>(name: string, input: unknown = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/desk/${name}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new NetworkError("The business could not be reached", error);
  }
  let body: { data?: T; error?: { code: string; message: string; details?: unknown } };
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    throw new NetworkError("The business's answer could not be read", error);
  }
  if (!response.ok || body.error) {
    const error = body.error ?? { code: "internal", message: "That did not go through" };
    throw new ApiError(error.code, error.message, response.status, error.details);
  }
  return body.data as T;
}

/** The rule a desk refusal names (`desk_code`, `desk_session_ended`, …), if any. */
export function deskRule(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const rule = (error.details as { rule?: unknown } | undefined)?.rule;
  return typeof rule === "string" ? rule : null;
}
