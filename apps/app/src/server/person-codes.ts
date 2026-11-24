// The keys of people's check-in codes and PINs (stage 51 step 3, ADR 0783), derived from the
// host's auth secret. One set per secret per isolate: deriving them costs a few HKDF calls.
import { type PersonCodeKeys, personCodeKeys } from "@composable-os/core";

let cached: { secret: string; keys: PersonCodeKeys } | undefined;

/** The keys for this env, or undefined when the auth secret is not set (codes are then refused). */
export function personCodeKeysFor(env: {
  BETTER_AUTH_SECRET?: string;
}): PersonCodeKeys | undefined {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) return undefined;
  if (cached?.secret !== secret) cached = { secret, keys: personCodeKeys(secret) };
  return cached.keys;
}

/** `{ personCodes }` for an invocation context, or nothing. */
export function personCodeKeysEntry(env: { BETTER_AUTH_SECRET?: string }): {
  personCodes?: PersonCodeKeys;
} {
  const keys = personCodeKeysFor(env);
  return keys ? { personCodes: keys } : {};
}
