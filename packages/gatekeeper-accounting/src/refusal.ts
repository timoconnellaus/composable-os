// How an accounting gatekeeper says why a write was refused (stage 61, ADR 0880). RPC carries an
// error's message and not its class, so the reason travels as a tag at the start of the message;
// the host's outbox reads it back with `refusalCode`. A refusal means nothing was written. Any
// other failure after the system was reached is an `ActionOutcomeUnknownError`: the host then
// looks the reference up before anything is sent again.

import { ActionApplyError } from "@composable-os/gatekeeper-kit/actions";
import type { AccountingRefusalCode } from "./types.js";

export const REFUSAL_CODES: readonly AccountingRefusalCode[] = [
  "unmapped",
  "locked_period",
  "invalid",
  "duplicate_number",
  "contact_archived",
  "rate_limited",
  "unavailable",
];

/** The codes the host retries with backoff; every other one holds the entry for a person. */
export const TRANSIENT_REFUSALS: readonly AccountingRefusalCode[] = ["rate_limited", "unavailable"];

const TAG = /\[accounting:([a-z_]+)\] /;

/** An `ActionApplyError` whose message starts with the refusal's tag. */
export function refuse(code: AccountingRefusalCode, message: string): ActionApplyError {
  return new ActionApplyError(`[accounting:${code}] ${message}`);
}

/**
 * The refusal code an error's message carries, wherever the tag is in it (the host's queue puts
 * its own outcome tag in front), or `null` when it carries none.
 */
export function refusalCode(message: unknown): AccountingRefusalCode | null {
  const text = message instanceof Error ? message.message : String(message ?? "");
  const match = TAG.exec(text);
  const code = match?.[1] as AccountingRefusalCode | undefined;
  return code && REFUSAL_CODES.includes(code) ? code : null;
}
