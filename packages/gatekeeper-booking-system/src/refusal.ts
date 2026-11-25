// How a booking-system gatekeeper says why a read was refused (stage 65, ADR 0920). RPC carries an
// error's message and not its class, so the reason travels as a tag at the start of the message;
// the host reads it back with `refusalCode`. Nothing is ever written, so a refusal only says
// whether to try again, wait for the budget, or tell an admin the connection no longer reaches
// the site.

import type { BookingSystemRefusalCode } from "./types.js";

export const REFUSAL_CODES: readonly BookingSystemRefusalCode[] = [
  "unauthorised",
  "not_activated",
  "rate_limited",
  "over_budget",
  "unavailable",
  "invalid",
];

/** The codes the host retries with backoff. */
export const TRANSIENT_REFUSALS: readonly BookingSystemRefusalCode[] = [
  "rate_limited",
  "unavailable",
];

/** The codes that mark the connection expired (`credentialsChanged`): the key or the site's grant. */
export const EXPIRING_REFUSALS: readonly BookingSystemRefusalCode[] = [
  "unauthorised",
  "not_activated",
];

const TAG = /\[booking-system:([a-z_]+)\] /;

/** An error whose message starts with the refusal's tag. */
export function refuse(code: BookingSystemRefusalCode, message: string): Error {
  return new Error(`[booking-system:${code}] ${message}`);
}

/**
 * The refusal code an error's message carries, wherever the tag is in it (RPC or the host may put
 * their own text in front), or `null` when it carries none.
 */
export function refusalCode(message: unknown): BookingSystemRefusalCode | null {
  const text = message instanceof Error ? message.message : String(message ?? "");
  const match = TAG.exec(text);
  const code = match?.[1] as BookingSystemRefusalCode | undefined;
  return code && REFUSAL_CODES.includes(code) ? code : null;
}
