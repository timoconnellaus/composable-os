// Stage 23 in cos-app: the HTTP surface with real sessions (ADR 0403, ADR 0415).
//
// - Acceptance criterion 1, one pipeline: a call over HTTP and the same call as a server function
//   produce the same audit row, field diffs and timeline posts, for a write of each risk class
//   staff may make (write, bulk-write, destructive). A customer's write over HTTP matches the same
//   write through invoke(), since customers have no server functions.
// - Who the caller is comes from the session: a Better Auth staff cookie is staff, a customer
//   cookie is that customer, none is the public, and both at once are refused.
// - Acceptance criterion 4's last part: a customer's session on a staff operation gets the answer
//   no session gets.
import { env } from "cloudflare:workers";
import { createCustomerAuth, createIdentityProvider, customerIdentity } from "@composable-os/auth";
import {
  coreInvoker,
  forPacks,
  inviteCustomer,
  loadCustomer,
  type OpenOperationsFile,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import openOperations from "../../../packages/core/open-operations.json";
import { type ApiEnv, handleApi, handleCustomerAuth } from "../src/server/http/api.ts";
import type { McpEnv } from "../src/server/mcp/handler.ts";
import { runOperation } from "../src/server/operations.ts";
import { ORIGIN, signUp, type TestUser, testEnv, unique } from "./mcp-helpers.ts";

const CUSTOMER_SECRET = "customer-secret-customer-secret-456";
const apiEnv = {
  ...testEnv(),
  CUSTOMER_AUTH_SECRET: CUSTOMER_SECRET,
  CUSTOMER_AUTH_URL: ORIGIN,
} as unknown as ApiEnv & McpEnv;
const db = createCrmDb(env.DB);

let admin: TestUser;
let customerCookie = "";
let customerId = "";
let personId = "";
let code = "";

const customers = customerIdentity(
  createCustomerAuth({
    db: env.DB,
    secret: CUSTOMER_SECRET,
    baseURL: ORIGIN,
    sendCode: async (message) => {
      code = message.code;
    },
  }),
  env.DB,
);

const json = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  admin = await signUp(apiEnv, "admin");
  const email = `${unique("customer")}@example.com`;
  await inviteCustomer(db, email, admin.id, new Date().toISOString());
  await customers.handle(
    json("/api/customer-auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
  );
  const signedIn = await customers.handle(
    json("/api/customer-auth/sign-in/email-otp", { email, otp: code }),
  );
  customerCookie = (signedIn?.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
  const principal = await customers.resolve(
    new Request(ORIGIN, { headers: { cookie: customerCookie } }),
  );
  if (principal.kind !== "customer") throw new Error("customer did not sign in");
  customerId = principal.customerId;
  personId = principal.personId;
}, 60_000);

/** POST /api/v1/op/<name> with a cookie (or none) and, for writes, a fresh key. */
async function api(name: string, input: unknown, cookie?: string, key = crypto.randomUUID()) {
  const response = await handleApi(
    new Request(`${ORIGIN}/api/v1/op/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(input),
    }),
    apiEnv,
  );
  if (!response) throw new Error("not served");
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the envelope holds
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** The same call as the UI's server function makes it. */
async function serverFn(name: string, input: unknown) {
  const principal = await createIdentityProvider(apiEnv).resolve(
    new Request(ORIGIN, { headers: { cookie: admin.cookie } }),
  );
  return runOperation(apiEnv, principal, { name, input });
}

/** Ids, times and the audit's own id replaced by placeholders, so two calls compare. */
function normalise(value: unknown, ids: Record<string, string>): unknown {
  let text = JSON.stringify(value);
  for (const [real, alias] of Object.entries(ids)) text = text.split(real).join(alias);
  text = text
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>")
    .replace(/\b(audit|act|aud)_[A-Za-z0-9]+/g, "<$1>");
  return JSON.parse(text);
}

/** What one call left behind: its audit row, its field diffs and its timeline posts. */
async function traceOf(operation: string, recordIds: string[], since: string) {
  const audit = await db.query
    .selectFrom("core_audit")
    .selectAll()
    .where("operation", "=", operation)
    .where("at", ">=", since)
    .orderBy("at", "desc")
    .executeTakeFirstOrThrow();
  const changes = await db.query
    .selectFrom("core_audit_changes")
    .select(["object_type", "record_id", "action", "diff"])
    .where("audit_id", "=", audit.id)
    .orderBy("id")
    .execute();
  const posts = await db.query
    .selectFrom("core_activity as a")
    .innerJoin("core_activity_links as l", "l.activity_id", "a.id")
    .select(["a.type", "a.subject", "a.payload", "a.author_user_id", "a.author_actor"])
    .where("l.record_id", "in", recordIds)
    .where("a.created_at", ">=", since)
    .orderBy("a.id")
    .execute();
  const { id: _id, at: _at, origin, ...row } = audit;
  return {
    origin: JSON.parse(origin) as { surface: string },
    row: { ...row, input: JSON.parse(row.input), result: row.result && JSON.parse(row.result) },
    changes: changes.map((c) => ({ ...c, diff: JSON.parse(c.diff) })),
    posts: posts.map((p) => ({ ...p, payload: JSON.parse(p.payload) })),
  };
}

async function twoOrganisations(label: string): Promise<[string, string]> {
  const ids: string[] = [];
  for (let n = 0; n < 2; n += 1) {
    // The same name for both: the two calls must differ only in their surface.
    const made = await serverFn("organisation.create", { name: label, industry: "Old" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    ids.push((made.data as { id: string }).id);
  }
  return ids as [string, string];
}

describe("one pipeline: HTTP and the server function leave the same trace", () => {
  const cases = [
    {
      risk: "write",
      operation: "organisation.update",
      input: (id: string) => ({ id, name: "Renamed", industry: "New" }),
    },
    {
      risk: "bulk-write",
      operation: "organisation.updateMany",
      input: (id: string) => ({ ids: [id], set: { industry: "Bulk", ownerId: admin.id } }),
    },
    {
      risk: "destructive",
      operation: "organisation.delete",
      input: (id: string) => ({ id }),
    },
  ] as const;

  for (const c of cases) {
    it(`${c.risk}: ${c.operation}`, async () => {
      const [viaFn, viaHttp] = await twoOrganisations(unique(c.risk));
      const since = new Date(Date.now() - 1000).toISOString();

      const fn = await serverFn(c.operation, c.input(viaFn));
      expect(fn.ok, JSON.stringify(fn)).toBe(true);
      const fnTrace = await traceOf(c.operation, [viaFn], since);

      const http = await api(c.operation, c.input(viaHttp), admin.cookie);
      expect(http.status, JSON.stringify(http.body)).toBe(200);
      const httpTrace = await traceOf(c.operation, [viaHttp], since);

      // The same output, but for the record's own id.
      expect(normalise(http.body.data, { [viaHttp]: "<org>" })).toEqual(
        normalise(fn.ok ? fn.data : null, { [viaFn]: "<org>" }),
      );
      // Where the call came from is the one difference.
      expect(fnTrace.origin).toEqual({ surface: "ui" });
      expect(httpTrace.origin).toEqual({ surface: "client" });
      const a = normalise({ ...fnTrace, origin: null }, { [viaFn]: "<org>" });
      const b = normalise({ ...httpTrace, origin: null }, { [viaHttp]: "<org>" });
      expect(b).toEqual(a);
      expect(fnTrace.row).toMatchObject({
        actor: "human",
        user_id: admin.id,
        outcome: "ok",
        risk: c.risk,
      });
      // Not vacuous: each write left field diffs, and the renames and owner changes a post.
      expect(fnTrace.changes.length).toBeGreaterThan(0);
      if (c.risk !== "destructive") expect(fnTrace.posts.length).toBeGreaterThan(0);
    });
  }

  it("write, for a customer: HTTP and invoke() leave the same trace", async () => {
    const direct = (primaryPhone: string) =>
      coreInvoker.invokeByName(
        "me.update",
        { primaryPhone },
        {
          principal: { kind: "customer", customerId, personId },
          db,
          origin: { surface: "client" },
        },
      );
    await direct("+1 555 0101");
    const since = new Date().toISOString();
    const http = await api("me.update", { primaryPhone: "+1 555 0102" }, customerCookie);
    expect(http.status, JSON.stringify(http.body)).toBe(200);
    expect((http.body.data as { primaryPhone: string }).primaryPhone).toBe("+1 555 0102");
    const httpTrace = await traceOf("me.update", [personId], since);
    const since2 = new Date().toISOString();
    await direct("+1 555 0103");
    const directTrace = await traceOf("me.update", [personId], since2);

    expect(httpTrace.row).toMatchObject({ actor: "customer", user_id: customerId, outcome: "ok" });
    expect(httpTrace.changes).toHaveLength(1);
    expect(httpTrace.changes[0]?.diff).toMatchObject({
      phones: { before: [{ number: "+1 555 0101" }], after: [{ number: "+1 555 0102" }] },
    });
    // Over HTTP the origin also names the session the call came with (its cookie's).
    expect(httpTrace.origin).toEqual({ surface: "client", sessionId: expect.any(String) });
    expect(directTrace.origin).toEqual({ surface: "client" });
    expect(
      normalise(
        { ...httpTrace, origin: null },
        { "+1 555 0101": "<before>", "+1 555 0102": "<after>" },
      ),
    ).toEqual(
      normalise(
        { ...directTrace, origin: null },
        { "+1 555 0102": "<before>", "+1 555 0103": "<after>" },
      ),
    );
  });
});

describe("the caller is the session's", () => {
  it("a customer cookie is that customer, and no cookie is the public", async () => {
    const me = await api("me.get", {}, customerCookie);
    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(personId);
    const account = await loadCustomer(db.query, customerId);
    expect(account?.personId).toBe(personId);
    const nobody = await api("me.get", {});
    expect(nobody).toEqual({
      status: 404,
      body: { error: { code: "unknown_operation", message: 'No operation named "me.get"' } },
    });
  });

  it("a staff cookie is staff: staff operations run, customer ones do not exist", async () => {
    const list = await api("organisation.list", {}, admin.cookie);
    expect(list.status).toBe(200);
    const me = await api("me.get", {}, admin.cookie);
    expect(me.status).toBe(404);
  });

  it("a customer cookie on a staff operation gets the answer no cookie gets", async () => {
    for (const name of ["organisation.list", "person.create", "query.sql", "export.csv"]) {
      const customer = await api(name, {}, customerCookie);
      const none = await api(name, {});
      expect(customer, name).toEqual(none);
      expect(customer.status).toBe(404);
    }
  });

  it("a staff cookie and a customer cookie together are refused", async () => {
    const both = await api("organisation.list", {}, `${admin.cookie}; ${customerCookie}`);
    expect(both).toEqual({
      status: 403,
      body: {
        error: {
          code: "forbidden",
          message: "This request carries a staff session and a customer session. Sign out of one.",
        },
      },
    });
  });

  it("the manifest is the caller's: a customer's names no staff operation", async () => {
    const manifest = async (cookie?: string) => {
      const response = await handleApi(
        new Request(`${ORIGIN}/api/v1/manifest`, cookie ? { headers: { cookie } } : {}),
        apiEnv,
      );
      if (!response) throw new Error("not served");
      return ((await response.json()) as { data: { operations: { name: string }[] } }).data;
    };
    const names = (await manifest(customerCookie)).operations.map((o) => o.name);
    expect(names).toContain("me.get");
    // Exactly the generated list's operations for each audience (tool-only ones are not called
    // directly), so a newly opened one (stage 26's capacity.get) is expected without naming it.
    // The generated list is the union over every pack the release carries, each tool named with
    // its pack; this deployment installs no pack, so it serves exactly the list's core slice.
    // The packs this test's host installs: none (it loads no extension).
    const INSTALLED_PACKS: string[] = [];
    const listed = (audience: "customer" | "public") =>
      forPacks(openOperations as OpenOperationsFile, INSTALLED_PACKS)
        .operations.filter(
          (op) =>
            (op.audiences as string[]).includes(audience) &&
            !("toolOnly" in op) &&
            !("deskOnly" in op),
        )
        .map((op) => op.name)
        .sort();
    expect([...names].sort()).toEqual(listed("customer"));
    expect((await manifest()).operations.map((o) => o.name).sort()).toEqual(listed("public"));
    expect((await manifest(admin.cookie)).operations.map((o) => o.name)).toContain(
      "organisation.list",
    );
  });
});

describe("native apps: tokens (ADR 0419, criterion 4)", () => {
  async function auth(path: string, payload: unknown, headers: Record<string, string> = {}) {
    const response = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload),
      }),
      apiEnv,
    );
    if (!response) throw new Error("not served");
    // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the envelope holds
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }
  const bearer = (token: string) => `Bearer ${token}`;

  async function apiWith(name: string, input: unknown, authorization?: string) {
    const response = await handleApi(
      new Request(`${ORIGIN}/api/v1/op/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(input),
      }),
      apiEnv,
    );
    if (!response) throw new Error("not served");
    return { status: response.status, body: await response.text() };
  }

  it("a customer exchanges their sign-in for tokens and calls with them", async () => {
    const tokens = await auth("token", { deviceName: "Ada's iPhone" }, { cookie: customerCookie });
    expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);
    expect(tokens.body.data.accessToken).toMatch(/^cos_at_/);
    const me = await apiWith("me.get", {}, bearer(tokens.body.data.accessToken));
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body).data.id).toBe(personId);
    const sessions = JSON.parse(
      (await apiWith("me.sessions.list", {}, bearer(tokens.body.data.accessToken))).body,
    ).data.items as { deviceName: string | null; current: boolean }[];
    expect(sessions).toContainEqual(
      expect.objectContaining({ deviceName: "Ada's iPhone", current: true }),
    );
  });

  it("a customer token on a staff operation gets exactly the answer no token gets", async () => {
    const tokens = await auth("token", { deviceName: "Phone" }, { cookie: customerCookie });
    const token = bearer(tokens.body.data.accessToken);
    for (const name of ["organisation.list", "person.create", "deviceSession.list"]) {
      expect(await apiWith(name, {}, token), name).toEqual(await apiWith(name, {}));
    }
  });

  it("staff exchange theirs; a staff token is staff, and only for staff operations", async () => {
    const tokens = await auth("token", { deviceName: "Admin's tablet" }, { cookie: admin.cookie });
    expect(tokens.status).toBe(200);
    const token = bearer(tokens.body.data.accessToken);
    expect((await apiWith("organisation.list", {}, token)).status).toBe(200);
    expect((await apiWith("me.get", {}, token)).status).toBe(404);
    const mine = JSON.parse((await apiWith("deviceSession.list", {}, token)).body).data.items;
    expect(mine.map((s: { deviceName: string }) => s.deviceName)).toContain("Admin's tablet");
  });

  it("a refresh rotates the tokens; using the old refresh token again ends the session", async () => {
    const first = (await auth("token", { deviceName: "Phone" }, { cookie: customerCookie })).body
      .data;
    const second = await auth("refresh", { refreshToken: first.refreshToken });
    expect(second.status).toBe(200);
    expect((await apiWith("me.get", {}, bearer(second.body.data.accessToken))).status).toBe(200);
    const replay = await auth("refresh", { refreshToken: first.refreshToken });
    expect(replay).toMatchObject({
      status: 401,
      body: { error: { code: "forbidden", details: { reason: "refresh_reused" } } },
    });
    // The whole session is gone: the newest access token stops too.
    const after = await apiWith("me.get", {}, bearer(second.body.data.accessToken));
    expect(after.status).toBe(401);
    expect(JSON.parse(after.body).error.details.reason).toBe("token_invalid");
  });

  it("there is nothing to exchange without a sign-in", async () => {
    const none = await auth("token", { deviceName: "Phone" });
    expect(none).toMatchObject({
      status: 401,
      body: { error: { details: { reason: "not_signed_in" } } },
    });
  });
});

describe("customer sign-in, mounted (ADR 0419)", () => {
  it("says it is not set up until an admin chooses the email connection, for every address", async () => {
    const ask = async (email: string) => {
      const response = await handleCustomerAuth(
        json("/api/customer-auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
        apiEnv,
      );
      return { status: response.status, body: await response.text() };
    };
    const known = await ask("someone@example.com");
    expect(known.status).toBe(503);
    expect(known.body).toContain("Customer sign-in is not set up");
    expect(await ask(`${unique("stranger")}@example.com`)).toEqual(known);
  });

  it("is not served at all without CUSTOMER_AUTH_SECRET", async () => {
    const response = await handleCustomerAuth(json("/api/customer-auth/sign-in/email-otp", {}), {
      ...apiEnv,
      CUSTOMER_AUTH_SECRET: undefined,
    } as ApiEnv);
    expect(response.status).toBe(503);
  });
});
