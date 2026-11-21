// Stage 23, the HTTP surface (ADR 0403, ADR 0415): the route, the callers, the envelope, the
// manifest and cross-origin calls. Isolation over HTTP is http-isolation.test.ts; keys are
// http-idempotency.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import committed from "../open-operations.json";
import {
  type ActingUser,
  type AnyInvocationContext,
  audiencesOf,
  coreRegistry,
  type OpenOperationsFile,
  openOperations,
} from "../src/index.ts";
import {
  type Customer,
  createCustomer,
  fixtureRegistry,
  installShop,
  ORDER,
  outside,
  PUBLIC,
} from "./customer-fixtures.ts";
import { context, createUser, db } from "./helpers.ts";
import { ORIGIN, opRequest, outcomeOf, surfaceOver, tokenFor } from "./http-helpers.ts";

const PUBLIC_CTX = outside(PUBLIC);
const surface = surfaceOver(fixtureRegistry, PUBLIC_CTX, {
  allowedOrigins: ["https://shop.example"],
});
const core = surfaceOver(coreRegistry, PUBLIC_CTX);

let admin: ActingUser;
let a: Customer;

beforeAll(async () => {
  admin = await createUser("admin");
  await installShop();
  a = await createCustomer(admin, "A");
}, 60_000);

const staffCtx = (): AnyInvocationContext => context(admin, { origin: { surface: "client" } });

async function said(response: Response | null) {
  if (!response) throw new Error("not served");
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the envelope holds
  return { status: response.status, body: (await response.json()) as any };
}

describe("the route", () => {
  it("serves only /api/v1", async () => {
    expect(await surface.handle(new Request(`${ORIGIN}/api/v2/op/x`))).toBeNull();
    expect(await surface.handle(new Request(`${ORIGIN}/mcp`))).toBeNull();
    expect(await said(await surface.handle(new Request(`${ORIGIN}/api/v1/nothing`)))).toEqual({
      status: 404,
      body: { error: { code: "not_found", message: "No such route" } },
    });
  });

  it("runs an operation for each of the three callers, from the request's credential", async () => {
    for (const [ctx, kind] of [
      [staffCtx(), "staff"],
      [outside(a.principal), "customer"],
      [null, "public"],
    ] as const) {
      const out = await said(await surface.handle(opRequest("fixture.whoAmI", {}, ctx)));
      expect(out).toEqual({ status: 200, body: { data: { kind } } });
    }
  });

  it("is POST with JSON", async () => {
    const get = await surface.handle(opRequest("fixture.whoAmI", {}, null, { method: "GET" }));
    expect(get?.status).toBe(405);
    expect(get?.headers.get("allow")).toBe("POST");
    const form = await surface.handle(
      opRequest("fixture.whoAmI", {}, null, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(await said(form)).toMatchObject({
      status: 415,
      body: { error: { code: "invalid_input" } },
    });
    const broken = await surface.handle(opRequest("fixture.whoAmI", {}, null, { body: "{nope" }));
    expect(await said(broken)).toEqual({
      status: 400,
      body: { error: { code: "invalid_input", message: "The request body is not valid JSON" } },
    });
    const empty = await surface.handle(opRequest("fixture.whoAmI", {}, null, { body: "" }));
    expect(await said(empty)).toEqual({ status: 200, body: { data: { kind: "public" } } });
  });
});

describe("the envelope", () => {
  it("carries the existing codes and the details operations return", async () => {
    const bad = await said(
      await surface.handle(opRequest("fixture.myGet", { object: ORDER }, outside(a.principal))),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_input");
    expect(bad.body.error.details.issues[0].path).toEqual(["id"]);

    const missing = await said(
      await surface.handle(
        opRequest("fixture.myGet", { object: ORDER, id: "rec_nope" }, outside(a.principal)),
      ),
    );
    expect(missing).toEqual({
      status: 404,
      body: {
        error: {
          code: "not_found",
          message: `No ${ORDER} with id rec_nope`,
          details: { object: ORDER, id: "rec_nope" },
        },
      },
    });
    // A handler's own failure goes out to an outside caller as its code alone.
    const raw = await said(
      await surface.handle(
        opRequest("fixture.rawAccess", { how: "db", object: ORDER, id: "x" }, outside(a.principal)),
      ),
    );
    expect(raw).toEqual({
      status: 500,
      body: { error: { code: "internal", message: "Internal error" } },
    });
  });
});

describe("what a caller may not call does not exist for them", () => {
  const STAFF_OPERATION = "person.create";
  const unknown = (name: string) => ({
    status: 404,
    body: { error: { code: "unknown_operation", message: `No operation named "${name}"` } },
  });

  it("a staff operation answers a customer and the public as a name that does not exist", async () => {
    for (const ctx of [outside(a.principal), null]) {
      for (const name of [STAFF_OPERATION, "record.list", "query.sql", "no.such"]) {
        const out = await said(await core.handle(opRequest(name, { givenName: "x" }, ctx)));
        expect(out, name).toEqual(unknown(name));
      }
    }
  });

  it("a customer's credential on a staff operation gets exactly what no credential gets", async () => {
    for (const name of [STAFF_OPERATION, "user.list", "export.csv"]) {
      const withToken = await core.handle(opRequest(name, {}, outside(a.principal)));
      const without = await core.handle(opRequest(name, {}, null));
      expect(withToken?.status).toBe(without?.status);
      expect(await withToken?.text()).toBe(await without?.text());
    }
  });

  it("a tool-only operation and a customer-only one are closed to the callers they are not for", async () => {
    for (const name of ["my.create", "my.update"]) {
      const out = await said(await core.handle(opRequest(name, {}, outside(a.principal))));
      expect(out, name).toEqual(unknown(name));
    }
    const staffAsks = await said(await core.handle(opRequest("me.get", {}, staffCtx())));
    expect(staffAsks).toEqual(unknown("me.get"));
  });

  it("a credential that is not a session is refused before anything is looked at", async () => {
    const forged = await core.handle(
      opRequest("me.get", {}, null, { headers: { authorization: "Bearer forged" } }),
    );
    expect(await said(forged)).toEqual({
      status: 403,
      body: { error: { code: "forbidden", message: "Sign in again" } },
    });
  });
});

describe("the manifest", () => {
  const manifestOf = async (s: typeof core, ctx: AnyInvocationContext | null) => {
    const headers: Record<string, string> = {};
    if (ctx && ctx.principal?.kind !== "public") headers.authorization = `Bearer ${tokenFor(ctx)}`;
    const out = await said(await s.handle(new Request(`${ORIGIN}/api/v1/manifest`, { headers })));
    expect(out.status).toBe(200);
    return out.body.data as {
      audience: string;
      operations: { name: string; risk: string; input: unknown; output: unknown }[];
    };
  };
  const generated = committed as OpenOperationsFile;
  const listed = (file: OpenOperationsFile, audience: "customer" | "public") =>
    file.operations
      .filter((op) => op.audiences.includes(audience) && !op.toolOnly)
      .map((op) => op.name)
      .sort();

  it("for a customer lists exactly the generated list's customer operations", async () => {
    const m = await manifestOf(core, outside(a.principal));
    expect(m.audience).toBe("customer");
    expect(m.operations.map((op) => op.name)).toEqual(listed(generated, "customer"));
    expect(m.operations.length).toBeGreaterThan(0);
  });

  it("for the public lists exactly the public ones", async () => {
    const m = await manifestOf(core, null);
    expect(m.audience).toBe("public");
    expect(m.operations.map((op) => op.name)).toEqual(listed(generated, "public"));
  });

  it("follows the registry: with the fixtures opened, the fixtures' operations appear", async () => {
    const file = openOperations(fixtureRegistry.list());
    expect((await manifestOf(surface, outside(a.principal))).operations.map((o) => o.name)).toEqual(
      listed(file, "customer"),
    );
    expect((await manifestOf(surface, null)).operations.map((o) => o.name)).toEqual(
      listed(file, "public"),
    );
  });

  it("never names a staff operation to a customer, and gives JSON Schema for each", async () => {
    const m = await manifestOf(core, outside(a.principal));
    for (const op of m.operations) {
      const registered = coreRegistry.get(op.name);
      expect(registered && audiencesOf(registered)).toContain("customer");
      expect(op.input).toMatchObject({ type: "object" });
      expect(op.output).toBeTypeOf("object");
    }
    const staff = await manifestOf(core, staffCtx());
    expect(staff.audience).toBe("staff");
    expect(staff.operations.map((o) => o.name)).toContain("person.create");
    expect(staff.operations.map((o) => o.name)).not.toContain("me.get");
  });
});

describe("cross-origin calls", () => {
  const from = (origin: string | null, method = "POST") =>
    opRequest("fixture.whoAmI", {}, null, {
      method,
      headers: origin ? { origin } : {},
      ...(method === "OPTIONS" ? { body: undefined } : {}),
    });

  it("are allowed from a listed origin and refused from any other", async () => {
    const listed = await surface.handle(from("https://shop.example"));
    expect(listed?.status).toBe(200);
    expect(listed?.headers.get("access-control-allow-origin")).toBe("https://shop.example");
    const other = await surface.handle(from("https://evil.example"));
    expect(await said(other)).toEqual({
      status: 403,
      body: { error: { code: "forbidden", message: "This origin may not call the API" } },
    });
    expect((await surface.handle(from(ORIGIN)))?.status).toBe(200);
    // A phone or a server sends no origin.
    expect((await surface.handle(from(null)))?.status).toBe(200);
  });

  it("answer a preflight from a listed origin only", async () => {
    const ok = await surface.handle(
      new Request(`${ORIGIN}/api/v1/op/fixture.whoAmI`, {
        method: "OPTIONS",
        headers: { origin: "https://shop.example" },
      }),
    );
    expect(ok?.status).toBe(204);
    expect(ok?.headers.get("access-control-allow-headers")).toContain("idempotency-key");
    const refused = await surface.handle(
      new Request(`${ORIGIN}/api/v1/op/fixture.whoAmI`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(refused?.status).toBe(403);
  });
});

it("calls go through the pipeline: an outside write over HTTP is audited as one", async () => {
  const id = a.records[ORDER]?.[0] as string;
  const response = await surface.handle(
    opRequest(
      "fixture.myUpdate",
      { object: ORDER, id, values: { note: "over HTTP" } },
      outside(a.principal),
    ),
  );
  expect(await outcomeOf(response as Response)).toMatchObject({
    ok: true,
    value: { values: { note: "over HTTP" } },
  });
  const row = await db.query
    .selectFrom("core_audit")
    .selectAll()
    .where("operation", "=", "fixture.myUpdate")
    .where("user_id", "=", a.principal.customerId)
    .orderBy("at", "desc")
    .executeTakeFirstOrThrow();
  expect(row).toMatchObject({ actor: "customer", outcome: "ok" });
  expect(JSON.parse(row.origin)).toEqual({ surface: "client" });
});
