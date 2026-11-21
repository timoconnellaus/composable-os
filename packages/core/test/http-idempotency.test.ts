// Stage 23, acceptance criterion 3: idempotency keys on the HTTP surface (ADR 0416). The same key
// and input, sent twice and sent twice at once, runs the handler once and returns the same
// response; a different input with the same key is refused; a write with no key is refused.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { objectTableOf } from "../src/extensions/schema.ts";
import {
  type ActingUser,
  type AnyInvocationContext,
  CLAIM_STALE_MS,
  coreRegistry,
  createInvoker,
  createRegistry,
  defineOperation,
  inputHash,
  purgeIdempotencyKeys,
  runIdempotent,
} from "../src/index.ts";
import {
  type Customer,
  createCustomer,
  fixtureOperations,
  installShop,
  ORDER,
  outside,
  PUBLIC,
  REQUEST,
} from "./customer-fixtures.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import { opRequest, surfaceOver } from "./http-helpers.ts";

/** How many times each counted handler ran. */
const runs = new Map<string, number>();
const ran = (text: string) => runs.get(text) ?? 0;

/** A customer's write that counts its handler's runs, and creates a request record each run. */
const countedCreate = defineOperation({
  name: "fixture.countedCreate",
  description: "Fixture: creates a request for the caller, counting how often its handler ran.",
  input: z.object({ text: z.string().min(1).max(200) }),
  output: z.object({ id: z.string(), run: z.number() }),
  permission: "records:read",
  risk: "write",
  audiences: ["customer"],
  async handler(input, ctx) {
    const run = ran(input.text) + 1;
    runs.set(input.text, run);
    // Lets two calls sent at once overlap inside the handler.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const created = await ctx.records.create(REQUEST, { text: input.text });
    return { id: created.id, run };
  },
});

/** The same for staff: a person per run. */
const countedPerson = defineOperation({
  name: "fixture.countedPerson",
  description: "Fixture: a staff write that counts its handler's runs.",
  input: z.object({ text: z.string().min(1).max(200) }),
  output: z.object({ run: z.number() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const run = ran(input.text) + 1;
    runs.set(input.text, run);
    ctx.write(
      db.query.insertInto("core_meta").values({ key: `counted:${input.text}:${run}`, value: "x" }),
    );
    return { run };
  },
});

const registry = createRegistry([
  ...coreRegistry.list(),
  ...fixtureOperations,
  countedCreate,
  countedPerson,
]);
const surface = surfaceOver(registry, outside(PUBLIC));

let admin: ActingUser;
let a: Customer;
let b: Customer;

beforeAll(async () => {
  admin = await createUser("admin");
  await installShop();
  a = await createCustomer(admin, "A");
  b = await createCustomer(admin, "B");
}, 60_000);

beforeEach(() => runs.clear());

async function send(
  name: string,
  input: unknown,
  ctx: AnyInvocationContext | null,
  key: string | null,
) {
  const response = await surface.handle(opRequest(name, input, ctx, { key }));
  if (!response) throw new Error("not served");
  return {
    status: response.status,
    replayed: response.headers.get("idempotent-replayed") === "true",
    text: await response.text(),
  };
}

const requestsOf = async (customer: Customer, text: string) =>
  (
    await env.DB.prepare(
      `SELECT count(*) AS n FROM ${objectTableOf(REQUEST)} WHERE text = ? AND asker = ?`,
    )
      .bind(text, customer.principal.personId)
      .first<{ n: number }>()
  )?.n;

describe("a write with a key", () => {
  it("sent twice runs the handler once and answers the same", async () => {
    const text = unique("twice");
    const key = crypto.randomUUID();
    const first = await send("fixture.countedCreate", { text }, outside(a.principal), key);
    const second = await send("fixture.countedCreate", { text }, outside(a.principal), key);
    // Applied once: the handler ran once and one record exists.
    expect(ran(text)).toBe(1);
    expect(await requestsOf(a, text)).toBe(1);
    expect(first).toMatchObject({ status: 200, replayed: false });
    expect(second).toEqual({ ...first, replayed: true });
  });

  it("sent twice at once runs the handler once and answers both the same", async () => {
    const text = unique("atonce");
    const key = crypto.randomUUID();
    const [one, two] = await Promise.all([
      send("fixture.countedCreate", { text }, outside(a.principal), key),
      send("fixture.countedCreate", { text }, outside(a.principal), key),
    ]);
    expect(ran(text)).toBe(1);
    expect(await requestsOf(a, text)).toBe(1);
    expect(one?.status).toBe(200);
    expect(two?.text).toBe(one?.text);
    expect([one?.replayed, two?.replayed].sort()).toEqual([false, true]);
  });

  it("five at once, still once", async () => {
    const text = unique("five");
    const key = crypto.randomUUID();
    const all = await Promise.all(
      Array.from({ length: 5 }, () =>
        send("fixture.countedCreate", { text }, outside(a.principal), key),
      ),
    );
    expect(new Set(all.map((r) => r.text)).size).toBe(1);
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(ran(text)).toBe(1);
    expect(await requestsOf(a, text)).toBe(1);
  });

  it("with a different input is refused, and nothing runs", async () => {
    const text = unique("first");
    const key = crypto.randomUUID();
    await send("fixture.countedCreate", { text }, outside(a.principal), key);
    const other = await send(
      "fixture.countedCreate",
      { text: `${text}-other` },
      outside(a.principal),
      key,
    );
    expect(other.status).toBe(422);
    expect(JSON.parse(other.text)).toEqual({
      error: {
        code: "invalid_input",
        message: "This Idempotency-Key was already used with a different input",
        details: { reason: "idempotency_key_reused" },
      },
    });
    expect(ran(`${text}-other`)).toBe(0);
    // A different operation with the same key is a different input too.
    const otherOp = await send(
      "fixture.myCreate",
      { object: REQUEST, values: { text } },
      outside(a.principal),
      key,
    );
    expect(otherOp.status).toBe(422);
  });

  it("is the caller's own: another customer's key of the same text is theirs", async () => {
    const text = unique("scoped");
    const key = crypto.randomUUID();
    await send("fixture.countedCreate", { text }, outside(a.principal), key);
    const theirs = await send("fixture.countedCreate", { text }, outside(b.principal), key);
    expect(theirs).toMatchObject({ status: 200, replayed: false });
    expect(ran(text)).toBe(2);
    expect(await requestsOf(b, text)).toBe(1);
  });

  it("that failed before committing keeps nothing: a retry runs again", async () => {
    const key = crypto.randomUUID();
    const id = a.records[ORDER]?.[0] as string;
    const refused = await send(
      "fixture.myUpdate",
      { object: ORDER, id, values: { internalNote: "no" } },
      outside(a.principal),
      key,
    );
    expect(refused.status).toBe(400);
    const stored = await db.query
      .selectFrom("core_idempotency_key")
      .selectAll()
      .where("idempotency_key", "=", key)
      .execute();
    expect(stored).toEqual([]);
    const retried = await send(
      "fixture.myUpdate",
      { object: ORDER, id, values: { note: "fixed" } },
      outside(a.principal),
      key,
    );
    expect(retried.status).toBe(200);
  });

  it("keeps a response computed after the commit, and replays it", async () => {
    const key = crypto.randomUUID();
    const id = a.records[ORDER]?.[0] as string;
    const input = { object: ORDER, id, values: { note: unique("late") } };
    const first = await send("fixture.myUpdate", input, outside(a.principal), key);
    expect(JSON.parse(first.text).data.values.note).toBe(input.values.note);
    const again = await send("fixture.myUpdate", input, outside(a.principal), key);
    expect(again).toEqual({ ...first, replayed: true });
  });

  it("is stored with the write, in its batch", async () => {
    const text = unique("batch");
    const key = crypto.randomUUID();
    const reply = await send("fixture.countedCreate", { text }, outside(a.principal), key);
    const row = await db.query
      .selectFrom("core_idempotency_key")
      .selectAll()
      .where("scope", "=", `customer:${a.principal.customerId}`)
      .where("idempotency_key", "=", key)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      operation: "fixture.countedCreate",
      input_hash: await inputHash("fixture.countedCreate", { text }),
      status: 200,
      response: reply.text,
    });
    // And the claim is gone once the call ended.
    const claims = await db.query
      .selectFrom("core_idempotency_claim")
      .selectAll()
      .where("idempotency_key", "=", key)
      .execute();
    expect(claims).toEqual([]);
  });

  it("works for staff too, and a queued write is queued once", async () => {
    const text = unique("staff");
    const key = crypto.randomUUID();
    const staff = context(admin, { origin: { surface: "client" } });
    const one = await send("fixture.countedPerson", { text }, staff, key);
    const two = await send("fixture.countedPerson", { text }, staff, key);
    expect(one.status).toBe(200);
    expect(two).toEqual({ ...one, replayed: true });
    expect(ran(text)).toBe(1);

    const queuedText = unique("queued");
    // A key of its own: `key` with its last character changed was the same key one time in 16.
    const queuedKey = crypto.randomUUID();
    const reviewed = context(admin, {
      origin: { surface: "client" },
      floor: { "*": { write: "review" } },
    });
    const q1 = await send(
      "fixture.countedPerson",
      { text: queuedText },
      reviewed,
      queuedKey,
    );
    const q2 = await send(
      "fixture.countedPerson",
      { text: queuedText },
      reviewed,
      queuedKey,
    );
    expect(q1.status).toBe(202);
    expect(JSON.parse(q1.text).error.code).toBe("pending_approval");
    expect(q2).toEqual({ ...q1, replayed: true });
    const pending = await db.query
      .selectFrom("core_pending_action")
      .select("id")
      .where("operation", "=", "fixture.countedPerson")
      .where("input", "like", `%${queuedText}%`)
      .execute();
    expect(pending).toHaveLength(1);
  });
});

describe("a write without a key", () => {
  it("is refused, for every caller, and nothing runs", async () => {
    const text = unique("nokey");
    for (const [name, ctx] of [
      ["fixture.countedCreate", outside(a.principal)],
      ["fixture.countedPerson", context(admin, { origin: { surface: "client" } })],
    ] as const) {
      const out = await send(name, { text }, ctx, null);
      expect(out.status).toBe(400);
      expect(JSON.parse(out.text)).toEqual({
        error: {
          code: "invalid_input",
          message: "A write needs an Idempotency-Key header",
          details: { reason: "idempotency_key_required" },
        },
      });
    }
    expect(ran(text)).toBe(0);
  });

  it("with a key too short to be unguessable is refused", async () => {
    const out = await send("fixture.countedCreate", { text: "x" }, outside(a.principal), "short");
    expect(out.status).toBe(400);
    expect(JSON.parse(out.text).error.details).toEqual({ reason: "idempotency_key_invalid" });
  });

  it("a read needs none", async () => {
    const out = await send("fixture.myList", { object: ORDER }, outside(a.principal), null);
    expect(out.status).toBe(200);
  });

  it("a closed operation says it does not exist, key or no key", async () => {
    const withKey = await send(
      "person.create",
      { givenName: "x" },
      outside(a.principal),
      crypto.randomUUID(),
    );
    const without = await send("person.create", { givenName: "x" }, outside(a.principal), null);
    expect(withKey.status).toBe(404);
    expect(without.text).toBe(withKey.text);
  });
});

describe("claims", () => {
  const call = (key: string, text: string, waitMs?: number) => ({
    db,
    scope: "test",
    key,
    operation: "fixture.claims",
    hash: text,
    now: () => new Date(),
    replyFor: () => ({ status: 200, body: JSON.stringify({ data: text }) }),
    ...(waitMs ? { waitMs } : {}),
  });

  it("a claim left by a call that died is taken over once stale", async () => {
    const key = crypto.randomUUID();
    await db.query
      .insertInto("core_idempotency_claim")
      .values({
        scope: "test",
        idempotency_key: key,
        operation: "fixture.claims",
        input_hash: "h",
        claim: "dead",
        claimed_at: new Date(Date.now() - CLAIM_STALE_MS - 1000).toISOString(),
      })
      .execute();
    let ranHere = 0;
    const reply = await runIdempotent(call(key, "h"), async (inBatch) => {
      ranHere += 1;
      await db.batch(inBatch({ kind: "applied", output: "h", deferred: false }));
      return { status: 200, body: JSON.stringify({ data: "h" }) };
    });
    expect(ranHere).toBe(1);
    expect(reply).toMatchObject({ status: 200, replayed: false });
  });

  it("a fresh claim makes a second call wait, then answer to retry", async () => {
    const key = crypto.randomUUID();
    await db.query
      .insertInto("core_idempotency_claim")
      .values({
        scope: "test",
        idempotency_key: key,
        operation: "fixture.claims",
        input_hash: "h",
        claim: "alive",
        claimed_at: new Date().toISOString(),
      })
      .execute();
    let ranHere = 0;
    await expect(
      runIdempotent(call(key, "h", 200), async () => {
        ranHere += 1;
        return { status: 200, body: "{}" };
      }),
    ).rejects.toMatchObject({ code: "conflict", details: { reason: "idempotency_key_in_flight" } });
    expect(ranHere).toBe(0);
  });

  it("a second batch for a key that committed applies nothing", async () => {
    const key = crypto.randomUUID();
    const marker = `idem:${key}`;
    const statements = (claim: string) => [
      db.query.insertInto("core_meta").values({ key: `${marker}:${claim}`, value: "x" }),
      db.query.insertInto("core_idempotency_key").values({
        scope: "test",
        idempotency_key: key,
        operation: "fixture.claims",
        input_hash: "h",
        claim,
        status: 200,
        response: "{}",
        created_at: new Date().toISOString(),
      }),
    ];
    await db.batch(statements("one"));
    await expect(db.batch(statements("two"))).rejects.toThrow(/UNIQUE/);
    const metas = await env.DB.prepare("SELECT key FROM core_meta WHERE key LIKE ?")
      .bind(`${marker}%`)
      .all();
    expect(metas.results).toEqual([{ key: `${marker}:one` }]);
  });
});

it("keys are purged after 24 hours", async () => {
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const key = crypto.randomUUID();
  await db.query
    .insertInto("core_idempotency_key")
    .values({
      scope: "purge",
      idempotency_key: key,
      operation: "x",
      input_hash: "h",
      claim: "c",
      status: 200,
      response: "{}",
      created_at: old,
    })
    .execute();
  await db.query
    .insertInto("core_idempotency_claim")
    .values({
      scope: "purge",
      idempotency_key: key,
      operation: "x",
      input_hash: "h",
      claim: "c",
      claimed_at: old,
    })
    .execute();
  const fresh = crypto.randomUUID();
  await db.query
    .insertInto("core_idempotency_key")
    .values({
      scope: "purge",
      idempotency_key: fresh,
      operation: "x",
      input_hash: "h",
      claim: "c",
      status: 200,
      response: "{}",
      created_at: new Date().toISOString(),
    })
    .execute();
  const result = await purgeIdempotencyKeys(db, new Date());
  expect(result.deleted).toBeGreaterThanOrEqual(2);
  const left = await db.query
    .selectFrom("core_idempotency_key")
    .select("idempotency_key")
    .where("scope", "=", "purge")
    .execute();
  expect(left).toEqual([{ idempotency_key: fresh }]);
});

it("erasing a person removes their stored replies, and any other reply that names them", async () => {
  const c = await createCustomer(admin, "C");
  // The fixtures' principals have no account row; this one needs one for erase to find.
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, status, link_state, created_at, updated_at) VALUES (?, ?, ?, 1, 'active', 'linked', ?, ?)",
  )
    .bind(c.principal.customerId, c.principal.personId, `${unique("c")}@example.com`, at, at)
    .run();
  const mine = crypto.randomUUID();
  await send("fixture.countedCreate", { text: unique("erase") }, outside(c.principal), mine);
  // A staff write about them, whose stored reply holds their name.
  const staffKey = crypto.randomUUID();
  const staff = context(admin, { origin: { surface: "client" } });
  const updated = await send(
    "person.update",
    { id: c.principal.personId, givenName: "Erasable" },
    staff,
    staffKey,
  );
  expect(updated.status).toBe(200);
  const other = crypto.randomUUID();
  await send("fixture.countedCreate", { text: unique("keep") }, outside(a.principal), other);
  const keys = () =>
    db.query
      .selectFrom("core_idempotency_key")
      .select("idempotency_key")
      .where("idempotency_key", "in", [mine, staffKey, other])
      .execute()
      .then((rows) => rows.map((r) => r.idempotency_key).sort());
  expect(await keys()).toEqual([mine, staffKey, other].sort());

  const { invoke } = await import("../src/index.ts");
  await invoke("person.erase", { id: c.principal.personId }, context(admin));
  expect(await keys()).toEqual([other]);
});

/** A D1 binding that counts what it is asked to run: statements, and round trips to D1. */
function countingD1(inner: D1Database) {
  const count = { statements: 0, roundTrips: 0 };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") return value;
        const fn = value as (...args: unknown[]) => unknown;
        if (prop === "bind") {
          return (...args: unknown[]) => wrap(fn.apply(target, args) as D1PreparedStatement);
        }
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...args: unknown[]) => {
            count.roundTrips += 1;
            return fn.apply(target, args);
          };
        }
        return fn.bind(target);
      },
    });
    real.set(proxy, statement);
    return proxy;
  };
  const d1 = new Proxy(inner, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          count.statements += 1;
          return wrap(target.prepare(query));
        };
      }
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          count.roundTrips += 1;
          return target.batch(statements.map((s) => real.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
  return { d1, count };
}

describe("what a key costs (ADR 0416)", () => {
  it("one more round trip and three more statements than the same write without the surface", async () => {
    const { d1, count } = countingD1(env.DB);
    const ctx = { principal: a.principal, db: createCrmDb(d1) } as const;
    const invoker = createInvoker(registry);
    const direct = async () => {
      await invoker.invokeByName("fixture.countedCreate", { text: unique("cost") }, ctx);
    };
    const overHttp = async () => {
      const response = await surface.handle(
        opRequest("fixture.countedCreate", { text: unique("cost") }, ctx),
      );
      expect(response?.status).toBe(200);
    };
    // Warm both paths (the schema registry), then measure each once.
    await direct();
    await overHttp();
    const measure = async (run: () => Promise<void>) => {
      const before = { ...count };
      await run();
      return {
        statements: count.statements - before.statements,
        roundTrips: count.roundTrips - before.roundTrips,
      };
    };
    const plain = await measure(direct);
    const keyed = await measure(overHttp);
    expect(plain.statements).toBeGreaterThan(0);
    expect(keyed.statements - plain.statements).toBe(3);
    expect(keyed.roundTrips - plain.roundTrips).toBe(1);
  });
});
