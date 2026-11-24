// Stage 22 step 6 (ADR 0414): a pack's tool called by a customer runs as that customer. Its
// operation calls go through the pipeline's outside path with the same principal, so the tool
// reaches only the caller's own records, and may set only the object's writable fields plus the
// ones the tool itself lists. Real D1, the real workspace and the real sandbox.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  invokeByName,
  type OutsideInvocationContext,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { call, createAdmin, db, host, install, source, unique } from "./helpers.ts";

let admin: ActingUser;
let a: CustomerPrincipal;
let b: CustomerPrincipal;
let orderA: string;
let orderB: string;
const id = unique("shop");
const ORDER = `${id}.order`;

const tool = (name: string, body: string) => `${name}: defineTool({
      description: "A test tool a customer calls on one of their orders.",
      input: z.object({ id: z.string() }),
      output: z.unknown(),
      handler: async ({ id }, ctx) => { ${body} },
    }),`;

/**
 * Installs go through the workspace, which holds runtime extensions, and a runtime extension may
 * not open a tool. So the test installs the extension plain and then makes it what a shipped one
 * with these declarations would be: the stored manifest and object definition, edited in place.
 */
async function ship(shipped: boolean): Promise<void> {
  const row = await env.DB.prepare("SELECT manifest FROM core_extensions WHERE id = ?")
    .bind(id)
    .first<{ manifest: string }>();
  const manifest = JSON.parse(row?.manifest ?? "{}");
  const customer = { field: "buyer", read: ["title", "status", "note"], write: ["note"] };
  manifest.objects.order.customer = customer;
  for (const name of ["cancel", "setSecret", "peek", "mine", "steal"]) {
    manifest.tools[name].audiences = ["customer"];
  }
  manifest.tools.cancel.customerFields = { [ORDER]: ["status"] };
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE core_extensions SET source = ?, manifest = ? WHERE id = ?").bind(
      shipped ? "shipped" : "runtime",
      JSON.stringify(manifest),
      id,
    ),
    env.DB.prepare(
      "UPDATE core_extension_objects SET definition = json_set(definition, '$.customer', json(?)), updated_at = ? WHERE name = ?",
    ).bind(JSON.stringify(customer), now, ORDER),
  ]);
}

const outside = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  extensionHost: host,
});

async function outcome(run: Promise<unknown>) {
  try {
    return { ok: true as const, value: await run };
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: { code?: string } };
    return { ok: false as const, code: e.code, message: e.message, inner: e.details?.code };
  }
}

const stored = (orderId: string) =>
  env.DB.prepare(`SELECT status, note, secret, buyer FROM x_${id}_order WHERE id = ?`)
    .bind(orderId)
    .first<{ status: string; note: string | null; secret: string; buyer: string }>();

beforeAll(async () => {
  admin = await createAdmin();
  await install(
    admin,
    id,
    source(
      id,
      `permissions: { modules: ["ops"] },
  objects: {
    order: {
      label: "Order", plural: "Orders", titleField: "title",
      fields: {
        title: { type: "text", label: "Title", required: true },
        status: { type: "select", label: "Status", options: [{ value: "open", label: "Open" }, { value: "cancelled", label: "Cancelled" }] },
        note: { type: "text", label: "Note" },
        secret: { type: "text", label: "Staff note" },
        buyer: { type: "relation", label: "Buyer", to: "person" },
      },
    },
  },
  tools: {
    ${tool("cancel", `return ctx.ops.call("my.update", { object: "${ORDER}", id, values: { status: "cancelled" } });`)}
    ${tool("setSecret", `return ctx.ops.call("my.update", { object: "${ORDER}", id, values: { secret: "changed" } });`)}
    ${tool("peek", `return ctx.ops.call("record.get", { object: "${ORDER}", id });`)}
    ${tool("mine", `return ctx.ops.call("my.list", { object: "${ORDER}" });`)}
    ${tool("steal", `return ctx.ops.call("my.update", { object: "${ORDER}", id, values: { buyer: "per_someone" } });`)}
  },`,
    ),
  );
  const people: CustomerPrincipal[] = [];
  const orders: string[] = [];
  for (const label of ["A", "B"]) {
    const person = await call<{ id: string }>(admin, "person.create", { givenName: unique(label) });
    people.push({ kind: "customer", customerId: `cus_${unique(label)}`, personId: person.id });
    const order = await call<{ id: string }>(admin, "record.create", {
      object: ORDER,
      values: {
        title: `Order ${label}`,
        status: "open",
        secret: `secret-${label}`,
        buyer: person.id,
      },
    });
    orders.push(order.id);
  }
  [a, b] = people as [CustomerPrincipal, CustomerPrincipal];
  [orderA, orderB] = orders as [string, string];
  await ship(true);
}, 120_000);

describe("a pack's tool called by a customer", () => {
  it("changes the caller's own record, in a field the tool lists", async () => {
    const done = await outcome(invokeByName(`x.${id}.cancel`, { id: orderA }, outside(a)));
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true });
    // What the tool got back is the record as the customer may see it.
    expect((done as { value: { values: object } }).value.values).toEqual({
      title: "Order A",
      status: "cancelled",
      note: null,
    });
    expect(await stored(orderA)).toMatchObject({ status: "cancelled", secret: "secret-A" });
    const audit = await env.DB.prepare(
      `SELECT a.actor, a.user_id, a.operation, c.diff FROM core_audit_changes c
       JOIN core_audit a ON a.id = c.audit_id WHERE c.record_id = ? AND a.actor = 'customer'`,
    )
      .bind(orderA)
      .first<{ actor: string; user_id: string; operation: string; diff: string }>();
    expect(audit).toMatchObject({
      actor: "customer",
      user_id: a.customerId,
      operation: "my.update",
    });
    expect(Object.keys(JSON.parse(audit?.diff ?? "{}"))).toEqual(["status"]);
  });

  it("cannot touch another customer's record: to the tool it is not there", async () => {
    const refused = await outcome(invokeByName(`x.${id}.cancel`, { id: orderB }, outside(a)));
    expect(refused).toMatchObject({ ok: false, code: "extension_error" });
    expect(JSON.stringify(refused)).not.toContain("secret-B");
    expect(await stored(orderB)).toMatchObject({ status: "open", buyer: b.personId });
    const list = await outcome(invokeByName(`x.${id}.mine`, { id: "x" }, outside(a)));
    expect(list.ok, JSON.stringify(list)).toBe(true);
    const items = (list as { value: { items: { id: string }[] } }).value.items;
    expect(items.map((item) => item.id)).toEqual([orderA]);
  });

  it("sets nothing the tool does not list, and never whose record it is", async () => {
    for (const name of ["setSecret", "steal"]) {
      const refused = await outcome(invokeByName(`x.${id}.${name}`, { id: orderA }, outside(a)));
      expect(refused, name).toMatchObject({ ok: false, code: "extension_error" });
    }
    expect(await stored(orderA)).toMatchObject({ secret: "secret-A", buyer: a.personId });
  });

  it("reaches no operation that is not open to the customer", async () => {
    const refused = await outcome(invokeByName(`x.${id}.peek`, { id: orderA }, outside(a)));
    expect(refused).toMatchObject({ ok: false, code: "extension_error" });
    expect(JSON.stringify(refused)).not.toContain("secret-A");
  });

  it("my.update is not something a customer calls themselves", async () => {
    const direct = await outcome(
      invokeByName("my.update", { object: ORDER, id: orderA, values: { note: "hi" } }, outside(a)),
    );
    expect(direct).toMatchObject({ ok: false, code: "unknown_operation" });
    // Nor by claiming to be a tool that is not open to them or does not exist.
    for (const claimed of ["nothing", "cancel"]) {
      const forged = await outcome(
        invokeByName(
          "my.update",
          { object: ORDER, id: orderA, values: { secret: "x" } },
          { ...outside(a), tool: { extension: claimed === "cancel" ? id : "nope", tool: claimed } },
        ),
      );
      expect(forged.ok, claimed).toBe(false);
    }
    expect(await stored(orderA)).toMatchObject({ secret: "secret-A" });
  });

  it("a tool cannot make an operation kept to a person, such as deleting the account", async () => {
    // As the runner calls an operation for the shipped tool `cancel` the customer called. Stage
    // 48 step 6 (ADR 0713): me.deleteAccount ends subscriptions, and is `actors: ["human"]`.
    for (const [name, input] of [
      ["me.deleteAccount", {}],
      ["subscription.cancel", { id: "sbs_none" }],
    ] as const) {
      const refused = await invokeByName(name, input, {
        ...outside(a),
        tool: { extension: id, tool: "cancel" },
      }).catch((error: { code?: string; details?: { rule?: string } }) => error);
      expect(refused, name).toMatchObject({ code: "forbidden", details: { rule: "actor" } });
    }
  });

  it("a tool open to customers alone does not exist for staff", async () => {
    const refused = await outcome(call(admin, `x.${id}.cancel`, { id: orderA }));
    expect(refused).toMatchObject({ ok: false, code: "unknown_operation" });
  });

  it("a runtime extension's tool is closed to customers whatever its manifest says", async () => {
    await ship(false);
    try {
      const refused = await outcome(invokeByName(`x.${id}.cancel`, { id: orderA }, outside(a)));
      expect(refused).toMatchObject({ ok: false, code: "unknown_operation" });
    } finally {
      await ship(true);
    }
  });
});
