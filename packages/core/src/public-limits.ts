// The rate limit per client address on every operation open to the public (ADR 0940).
//
// The pipeline counts each call from outside the org (a customer, a practitioner or the public;
// never an enrolled device) to an operation whose audiences include `public`, before its input is
// parsed or any work is done. The store is the Workers Rate Limiting binding (rate-limit.ts, ADR
// 0091): one in-memory count per Cloudflare location, no D1 statement, a fixed 60-second window.
// Each tier is one binding, declared in apps/app/wrangler.jsonc and apps/runner/wrangler.jsonc with
// the same namespace, so the two Workers share counts:
//
//   standard  PUBLIC_RATE_LIMIT         120 a minute per address and operation (reads)
//   low       PUBLIC_WRITE_RATE_LIMIT    30 a minute per address and operation (writes)
//   strict    PUBLIC_STRICT_RATE_LIMIT   10 a minute per address and group (starts, codes, stops)
//   shared    PUBLIC_SHARED_RATE_LIMIT 1200 a minute per client app and group, for a bound Worker
//                                        that passes no visitor address (an older template)
//
// The pipeline never sees an address: the adapter gives it a key (`addressKey` in
// @composable-os/auth, a keyed SHA-256 of the address's bucket, an IPv6 address's /64).
import { RateLimitedError } from "./errors.ts";
import type { RiskClass } from "./principals.ts";
import type { RateLimitBinding } from "./rate-limit.ts";

/** How tightly an operation open to the public is limited per client address. */
export type PublicLimitTier = "standard" | "low" | "strict";

export const PUBLIC_LIMIT_TIERS: readonly PublicLimitTier[] = ["standard", "low", "strict"];

/** An operation's limit per client address (ADR 0940). */
export interface PublicLimit {
  tier: PublicLimitTier;
  /**
   * Operations that share one count per address (`order.start` and `order.startHeld`; the code
   * checks). Default: the operation's own name.
   */
  group?: string;
  /**
   * Counted on a pack tool's own calls too, not only at the door (always so on the strict tier):
   * for an operation reached only through a tool (`toolOnly`: `intake.open`).
   */
  inTools?: true;
  /**
   * The operation checks a code someone could guess (guesses.ts): it is given `ctx.guesses`, which
   * refuses once this address gave 20 wrong codes in the hour, in this group (`code`: discount.check,
   * order.applyCode, and order.start, order.startHeld and order.quote when a code is given). Core
   * `hostInternal` operations only.
   */
  guesses?: string;
}

/** The limit of an operation open to the public that declares none, by its risk class. */
export const PUBLIC_LIMIT_DEFAULTS: Readonly<Partial<Record<RiskClass, PublicLimit>>> = {
  read: { tier: "standard" },
  write: { tier: "low" },
};

/** How many calls a tier allows per window (the bindings' `simple.limit`, for the docs and tests). */
export const PUBLIC_LIMIT_PER_MINUTE: Readonly<Record<PublicLimitTier | "shared", number>> = {
  standard: 120,
  low: 30,
  strict: 10,
  shared: 1200,
};

/** The bindings, one per tier, and the shared bucket's. A missing one is the store being down. */
export interface PublicLimitBindings {
  standard?: RateLimitBinding | undefined;
  low?: RateLimitBinding | undefined;
  strict?: RateLimitBinding | undefined;
  shared?: RateLimitBinding | undefined;
}

/** The env names of the bindings, as the app's and the runner's wrangler.jsonc declare them. */
export interface PublicLimitEnv {
  PUBLIC_RATE_LIMIT?: RateLimitBinding;
  PUBLIC_WRITE_RATE_LIMIT?: RateLimitBinding;
  PUBLIC_STRICT_RATE_LIMIT?: RateLimitBinding;
  PUBLIC_SHARED_RATE_LIMIT?: RateLimitBinding;
}

/** The bindings from a Worker's env. */
export function publicLimitBindings(env: PublicLimitEnv): PublicLimitBindings {
  return {
    standard: env.PUBLIC_RATE_LIMIT,
    low: env.PUBLIC_WRITE_RATE_LIMIT,
    strict: env.PUBLIC_STRICT_RATE_LIMIT,
    shared: env.PUBLIC_SHARED_RATE_LIMIT,
  };
}

/**
 * Who a call is counted as: a keyed hash of the client's address (never the address), or, when a
 * client app's Worker passed none, one shared bucket for that client app (`shared`).
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

/**
 * The limit an operation open to the public is counted against: its own declaration, or its
 * risk class's default. Null for an operation not open to the public (nothing to count here) and
 * for one open to it with no limit at all, which the pipeline refuses and a registry test forbids.
 */
export function publicLimitOf(op: LimitedOperation): PublicLimit | null {
  if (!op.audiences?.includes("public")) return null;
  return op.publicLimit ?? PUBLIC_LIMIT_DEFAULTS[op.risk] ?? null;
}

/** Whether an operation open to the public has a limit it is counted against. */
export function hasPublicLimit(op: LimitedOperation): boolean {
  return !op.audiences?.includes("public") || publicLimitOf(op) !== null;
}

/**
 * Whether a call is refused when its limit cannot be counted (the binding throws, or a deploy left
 * it out): every write, and every strict operation (code checks, order starts). A read on the
 * standard or low tier is allowed: being unable to count must not take a shop's pages down.
 */
export function closesWhenDown(op: LimitedOperation, limit: PublicLimit): boolean {
  return limit.tier === "strict" || op.risk !== "read";
}

const RETRY_SECONDS = 60;
let warned = false;

/** One refusal for every reason, the same whatever the call asked about. */
function tooMany(): never {
  throw new RateLimitedError(`Too many calls; retry in ${RETRY_SECONDS}s`, {
    retryAfterSeconds: RETRY_SECONDS,
    rule: "client_address",
  });
}

/**
 * Counts one call against its operation's limit per client address, or refuses it with
 * `rate_limited` (HTTP 429, `Retry-After`). `bindings` absent: the adapter keeps no limiter (a
 * test, a script), and nothing is counted. `inTool`: the call is a pack tool's own; only a strict
 * operation (or one declaring `inTools`) is counted there, so a guess or an order start made
 * through a tool shares the one count per address, and the tool's other calls stay part of the
 * call that started it.
 */
export async function checkPublicLimit(
  bindings: PublicLimitBindings | undefined,
  address: ClientAddress | undefined,
  op: LimitedOperation,
  { inTool = false }: { inTool?: boolean } = {},
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
  if (inTool && limit.tier !== "strict" && !limit.inTools) return;
  const who = address ?? UNKNOWN_ADDRESS;
  const binding = who.shared ? bindings.shared : bindings[limit.tier];
  const key = `public:${who.shared ? "app" : "addr"}:${who.key}:${limit.group ?? op.name}`;
  let success: boolean;
  try {
    if (!binding) throw new Error("rate limit binding missing");
    ({ success } = await binding.limit({ key }));
  } catch (error) {
    if (closesWhenDown(op, limit)) {
      throw new RateLimitedError("This cannot be done just now: try again shortly", {
        retryAfterSeconds: RETRY_SECONDS,
        rule: "limit_unavailable",
      });
    }
    if (!warned) {
      warned = true;
      console.warn("public rate limit unavailable: reads are allowed", String(error));
    }
    return;
  }
  if (!success) tooMany();
}
