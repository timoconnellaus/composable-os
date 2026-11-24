// Stage 22 steps 7 and 8 (ADR 0402): deleting a customer account, erase requests, limits, and what
// erase and merge do to customer accounts. Acceptance criteria 12, 13 and 14, against real D1.
//
// 12: me.deleteAccount disables the account and ends its sessions in one batch with the request;
//     erase and decline close the request; an overdue one notifies admins once a day.
// 13: erase leaves no customer row, session, code, invite or request; merge moves the account,
//     is refused while both people have an active one, and resolves `needs_merge`.
// 14: limits per account, per operation and per code address (memoryRateLimit).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CustomerPrincipal,
  checkCodeRequestLimit,
  checkOutsideRateLimit,
  customerMayGetCode,
  type IntegrationRuntime,
  invoke,
  invokeByName,
  memoryRateLimit,
  newId,
  notifyOverdueEraseRequests,
  RateLimitedError,
} from "../src/index.ts";
import { auditChanges, context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
});

const email = (label: string) => `${unique(label)}@erase.example`;
const iso = () => new Date().toISOString();

interface Account {
  principal: CustomerPrincipal;
  email: string;
  sessions: string[];
}

async function person(address: string, name = unique("Pat")) {
  return invoke(
    "person.create",
    { displayName: name, emails: [{ email: address }] },
    context(member),
  );
}

/** A customer account for a new Person (or `personId`), with two sessions. */
async function account(
  options: { personId?: string; email?: string; status?: "active" | "disabled" } = {},
): Promise<Account> {
  const address = options.email ?? email("cus");
  const personId = options.personId ?? (await person(address)).id;
  const id = newId("customer");
  const now = iso();
  await env.DB.prepare(
    `INSERT INTO core_customer (id, person_id, email, email_verified, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(id, personId, address, options.status ?? "active", now, now)
    .run();
  const sessions: string[] = [];
  for (let n = 0; n < 2; n += 1) {
    const session = `ses_${unique("s")}`;
    await env.DB.prepare(
      `INSERT INTO core_customer_session (id, customer_id, token, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        session,
        id,
        `token-${session}`,
        new Date(Date.now() + 86_400_000).toISOString(),
        now,
        now,
      )
      .run();
    sessions.push(session);
  }
  return { principal: { kind: "customer", customerId: id, personId }, email: address, sessions };
}

const asCustomer = (acc: Account, clock?: () => Date) => ({
  principal: acc.principal,
  db,
  ...(clock ? { clock } : {}),
});

/**
 * Deletes the account as its customer does: the preview, then the confirm (ADR 0713), from its
 * first session, signed in just now (the confirm needs a recent sign-in, ADR 0712).
 */
async function deleteAccount(acc: Account, clock?: () => Date) {
  const session = acc.sessions[0] as string;
  await env.DB.prepare("UPDATE core_customer_session SET created_at = ? WHERE id = ?")
    .bind((clock?.() ?? new Date()).toISOString(), session)
    .run();
  const preview = (await invokeByName("me.deleteAccount", {}, asCustomer(acc, clock))) as {
    expect: string;
  };
  return invokeByName(
    "me.deleteAccount",
    { confirm: true, expect: preview.expect },
    {
      ...asCustomer(acc, clock),
      origin: { surface: "client" as const, sessionId: session },
    },
  ) as Promise<{
    disabled: true;
    sessionsEnded: number;
    eraseRequest: { requestedAt: string; dueAt: string };
  }>;
}

async function accountRow(id: string) {
  return env.DB.prepare("SELECT status, person_id, link_state FROM core_customer WHERE id = ?")
    .bind(id)
    .first<{ status: string; person_id: string | null; link_state: string }>();
}

async function sessionCount(customerId: string) {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_customer_session WHERE customer_id = ?",
  )
    .bind(customerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function requestsFor(personId: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM core_erase_request WHERE person_id = ? ORDER BY requested_at",
  )
    .bind(personId)
    .all<Record<string, string | null>>();
  return results;
}

async function adminNotices(dedupePrefix: string) {
  const { results } = await env.DB.prepare(
    "SELECT title, body, link, dedupe_key FROM core_notifications WHERE user_id = ?1 AND substr(dedupe_key, 1, length(?2)) = ?2 ORDER BY created_at",
  )
    .bind(admin.id, dedupePrefix)
    .all<{ title: string; body: string; link: string; dedupe_key: string }>();
  return results;
}

// --- 12: deleting an account -------------------------------------------------------------------

describe("me.deleteAccount (criterion 12)", () => {
  it("disables the account, ends every session and makes an erase request due in 30 days", async () => {
    const acc = await account();
    const other = await account();
    const at = new Date("2030-03-01T10:00:00.000Z");
    const done = await deleteAccount(acc, () => at);
    expect(done).toEqual({
      deleted: true,
      disabled: true,
      sessionsEnded: 2,
      subscriptionsEnding: 0,
      ordersCancelled: 0,
      eraseRequest: { requestedAt: at.toISOString(), dueAt: "2030-03-31T10:00:00.000Z" },
    });
    expect(await accountRow(acc.principal.customerId)).toMatchObject({ status: "disabled" });
    expect(await sessionCount(acc.principal.customerId)).toBe(0);
    const [request] = await requestsFor(acc.principal.personId);
    expect(request).toMatchObject({
      customer_id: acc.principal.customerId,
      status: "open",
      requested_at: at.toISOString(),
      due_at: "2030-03-31T10:00:00.000Z",
      closed_at: null,
    });
    // Admins are told, with a link to the Person.
    const [notice] = await adminNotices(`erase_request:${request?.id}`);
    expect(notice?.title).toBe("A customer asked to be erased");
    expect(JSON.parse(notice?.link ?? "{}")).toEqual({
      kind: "record",
      object: "person",
      id: acc.principal.personId,
    });
    // Audited as the customer.
    const audit = await env.DB.prepare(
      "SELECT actor, user_id, outcome FROM core_audit WHERE operation = 'me.deleteAccount' AND user_id = ?",
    )
      .bind(acc.principal.customerId)
      .first();
    expect(audit).toEqual({ actor: "customer", user_id: acc.principal.customerId, outcome: "ok" });
    // Nobody else's account changed.
    expect(await accountRow(other.principal.customerId)).toMatchObject({ status: "active" });
    expect(await sessionCount(other.principal.customerId)).toBe(2);
    expect(await requestsFor(other.principal.personId)).toEqual([]);
    // The person can no longer get a sign-in code.
    expect(await customerMayGetCode(db.query, acc.email)).toBe(false);
    expect(await customerMayGetCode(db.query, other.email)).toBe(true);
  });

  it("is idempotent: asking again makes no second request and no second notice", async () => {
    const acc = await account();
    const first = await deleteAccount(acc);
    // Asked again from a new sign-in (a recent one is needed, ADR 0712): only that session ends.
    const session = `ses_${unique("s")}`;
    await env.DB.prepare(
      `INSERT INTO core_customer_session (id, customer_id, token, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(session, acc.principal.customerId, `token-${session}`, iso(), iso(), iso())
      .run();
    const again = await deleteAccount({ ...acc, sessions: [session] });
    expect(again.eraseRequest).toEqual(first.eraseRequest);
    expect(again.sessionsEnded).toBe(1);
    const requests = await requestsFor(acc.principal.personId);
    expect(requests).toHaveLength(1);
    expect(await adminNotices(`erase_request:${requests[0]?.id}`)).toHaveLength(1);
  });

  it("uses the due-date setting, which only a human admin changes", async () => {
    await invoke("customer.settings.update", { eraseDueDays: 7 }, context(admin));
    try {
      const acc = await account();
      const at = new Date("2030-05-01T00:00:00.000Z");
      expect((await deleteAccount(acc, () => at)).eraseRequest.dueAt).toBe(
        "2030-05-08T00:00:00.000Z",
      );
      await expect(
        invoke("customer.settings.update", { eraseDueDays: 90 }, context(member)),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        invoke("customer.settings.update", { eraseDueDays: 90 }, context(admin, { actor: "mcp" })),
      ).rejects.toThrow();
    } finally {
      await invoke("customer.settings.update", { eraseDueDays: 30 }, context(admin));
    }
  });

  it("is one batch: when one statement fails, nothing changes", async () => {
    const acc = await account();
    await env.DB.prepare(
      `CREATE TRIGGER test_abort_erase_request BEFORE INSERT ON core_erase_request
       BEGIN SELECT RAISE(ABORT, 'test abort'); END`,
    ).run();
    try {
      await expect(deleteAccount(acc)).rejects.toMatchObject({ code: "internal" });
    } finally {
      await env.DB.prepare("DROP TRIGGER test_abort_erase_request").run();
    }
    expect(await accountRow(acc.principal.customerId)).toMatchObject({ status: "active" });
    expect(await sessionCount(acc.principal.customerId)).toBe(2);
    expect(await requestsFor(acc.principal.personId)).toEqual([]);
  });

  it("touches only the caller's own account: a principal with no account changes nothing", async () => {
    const victim = await account();
    // A principal whose account id does not exist, or does not belong to its Person.
    for (const principal of [
      { kind: "customer" as const, customerId: "cus_missing", personId: victim.principal.personId },
      {
        kind: "customer" as const,
        customerId: victim.principal.customerId,
        personId: (await person(email("p"))).id,
      },
    ]) {
      await expect(invokeByName("me.deleteAccount", {}, { principal, db })).rejects.toMatchObject({
        code: "not_found",
      });
    }
    expect(await accountRow(victim.principal.customerId)).toMatchObject({ status: "active" });
    expect(await sessionCount(victim.principal.customerId)).toBe(2);
    expect(await requestsFor(victim.principal.personId)).toEqual([]);
  });
});

describe("eraseRequest.list and decline (criterion 12)", () => {
  const sent: { to: string[]; subject: string; text: string }[] = [];
  const integrations = {
    async call(input: { args: unknown[] }) {
      sent.push(input.args[0] as (typeof sent)[number]);
      return { value: { status: "sent" }, pending: [], applied: [{ action: 1 }] };
    },
  } as unknown as IntegrationRuntime;

  beforeAll(async () => {
    const id = newId("connection");
    const now = iso();
    await env.DB.prepare(
      "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'email-send', 'org', ?, 'Mail', 'active', ?, ?, ?)",
    )
      .bind(
        id,
        admin.id,
        JSON.stringify([
          {
            key: "k1",
            url: "email-send://sender/crm%40example.com",
            pattern: "email-send://sender/:address",
            title: "Mail",
            tsType: "X",
            bindingName: "X",
          },
        ]),
        now,
        now,
      )
      .run();
    await invoke("notification.updateDeliverySettings", { email: id }, context(admin));
    // Customer mail goes out from the connection the customer settings name (stage 23).
    await invoke("customer.settings.update", { emailConnectionId: id }, context(admin));
  });

  it("lists open requests soonest due first, flagging overdue ones; admins only", async () => {
    const late = await account();
    const soon = await account();
    await deleteAccount(late, () => new Date("2020-01-01T00:00:00.000Z"));
    await deleteAccount(soon, () => new Date());
    const { items } = await invoke("eraseRequest.list", {}, context(admin));
    const mine = items.filter((i) =>
      [late.principal.personId, soon.principal.personId].includes(i.personId),
    );
    expect(mine.map((i) => [i.personId, i.overdue])).toEqual([
      [late.principal.personId, true],
      [soon.principal.personId, false],
    ]);
    expect(mine[0]?.personName).toEqual(expect.any(String));
    await expect(invoke("eraseRequest.list", {}, context(member))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("decline closes the request, keeps the reason, emails it through the gatekeeper, and is audited", async () => {
    const acc = await account();
    await deleteAccount(acc);
    const [request] = await requestsFor(acc.principal.personId);
    const id = request?.id as string;
    const before = sent.length;
    const done = await invoke(
      "eraseRequest.decline",
      { id, reason: "Invoices must be kept for seven years." },
      context(admin, { integrations }),
    );
    expect(done).toEqual({ id, status: "declined", email: "sent" });
    expect(sent.slice(before)).toEqual([
      expect.objectContaining({
        to: [acc.email],
        text: expect.stringContaining("Invoices must be kept for seven years."),
      }),
    ]);
    expect((await requestsFor(acc.principal.personId))[0]).toMatchObject({
      status: "declined",
      decline_reason: "Invoices must be kept for seven years.",
      closed_by: admin.id,
    });
    const changes = await auditChanges(id);
    expect(changes.at(-1)).toMatchObject({
      operation: "eraseRequest.decline",
      object_type: "erase_request",
    });
    // The account stays disabled, and a closed request cannot be declined again.
    expect(await accountRow(acc.principal.customerId)).toMatchObject({ status: "disabled" });
    await expect(
      invoke("eraseRequest.decline", { id, reason: "again" }, context(admin, { integrations })),
    ).rejects.toMatchObject({ code: "conflict" });
    // Members and non-humans cannot decline.
    await expect(
      invoke("eraseRequest.decline", { id, reason: "x" }, context(member)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("decline still closes the request when there is no gatekeeper to email through", async () => {
    const acc = await account();
    await deleteAccount(acc);
    const id = (await requestsFor(acc.principal.personId))[0]?.id as string;
    const done = await invoke("eraseRequest.decline", { id, reason: "Kept" }, context(admin));
    expect(done).toMatchObject({ id, status: "declined", email: "not_sent" });
    expect((await requestsFor(acc.principal.personId))[0]).toMatchObject({ status: "declined" });
  });

  it("erasing the person closes the request (audited) and deletes it", async () => {
    const acc = await account();
    await deleteAccount(acc);
    const id = (await requestsFor(acc.principal.personId))[0]?.id as string;
    const erased = await invoke("person.erase", { id: acc.principal.personId }, context(admin));
    expect(erased.eraseRequestsClosed).toBe(1);
    expect(await requestsFor(acc.principal.personId)).toEqual([]);
    const changes = await auditChanges(id);
    expect(changes.at(-1)).toMatchObject({
      operation: "person.erase",
      object_type: "erase_request",
    });
    expect(changes.at(-1)?.diff).toMatchObject({ status: { before: "open", after: "erased" } });
  });
});

describe("overdue erase requests (criterion 12)", () => {
  it("notify admins about each overdue request at most once a day, until it is closed", async () => {
    const acc = await account();
    await deleteAccount(acc, () => new Date("2031-01-01T09:00:00.000Z"));
    const id = (await requestsFor(acc.principal.personId))[0]?.id as string;
    const notices = () => adminNotices(`erase_request.overdue:${id}`);

    // Not yet due.
    await notifyOverdueEraseRequests(db, new Date("2031-01-20T09:00:00.000Z"));
    expect(await notices()).toHaveLength(0);
    // Due: told once, and not again the same day.
    const due = new Date("2031-02-01T03:17:00.000Z");
    expect((await notifyOverdueEraseRequests(db, due)).notified).toBeGreaterThanOrEqual(1);
    await notifyOverdueEraseRequests(db, new Date("2031-02-01T15:00:00.000Z"));
    expect(await notices()).toHaveLength(1);
    expect((await notices())[0]).toMatchObject({ title: "An erase request is overdue" });
    // The next day's run tells them again.
    await notifyOverdueEraseRequests(db, new Date("2031-02-02T03:17:00.000Z"));
    expect(await notices()).toHaveLength(2);
    // Once declined, never again.
    await invoke("eraseRequest.decline", { id, reason: "Kept by law" }, context(admin));
    await notifyOverdueEraseRequests(db, new Date("2031-02-05T03:17:00.000Z"));
    expect(await notices()).toHaveLength(2);
  });
});

// --- 13: erase and merge -----------------------------------------------------------------------

describe("person.erase and customer accounts (criterion 13)", () => {
  it("leaves no customer row, session, code, invite or request, and lists the address as erased", async () => {
    const current = email("cur");
    const second = email("sec");
    const p = await invoke(
      "person.create",
      { displayName: unique("Erin"), emails: [{ email: current }, { email: second }] },
      context(member),
    );
    const acc = await account({ personId: p.id, email: current });
    // An account waiting for a merge with their other address, codes for both, invites.
    const waiting = newId("customer");
    const now = iso();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_customer (id, person_id, email, email_verified, link_state, created_at, updated_at) VALUES (?, NULL, ?, 1, 'needs_merge', ?, ?)",
      ).bind(waiting, second, now, now),
      env.DB.prepare(
        "INSERT INTO core_customer_verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, 'hashed', ?, ?, ?), (?, ?, 'hashed', ?, ?, ?)",
      ).bind(
        `ver_${unique("v")}`,
        `sign-in-otp-${current}`,
        now,
        now,
        now,
        `ver_${unique("v")}`,
        `sign-in-otp-${second}`,
        now,
        now,
        now,
      ),
      env.DB.prepare(
        "INSERT INTO core_customer_invite (email, invited_by, invited_at) VALUES (?, ?, ?), (?, ?, ?)",
      ).bind(current, admin.id, now, second, admin.id, now),
    ]);
    await deleteAccount(acc);
    const bystander = await account();
    await invoke("customer.invite", { email: email("bystander") }, context(admin));

    await invoke("person.erase", { id: p.id }, context(admin));

    const left = await env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM core_customer WHERE id IN (?1, ?2) OR email IN (?3, ?4)) AS accounts,
         (SELECT count(*) FROM core_customer_session WHERE customer_id IN (?1, ?2)) AS sessions,
         (SELECT count(*) FROM core_customer_verification WHERE identifier LIKE '%' || ?3 OR identifier LIKE '%' || ?4) AS codes,
         (SELECT count(*) FROM core_customer_invite WHERE email IN (?3, ?4)) AS invites,
         (SELECT count(*) FROM core_erase_request WHERE person_id = ?5 OR customer_id IN (?1, ?2)) AS requests`,
    )
      .bind(acc.principal.customerId, waiting, current, second, p.id)
      .first();
    expect(left).toEqual({ accounts: 0, sessions: 0, codes: 0, invites: 0, requests: 0 });
    // The address cannot sign up again.
    expect(await customerMayGetCode(db.query, current)).toBe(false);
    expect(await customerMayGetCode(db.query, second)).toBe(false);
    const status = await invoke("erasure.addressStatus", { email: current }, context(admin));
    expect(status.erased).toBe(true);
    // Someone else's account is untouched.
    expect(await accountRow(bystander.principal.customerId)).toMatchObject({ status: "active" });
    expect(await sessionCount(bystander.principal.customerId)).toBe(2);
  });
});

describe("person.merge and customer accounts (criterion 13)", () => {
  const merge = (survivorId: string, mergedId: string) =>
    invoke("person.merge", { survivorId, mergedId }, context(member));

  it("moves the duplicate's account to the survivor", async () => {
    const survivor = await person(email("s"));
    const dup = await account();
    await merge(survivor.id, dup.principal.personId);
    expect(await accountRow(dup.principal.customerId)).toMatchObject({
      person_id: survivor.id,
      status: "active",
    });
    expect(await sessionCount(dup.principal.customerId)).toBe(2);
    const changes = await auditChanges(dup.principal.customerId);
    expect(changes.at(-1)).toMatchObject({ operation: "person.merge", object_type: "customer" });
  });

  it("is refused while both people have an active account, and nothing changes", async () => {
    const keep = await account();
    const dup = await account();
    await expect(merge(keep.principal.personId, dup.principal.personId)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Disable one"),
    });
    expect(await accountRow(keep.principal.customerId)).toMatchObject({
      person_id: keep.principal.personId,
    });
    expect(await accountRow(dup.principal.customerId)).toMatchObject({
      person_id: dup.principal.personId,
    });
    const live = await env.DB.prepare("SELECT deleted_at FROM core_person WHERE id = ?")
      .bind(dup.principal.personId)
      .first<{ deleted_at: string | null }>();
    expect(live?.deleted_at).toBeNull();
  });

  it("once staff disable one, deletes the disabled account and keeps the other on the survivor", async () => {
    // The survivor's account is the disabled one: the duplicate's active one takes its place.
    const keep = await account();
    const dup = await account();
    await invoke("customer.disable", { id: keep.principal.customerId }, context(admin));
    await merge(keep.principal.personId, dup.principal.personId);
    expect(await accountRow(keep.principal.customerId)).toBeNull();
    expect(await sessionCount(keep.principal.customerId)).toBe(0);
    expect(await accountRow(dup.principal.customerId)).toMatchObject({
      person_id: keep.principal.personId,
      status: "active",
    });

    // The duplicate's is the disabled one: it goes, the survivor keeps its own.
    const keep2 = await account();
    const dup2 = await account();
    await invoke("customer.disable", { id: dup2.principal.customerId }, context(admin));
    await merge(keep2.principal.personId, dup2.principal.personId);
    expect(await accountRow(dup2.principal.customerId)).toBeNull();
    expect(await accountRow(keep2.principal.customerId)).toMatchObject({
      person_id: keep2.principal.personId,
      status: "active",
    });
  });

  it("links an account waiting for the merge to the survivor", async () => {
    const dupAddress = email("dup");
    const survivor = await person(email("s"));
    const dup = await person(dupAddress);
    const waiting = newId("customer");
    const now = iso();
    await env.DB.prepare(
      "INSERT INTO core_customer (id, person_id, email, email_verified, link_state, created_at, updated_at) VALUES (?, NULL, ?, 1, 'needs_merge', ?, ?)",
    )
      .bind(waiting, dupAddress, now, now)
      .run();
    await merge(survivor.id, dup.id);
    expect(await accountRow(waiting)).toMatchObject({
      person_id: survivor.id,
      link_state: "linked",
    });
  });

  it("leaves a waiting account waiting when the survivor already has one", async () => {
    const dupAddress = email("dup");
    const keep = await account();
    const dup = await person(dupAddress);
    const waiting = newId("customer");
    const now = iso();
    await env.DB.prepare(
      "INSERT INTO core_customer (id, person_id, email, email_verified, link_state, created_at, updated_at) VALUES (?, NULL, ?, 1, 'needs_merge', ?, ?)",
    )
      .bind(waiting, dupAddress, now, now)
      .run();
    await merge(keep.principal.personId, dup.id);
    expect(await accountRow(waiting)).toMatchObject({ person_id: null, link_state: "needs_merge" });
    expect(await accountRow(keep.principal.customerId)).toMatchObject({
      person_id: keep.principal.personId,
    });
  });

  it("moves the duplicate's erase request to the survivor", async () => {
    const survivor = await person(email("s"));
    const dup = await account();
    await deleteAccount(dup);
    await merge(survivor.id, dup.principal.personId);
    expect(await requestsFor(survivor.id)).toEqual([
      expect.objectContaining({ status: "open", customer_id: dup.principal.customerId }),
    ]);
  });
});

// --- 14: limits --------------------------------------------------------------------------------

describe("rate limits for outside callers (criterion 14)", () => {
  const a: CustomerPrincipal = { kind: "customer", customerId: "cus_a", personId: "per_a" };
  const b: CustomerPrincipal = { kind: "customer", customerId: "cus_b", personId: "per_b" };

  it("hold per account and per operation", async () => {
    const binding = memoryRateLimit(2);
    await checkOutsideRateLimit(binding, a, "me.get");
    await checkOutsideRateLimit(binding, a, "me.get");
    await expect(checkOutsideRateLimit(binding, a, "me.get")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    await expect(checkOutsideRateLimit(binding, a, "me.get")).rejects.toMatchObject({
      code: "rate_limited",
      details: { retryAfterSeconds: 60 },
    });
    // Another operation, and another account, count on their own.
    await checkOutsideRateLimit(binding, a, "my.list");
    await checkOutsideRateLimit(binding, b, "me.get");
    await checkOutsideRateLimit(binding, b, "me.get");
    expect(binding.hits("customer:cus_a:me.get")).toBe(4);
    expect(binding.hits("customer:cus_b:me.get")).toBe(2);
    // The public are limited per client address at the edge, not here.
    for (let n = 0; n < 5; n += 1) await checkOutsideRateLimit(binding, { kind: "public" }, "x");
    // A missing binding allows the call.
    await checkOutsideRateLimit(undefined, a, "me.get");
  });

  it("hold on code requests, per normalised address and never per client address", async () => {
    const binding = memoryRateLimit(3);
    await checkCodeRequestLimit(binding, "Ada@Example.com");
    await checkCodeRequestLimit(binding, " ada@example.com ");
    await checkCodeRequestLimit(binding, "ADA@EXAMPLE.COM");
    await expect(checkCodeRequestLimit(binding, "ada@example.com")).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    await checkCodeRequestLimit(binding, "bea@example.com");
    expect(binding.hits("code:ada@example.com")).toBe(4);
    expect(binding.hits("code:bea@example.com")).toBe(1);
    // Not an address: nothing to count (nothing will be sent).
    await checkCodeRequestLimit(binding, "not an address");
    expect(binding.hits("code:not an address")).toBe(0);
  });
});
