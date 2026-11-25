// The host's limits on calls to operations open to the public (ADR 0940).
//
// The pipeline counts each call from outside the org (a customer, a practitioner or the public;
// never an enrolled device) to an operation whose audiences include `public`, before its input is
// parsed or any work is done. Two kinds of count, both in the Workers Rate Limiting binding
// (rate-limit.ts, ADR 0091: in memory per Cloudflare location, no D1 statement, 60-second windows):
//
// - Per client address, for floods only, set high: many people share one address (a venue's wifi
//   at an on-sale, a gym's network, a carrier's NAT). Counted once per outside call, at the door.
//     read    PUBLIC_RATE_LIMIT         600 a minute per address and operation
//     write   PUBLIC_WRITE_RATE_LIMIT   120 a minute per address and operation
//     asset   PUBLIC_ASSET_RATE_LIMIT  1200 a minute per address and operation (pictures, video)
//     shared  PUBLIC_SHARED_RATE_LIMIT 6000 a minute per client app and operation, for a bound
//                                           Worker that names no visitor (an older template)
// - Per caller, tight, on what is costly or guessable (`perCaller`): a signed-in customer's
//   account; a guest by the order (or personal link) the call names; at the door and inside a
//   pack's tool alike (cos-runner binds it in the same namespace).
//     caller  PUBLIC_CALLER_RATE_LIMIT   10 a minute per caller and group
//   A guest naming nothing (a new order's start, a code checked before any order) has no caller
//   count: only the per-address flood count holds them.
//
// When a binding is missing or throws, calls go through (ADR 0091's fail-open): a deploy that
// left one out must not take checkout down. Each such call is logged (at most once a minute per
// isolate), the admins are told once a day, and the status page shows it. Wrong promo codes are
// counted in D1 (guesses.ts), which holds whatever the binding does.
//
// The pipeline never sees an address: the adapter gives it a key (`addressKey` in
// @composable-os/auth, an HMAC of the address's bucket, an IPv6 address's /64).
import { sha256Hex } from "./digest.ts";
import { RateLimitedError } from "./errors.ts";
import type { RiskClass } from "./principals.ts";
import type { RateLimitBinding } from "./rate-limit.ts";

/** The per-address flood tier an operation open to the public is counted on. */
export type PublicLimitTier = "read" | "write" | "asset";

export const PUBLIC_LIMIT_TIERS: readonly PublicLimitTier[] = ["read", "write", "asset"];

/** An operation's limits for calls from outside the org (ADR 0940). */
export interface PublicLimit {
  /** The per-address flood tier. */
  tier: PublicLimitTier;
  /**
   * `invalid`: the per-address count holds only what the handler reports refused (`ctx.refused`),
   * not every call: `contact.stop`, whose one-click calls come from a mail provider's few servers,
   * counts only tokens that are not valid.
   */
  addressCounts?: "invalid";
  /**
   * Limited tightly per caller (the `caller` tier): a signed-in customer's (or practitioner's)
   * account; a guest by the input field `by` names (an order's `id`, a personal link's `link`),
   * when the call gives one. A guest naming nothing is counted per address only.
   */
  perCaller?: { by?: string };
  /** Operations that share one per-caller count (and one wrong-code identity). Default: its name. */
  group?: string;
  /**
   * The operation checks a code someone could guess (guesses.ts): it is given `ctx.guesses`, which
   * counts wrong codes per caller in this group (`code`: discount.check, order.applyCode, and
   * order.start, order.startHeld and order.quote when a code is given). Core `hostInternal` only.
   */
  guesses?: string;
}

/** The limit of an operation open to the public that declares none, by its risk class. */
export const PUBLIC_LIMIT_DEFAULTS: Readonly<Partial<Record<RiskClass, PublicLimit>>> = {
  read: { tier: "read" },
  write: { tier: "write" },
};

/** How many calls each binding allows a minute (its `simple.limit`, for the docs and tests). */
export const PUBLIC_LIMIT_PER_MINUTE: Readonly<
  Record<PublicLimitTier | "shared" | "caller", number>
> = {
  read: 600,
  write: 120,
  asset: 1200,
  shared: 6000,
  caller: 10,
};

/** The bindings. A missing one is the store being down: calls go through, and it is reported. */
export interface PublicLimitBindings {
  read?: RateLimitBinding | undefined;
  write?: RateLimitBinding | undefined;
  asset?: RateLimitBinding | undefined;
  shared?: RateLimitBinding | undefined;
  caller?: RateLimitBinding | undefined;
  /** Host-wide, only while wrong codes are over the hour's ceiling (guesses.ts). */
  codeSurge?: RateLimitBinding | undefined;
}

/** The env names of the bindings, as the app's and the runner's wrangler.jsonc declare them. */
export interface PublicLimitEnv {
  PUBLIC_RATE_LIMIT?: RateLimitBinding;
  PUBLIC_WRITE_RATE_LIMIT?: RateLimitBinding;
  PUBLIC_ASSET_RATE_LIMIT?: RateLimitBinding;
  PUBLIC_SHARED_RATE_LIMIT?: RateLimitBinding;
  PUBLIC_CALLER_RATE_LIMIT?: RateLimitBinding;
  PUBLIC_CODE_SURGE_RATE_LIMIT?: RateLimitBinding;
}

/** The binding names, for the status page's line. */
export const PUBLIC_LIMIT_BINDING_NAMES = [
  "PUBLIC_RATE_LIMIT",
  "PUBLIC_WRITE_RATE_LIMIT",
  "PUBLIC_ASSET_RATE_LIMIT",
  "PUBLIC_SHARED_RATE_LIMIT",
  "PUBLIC_CALLER_RATE_LIMIT",
  "PUBLIC_CODE_SURGE_RATE_LIMIT",
] as const;

/** The bindings from a Worker's env. */
export function publicLimitBindings(env: PublicLimitEnv): PublicLimitBindings {
  return {
    read: env.PUBLIC_RATE_LIMIT,
    write: env.PUBLIC_WRITE_RATE_LIMIT,
    asset: env.PUBLIC_ASSET_RATE_LIMIT,
    shared: env.PUBLIC_SHARED_RATE_LIMIT,
    caller: env.PUBLIC_CALLER_RATE_LIMIT,
    codeSurge: env.PUBLIC_CODE_SURGE_RATE_LIMIT,
  };
}

/**
 * Who a call is counted as: a keyed hash of the client's address (never the address), or, when a
 * client app's Worker named none, one shared bucket for that client app (`shared`).
 */
export interface ClientAddress {
  key: string;
  shared: boolean;
}

/** A call no adapter gave an address for: one shared bucket, never unlimited. */
export const UNKNOWN_ADDRESS: ClientAddress = Object.freeze({ key: "unknown", shared: true });

interface LimitedOperation {
  name: string;
  risk: RiskClass;
  audiences?: readonly string[] | undefined;
  publicLimit?: PublicLimit | undefined;
}

/** Who is calling, as far as the per-caller count needs. */
export type LimitedCaller =
  | { kind: "public" }
  | { kind: "customer"; customerId: string }
  | { kind: "practitioner"; practitionerId: string };

/**
 * The limit an operation open to the public is counted against: its own declaration, or its
 * risk class's default. Null for an operation not open to the public (nothing to count here) and
 * for one open to it with no limit at all, which the pipeline refuses and a registry test forbids.
 */
export function publicLimitOf(op: LimitedOperation): PublicLimit | null {
  if (!op.audiences?.includes("public")) return null;
  return op.publicLimit ?? PUBLIC_LIMIT_DEFAULTS[op.risk] ?? null;
}

/**
 * The value of the field a guest's call is identified by (`perCaller.by`), from the raw input, or
 * null: a string of a sane length only. Read before the input is parsed, for the count only.
 */
export function guestHandle(by: string | undefined, rawInput: unknown): string | null {
  if (!by || rawInput === null || typeof rawInput !== "object") return null;
  const value = (rawInput as Record<string, unknown>)[by];
  return typeof value === "string" && value.length > 0 && value.length <= 400 ? value : null;
}

/**
 * Who a call is counted as per caller: an account, or a guest's order or link (hashed), or null
 * when nothing identifies them.
 */
export async function callerKeyOf(
  caller: LimitedCaller,
  limit: PublicLimit,
  rawInput: unknown,
): Promise<string | null> {
  if (caller.kind === "customer") return `acct:${caller.customerId}`;
  if (caller.kind === "practitioner") return `prac:${caller.practitionerId}`;
  const handle = guestHandle(limit.perCaller?.by, rawInput);
  return handle
    ? `guest:${(await sha256Hex(`${limit.perCaller?.by}\n${handle}`)).slice(0, 32)}`
    : null;
}

const RETRY_SECONDS = 60;
const LOG_EVERY_MS = 60_000;
let loggedAt = 0;

/** The dedupe key prefix of the admins' daily notice that the limits are down (the status page reads it). */
export const PUBLIC_LIMIT_DOWN_NOTICE = "public_limit.down:";

/** What the pipeline is told when a count could not be made (the call went through). */
export type LimiterDown = (what: string) => void;

/** Logs a count that could not be made, at most once a minute per isolate. */
function reportDown(what: string, error: unknown, onDown: LimiterDown | undefined): void {
  const now = Date.now();
  if (now - loggedAt >= LOG_EVERY_MS) {
    loggedAt = now;
    console.error(
      "public rate limit unavailable: calls are going through unlimited (ADR 0940)",
      what,
      String((error as Error)?.message ?? error),
    );
  }
  onDown?.(what);
}

/** One refusal for every reason, the same whatever the call asked about. */
function tooMany(): never {
  throw new RateLimitedError(`Too many calls; retry in ${RETRY_SECONDS}s`, {
    retryAfterSeconds: RETRY_SECONDS,
    rule: "rate_limited",
  });
}

/** Counts one hit; over the limit, refused; the binding missing or failing, allowed and reported. */
export async function countHit(
  binding: RateLimitBinding | undefined,
  key: string,
  what: string,
  onDown?: LimiterDown,
): Promise<void> {
  let success: boolean;
  try {
    if (!binding) throw new Error(`${what}: rate limit binding missing`);
    ({ success } = await binding.limit({ key }));
  } catch (error) {
    reportDown(what, error, onDown);
    return;
  }
  if (!success) tooMany();
}

/** The per-address key of an operation's flood count. */
export function addressCountKey(who: ClientAddress, op: { name: string }): string {
  return `public:${who.shared ? "app" : "addr"}:${who.key}:${op.name}`;
}

/** The binding an operation's per-address count goes to. */
export function addressBinding(
  bindings: PublicLimitBindings,
  who: ClientAddress,
  limit: PublicLimit,
): RateLimitBinding | undefined {
  return who.shared ? bindings.shared : bindings[limit.tier];
}

/**
 * Counts one call from outside the org against its operation's limits, or refuses it with
 * `rate_limited` (HTTP 429, `Retry-After`). `bindings` absent: the adapter keeps no limiter (a
 * test, a script), and nothing is counted. `inTool`: the call is a pack tool's own; only the
 * per-caller count is made there (the tool's door call was counted per address already).
 */
export async function checkPublicLimit(
  bindings: PublicLimitBindings | undefined,
  address: ClientAddress | undefined,
  op: LimitedOperation,
  caller: LimitedCaller,
  rawInput: unknown,
  { inTool = false, onDown }: { inTool?: boolean; onDown?: LimiterDown } = {},
): Promise<void> {
  if (!bindings) return;
  if (!op.audiences?.includes("public")) return;
  const limit = publicLimitOf(op);
  if (!limit) {
    // The registry test forbids this; refused rather than counted as nothing.
    throw new RateLimitedError(`${op.name} has no limit for calls from outside`, {
      rule: "no_limit",
    });
  }
  const who = address ?? UNKNOWN_ADDRESS;
  if (!inTool && limit.addressCounts !== "invalid") {
    await countHit(addressBinding(bindings, who, limit), addressCountKey(who, op), op.name, onDown);
  }
  if (limit.perCaller) {
    const key = await callerKeyOf(caller, limit, rawInput);
    if (key) {
      await countHit(bindings.caller, `caller:${key}:${limit.group ?? op.name}`, op.name, onDown);
    }
  }
}
