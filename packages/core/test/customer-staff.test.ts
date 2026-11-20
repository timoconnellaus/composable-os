// Stage 22 step 5 (ADR 0402): the staff operations on customer accounts. Admins only (users:manage)
// and humans only; disabling ends every session in the same batch as the status change.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke, loadCustomer, newId } from "../src/index.ts";
import { call } from "./customer-fixtures.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
});

/** A Person, a linked customer account, and `sessions` live sessions. */
async function account(sessions = 2): Promise<{ id: string; personId: string; email: string }> {
  const email = `${unique("cust")}@customers.example`.toLowerCase();
  const person = await invoke("person.create", { emails: [{ email }] }, context(admin));
  const id = newId("customer");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at, last_sign_in_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(id, person.id, email, now, now, now)
    .run();
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  for (let n = 0; n < sessions; n += 1) {
    const sid = `ses_${unique("s")}`;
    await env.DB.prepare(
      `INSERT INTO core_customer_session (id, customer_id, token, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(sid, id, `token-${sid}`, expires, now, now)
      .run();
  }
  return { id, personId: person.id, email };
}

const sessionCount = async (customerId: string) =>
  (
    await env.DB.prepare("SELECT count(*) AS n FROM core_customer_session WHERE customer_id = ?")
      .bind(customerId)
      .first<{ n: number }>()
  )?.n ?? 0;

const STAFF_OPS: [string, (id: string) => unknown][] = [
  ["customer.list", () => ({})],
  ["customer.invite", () => ({ email: `${unique("inv")}@example.com` })],
  ["customer.disable", (id) => ({ id })],
  ["customer.enable", (id) => ({ id })],
  ["customer.revokeSessions", (id) => ({ id })],
];

describe("who may call them", () => {
  it("refuses a member, and every actor but a human", async () => {
    const { id } = await account(1);
    for (const [name, input] of STAFF_OPS) {
      const asMember = await call(name, input(id), context(member));
      expect(asMember, name).toMatchObject({ ok: false, error: { code: "forbidden" } });
      for (const actor of ["assistant", "mcp", "automation"] as const) {
        const outcome = await call(name, input(id), context(admin, { actor }));
        expect(outcome, `${name} as ${actor}`).toMatchObject({ ok: false });
      }
    }
    expect(await sessionCount(id)).toBe(1);
    expect((await loadCustomer(db.query, id))?.status).toBe("active");
  });
});

describe("customer.list", () => {
  it("lists accounts, and a Person's account by personId, without tokens", async () => {
    const one = await account(2);
    const listed = await invoke("customer.list", { personId: one.personId }, context(admin));
    expect(listed.items).toEqual([
      expect.objectContaining({
        id: one.id,
        personId: one.personId,
        email: one.email,
        status: "active",
        linkState: "linked",
        sessions: 2,
      }),
    ]);
    expect(listed.items[0]?.lastSignInAt).toBeTruthy();
    expect(JSON.stringify(listed)).not.toContain("token-");
    const all = await invoke("customer.list", { limit: 200 }, context(admin));
    expect(all.items.map((i) => i.id)).toContain(one.id);
  });

  it("pages", async () => {
    await account(0);
    await account(0);
    const first = await invoke("customer.list", { limit: 1 }, context(admin));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await invoke(
      "customer.list",
      { limit: 1, cursor: first.nextCursor ?? undefined },
      context(admin),
    );
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });
});

describe("customer.invite", () => {
  it("writes the invite, audited", async () => {
    const email = `${unique("invite")}@Example.com`;
    const done = await invoke("customer.invite", { email: ` ${email} ` }, context(admin));
    expect(done).toEqual({ email: email.toLowerCase() });
    const row = await env.DB.prepare("SELECT * FROM core_customer_invite WHERE email = ?")
      .bind(email.toLowerCase())
      .first<{ invited_by: string }>();
    expect(row?.invited_by).toBe(admin.id);
    const audit = await env.DB.prepare(
      "SELECT outcome FROM core_audit WHERE operation = 'customer.invite' AND user_id = ? ORDER BY at DESC LIMIT 1",
    )
      .bind(admin.id)
      .first<{ outcome: string }>();
    expect(audit?.outcome).toBe("ok");
  });

  it("refuses what is not an address", async () => {
    const outcome = await call("customer.invite", { email: "not an address" }, context(admin));
    expect(outcome).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("customer.disable, enable and revokeSessions", () => {
  it("disable ends every session with the status change, audited; enable undoes the status", async () => {
    const { id } = await account(3);
    const done = await invoke("customer.disable", { id }, context(admin));
    expect(done).toMatchObject({ id, status: "disabled", sessionsEnded: 3, sessions: 0 });
    expect(await sessionCount(id)).toBe(0);
    expect((await loadCustomer(db.query, id))?.status).toBe("disabled");

    const { results } = await env.DB.prepare(
      `SELECT c.diff FROM core_audit a JOIN core_audit_changes c ON c.audit_id = a.id
       WHERE a.operation = 'customer.disable' AND c.record_id = ?`,
    )
      .bind(id)
      .all<{ diff: string }>();
    expect(results.map((r) => JSON.parse(r.diff))).toEqual([
      { status: { before: "active", after: "disabled" } },
    ]);

    const enabled = await invoke("customer.enable", { id }, context(admin));
    expect(enabled).toMatchObject({ id, status: "active", sessionsEnded: 0 });
    expect((await loadCustomer(db.query, id))?.status).toBe("active");
    // Enabling does not bring sessions back: the person signs in again.
    expect(await sessionCount(id)).toBe(0);
  });

  it("disable changes nothing when the batch fails: the status and the sessions go together", async () => {
    const { id } = await account(2);
    // A batch that fails part-way leaves both as they were (D1 batches are one transaction).
    // Make the status update fail by a trigger, then check the sessions survived.
    await env.DB.prepare(
      `CREATE TRIGGER test_block_disable BEFORE UPDATE OF status ON core_customer
       WHEN NEW.id = '${id}' BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    ).run();
    try {
      const outcome = await call("customer.disable", { id }, context(admin));
      expect(outcome.ok).toBe(false);
    } finally {
      await env.DB.prepare("DROP TRIGGER test_block_disable").run();
    }
    expect(await sessionCount(id)).toBe(2);
    expect((await loadCustomer(db.query, id))?.status).toBe("active");
  });

  it("revokeSessions ends every session and keeps the account active", async () => {
    const { id } = await account(2);
    const other = await account(1);
    const done = await invoke("customer.revokeSessions", { id }, context(admin));
    expect(done).toEqual({ id, sessionsEnded: 2 });
    expect(await sessionCount(id)).toBe(0);
    expect(await sessionCount(other.id)).toBe(1);
    expect((await loadCustomer(db.query, id))?.status).toBe("active");
  });

  it("an unknown account is not found", async () => {
    for (const name of ["customer.disable", "customer.enable", "customer.revokeSessions"]) {
      const outcome = await call(name, { id: "cus_nope" }, context(admin));
      expect(outcome, name).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
  });
});

describe("the audit log names a customer", () => {
  it("shows a customer's call by their account's address, and filters by actor customer", async () => {
    const { id, personId, email } = await account(0);
    await call(
      "me.update",
      { givenName: "Named" },
      { principal: { kind: "customer", customerId: id, personId }, db },
    );
    const page = await invoke(
      "audit.list",
      { actor: "customer", operation: "me.update", limit: 200 },
      context(admin),
    );
    const entry = page.items.find((item) => item.userId === id);
    expect(entry).toMatchObject({ actor: "customer", userName: email });
    expect(page.items.every((item) => item.actor === "customer")).toBe(true);
  });
});
