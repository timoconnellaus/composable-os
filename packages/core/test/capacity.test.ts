// Stage 26, the spine (ADR 0430): the counter, the claim rows and the refusing constraint, and the
// pool claim in the same batch, under concurrency, against the real D1 binding in workerd.
//
// Claims are made by a fixture claimant (`fixture.claim`) through the real pipeline, as an order or
// a booking will make them: the claim statements go into the operation's own batch with its other
// writes and its audit row, and a refusal fails the whole batch.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  CLAIM_STATEMENTS,
  claimStatements,
  coreRegistry,
  counterInsert,
  createInvoker,
  createRegistry,
  defineOperation,
  newId,
  ValidationError,
} from "../src/index.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const OBJECT = "fixture.ticket";
const POOL_OBJECT = "fixture.event";

const counterOp = defineOperation({
  name: "fixture.counter",
  description: "Test fixture: creates a capacity counter for a record, optionally with a pool.",
  input: z.object({
    object: z.string(),
    record: z.string(),
    places: z.number().int().nullable(),
    pool: z.object({ object: z.string(), record: z.string() }).nullable().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    ctx.write(counterInsert(ctx.db, input, ctx.now));
    return { ok: true };
  },
});

const claimOp = defineOperation({
  name: "fixture.claim",
  description:
    "Test fixture claimant: holds places on records for an owner, optionally creating a person in the same batch.",
  input: z.object({
    forId: z.string(),
    personId: z.string().optional(),
    claims: z.array(z.object({ object: z.string(), record: z.string(), quantity: z.number() })),
    // Waits this long in the handler, so every claimant of a rush is in flight before any
    // batch commits.
    delayMs: z.number().optional(),
  }),
  output: z.object({ ids: z.array(z.string()) }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    if (input.delayMs) await new Promise((resolve) => setTimeout(resolve, input.delayMs));
    // The record being created with the claims (an order, in stage 25).
    if (input.personId) {
      ctx.write(
        ctx.db.insertInto("core_person").values({
          id: input.personId,
          display_name: "Claimant",
          created_at: ctx.now,
          updated_at: ctx.now,
        }),
      );
    }
    const ids: string[] = [];
    for (const claim of input.claims) {
      const { id, statements } = claimStatements(
        ctx.db,
        { ...claim, for: { type: "fixture", id: input.forId } },
        ctx.now,
      );
      ids.push(id);
      ctx.write(...statements);
    }
    return { ids };
  },
});

// The control: the check-then-write the behaviour avoids. It reads what is held and claims only
// when it saw room, on an unlimited counter so that nothing but its own read guards it.
const naiveClaimOp = defineOperation({
  name: "fixture.naiveClaim",
  description: "Test fixture: claims one place after reading the counter (the unsafe pattern).",
  input: z.object({ record: z.string(), limit: z.number() }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_capacity")
      .select("held")
      .where("object_type", "=", OBJECT)
      .where("record_id", "=", input.record)
      .executeTakeFirstOrThrow();
    if (row.held >= input.limit) throw new ValidationError("Sold out");
    // A remote D1 read is a round trip of milliseconds; locally it is nearly instant, which
    // hides the race. Widen the window to what production would have.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { statements } = claimStatements(
      ctx.db,
      { object: OBJECT, record: input.record, quantity: 1, for: { type: "fixture", id: "naive" } },
      ctx.now,
    );
    ctx.write(...statements);
    return { ok: true };
  },
});

const { invoke } = createInvoker(
  createRegistry([...coreRegistry.list(), counterOp, claimOp, naiveClaimOp]),
);

let member: ActingUser;
const ctx = () => context(member);

beforeAll(async () => {
  member = await createUser("member");
});

async function counter(object: string, record: string, places: number | null, pool?: string) {
  await invoke(
    "fixture.counter",
    { object, record, places, pool: pool ? { object: POOL_OBJECT, record: pool } : null },
    ctx(),
  );
}

async function counterRow(object: string, record: string) {
  return env.DB.prepare(
    "SELECT places, held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(object, record)
    .first<{ places: number | null; held: number; taken: number }>();
}

async function claimRows(where: string, ...params: string[]) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM core_capacity_claim WHERE ${where} ORDER BY id`,
  )
    .bind(...params)
    .all<Record<string, unknown>>();
  return results;
}

type Outcome = { ok: true } | { ok: false; error: unknown };

async function claimOnce(
  forId: string,
  claims: { object: string; record: string; quantity: number }[],
  personId?: string,
  delayMs?: number,
): Promise<Outcome> {
  try {
    await invoke("fixture.claim", { forId, claims, personId, delayMs }, ctx());
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Makes `count` claims of 1 at once; `recordFor(i)` picks each claim's record. */
async function rush(
  count: number,
  recordFor: (i: number) => string,
  tag: string,
  delayMs?: number,
) {
  const started = performance.now();
  const outcomes = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      claimOnce(
        `${tag}-${i}`,
        [{ object: OBJECT, record: recordFor(i), quantity: 1 }],
        undefined,
        delayMs,
      ),
    ),
  );
  const ms = performance.now() - started;
  return { outcomes, ms };
}

// Run plainly, and with every claimant waiting in its handler first so that all 500 batches are
// in flight before any commits.
describe.each([
  { mode: "as they come", delayMs: undefined },
  { mode: "all in flight", delayMs: 5 },
])("criterion 1: never oversold ($mode)", ({ mode, delayMs }) => {
  it("500 claims of 1 at once against 100 places: exactly 100 held, 400 refused", async () => {
    const record = unique("tkt");
    await counter(OBJECT, record, 100);
    const tag = unique("rush");
    const { outcomes, ms } = await rush(500, () => record, tag, delayMs);
    console.log(`criterion 1 (100 places, ${mode}): 500 claims in ${ms.toFixed(0)} ms`);

    const refused = outcomes.filter((o) => !o.ok);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(100);
    expect(refused).toHaveLength(400);
    for (const outcome of refused) {
      const error = (outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe("invalid_input");
      expect((error as ValidationError).details).toEqual({
        rule: "capacity",
        object: OBJECT,
        record,
        asked: 1,
        available: 0,
      });
    }
    expect(await counterRow(OBJECT, record)).toEqual({ places: 100, held: 100, taken: 0 });
    const claims = await claimRows("object_type = ? AND record_id = ?", OBJECT, record);
    expect(claims).toHaveLength(100);
    expect(claims.every((c) => c.state === "held" && c.quantity === 1)).toBe(true);
  });

  it("a pool of 60 over two records of 50: exactly 60 held across both", async () => {
    const event = unique("evt");
    const a = unique("tktA");
    const b = unique("tktB");
    await counter(POOL_OBJECT, event, 60);
    await counter(OBJECT, a, 50, event);
    await counter(OBJECT, b, 50, event);
    const tag = unique("pool");
    const { outcomes, ms } = await rush(500, (i) => (i % 2 ? a : b), tag, delayMs);
    console.log(`criterion 1 (pool of 60, ${mode}): 500 claims in ${ms.toFixed(0)} ms`);

    const refused = outcomes.filter((o) => !o.ok);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(60);
    expect(refused).toHaveLength(440);
    for (const outcome of refused) {
      const error = (outcome as { error: unknown }).error as ValidationError;
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.details).toMatchObject({ rule: "capacity", asked: 1, available: 0 });
      const details = error.details as { object: string; record: string };
      // Whichever counter refused: the pool, or a ticket type that ran out first.
      expect([`${POOL_OBJECT}/${event}`, `${OBJECT}/${a}`, `${OBJECT}/${b}`]).toContain(
        `${details.object}/${details.record}`,
      );
    }
    const pool = await counterRow(POOL_OBJECT, event);
    const rowA = await counterRow(OBJECT, a);
    const rowB = await counterRow(OBJECT, b);
    expect(pool).toEqual({ places: 60, held: 60, taken: 0 });
    expect((rowA?.held ?? 0) + (rowB?.held ?? 0)).toBe(60);
    const claims = await claimRows("for_id LIKE ?", `${tag}-%`);
    expect(claims).toHaveLength(60);
    // Each claim names the pool it drew on.
    expect(
      claims.every((c) => c.pool_object_type === POOL_OBJECT && c.pool_record_id === event),
    ).toBe(true);
  });
});

describe("the harness is really concurrent", () => {
  it("a read-then-write claim under the same rush oversells (the control)", async () => {
    const record = unique("tkt");
    await counter(OBJECT, record, null);
    const outcomes = await Promise.all(
      Array.from({ length: 500 }, () =>
        invoke("fixture.naiveClaim", { record, limit: 100 }, ctx()).then(
          () => true,
          () => false,
        ),
      ),
    );
    const sold = outcomes.filter(Boolean).length;
    console.log(`control (read then write, limit 100): ${sold} sold`);
    expect(sold).toBeGreaterThan(100);
  });
});

describe("criterion 2: all or nothing", () => {
  it("a batch whose second claim is refused leaves no trace of its first claim or its record", async () => {
    const first = unique("tkt1");
    const second = unique("tkt2");
    await counter(OBJECT, first, 10);
    await counter(OBJECT, second, 2);
    const forId = unique("order");
    const personId = newId("person");
    const outcome = await claimOnce(
      forId,
      [
        { object: OBJECT, record: first, quantity: 3 },
        { object: OBJECT, record: second, quantity: 5 },
      ],
      personId,
    );
    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: ValidationError }).error;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.details).toEqual({
      rule: "capacity",
      object: OBJECT,
      record: second,
      asked: 5,
      available: 2,
    });
    expect(await counterRow(OBJECT, first)).toEqual({ places: 10, held: 0, taken: 0 });
    expect(await counterRow(OBJECT, second)).toEqual({ places: 2, held: 0, taken: 0 });
    expect(await claimRows("for_id = ?", forId)).toEqual([]);
    const person = await env.DB.prepare("SELECT id FROM core_person WHERE id = ?")
      .bind(personId)
      .first();
    expect(person).toBeNull();
  });

  it("a claim the pool refuses leaves the record's own counter untouched", async () => {
    const event = unique("evt");
    const ticket = unique("tkt");
    await counter(POOL_OBJECT, event, 2);
    await counter(OBJECT, ticket, 50, event);
    const forId = unique("order");
    const outcome = await claimOnce(forId, [{ object: OBJECT, record: ticket, quantity: 3 }]);
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: ValidationError }).error.details).toEqual({
      rule: "capacity",
      object: POOL_OBJECT,
      record: event,
      asked: 3,
      available: 2,
    });
    expect(await counterRow(OBJECT, ticket)).toEqual({ places: 50, held: 0, taken: 0 });
    expect(await counterRow(POOL_OBJECT, event)).toEqual({ places: 2, held: 0, taken: 0 });
    expect(await claimRows("for_id = ?", forId)).toEqual([]);

    // Within both limits it claims on both, and the claim names the pool.
    expect((await claimOnce(forId, [{ object: OBJECT, record: ticket, quantity: 2 }])).ok).toBe(
      true,
    );
    expect(await counterRow(OBJECT, ticket)).toEqual({ places: 50, held: 2, taken: 0 });
    expect(await counterRow(POOL_OBJECT, event)).toEqual({ places: 2, held: 2, taken: 0 });
  });
});

describe("the counter", () => {
  it("unlimited places count claims and never refuse", async () => {
    const record = unique("tkt");
    await counter(OBJECT, record, null);
    expect((await claimOnce(unique("o"), [{ object: OBJECT, record, quantity: 1000 }])).ok).toBe(
      true,
    );
    expect(await counterRow(OBJECT, record)).toEqual({ places: null, held: 1000, taken: 0 });
  });

  it("a claim on a record with no counter fails the batch", async () => {
    const forId = unique("order");
    const outcome = await claimOnce(forId, [
      { object: OBJECT, record: unique("none"), quantity: 1 },
    ]);
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: ValidationError }).error).toBeInstanceOf(ValidationError);
    expect(await claimRows("for_id = ?", forId)).toEqual([]);
  });

  it("a claim of fewer than one place is refused before anything is queued", async () => {
    const record = unique("tkt");
    await counter(OBJECT, record, 5);
    const outcome = await claimOnce(unique("o"), [{ object: OBJECT, record, quantity: 0 }]);
    expect((outcome as { error: ValidationError }).error).toBeInstanceOf(ValidationError);
  });

  it("places cannot be set below what is claimed, and the refusal carries the numbers", async () => {
    const record = unique("tkt");
    await counter(OBJECT, record, 5);
    expect((await claimOnce(unique("o"), [{ object: OBJECT, record, quantity: 4 }])).ok).toBe(true);
    // Straight at the database: the rule holds whatever writes the row.
    const lowered = await env.DB.prepare(
      "UPDATE core_capacity SET places = 3 WHERE object_type = ? AND record_id = ?",
    )
      .bind(OBJECT, record)
      .run()
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(String(lowered)).toContain("core_capacity_refused");
    expect(await counterRow(OBJECT, record)).toEqual({ places: 5, held: 4, taken: 0 });
  });

  it("a claim is a fixed number of statements with no read before them", () => {
    const { statements } = claimStatements(
      db.query,
      { object: OBJECT, record: "r", quantity: 1, for: { type: "fixture", id: "f" } },
      new Date().toISOString(),
    );
    expect(statements).toHaveLength(CLAIM_STATEMENTS);
    const sqls = statements.map((s) => s.compile().sql);
    expect(sqls.every((s) => /^(update|insert)/i.test(s.trim()))).toBe(true);
  });
});
