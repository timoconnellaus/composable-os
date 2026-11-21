// Stage 22 step 5 (ADR 0402, ADR 0413): the operations open to customers. `me.get` and
// `me.update` are the caller's own Person, declared fields only; `my.list` and `my.get` read any
// object that declares a customer through the seam; the session operations touch only the
// caller's own `core_customer_session` rows and never return a token.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import committed from "../open-operations.json";
import {
  type ActingUser,
  coreRegistry,
  invoke,
  newId,
  openOperations,
  personObject,
} from "../src/index.ts";
import {
  type Customer,
  call,
  createCustomer,
  installShop,
  ORDER,
  outside,
  PUBLIC,
  TICKET,
} from "./customer-fixtures.ts";
import { context, createUser } from "./helpers.ts";

let admin: ActingUser;
let a: Customer;
let b: Customer;

const READ = ["displayName", "givenName", "familyName", "primaryEmail", "primaryPhone"];

beforeAll(async () => {
  admin = await createUser("admin");
  await installShop();
  a = await createCustomer(admin, "A");
  b = await createCustomer(admin, "B");
}, 60_000);

const OPENED = [
  "me.deleteAccount",
  "me.get",
  "me.sessions.list",
  "me.sessions.revoke",
  "me.signOut",
  "me.update",
  "my.get",
  "my.list",
];

describe("what this step opens", () => {
  it("open-operations.json lists the me.* and my.* operations, the account ones hostInternal", () => {
    // Entries a customer can call directly. `toolOnly` ones are reached only through a pack's
    // tool (ADR 0414) and are listed by the step that adds them.
    // The me.* and my.* entries: later stages list their own (orders, stage 25).
    const direct = (committed.operations as { name: string; toolOnly?: boolean }[]).filter(
      (entry) => !entry.toolOnly && /^(me|my)\./.test(entry.name),
    );
    expect(direct.map((entry) => entry.name)).toEqual(OPENED);
    expect(committed).toEqual(openOperations(coreRegistry.list()));
    for (const entry of direct as { name: string; hostInternal?: boolean }[]) {
      expect(entry.hostInternal === true, entry.name).toBe(
        ["me.deleteAccount", "me.sessions.list", "me.sessions.revoke", "me.signOut"].includes(
          entry.name,
        ),
      );
    }
  });

  it("the Person declares itself its own customer, with a short list of fields", () => {
    expect(personObject.customer).toEqual({
      field: "id",
      read: READ,
      write: ["displayName", "givenName", "familyName", "primaryPhone"],
    });
  });

  it("staff and the public cannot call them", async () => {
    for (const name of OPENED) {
      for (const ctx of [context(admin), outside(PUBLIC)]) {
        const outcome = await call(name, {}, ctx);
        expect(outcome, name).toMatchObject({ ok: false, error: { code: "unknown_operation" } });
      }
    }
  });
});

describe("me.get", () => {
  it("returns the caller's own Person, only the listed fields, in staff shape", async () => {
    const me = await call("me.get", {}, outside(a.principal));
    expect(me.ok, JSON.stringify(me)).toBe(true);
    const value = (me as { value: Record<string, unknown> }).value;
    expect(Object.keys(value).sort()).toEqual(["id", ...READ].sort());
    const staff = await invoke(
      "person.list",
      { filter: { field: "id", op: "eq", value: a.principal.personId } },
      context(admin),
    );
    const row = staff.items[0] as Record<string, unknown>;
    expect(value).toEqual(Object.fromEntries(["id", ...READ].map((k) => [k, row[k]])));
    expect(value.id).toBe(a.principal.personId);
    expect(JSON.stringify(value)).not.toContain(b.principal.personId);
  });
});

describe("me.update", () => {
  it("changes only listed writable fields, audited as the customer with a diff of those", async () => {
    const done = await call(
      "me.update",
      { givenName: "Ada", primaryPhone: "+61 400 000 001" },
      outside(a.principal),
    );
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect((done as { value: Record<string, unknown> }).value).toMatchObject({
      id: a.principal.personId,
      givenName: "Ada",
      primaryPhone: "+61 400 000 001",
    });

    // Staff see the change through the ordinary person.get.
    const person = await invoke("person.get", { id: a.principal.personId }, context(admin));
    expect(person.givenName).toBe("Ada");
    expect(person.phones).toEqual([{ number: "+61 400 000 001", label: null, primary: true }]);

    const { results } = await env.DB.prepare(
      `SELECT a.actor, a.user_id, a.outcome, c.object_type, c.record_id, c.diff
       FROM core_audit a JOIN core_audit_changes c ON c.audit_id = a.id
       WHERE a.operation = 'me.update' AND c.record_id = ?`,
    )
      .bind(a.principal.personId)
      .all<Record<string, string>>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      actor: "customer",
      user_id: a.principal.customerId,
      outcome: "ok",
      object_type: "person",
    });
    const diff = JSON.parse(results[0]?.diff ?? "{}") as Record<string, unknown>;
    // The person.update snapshot: the phone shows in `phones`, as on the History tab.
    expect(Object.keys(diff).sort()).toEqual(["givenName", "phones"]);
  });

  it("replaces the primary phone and keeps the others", async () => {
    await invoke(
      "person.update",
      {
        id: a.principal.personId,
        phones: [
          { number: "+61 400 000 002", label: "mobile", primary: true },
          { number: "+61 2 0000 0003", label: "work" },
        ],
      },
      context(admin),
    );
    const done = await call("me.update", { primaryPhone: "+61 400 000 009" }, outside(a.principal));
    expect(done.ok, JSON.stringify(done)).toBe(true);
    const person = await invoke("person.get", { id: a.principal.personId }, context(admin));
    expect(person.phones).toEqual([
      { number: "+61 400 000 009", label: "mobile", primary: true },
      { number: "+61 2 0000 0003", label: "work", primary: false },
    ]);
    await call("me.update", { primaryPhone: null }, outside(a.principal));
    const cleared = await invoke("person.get", { id: a.principal.personId }, context(admin));
    expect(cleared.phones).toEqual([{ number: "+61 2 0000 0003", label: "work", primary: true }]);
  });

  it("cannot name a person, nor set a field it may not write", async () => {
    const before = await invoke("person.get", { id: b.principal.personId }, context(admin));
    for (const input of [
      { id: b.principal.personId, givenName: "Mallory" },
      { personId: b.principal.personId, givenName: "Mallory" },
      { primaryEmail: "mallory@example.com" },
      { emails: [{ email: "mallory@example.com" }] },
      { ownerId: admin.id },
      { description: "x" },
    ]) {
      const outcome = await call("me.update", input, outside(a.principal));
      expect(outcome, JSON.stringify(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(await invoke("person.get", { id: b.principal.personId }, context(admin))).toEqual(
      before,
    );
  });

  it("with nothing to change, changes nothing", async () => {
    const before = await invoke("person.get", { id: a.principal.personId }, context(admin));
    const done = await call("me.update", {}, outside(a.principal));
    expect(done.ok).toBe(true);
    expect(await invoke("person.get", { id: a.principal.personId }, context(admin))).toEqual(
      before,
    );
  });
});

describe("my.list and my.get", () => {
  it("read the caller's own records of an object that declares a customer", async () => {
    for (const object of [ORDER, TICKET]) {
      const page = await call("my.list", { object }, outside(a.principal));
      expect(page.ok, JSON.stringify(page)).toBe(true);
      const items = (page as { value: { items: { id: string }[] } }).value.items;
      expect(items.map((i) => i.id).sort()).toEqual([...(a.records[object] ?? [])].sort());
      const id = a.records[object]?.[0] as string;
      const one = await call("my.get", { object, id }, outside(a.principal));
      expect(one).toMatchObject({ ok: true, value: { object, id } });
    }
    const order = await call(
      "my.get",
      { object: ORDER, id: a.records[ORDER]?.[0] },
      outside(a.principal),
    );
    const values = (order as { value: { values: Record<string, unknown> } }).value.values;
    expect(Object.keys(values).sort()).toEqual(["note", "status", "title", "total"]);
  });

  it("read the caller's own Person, and only theirs", async () => {
    const page = await call("my.list", { object: "person" }, outside(a.principal));
    const items = (page as { value: { items: { id: string; values: object }[] } }).value.items;
    expect(items.map((i) => i.id)).toEqual([a.principal.personId]);
    expect(Object.keys(items[0]?.values ?? {}).sort()).toEqual([...READ].sort());

    const own = await call(
      "my.get",
      { object: "person", id: a.principal.personId },
      outside(a.principal),
    );
    expect(own).toMatchObject({ ok: true, value: { id: a.principal.personId } });
    const theirs = await call(
      "my.get",
      { object: "person", id: b.principal.personId },
      outside(a.principal),
    );
    const guess = await call(
      "my.get",
      { object: "person", id: "per_01GUESSED00000000000000000" },
      outside(a.principal),
    );
    const shape = (o: unknown) => JSON.stringify(o).replace(/per_[A-Za-z0-9]+/g, "<id>");
    expect(theirs.ok).toBe(false);
    expect(shape(theirs)).toBe(shape(guess));
  });

  it("an object that declares no customer is unknown", async () => {
    for (const object of ["organisation", "task", "activity"]) {
      const outcome = await call("my.list", { object }, outside(a.principal));
      expect(outcome).toEqual({
        ok: false,
        error: {
          code: "invalid_input",
          message: `Unknown object "${object}"`,
          details: { object },
        },
      });
    }
  });
});

// --- Sessions -----------------------------------------------------------------------------------

interface Account {
  customer: Customer;
  sessions: string[];
}

/** A real `core_customer` row for a fixture customer, and two sessions. */
async function account(customer: Customer): Promise<Account> {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      customer.principal.customerId,
      customer.principal.personId,
      `${customer.principal.customerId.toLowerCase()}@customers.example`,
      now,
      now,
    )
    .run();
  const sessions: string[] = [];
  for (let n = 0; n < 2; n += 1) {
    const id = newId("audit").replace(/^aud_/, "ses_");
    await env.DB.prepare(
      `INSERT INTO core_customer_session (id, customer_id, token, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, customer.principal.customerId, `secret-token-${id}`, expires, now, now)
      .run();
    sessions.push(id);
  }
  return { customer, sessions };
}

async function sessionIds(customerId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM core_customer_session WHERE customer_id = ? ORDER BY id",
  )
    .bind(customerId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

describe("sessions", () => {
  let mine: Account;
  let theirs: Account;

  beforeAll(async () => {
    const c = await createCustomer(admin, "C");
    const d = await createCustomer(admin, "D");
    mine = await account(c);
    theirs = await account(d);
  });

  const as = (acc: Account, sessionId?: string) =>
    outside(acc.customer.principal, {
      origin: { surface: "client", ...(sessionId ? { sessionId } : {}) },
    });

  it("me.sessions.list shows only the caller's sessions, and never a token", async () => {
    const listed = await call("me.sessions.list", {}, as(mine, mine.sessions[0]));
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    const items = (listed as { value: { items: { id: string; current: boolean }[] } }).value.items;
    expect(items.map((i) => i.id).sort()).toEqual([...mine.sessions].sort());
    expect(items.find((i) => i.current)?.id).toBe(mine.sessions[0]);
    const text = JSON.stringify(listed);
    expect(text).not.toContain("secret-token");
    for (const id of theirs.sessions) expect(text).not.toContain(id);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        "createdAt",
        "current",
        "expiresAt",
        "id",
        "lastActiveAt",
      ]);
    }
  });

  it("me.sessions.revoke of another customer's session answers as an unknown one, and keeps it", async () => {
    const target = theirs.sessions[0] as string;
    const unknown = "ses_01UNKNOWN0000000000000000000";
    const refused = await call("me.sessions.revoke", { id: target }, as(mine));
    const control = await call("me.sessions.revoke", { id: unknown }, as(mine));
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused).split(target).join("<id>")).toBe(
      JSON.stringify(control).split(unknown).join("<id>"),
    );
    expect(await sessionIds(theirs.customer.principal.customerId)).toEqual(
      [...theirs.sessions].sort(),
    );
  });

  it("me.sessions.revoke ends one of the caller's own sessions", async () => {
    const [keep, end] = mine.sessions as [string, string];
    const done = await call("me.sessions.revoke", { id: end }, as(mine, keep));
    expect(done).toEqual({ ok: true, value: { id: end, revoked: true } });
    expect(await sessionIds(mine.customer.principal.customerId)).toEqual([keep]);
    mine.sessions = [keep];
  });

  it("me.signOut ends the current session only", async () => {
    const extra = await account(await createCustomer(admin, "E"));
    const [current, other] = extra.sessions as [string, string];
    // Without a session named, nothing is ended.
    expect(await call("me.signOut", {}, as(extra))).toEqual({
      ok: true,
      value: { signedOut: false },
    });
    // Another customer's session named as the current one is not ended.
    expect(await call("me.signOut", {}, as(extra, theirs.sessions[0]))).toEqual({
      ok: true,
      value: { signedOut: false },
    });
    expect(await sessionIds(theirs.customer.principal.customerId)).toEqual(
      [...theirs.sessions].sort(),
    );
    expect(await call("me.signOut", {}, as(extra, current))).toEqual({
      ok: true,
      value: { signedOut: true },
    });
    expect(await sessionIds(extra.customer.principal.customerId)).toEqual([other]);
  });

  it("a principal with no account row gets an empty list and not-found, not an error", async () => {
    const listed = await call("me.sessions.list", {}, outside(a.principal));
    expect(listed).toEqual({ ok: true, value: { items: [] } });
    const revoke = await call("me.sessions.revoke", { id: "ses_x" }, outside(a.principal));
    expect(revoke).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await call("me.signOut", {}, outside(a.principal))).toEqual({
      ok: true,
      value: { signedOut: false },
    });
  });
});
