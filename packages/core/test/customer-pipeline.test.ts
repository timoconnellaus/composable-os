// Stage 22 step 3 (ADR 0402, ADR 0412): the customer and public principals in the pipeline.
// A call from outside the org is refused by every operation that does not list its audience,
// is never queued for review, is audited as actor `customer` or `public`, and gets none of what
// a staff call carries.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type AutomationQueueMessage,
  coreOperations,
  evaluateOutsideGate,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  RISK_CLASSES,
  scopeOf,
} from "../src/index.ts";
import {
  type Customer,
  call,
  createCustomer,
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
    for (const principal of [a.principal, PUBLIC]) {
      for (const op of coreOperations) {
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
    // A floor can only refuse, and one that asks for review refuses.
    expect(evaluateOutsideGate("write", { "*": { write: "review" } })).toBe("deny");
    expect(evaluateOutsideGate("write", { "*": { "*": "deny" } })).toBe("deny");
    expect(evaluateOutsideGate("read", { "*": { write: "review" } })).toBe("auto");
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

  it("a floor that would send the write to review refuses it, and that is audited", async () => {
    const id = a.records[ORDER]?.[0] as string;
    const pending = await count("SELECT count(*) AS n FROM core_pending_action");
    const refused = await call(
      "fixture.myUpdate",
      { object: ORDER, id, values: { note: "under a floor" } },
      outside(a.principal, { floor: { "*": { write: "review" } } }),
    );
    expect(refused).toEqual({
      ok: false,
      error: { code: "denied", message: "fixture.myUpdate is not available" },
    });
    expect(await count("SELECT count(*) AS n FROM core_pending_action")).toBe(pending);
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
      "fixture.carelessUpdate",
      { object: ORDER, id, values: { note: "x" } },
      outside(a.principal),
    );
    const row = await env.DB.prepare(
      "SELECT actor, outcome, error FROM core_audit WHERE operation = 'fixture.carelessUpdate' AND outcome = 'error' ORDER BY at DESC LIMIT 1",
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
