// The rate limit per client address on operations open to the public (ADR 0940): every one has a
// limit (the registry walk, shipped packs' tools included), the named ones their tighter ones, and
// the pipeline counts a call before any work: over the limit it is refused with the same answer
// whatever was asked, and changes nothing; another address is not affected; a customer is counted
// per address too; a strict operation is counted inside a pack's tool; and when the store is down a
// read passes and a strict operation or a write does not.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type AnyOperation,
  type ClientAddress,
  checkPublicLimit,
  coreRegistry,
  guessCounter,
  invokeByName,
  memoryRateLimit,
  type OutsideInvocationContext,
  PUBLIC_LIMIT_DEFAULTS,
  type PublicLimit,
  type PublicLimitBindings,
  publicLimitOf,
  purgeWrongGuesses,
  type RateLimitBinding,
  stopToken,
  WRONG_GUESSES_PER_HOUR,
} from "../src/index.ts";
import { context, createUser, db, refusal, unique } from "./helpers.ts";
import { releasePackTools } from "./release-packs.ts";

const PUBLIC = { kind: "public" } as const;

/** Every operation a host of this release can serve: core and every carried pack's tools. */
const everything: AnyOperation[] = [...coreRegistry.list(), ...releasePackTools];
const openToPublic = everything.filter((op) => op.audiences?.includes("public"));

/** The operations given a tighter limit than their risk class's default (ADR 0940). */
const DECLARED: Record<string, PublicLimit> = {
  "order.start": { tier: "strict", group: "order.start", guesses: "code" },
  "order.startHeld": { tier: "strict", group: "order.start", guesses: "code" },
  "order.quote": { tier: "low", guesses: "code" },
  "discount.check": { tier: "strict", group: "code", guesses: "code" },
  "order.applyCode": { tier: "strict", group: "code", guesses: "code" },
  "contact.stop": { tier: "strict" },
  "intake.submit": { tier: "strict" },
  "intake.open": { tier: "low", inTools: true },
};

/** Operations open to the public with no limit to count them against. */
function unlimited(operations: readonly AnyOperation[]): string[] {
  return operations
    .filter((op) => op.audiences?.includes("public") && publicLimitOf(op) === null)
    .map((op) => op.name);
}

describe("every operation open to the public has a limit (the registry walk)", () => {
  it("core operations and every shipped pack's tools", () => {
    expect(openToPublic.length).toBeGreaterThan(30);
    expect(openToPublic.some((op) => op.name.startsWith("x."))).toBe(true);
    expect(
      unlimited(everything),
      "An operation open to the public has no limit per client address: give it a publicLimit, " +
        "or a default for its risk class in PUBLIC_LIMIT_DEFAULTS (ADR 0940).",
    ).toEqual([]);
  });

  it("names an operation whose risk class has no default", () => {
    const bare = { name: "fixture.bare", risk: "bulk-write", audiences: ["public"] } as const;
    expect(unlimited([bare as unknown as AnyOperation])).toEqual(["fixture.bare"]);
  });

  it("the guessable and costly ones keep their tighter limits", () => {
    for (const [name, limit] of Object.entries(DECLARED)) {
      const op = coreRegistry.get(name);
      expect(op, name).toBeDefined();
      expect(publicLimitOf(op as AnyOperation), name).toEqual(limit);
    }
  });

  it("the defaults are standard for a read and low for a write", () => {
    expect(PUBLIC_LIMIT_DEFAULTS).toEqual({ read: { tier: "standard" }, write: { tier: "low" } });
  });
});

/** In-memory bindings, one per tier, exact per key (rate-limit.ts). */
function bindings(limits: { strict?: number; low?: number; standard?: number; shared?: number }) {
  return {
    standard: memoryRateLimit(limits.standard ?? 120),
    low: memoryRateLimit(limits.low ?? 30),
    strict: memoryRateLimit(limits.strict ?? 10),
    shared: memoryRateLimit(limits.shared ?? 1200),
  };
}

const at = (key: string): ClientAddress => ({ key, shared: false });

const outside = (
  limits: PublicLimitBindings,
  address: ClientAddress | undefined,
  principal: OutsideInvocationContext["principal"] = PUBLIC,
): OutsideInvocationContext => ({
  principal,
  db,
  publicLimits: limits,
  ...(address ? { clientAddress: address } : {}),
});

let admin: ActingUser;
beforeAll(async () => {
  admin = await createUser("admin");
});

async function stopFor(): Promise<{ person: string; token: string }> {
  const person = (await invokeByName(
    "person.create",
    { givenName: unique("Stop") },
    context(admin),
  )) as { id: string };
  const token = (await stopToken(db.query, {
    person: person.id,
    channel: "email",
    scope: "follow_up",
  })) as string;
  return { person: person.id, token };
}

const choices = async (person: string) =>
  (
    await env.DB.prepare("SELECT count(*) AS n FROM core_contact_choice WHERE person_id = ?")
      .bind(person)
      .first<{ n: number }>()
  )?.n ?? 0;

describe("the pipeline counts each public call per client address", () => {
  it("the 11th contact.stop in a minute from one address is refused; another address is not", async () => {
    const limits = bindings({});
    const a = at(unique("addr"));
    for (let n = 0; n < 10; n += 1) {
      await invokeByName("contact.stop", { token: "not-a-token" }, outside(limits, a));
    }
    const refused = await refusal(
      invokeByName("contact.stop", { token: "not-a-token" }, outside(limits, a)),
    );
    expect(refused).toMatchObject({
      code: "rate_limited",
      details: { retryAfterSeconds: 60, rule: "client_address" },
    });
    expect(
      await invokeByName("contact.stop", { token: "not-a-token" }, outside(limits, at("other"))),
    ).toEqual({ done: true });
  });

  it("a refused call changes nothing, and is answered the same whatever it asked about", async () => {
    const limits = bindings({ strict: 0 });
    const a = at(unique("addr"));
    const real = await stopFor();
    const before = await choices(real.person);
    const audited = async () =>
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM core_audit WHERE operation = 'contact.stop'",
        ).first<{ n: number }>()
      )?.n ?? 0;
    const auditedBefore = await audited();
    const pendingBefore = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_pending_action",
    ).first<{
      n: number;
    }>();
    const good = await refusal(
      invokeByName("contact.stop", { token: real.token }, outside(limits, a)),
    );
    const bad = await refusal(
      invokeByName("contact.stop", { token: "made-up" }, outside(limits, a)),
    );
    expect(good).toMatchObject({ code: "rate_limited" });
    expect({ code: good.code, message: good.message, details: good.details }).toEqual({
      code: bad.code,
      message: bad.message,
      details: bad.details,
    });
    // The stop was not made, nothing was audited and nothing queued.
    expect(await choices(real.person)).toBe(before);
    expect(await audited()).toBe(auditedBefore);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM core_pending_action").first<{ n: number }>(),
    ).toEqual(pendingBefore);
    // Unlimited, the same token stops: so the refusal above is what held it back.
    await invokeByName("contact.stop", { token: real.token }, outside(bindings({}), a));
    expect(await choices(real.person)).toBe(before + 1);
  });

  it("a signed-in customer is counted per address too, in the same count as the public", async () => {
    const limits = bindings({ strict: 2 });
    const a = at(unique("addr"));
    const customer = {
      kind: "customer" as const,
      customerId: unique("cus_"),
      personId: unique("per_"),
    };
    await invokeByName("contact.stop", { token: "x" }, outside(limits, a));
    await invokeByName("contact.stop", { token: "x" }, outside(limits, a, customer));
    expect(
      await refusal(invokeByName("contact.stop", { token: "x" }, outside(limits, a, customer))),
    ).toMatchObject({ code: "rate_limited" });
  });

  it("an operation not open to the public is not counted here", async () => {
    const limits = bindings({ standard: 0, low: 0, strict: 0, shared: 0 });
    const customer = {
      kind: "customer" as const,
      customerId: unique("cus_"),
      personId: unique("per_"),
    };
    // me.get is open to customers only: the per-account limit is its, not this one.
    const error = await refusal(invokeByName("me.get", {}, outside(limits, at("a"), customer)));
    expect(error.code).not.toBe("rate_limited");
  });

  it("with no address the call is counted in the shared bucket, never unlimited", async () => {
    const limits = bindings({ shared: 1 });
    await invokeByName("contact.stop", { token: "x" }, outside(limits, undefined));
    expect(
      await refusal(invokeByName("contact.stop", { token: "x" }, outside(limits, undefined))),
    ).toMatchObject({ code: "rate_limited" });
    expect(limits.shared.hits("public:app:unknown:contact.stop")).toBe(2);
    expect(limits.strict.hits("public:app:unknown:contact.stop")).toBe(0);
  });
});

const throwing: RateLimitBinding = {
  async limit() {
    throw new Error("the store is down");
  },
};

describe("when the store is down", () => {
  it("a public read passes; a strict operation and a write are refused", async () => {
    const down = { standard: throwing, low: throwing, strict: throwing, shared: throwing };
    // stock.get is a read: it passes the limiter (and fails on its empty input after it).
    const read = await refusal(invokeByName("stock.get", {}, outside(down, at("a"))));
    expect(read.code).toBe("invalid_input");
    const strict = await refusal(
      invokeByName("contact.stop", { token: "x" }, outside(down, at("a"))),
    );
    expect(strict).toMatchObject({ code: "rate_limited", details: { rule: "limit_unavailable" } });
    // A deploy that left the bindings out is the store being down.
    const missing = await refusal(
      invokeByName("contact.stop", { token: "x" }, outside({}, at("a"))),
    );
    expect(missing).toMatchObject({ code: "rate_limited", details: { rule: "limit_unavailable" } });
    const write = { name: "x.shop.buy", risk: "write", audiences: ["public"] } as const;
    await expect(checkPublicLimit({}, at("a"), write)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("an adapter that keeps no limiter counts nothing (a test, a script)", async () => {
    for (let n = 0; n < 15; n += 1) {
      await invokeByName("contact.stop", { token: "x" }, { principal: PUBLIC, db });
    }
  });
});

describe("inside a pack's tool", () => {
  const strict = { name: "order.startHeld", risk: "write", audiences: ["public"] } as const;
  const read = { name: "public.list", risk: "read", audiences: ["public"] } as const;

  it("a strict operation is counted again; a read is part of the call that started the tool", async () => {
    const limits = bindings({ strict: 1, standard: 0 });
    await checkPublicLimit(limits, at("t"), read, { inTool: true });
    expect(limits.standard.hits("public:addr:t:public.list")).toBe(0);
    const startHeld = { ...strict, publicLimit: { tier: "strict", group: "order.start" } } as const;
    await checkPublicLimit(limits, at("t"), startHeld, { inTool: true });
    await expect(
      checkPublicLimit(limits, at("t"), startHeld, { inTool: true }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    // order.start shares the group's count.
    const start = { ...startHeld, name: "order.start" };
    await expect(checkPublicLimit(limits, at("t"), start)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("an operation declaring inTools is counted there too", async () => {
    const limits = bindings({ low: 0 });
    const open = {
      name: "intake.open",
      risk: "read",
      audiences: ["public"],
      publicLimit: { tier: "low", inTools: true },
    } as const;
    await expect(checkPublicLimit(limits, at("t"), open, { inTool: true })).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});

describe("wrong guesses (guesses.ts)", () => {
  it("the 21st check in the hour from one address is refused, right or wrong; another address is not", async () => {
    const now = new Date().toISOString();
    const a = guessCounter(db, at(unique("guesser")), "code", now);
    for (let n = 0; n < WRONG_GUESSES_PER_HOUR; n += 1) {
      await a.check();
      await a.wrong();
    }
    await expect(a.check()).rejects.toMatchObject({
      code: "rate_limited",
      details: { rule: "client_address" },
    });
    await guessCounter(db, at(unique("buyer")), "code", now).check();
    // Another group is its own count.
    await guessCounter(db, at("guesser"), "giftCard", now).check();
  });

  it("keeps no address or key, only a hash with the hour, and the purge removes ended hours", async () => {
    const key = unique("keep");
    const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await guessCounter(db, at(key), "code", hourAgo).wrong();
    const rows = await env.DB.prepare("SELECT guess_key, window_start FROM core_wrong_guess").all<{
      guess_key: string;
      window_start: string;
    }>();
    expect(rows.results.every((row) => /^[0-9a-f]{64}$/.test(row.guess_key))).toBe(true);
    expect(rows.results.some((row) => row.guess_key.includes(key))).toBe(false);
    await purgeWrongGuesses(db, new Date());
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_wrong_guess WHERE window_start < ?",
    )
      .bind(new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
