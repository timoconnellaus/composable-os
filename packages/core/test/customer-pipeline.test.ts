// Stage 22 step 3 (ADR 0402, ADR 0412): the customer and public principals in the pipeline.
// A call from outside the org is refused by every operation that does not list its audience,
// is never queued for review, is audited as actor `customer` or `public`, and gets none of what
// a staff call carries.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  type AutomationQueueMessage,
  coreOperations,
  createRegistry,
  defineOperation,
  evaluateOutsideGate,
  type InvocationContext,
  invokeByName,
  memoryRateLimit,
  type OutsideInvocationContext,
  openOperations,
  RISK_CLASSES,
  scopeOf,
} from "../src/index.ts";
import {
  type Customer,
  call,
  createCustomer,
  fixtureRegistry,
  installShop,
  ORDER,
  outside,
  PUBLIC,
} from "./customer-fixtures.ts";
import { context, createUser, db, setPreset } from "./helpers.ts";

let admin: ActingUser;
let a: Customer;

beforeAll(async () => {
  admin = await createUser("admin");
  await installShop();
  a = await createCustomer(admin, "A");
}, 60_000);

const count = async (sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0;

describe("default closed (criterion 1)", () => {
  it("every core operation refuses a customer and the public, before it reads the input", async () => {
    const audits = await count("SELECT count(*) AS n FROM core_audit");
    const answers = new Set<string>();
    // The operations the generated list opens to the caller's audience are left out, and only
    // those: every other core operation, including a `toolOnly` one called directly, refuses.
    const listed = openOperations(coreOperations).operations as {
      name: string;
      audiences: readonly string[];
      toolOnly?: boolean;
    }[];
    const openTo = (kind: string) =>
      new Set(listed.filter((e) => e.audiences.includes(kind) && !e.toolOnly).map((e) => e.name));
    expect([...openTo("customer")].sort()).toEqual([
      "capacity.get",
      "me.deleteAccount",
      "me.get",
      "me.sessions.list",
      "me.sessions.revoke",
      "me.signOut",
      "me.update",
      "my.get",
      "my.list",
      // Stage 25 (ADR 0428): a customer starts, reads and cancels their own orders.
      "order.cancel",
      "order.get",
      "order.start",
      "order.view",
    ]);
    // Stage 25: a guest starts, opens and pays an order. Stage 26: places left (ADR 0433).
    expect([...openTo("public")].sort()).toEqual(["capacity.get", "order.start", "order.view"]);
    for (const principal of [a.principal, PUBLIC]) {
      const open = openTo(principal.kind);
      for (const op of coreOperations) {
        if (open.has(op.name)) continue;
        // Input no operation accepts: validation would say `invalid_input` if it ran.
        const outcome = await invokeByName(op.name, 42, outside(principal)).then(
          () => "returned",
          (error: { code?: string; message?: string }) =>
            `${error.code}: ${error.message?.replace(op.name, "<name>")}`,
        );
        answers.add(outcome);
      }
    }
    expect(coreOperations.length).toBeGreaterThan(250);
    // One answer for all of them: the one a name that is not registered gets.
    expect([...answers]).toEqual(['unknown_operation: No operation named "<name>"']);
    const unknown = await call("nothing.atAll", 42, outside(a.principal));
    expect(unknown).toEqual({
      ok: false,
      error: { code: "unknown_operation", message: 'No operation named "nothing.atAll"' },
    });
    expect(await count("SELECT count(*) AS n FROM core_audit")).toBe(audits);
  });

  it("each audience calls only what lists it", async () => {
    const who = async (ctx: InvocationContext | OutsideInvocationContext) =>
      call("fixture.whoAmI", {}, ctx);
    expect(await who(context(admin))).toEqual({ ok: true, value: { kind: "staff" } });
    expect(await who(outside(a.principal))).toEqual({ ok: true, value: { kind: "customer" } });
    expect(await who(outside(PUBLIC))).toEqual({ ok: true, value: { kind: "public" } });

    const closed = { ok: false, error: { code: "unknown_operation" } };
    expect(await call("fixture.myList", { object: ORDER }, context(admin))).toMatchObject(closed);
    expect(await call("fixture.myList", { object: ORDER }, outside(PUBLIC))).toMatchObject(closed);
    expect(await call("fixture.publicPeek", { object: ORDER }, outside(a.principal))).toMatchObject(
      closed,
    );
    expect(await call("fixture.publicPeek", { object: ORDER }, context(admin))).toMatchObject(
      closed,
    );
  });
});

describe("the principal", () => {
  it("is what the adapter passed, and nothing in a context can be both staff and a principal", async () => {
    const both = { ...context(admin), principal: a.principal } as unknown as InvocationContext;
    expect(await call("fixture.whoAmI", {}, both)).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
    // Not as staff either: person.list would have answered a staff call.
    expect(await call("person.list", {}, both)).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
  });

  it("refuses a principal of a kind it does not know, or one that is not whole", async () => {
    for (const principal of [
      { kind: "staff", userId: admin.id, role: "admin" },
      { kind: "customer" },
      { kind: "customer", customerId: "cus_1", personId: "" },
      { kind: "customer", customerId: "cus_1", personId: "per_1' OR 1=1" },
      { kind: "admin" },
      "customer",
      {},
    ]) {
      const ctx = { principal, db } as unknown as OutsideInvocationContext;
      for (const name of ["fixture.whoAmI", "person.list", "fixture.myList"]) {
        expect(await call(name, { object: ORDER }, ctx), JSON.stringify(principal)).toMatchObject({
          ok: false,
          error: { code: "internal" },
        });
      }
    }
  });

  it("a scope is computed from the principal alone", () => {
    const order = { name: ORDER } as Parameters<typeof scopeOf>[1];
    expect(scopeOf({ kind: "staff", userId: admin.id, role: "viewer" }, order).kind).toBe("all");
    expect(scopeOf(a.principal, order)).toMatchObject({
      kind: "customer",
      personId: a.principal.personId,
      column: "buyer",
      columns: ["id", "title", "status", "total", "note"],
    });
    expect(scopeOf(PUBLIC, order).kind).toBe("none");
    expect(scopeOf({ kind: "robot" } as never, order).kind).toBe("none");
  });

  it("a handler gets no staff user, actor or pipeline on a customer's call", async () => {
    expect(await call("fixture.staffHabit", {}, outside(a.principal))).toEqual({
      ok: false,
      error: { code: "internal", message: "Internal error" },
    });
  });
});

describe("the gate allows or refuses, and never queues", () => {
  it("allows reads and writes and nothing else, whatever the preset", () => {
    for (const risk of RISK_CLASSES) {
      expect(evaluateOutsideGate(risk)).toBe(risk === "read" || risk === "write" ? "auto" : "deny");
    }
    // A floor that asks for review is about calls that can wait: it does not apply here.
    expect(evaluateOutsideGate("write", { "*": { write: "review" } })).toBe("auto");
    expect(evaluateOutsideGate("write", { "*": { "*": "review" } })).toBe("auto");
    expect(evaluateOutsideGate("write", { "*": { write: { autoUpTo: 0, above: "review" } } })).toBe(
      "auto",
    );
    // A floor that denies still denies.
    expect(evaluateOutsideGate("write", { "*": { write: "deny" } })).toBe("deny");
    expect(evaluateOutsideGate("read", { "*": { "*": "deny" } })).toBe("deny");
    expect(evaluateOutsideGate("read", { "*": { write: "deny" } })).toBe("auto");
    expect(
      evaluateOutsideGate("write", { mcp: { write: "deny" }, "*": { destructive: "deny" } }),
    ).toBe("auto");
  });

  it("a customer's write applies under the cautious preset, with nothing queued", async () => {
    await setPreset("cautious");
    try {
      const pending = await count("SELECT count(*) AS n FROM core_pending_action");
      const id = a.records[ORDER]?.[0] as string;
      const done = await call(
        "fixture.myUpdate",
        { object: ORDER, id, values: { note: "under cautious" } },
        outside(a.principal),
      );
      expect(done).toMatchObject({ ok: true, value: { values: { note: "under cautious" } } });
      expect(await count("SELECT count(*) AS n FROM core_pending_action")).toBe(pending);
    } finally {
      await setPreset("balanced");
    }
  });

  it("a floor that asks for review does not apply: the write lands and nothing is queued", async () => {
    const id = a.records[ORDER]?.[0] as string;
    const pending = await count("SELECT count(*) AS n FROM core_pending_action");
    const done = await call(
      "fixture.myUpdate",
      { object: ORDER, id, values: { note: "under a review floor" } },
      outside(a.principal, { floor: { "*": { write: "review" } } }),
    );
    expect(done).toMatchObject({ ok: true, value: { values: { note: "under a review floor" } } });
    expect(await count("SELECT count(*) AS n FROM core_pending_action")).toBe(pending);
  });

  it("a floor that denies refuses the write, and that is audited", async () => {
    const id = a.records[ORDER]?.[0] as string;
    const refused = await call(
      "fixture.myUpdate",
      { object: ORDER, id, values: { note: "under a deny floor" } },
      outside(a.principal, { floor: { "*": { write: "deny" } } }),
    );
    expect(refused).toEqual({
      ok: false,
      error: { code: "denied", message: "fixture.myUpdate is not available" },
    });
    const row = await env.DB.prepare(
      "SELECT actor, user_id, gate_decision, outcome FROM core_audit WHERE operation = 'fixture.myUpdate' AND outcome = 'denied' AND user_id = ?",
    )
      .bind(a.principal.customerId)
      .first();
    expect(row).toEqual({
      actor: "customer",
      user_id: a.principal.customerId,
      gate_decision: "deny",
      outcome: "denied",
    });
  });
});

describe("audit", () => {
  it("a customer's write is audited as actor customer with the account's id and a field diff", async () => {
    const id = a.records[ORDER]?.[1] as string;
    await call(
      "fixture.myUpdate",
      { object: ORDER, id, values: { note: "audited" } },
      outside(a.principal, { clock: () => new Date("2026-11-20T10:00:00.000Z") }),
    );
    const row = await env.DB.prepare(
      `SELECT a.actor, a.user_id, a.risk, a.origin, a.gate_decision, a.outcome, a.at, c.object_type, c.action, c.diff
       FROM core_audit a JOIN core_audit_changes c ON c.audit_id = a.id
       WHERE c.record_id = ? AND a.actor = 'customer'`,
    )
      .bind(id)
      .first<Record<string, string>>();
    expect(row).toMatchObject({
      actor: "customer",
      user_id: a.principal.customerId,
      risk: "write",
      origin: '{"surface":"client"}',
      gate_decision: "auto",
      outcome: "ok",
      at: "2026-11-20T10:00:00.000Z",
      object_type: ORDER,
      action: "update",
    });
    expect(JSON.parse(row?.diff ?? "{}")).toEqual({
      // The second order's note: the fixture numbers them 1 and 2.
      note: { before: String(a.values[ORDER]?.note).replace(/1$/, "2"), after: "audited" },
    });
  });

  it("reads are counted per account and operation, not audited row by row", async () => {
    const audits = await count("SELECT count(*) AS n FROM core_audit");
    const at = () => new Date("2026-11-20T11:30:00.000Z");
    for (let i = 0; i < 3; i += 1) {
      await call("fixture.myList", { object: ORDER }, outside(a.principal, { clock: at }));
    }
    await call("fixture.whoAmI", {}, outside(PUBLIC, { clock: at }));
    expect(await count("SELECT count(*) AS n FROM core_audit")).toBe(audits);
    const { results } = await env.DB.prepare(
      "SELECT actor, user_id, operation, count FROM core_audit_read_counts WHERE hour = '2026-11-20T11:00:00.000Z' ORDER BY actor",
    ).all();
    expect(results).toEqual([
      { actor: "customer", user_id: a.principal.customerId, operation: "fixture.myList", count: 3 },
      { actor: "public", user_id: "", operation: "fixture.whoAmI", count: 1 },
    ]);
  });

  it("a read that fails writes nothing; a write that fails is audited with what the caller was told", async () => {
    const audits = await count("SELECT count(*) AS n FROM core_audit");
    await call(
      "fixture.myGet",
      { object: ORDER, id: "rec_01NOTTHERE0000000000000000" },
      outside(a.principal),
    );
    await call("fixture.myList", { object: "nope.nope" }, outside(PUBLIC));
    expect(await count("SELECT count(*) AS n FROM core_audit")).toBe(audits);

    const id = "rec_01NOTTHERE0000000000000000";
    await call(
      "fixture.myUpdate",
      { object: ORDER, id, values: { note: "x" } },
      outside(a.principal),
    );
    const row = await env.DB.prepare(
      "SELECT actor, outcome, error FROM core_audit WHERE operation = 'fixture.myUpdate' AND outcome = 'error' ORDER BY at DESC LIMIT 1",
    ).first<{ actor: string; outcome: string; error: string }>();
    expect(row).toMatchObject({ actor: "customer", outcome: "error" });
    expect(JSON.parse(row?.error ?? "{}")).toMatchObject({ code: "not_found" });
    expect(
      await count("SELECT count(*) AS n FROM core_audit_changes WHERE record_id = ?", id),
    ).toBe(0);
  });
});

describe("events", () => {
  it("a customer's change becomes a record event that says a customer made it", async () => {
    const sent: AutomationQueueMessage[] = [];
    const id = a.records[ORDER]?.[0] as string;
    const done = await call(
      "fixture.myUpdate",
      { object: ORDER, id, values: { note: "with events" } },
      outside(a.principal, { events: { send: async (messages) => void sent.push(...messages) } }),
    );
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain('"actor":"customer"');
    expect(JSON.stringify(sent[0])).toContain(a.principal.customerId);
  });
});

describe("the closed handler context (ADR 0413)", () => {
  it("the generated list shows which open operations keep the raw database", () => {
    const listed = openOperations(fixtureRegistry.list()).operations;
    expect(listed.filter((op) => op.hostInternal).map((op) => op.name)).toEqual([
      "fixture.bookkeeping",
      "me.deleteAccount",
      "me.sessions.list",
      "me.sessions.revoke",
      "me.signOut",
      // Stage 25 (ADR 0428): the host itself starts and changes an order for the caller.
      "order.cancel",
      "order.start",
      "order.view",
    ]);
    expect(listed.find((op) => op.name === "fixture.myUpdate")).toEqual({
      name: "fixture.myUpdate",
      audiences: ["customer"],
      risk: "write",
    });
  });

  it("an open operation without the flag has no database, write queue, change or activity", async () => {
    const id = a.records[ORDER]?.[0] as string;
    const activities = await count("SELECT count(*) AS n FROM core_activity");
    for (const how of ["db", "write", "recordChange", "postActivity", "loader", "list"]) {
      expect(
        await call("fixture.rawAccess", { how, object: ORDER, id }, outside(a.principal)),
        how,
      ).toEqual({ ok: false, error: { code: "internal", message: "Internal error" } });
    }
    expect(await count("SELECT count(*) AS n FROM core_activity")).toBe(activities);
  });

  it("a hostInternal operation keeps them, and the seam still checks the change it records", async () => {
    const id = a.records[ORDER]?.[0] as string;
    const kept = await call("fixture.bookkeeping", { object: ORDER, id }, outside(a.principal));
    expect(kept).toMatchObject({ ok: true });
    expect((kept as { value: { people: number } }).value.people).toBeGreaterThan(0);
    // A field the customer may not write, recorded by the handler itself: refused in full.
    const hidden = await call(
      "fixture.bookkeeping",
      { object: ORDER, id, field: "internalNote" },
      outside(a.principal),
    );
    expect(hidden).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const row = await env.DB.prepare(
      `SELECT internal_note AS n FROM ${`x_${ORDER.replace(".", "_")}`} WHERE id = ?`,
    )
      .bind(id)
      .first<{ n: string }>();
    expect(row?.n).toBe(a.values[ORDER]?.internalNote);
  });

  it("the flag is refused on an extension tool and on an operation that is not open", () => {
    const base = {
      description: "A fixture operation for the hostInternal checks.",
      input: z.object({}),
      output: z.object({}),
      permission: "records:read",
      risk: "read",
      handler: async () => ({}),
    } as const;
    expect(() =>
      defineOperation({
        ...base,
        name: "x.shop.tool",
        audiences: ["customer"],
        hostInternal: true,
      }),
    ).toThrow(/an extension tool can never be hostInternal/);
    expect(() =>
      createRegistry([
        { ...base, name: "x.shop.tool", audiences: ["customer"], hostInternal: true } as never,
      ]),
    ).toThrow(/an extension tool can never be hostInternal/);
    expect(() => defineOperation({ ...base, name: "fixture.closed", hostInternal: true })).toThrow(
      /hostInternal is only for an operation open to customer or public callers/,
    );
  });
});

describe("the audit actor is checked in code (migration 0400 dropped the CHECK)", () => {
  it("a call with an actor that is not one cannot be written", async () => {
    const audits = await count("SELECT count(*) AS n FROM core_audit");
    const forged = context(admin, { actor: "robot" as never });
    expect(await call("person.create", { givenName: "Robot" }, forged)).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
    expect(await count("SELECT count(*) AS n FROM core_audit")).toBe(audits);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_audit WHERE actor NOT IN ('human','assistant','mcp','automation','extension','customer','public')",
      ),
    ).toBe(0);
  });
});

describe("rate limits in the pipeline (criterion 14)", () => {
  it("a customer is limited per account and per operation, before any work is done", async () => {
    const rateLimit = memoryRateLimit(2);
    const ctx = () => outside(a.principal, { rateLimit });
    expect((await call("fixture.myList", { object: ORDER }, ctx())).ok).toBe(true);
    expect((await call("fixture.myList", { object: ORDER }, ctx())).ok).toBe(true);
    const third = await call("fixture.myList", { object: ORDER }, ctx());
    expect(third).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    // Another operation, and another account, have their own count.
    expect((await call("fixture.whoAmI", {}, ctx())).ok).toBe(true);
    const other = { ...a.principal, customerId: "cus_someone_else" };
    expect((await call("fixture.whoAmI", {}, outside(other, { rateLimit }))).ok).toBe(true);
    // A call to an operation the caller may not make is not counted: it does not exist for them.
    const before = rateLimit.hits(`customer:${a.principal.customerId}:person.list`);
    await call("person.list", {}, ctx());
    expect(rateLimit.hits(`customer:${a.principal.customerId}:person.list`)).toBe(before);
  });
});
