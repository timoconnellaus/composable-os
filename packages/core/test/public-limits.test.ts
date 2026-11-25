// The limits on calls to operations open to the public (ADR 0940): every one has a limit (the
// registry walk, shipped packs' tools included), the named ones their declared ones; per client
// address for floods, set high, and per caller (an account, a guest's order) on what is costly or
// guessable; a refusal is the same answer whatever was asked; contact.stop counts only tokens that
// are not valid; a pack tool's calls are counted per caller only; when the store is down calls go
// through and it is reported; and wrong promo codes are counted per caller, reserved before the
// lookup, locked for 15 minutes past 20, never on a shared bucket, with a host-wide ceiling.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ActingUser,
  type AnyOperation,
  type ClientAddress,
  CODE_LOCK_MS,
  checkPublicLimit,
  coreRegistry,
  type GuessCaller,
  guessCounter,
  HOST_WRONG_CODES_PER_HOUR,
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
  WRONG_CODES_PER_ADDRESS,
  WRONG_CODES_PER_CALLER,
} from "../src/index.ts";
import { context, createUser, db, refusal, unique } from "./helpers.ts";
import { releasePackTools } from "./release-packs.ts";

const PUBLIC = { kind: "public" } as const;

/** Every operation a host of this release can serve: core and every carried pack's tools. */
const everything: AnyOperation[] = [...coreRegistry.list(), ...releasePackTools];
const openToPublic = everything.filter((op) => op.audiences?.includes("public"));

/** The operations declaring their own limits (ADR 0940). */
const DECLARED: Record<string, PublicLimit> = {
  "order.start": { tier: "write", perCaller: {}, group: "order.start", guesses: "code" },
  "order.startHeld": { tier: "write", perCaller: {}, group: "order.start", guesses: "code" },
  "order.checkout": { tier: "write", perCaller: { by: "id" }, group: "order.checkout" },
  "subscription.start": { tier: "write", perCaller: {}, group: "subscription.start" },
  "order.quote": { tier: "read", guesses: "code" },
  "discount.check": { tier: "read", perCaller: {}, group: "code", guesses: "code" },
  "order.applyCode": { tier: "write", perCaller: { by: "id" }, group: "code", guesses: "code" },
  "contact.stop": { tier: "write", addressCounts: "invalid" },
  "intake.submit": { tier: "write", perCaller: { by: "link" }, group: "intake.submit" },
  "media.serve": { tier: "asset" },
  "media.play": { tier: "asset" },
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
      "An operation open to the public has no limit: give it a publicLimit, or a default for its " +
        "risk class in PUBLIC_LIMIT_DEFAULTS (ADR 0940).",
    ).toEqual([]);
  });

  it("names an operation whose risk class has no default", () => {
    const bare = { name: "fixture.bare", risk: "bulk-write", audiences: ["public"] } as const;
    expect(unlimited([bare as unknown as AnyOperation])).toEqual(["fixture.bare"]);
  });

  it("the costly and guessable ones keep their declared limits", () => {
    for (const [name, limit] of Object.entries(DECLARED)) {
      const op = coreRegistry.get(name);
      expect(op, name).toBeDefined();
      expect(publicLimitOf(op as AnyOperation), name).toEqual(limit);
    }
  });

  it("the defaults are the flood tiers: read for a read, write for a write", () => {
    expect(PUBLIC_LIMIT_DEFAULTS).toEqual({ read: { tier: "read" }, write: { tier: "write" } });
  });
});

/** In-memory bindings, exact per key (rate-limit.ts). */
function bindings(limits: Partial<Record<keyof PublicLimitBindings, number>> = {}) {
  return {
    read: memoryRateLimit(limits.read ?? 600),
    write: memoryRateLimit(limits.write ?? 120),
    asset: memoryRateLimit(limits.asset ?? 1200),
    shared: memoryRateLimit(limits.shared ?? 6000),
    caller: memoryRateLimit(limits.caller ?? 10),
    codeSurge: memoryRateLimit(limits.codeSurge ?? 30),
  };
}

const at = (key: string): ClientAddress => ({ key, shared: false });
const customer = () => ({
  kind: "customer" as const,
  customerId: unique("cus_"),
  personId: unique("per_"),
});

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

describe("per client address: floods only", () => {
  it("a public read past its limit is refused with 429's shape; another address is not", async () => {
    const limits = bindings({ read: 2 });
    const a = at(unique("addr"));
    for (let n = 0; n < 2; n += 1) {
      expect((await refusal(invokeByName("stock.get", {}, outside(limits, a)))).code).toBe(
        "invalid_input",
      );
    }
    expect(await refusal(invokeByName("stock.get", {}, outside(limits, a)))).toMatchObject({
      code: "rate_limited",
      details: { retryAfterSeconds: 60, rule: "rate_limited" },
    });
    expect((await refusal(invokeByName("stock.get", {}, outside(limits, at("b"))))).code).toBe(
      "invalid_input",
    );
  });

  it("a signed-in customer is counted per address too, in the same count as the public", async () => {
    const limits = bindings({ read: 2 });
    const a = at(unique("addr"));
    await refusal(invokeByName("stock.get", {}, outside(limits, a)));
    await refusal(invokeByName("stock.get", {}, outside(limits, a, customer())));
    expect(
      await refusal(invokeByName("stock.get", {}, outside(limits, a, customer()))),
    ).toMatchObject({ code: "rate_limited" });
  });

  it("an operation not open to the public is not counted here", async () => {
    const limits = bindings({ read: 0, write: 0, asset: 0, shared: 0, caller: 0 });
    const error = await refusal(invokeByName("me.get", {}, outside(limits, at("a"), customer())));
    expect(error.code).not.toBe("rate_limited");
  });

  it("with no address the call is counted in the shared bucket, never unlimited", async () => {
    const limits = bindings({ shared: 1 });
    await refusal(invokeByName("stock.get", {}, outside(limits, undefined)));
    expect(await refusal(invokeByName("stock.get", {}, outside(limits, undefined)))).toMatchObject({
      code: "rate_limited",
    });
    expect(limits.shared.hits("public:app:unknown:stock.get")).toBe(2);
    expect(limits.read.hits("public:app:unknown:stock.get")).toBe(0);
  });
});

describe("contact.stop: only tokens that are not valid count (review of PR #459, M1)", () => {
  it("a mail provider's server sending many valid stops is never refused", async () => {
    const limits = bindings({ write: 1 });
    const server = at(unique("mail-server"));
    for (let n = 0; n < 5; n += 1) {
      const real = await stopFor();
      const before = await choices(real.person);
      expect(
        await invokeByName("contact.stop", { token: real.token }, outside(limits, server)),
      ).toEqual({ done: true });
      expect(await choices(real.person)).toBe(before + 1);
    }
  });

  it("tokens that are not valid count per address, and past the flood level are refused", async () => {
    const limits = bindings({ write: 2 });
    const a = at(unique("addr"));
    await invokeByName("contact.stop", { token: "made-up-1" }, outside(limits, a));
    await invokeByName("contact.stop", { token: "made-up-2" }, outside(limits, a));
    expect(
      await refusal(invokeByName("contact.stop", { token: "made-up-3" }, outside(limits, a))),
    ).toMatchObject({ code: "rate_limited" });
    // A valid token from that address still stops.
    const real = await stopFor();
    await invokeByName("contact.stop", { token: real.token }, outside(limits, a));
    expect(await choices(real.person)).toBe(1);
  });
});

describe("per caller: the tight limits", () => {
  const start = { name: "order.start", risk: "write", audiences: ["public"] } as const;
  const startLimit = {
    ...start,
    publicLimit: { tier: "write", perCaller: {}, group: "order.start" },
  } as const;
  const checkout = {
    name: "order.checkout",
    risk: "write",
    audiences: ["public"],
    publicLimit: { tier: "write", perCaller: { by: "id" }, group: "order.checkout" },
  } as const;

  it("a signed-in customer by account, whatever address they come from", async () => {
    const limits = bindings({ caller: 2 });
    const who = { kind: "customer" as const, customerId: unique("cus_") };
    await checkPublicLimit(limits, at("home"), startLimit, who, {});
    await checkPublicLimit(limits, at("work"), startLimit, who, {});
    await expect(checkPublicLimit(limits, at("cafe"), startLimit, who, {})).rejects.toMatchObject({
      code: "rate_limited",
    });
    // Another member on the same network is not affected.
    const other = { kind: "customer" as const, customerId: unique("cus_") };
    await checkPublicLimit(limits, at("home"), startLimit, other, {});
  });

  it("a guest by the order the call names; a guest naming nothing only per address", async () => {
    const limits = bindings({ caller: 1, write: 1000 });
    const wifi = at(unique("venue-wifi"));
    await checkPublicLimit(limits, wifi, checkout, PUBLIC, { id: "ord_a" });
    await expect(
      checkPublicLimit(limits, wifi, checkout, PUBLIC, { id: "ord_a" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    // Another guest's order on the same wifi is not affected.
    await checkPublicLimit(limits, wifi, checkout, PUBLIC, { id: "ord_b" });
    // 200 guests starting orders on one wifi: no caller count, only the address's flood level.
    for (let n = 0; n < 200; n += 1) await checkPublicLimit(limits, wifi, startLimit, PUBLIC, {});
  });

  it("inside a pack's tool only the per-caller count is made", async () => {
    const limits = bindings({ caller: 1, write: 0, read: 0 });
    const read = { name: "public.list", risk: "read", audiences: ["public"] } as const;
    await checkPublicLimit(limits, at("t"), read, PUBLIC, {}, { inTool: true });
    const who = { kind: "customer" as const, customerId: unique("cus_") };
    await checkPublicLimit(limits, at("t"), startLimit, who, {}, { inTool: true });
    await expect(
      checkPublicLimit(limits, at("t"), startLimit, who, {}, { inTool: true }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("an order start past the per-account limit is refused before anything is written", async () => {
    const limits = bindings({ caller: 0 });
    const before = await env.DB.prepare("SELECT count(*) AS n FROM core_order").first<{
      n: number;
    }>();
    const error = await refusal(
      invokeByName("order.start", { lines: [] }, outside(limits, at("a"), customer())),
    );
    expect(error.code).toBe("rate_limited");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM core_order").first()).toEqual(before);
  });
});

const throwing: RateLimitBinding = {
  async limit() {
    throw new Error("the store is down");
  },
};

describe("when the limiter is unavailable, calls go through and it is reported (M4)", () => {
  it("every tier passes; the error is logged and the pipeline told", async () => {
    const down = {
      read: throwing,
      write: throwing,
      asset: throwing,
      shared: throwing,
      caller: throwing,
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const told: string[] = [];
    const startLimit = {
      name: "order.start",
      risk: "write",
      audiences: ["public"],
      publicLimit: { tier: "write", perCaller: {}, group: "order.start" },
    } as const;
    const who = { kind: "customer" as const, customerId: unique("cus_") };
    await checkPublicLimit(down, at("a"), startLimit, who, {}, { onDown: (w) => told.push(w) });
    // A deploy that left the bindings out is the store being down, the same way.
    await checkPublicLimit({}, at("a"), startLimit, who, {}, { onDown: (w) => told.push(w) });
    expect(told).toEqual(["order.start", "order.start", "order.start", "order.start"]);
    expect((await refusal(invokeByName("stock.get", {}, outside(down, at("a"))))).code).toBe(
      "invalid_input",
    );
    error.mockRestore();
  });

  it("an adapter that keeps no limiter counts nothing (a test, a script)", async () => {
    for (let n = 0; n < 15; n += 1) {
      await invokeByName("contact.stop", { token: "x" }, { principal: PUBLIC, db });
    }
  });
});

describe("wrong promo codes (guesses.ts)", () => {
  const now = () => new Date().toISOString();
  const asCustomer = (): GuessCaller => ({
    caller: { kind: "customer", customerId: unique("cus_") },
    address: at("shared-gym-wifi"),
    order: null,
  });

  it("after 20 wrong, that account is refused codes, right or wrong; another account is not", async () => {
    const who = asCustomer();
    const counter = () => guessCounter(db, who, "code", now());
    for (let n = 0; n < WRONG_CODES_PER_CALLER; n += 1) {
      const c = counter();
      await c.check();
      await c.wrong();
    }
    const locked = await refusal(counter().check());
    expect(locked).toMatchObject({ code: "rate_limited", details: { rule: "rate_limited" } });
    expect((locked.details as { retryAfterSeconds: number }).retryAfterSeconds).toBe(
      CODE_LOCK_MS / 1000,
    );
    // Another member on the same wifi is not affected.
    await guessCounter(db, asCustomer(), "code", now()).check();
  });

  it("a guest by their order; a guest naming none by address, at 50; a shared bucket never", async () => {
    const wifi = at(unique("wifi"));
    const order = (id: string) =>
      guessCounter(db, { caller: PUBLIC, address: wifi, order: id }, "code", now());
    for (let n = 0; n < WRONG_CODES_PER_CALLER; n += 1) {
      const c = order("ord_1");
      await c.check();
      await c.wrong();
    }
    await expect(order("ord_1").check()).rejects.toMatchObject({ code: "rate_limited" });
    await order("ord_2").check();
    const plain = () =>
      guessCounter(db, { caller: PUBLIC, address: wifi, order: null }, "code", now());
    for (let n = 0; n < WRONG_CODES_PER_ADDRESS; n += 1) {
      const c = plain();
      await c.check();
      await c.wrong();
    }
    await expect(plain().check()).rejects.toMatchObject({ code: "rate_limited" });
    const shared = () =>
      guessCounter(
        db,
        { caller: PUBLIC, address: { key: "client-app", shared: true }, order: null },
        "code",
        now(),
      );
    for (let n = 0; n < WRONG_CODES_PER_ADDRESS + 10; n += 1) {
      const c = shared();
      await c.check();
    }
  });

  it("a right code gives its reservation back", async () => {
    const who = asCustomer();
    for (let n = 0; n < WRONG_CODES_PER_CALLER + 10; n += 1) {
      const c = guessCounter(db, who, "code", now());
      await c.check();
      await c.right();
    }
    await guessCounter(db, who, "code", now()).check();
  });

  it("parallel guesses cannot overshoot: a guess is reserved before the lookup (F1)", async () => {
    const who = asCustomer();
    for (let n = 0; n < WRONG_CODES_PER_CALLER - 1; n += 1) {
      const c = guessCounter(db, who, "code", now());
      await c.check();
      await c.wrong();
    }
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () => guessCounter(db, who, "code", now()).check()),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("past the host-wide ceiling, code checks pass a short host-wide rate; admins are told", async () => {
    const group = unique("ceiling");
    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO core_wrong_guess (guess_key, window_start, wrong) VALUES (?, ?, ?)",
    )
      .bind(`host\n${group}\n${hour}`, hour, HOST_WRONG_CODES_PER_HOUR - 1)
      .run();
    const surge = memoryRateLimit(1);
    const someone = asCustomer();
    const c = guessCounter(db, someone, group, now(), { surge });
    await c.check();
    await c.wrong();
    const notice = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE dedupe_key = ?",
    )
      .bind(`public_limit.code_ceiling:${hour}`)
      .first<{ n: number }>();
    expect(notice?.n).toBeGreaterThan(0);
    await guessCounter(db, asCustomer(), group, now(), { surge }).check();
    expect(
      await refusal(guessCounter(db, asCustomer(), group, now(), { surge }).check()),
    ).toMatchObject({ code: "rate_limited", details: { retryAfterSeconds: 10 } });
  });

  it("keeps no address or account, only hashes; the purge removes every ended row", async () => {
    const key = unique("keep");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    for (let n = 0; n < 3; n += 1) {
      await guessCounter(
        db,
        { caller: PUBLIC, address: at(`${key}${n}`), order: null },
        "code",
        old,
      ).check();
    }
    const rows = await env.DB.prepare("SELECT guess_key FROM core_wrong_guess").all<{
      guess_key: string;
    }>();
    expect(rows.results.some((row) => row.guess_key.includes(key))).toBe(false);
    const { deleted } = await purgeWrongGuesses(db, new Date(), { chunk: 1 });
    expect(deleted).toBeGreaterThanOrEqual(3);
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_wrong_guess WHERE window_start < ? AND (locked_until IS NULL OR locked_until < ?)",
    )
      .bind(new Date(Date.now() - 60 * 60 * 1000).toISOString(), new Date().toISOString())
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
