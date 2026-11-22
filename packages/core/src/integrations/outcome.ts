// What came of an outbound action applied at once, read from the gatekeeper's error (stage 32b
// review). RPC between Workers carries an error's message but not its class, so a gatekeeper that
// tells the outcome puts a tag in front of its message, `[apply-outcome:<outcome>] `
// (packages/gatekeeper-payments/src/worker.ts, `APPLY_OUTCOME_TAG`, the same text):
//   refused     nothing changed (the kit's ActionApplyError)
//   unknown     it may have taken effect (ActionOutcomeUnknownError)
//   retryable   any other failure: the action is pending again and nothing was sent
// A message with no tag (another gatekeeper) is unknown: nothing says it did not happen.

export type ApplyOutcome = "refused" | "unknown" | "retryable";

const TAG = /^\[apply-outcome:(refused|unknown|retryable)\] /;

/** The outcome a failed apply's message carries, and the message without its tag. */
export function parseApplyOutcome(message: string): { outcome: ApplyOutcome; message: string } {
  const match = TAG.exec(message);
  if (!match) return { outcome: "unknown", message };
  return { outcome: match[1] as ApplyOutcome, message: message.slice(match[0].length) };
}
