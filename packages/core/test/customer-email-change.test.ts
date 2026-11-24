// Stage 48 steps 2, 3 and 3b (ADR 0712): a recent sign-in, changing the sign-in address, staff
// starting a change, the payment provider given the new address, and erase taking a former
// address only while no other identified Person holds it (#302). Acceptance criteria 6 to 9 and
// 16, against real D1. The host's mail and the payments gatekeeper are a double that applies only
// what the real gatekeepers would apply at once: a send of one of the host's fixed sign-in
// templates from its sign-in queue (the email gatekeeper's own rule, imported), and the host's
// own provider calls.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { isSignInCodeMessage } from "../../gatekeeper-email-send/src/sign-in.ts";
import {
  type ActingUser,
  type BlobStore,
  type CustomerPrincipal,
  customerCodeReason,
  type IntegrationRuntime,
  invoke,
  invokeByName,
  issueDeviceSession,
  newId,
} from "../src/index.ts";
import { erasedAddressHash } from "../src/records/erase-subject.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

// --- The doubles --------------------------------------------------------------------------------

interface Mail {
  to: string;
  subject: string;
  text: string;
}
const sent: Mail[] = [];
const providerCalls: { customerRef: string; email: string; changeId: string }[] = [];
/** `review`: the gate would hold the host's sends for a person (they are not sent). */
let mailMode: "apply" | "review" = "apply";

const runtime = {
  async callAsHost(input: { method: string; args: unknown[]; purpose: string }) {
    if (input.method === "send") {
      const message = input.args[0] as { to: string[]; subject: string; text: string };
      const applies =
        mailMode === "apply" && input.purpose === "sign-in" && isSignInCodeMessage(message);
      if (!applies) return { value: { status: "pending", id: 1 }, pending: [{}], applied: [] };
      sent.push({ to: message.to[0] as string, subject: message.subject, text: message.text });
      return { value: { status: "sent", id: 1 }, pending: [], applied: [{}] };
    }
    if (input.method === "updateCustomerEmail" && input.purpose === "orders") {
      providerCalls.push(input.args[0] as (typeof providerCalls)[number]);
      return { value: { status: "sent", id: 1 }, pending: [], applied: [{}] };
    }
    throw new Error(`unexpected call ${input.method}`);
  },
} as unknown as IntegrationRuntime;

function memoryBlobs(): BlobStore {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key) ?? null,
    put: async (key, value) => {
      map.set(key, value);
    },
    delete: async (keys) => {
      for (const k of keys) map.delete(k);
    },
    list: async (prefix) => ({ keys: [...map.keys()].filter((k) => k.startsWith(prefix)) }),
  };
}

/** A staff call, with the host's mail (staff contexts carry the integration host too). */
const staff = (user?: ActingUser, overrides: Parameters<typeof context>[1] = {}) =>
  context(user ?? admin, { integrations: runtime, ...overrides });

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const address = (label: string) => `${unique(label).toLowerCase()}@change.example`;
const codeIn = (mail: Mail | undefined) => /is (\d{6})\./.exec(mail?.text ?? "")?.[1] ?? "";
const lastTo = (to: string) => sent.filter((m) => m.to === to).at(-1);

beforeAll(async () => {
  // The host's sign-in kind applies at once only under Balanced, once an admin turned it on.
  await setPreset("balanced");
  admin = await createUser("admin");
  member = await createUser("member");
  const now = iso();
  const mail = newId("connection");
  await env.DB.prepare(
    "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'email-send', 'org', ?, 'Mail', 'active', ?, ?, ?)",
  )
    .bind(
      mail,
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
  await invoke("customer.settings.update", { emailConnectionId: mail }, staff());
  await env.DB.prepare(
    `INSERT INTO core_outbound_kind (tag, vendor, label, auto_approvable, auto_approve, first_seen_at, updated_at)
     VALUES ('email.signin', 'email-send', 'Send sign-in codes', 1, 1, ?, ?)
     ON CONFLICT (tag) DO UPDATE SET auto_approve = 1, auto_approvable = 1`,
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'payments', 'org', ?, 'Payments', 'active', ?, ?, ?)",
  )
    .bind(
      newId("connection"),
      admin.id,
      JSON.stringify([
        {
          key: "merchant",
          url: "payments://merchant/fake",
          pattern: "payments://merchant/:provider",
          title: "Payments with Fake provider",
          tsType: "PaymentsSession",
          bindingName: "PAYMENTS",
        },
      ]),
      now,
      now,
    )
    .run();
});

// --- Fixtures -----------------------------------------------------------------------------------

interface Member {
  principal: CustomerPrincipal;
  email: string;
  /** A second address of the Person's, which a change leaves alone. */
  work: string;
  /** A browser session signed in a minute ago, one signed in an hour ago, and a phone's. */
  fresh: string;
  old: string;
  device: string;
}

async function newMember(): Promise<Member> {
  const email = address("m");
  const work = address("work");
  const person = await invoke(
    "person.create",
    {
      displayName: unique("Member"),
      emails: [
        { email, primary: true, label: "home" },
        { email: work, label: "work" },
      ],
    },
    staff(),
  );
  const customerId = newId("customer");
  const now = iso();
  await env.DB.prepare(
    `INSERT INTO core_customer (id, person_id, email, email_verified, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'active', ?, ?)`,
  )
    .bind(customerId, person.id, email, now, now)
    .run();
  const session = async (signedInAgoMs: number) => {
    const id = `ses_${unique("s")}`;
    await env.DB.prepare(
      `INSERT INTO core_customer_session (id, customer_id, token, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        customerId,
        `token-${id}`,
        iso(Date.now() + 86_400_000),
        iso(Date.now() - signedInAgoMs),
        now,
      )
      .run();
    return id;
  };
  const device = await issueDeviceSession(
    db,
    { audience: "customer", subjectId: customerId },
    "Phone",
    new Date(),
  );
  return {
    principal: { kind: "customer", customerId, personId: person.id },
    email,
    work,
    fresh: await session(60_000),
    old: await session(3_600_000),
    device: device.sessionId,
  };
}

function as(m: Member, sessionId: string | null = m.fresh, clock?: () => Date) {
  return {
    principal: m.principal,
    db,
    origin: { surface: "client" as const, ...(sessionId ? { sessionId } : {}) },
    integrations: runtime,
    ...(clock ? { clock } : {}),
  };
}

async function refusal(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    const e = error as { toJSON?: () => Record<string, unknown> };
    return typeof e.toJSON === "function" ? e.toJSON() : { thrown: String(error) };
  }
  throw new Error("expected a refusal");
}

const ask = (m: Member, email: string, sessionId?: string | null) =>
  invokeByName("me.email.change", { email }, as(m, sessionId)) as Promise<{
    newEmail: string;
    expiresAt: string;
  }>;
const confirm = (m: Member, code: string, sessionId?: string | null, clock?: () => Date) =>
  invokeByName("me.email.confirm", { code }, as(m, sessionId, clock)) as Promise<{
    signInEmail: string;
    sessionsEnded: number;
  }>;

async function accountEmail(customerId: string) {
  return (
    await env.DB.prepare("SELECT email FROM core_customer WHERE id = ?")
      .bind(customerId)
      .first<{ email: string }>()
  )?.email;
}

async function personEmails(personId: string) {
  const { results } = await env.DB.prepare(
    "SELECT email, label, is_primary FROM core_person_emails WHERE person_id = ? ORDER BY position",
  )
    .bind(personId)
    .all<{ email: string; label: string | null; is_primary: number }>();
  return results;
}

async function sessionIds(customerId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM core_customer_session WHERE customer_id = ?1 UNION ALL SELECT id FROM core_device_session WHERE customer_id = ?1",
  )
    .bind(customerId)
    .all<{ id: string }>();
  return results.map((r) => r.id).sort();
}

// --- Criterion 8: a recent sign-in ----------------------------------------------------------------

describe("a recent sign-in (criterion 8)", () => {
  it("refuses changing the address or deleting the account from an old, missing or foreign session", async () => {
    const m = await newMember();
    const other = await newMember();
    for (const sessionId of [m.old, null, other.fresh, other.device, "dvs_nonesuch"]) {
      expect(await refusal(ask(m, address("new"), sessionId)), String(sessionId)).toMatchObject({
        code: "sign_in_again",
        details: { withinMinutes: 15 },
      });
      expect(
        await refusal(invokeByName("me.deleteAccount", {}, as(m, sessionId))),
        String(sessionId),
      ).toMatchObject({ code: "sign_in_again" });
    }
    // Nothing was sent, asked or deleted.
    expect(
      sent.filter((s) => s.to.endsWith("@change.example") && s.text.includes(m.email)),
    ).toEqual([]);
    const status = await env.DB.prepare("SELECT status FROM core_customer WHERE id = ?")
      .bind(m.principal.customerId)
      .first<{ status: string }>();
    expect(status?.status).toBe("active");
  });

  it("allows a browser or app session signed in within 15 minutes", async () => {
    const m = await newMember();
    await expect(ask(m, address("new"), m.fresh)).resolves.toMatchObject({
      newEmail: expect.any(String),
    });
    await expect(ask(m, address("new"), m.device)).resolves.toMatchObject({
      newEmail: expect.any(String),
    });
  });

  it("an app session exchanged from an old browser sign-in is as old as it", async () => {
    const m = await newMember();
    const exchanged = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: m.principal.customerId },
      "Tablet",
      new Date(),
      new Date(Date.now() - 3_600_000),
    );
    expect(await refusal(ask(m, address("new"), exchanged.sessionId))).toMatchObject({
      code: "sign_in_again",
    });
  });
});

// --- Criterion 6: changing the address --------------------------------------------------------------

describe("changing the sign-in address (criterion 6)", () => {
  it("emails a code to the new address, and only the code changes the address", async () => {
    const m = await newMember();
    // They pay a subscription through a provider customer: it is given the new address.
    const customerRef = `fcus_${unique("c")}`;
    const now = iso();
    await env.DB.prepare(
      `INSERT INTO core_subscription (id, payer_person_id, holder_person_id, email, placed_as,
         plan_object, plan_id, plan_title, amount, currency, interval, state, provider, provider_ref,
         customer_ref, cancel_at_period_end, observed_at, created_at, updated_at, version)
       VALUES (?, ?, ?, NULL, 'customer', 'plan', 'pln_1', 'Monthly', 4000, 'AUD', 'month',
         'active', 'fake', ?, ?, 0, ?, ?, ?, 0)`,
    )
      .bind(
        newId("subscription"),
        m.principal.personId,
        m.principal.personId,
        unique("sub"),
        customerRef,
        now,
        now,
        now,
      )
      .run();

    const next = address("next");
    const asked = await ask(m, next);
    expect(asked).toEqual({ newEmail: next, expiresAt: expect.any(String) });
    expect(Date.parse(asked.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    const mail = lastTo(next);
    expect(mail?.subject).toMatch(/^Confirm your new .+ sign-in address$/);
    const code = codeIn(mail);
    expect(code).toMatch(/^\d{6}$/);
    // Nothing changed yet; the code is kept only as a hash.
    expect(await accountEmail(m.principal.customerId)).toBe(m.email);
    const row = await env.DB.prepare(
      "SELECT * FROM core_customer_email_change WHERE customer_id = ?",
    )
      .bind(m.principal.customerId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ new_email: next, old_email: m.email, started_by: "customer" });
    expect(JSON.stringify(row)).not.toContain(code);

    const done = await confirm(m, code);
    // Other sessions ended (the old browser one and the phone); this one stays.
    expect(done).toEqual({ signInEmail: next, sessionsEnded: 2 });
    expect(await sessionIds(m.principal.customerId)).toEqual([m.fresh]);
    const me = (await invokeByName("me.get", {}, as(m))) as Record<string, unknown>;
    expect(me).toMatchObject({ signInEmail: next, primaryEmail: next, signInEmailVerified: true });
    // The old sign-in address left the Person; the other address stayed.
    expect(await personEmails(m.principal.personId)).toEqual([
      { email: next, label: "home", is_primary: 1 },
      { email: m.work, label: "work", is_primary: 0 },
    ]);
    // They sign in with the new address only: the old one has no account now.
    expect(await customerCodeReason(db.query, next)).toBe("account");
    expect(await customerCodeReason(db.query, m.email)).not.toBe("account");
    // The old address is told, naming the new one only in part.
    const notice = lastTo(m.email);
    expect(notice?.subject).toMatch(/sign-in address was changed$/);
    expect(notice?.text).toContain(`${next.slice(0, 1)}•••@change.example`);
    expect(notice?.text).not.toContain(next);
    // The provider is given the new address, once per provider customer.
    expect(providerCalls.filter((c) => c.customerRef === customerRef)).toEqual([
      { customerRef, email: next, changeId: row?.id },
    ]);
    // On the timeline, naming no address; the code is nowhere in the audit.
    const activity = await env.DB.prepare(
      `SELECT a.subject, a.payload FROM core_activity a JOIN core_activity_links l ON l.activity_id = a.id
       WHERE l.object_type = 'person' AND l.record_id = ? AND a.subject = 'Sign-in address changed'`,
    )
      .bind(m.principal.personId)
      .first<{ subject: string; payload: string }>();
    expect(JSON.parse(activity?.payload ?? "{}")).toEqual({
      kind: "sign_in_address",
      action: "changed",
      startedBy: "customer",
    });
    const audit = await env.DB.prepare(
      "SELECT input, actor, outcome FROM core_audit WHERE operation = 'me.email.confirm' AND user_id = ?",
    )
      .bind(m.principal.customerId)
      .first<{ input: string; actor: string; outcome: string }>();
    expect(audit).toMatchObject({ actor: "customer", outcome: "ok" });
    expect(audit?.input).not.toContain(code);
    // The code works once.
    expect(await refusal(confirm(m, code))).toMatchObject({ code: "invalid_input" });
  });

  it("a newer request replaces the open one", async () => {
    const m = await newMember();
    const first = address("first");
    const second = address("second");
    await ask(m, first);
    const firstCode = codeIn(lastTo(first));
    await ask(m, second);
    const secondCode = codeIn(lastTo(second));
    if (firstCode !== secondCode) {
      expect(await refusal(confirm(m, firstCode))).toMatchObject({ code: "invalid_input" });
    }
    await expect(confirm(m, secondCode)).resolves.toMatchObject({ signInEmail: second });
  });

  it("refuses the address it already is, and sends nothing when the code would wait for review", async () => {
    const m = await newMember();
    expect(await refusal(ask(m, m.email.toUpperCase()))).toMatchObject({ code: "invalid_input" });
    mailMode = "review";
    try {
      const next = address("held");
      expect(await refusal(ask(m, next))).toMatchObject({ code: "integration_error" });
      expect(lastTo(next)).toBeUndefined();
      // Only its reservation, never open, so its code can never be confirmed.
      expect(
        (await changeRows(m.principal.customerId)).map((r) => [r.new_email, r.end_reason]),
      ).toEqual([[next, "unsent"]]);
    } finally {
      mailMode = "apply";
    }
  });
});

// --- Criterion 7: an address in use -------------------------------------------------------------------

describe("an address in use at the business (criterion 7)", () => {
  it("is answered exactly as a usable one, and refused only once the mailbox is proved", async () => {
    const taken = await newMember();
    const personAddress = address("contact");
    await invoke(
      "person.create",
      { displayName: unique("Contact"), emails: [{ email: personAddress }] },
      staff(member),
    );
    const erased = address("erased");
    await env.DB.prepare(
      "INSERT INTO core_erased_address (hash, object_type, erased_at, erased_by) VALUES (?, 'person', ?, ?)",
    )
      .bind(await erasedAddressHash(erased), iso(), admin.id)
      .run();

    for (const used of [personAddress, taken.email, erased]) {
      const m = await newMember();
      const asked = await ask(m, used);
      expect(Object.keys(asked).sort(), used).toEqual(["expiresAt", "newEmail"]);
      const code = codeIn(lastTo(used));
      expect(code, used).toMatch(/^\d{6}$/);
      expect(await refusal(confirm(m, code)), used).toMatchObject({
        code: "conflict",
        message: "This address is already in use at the business",
      });
      // Nothing changed.
      expect(await accountEmail(m.principal.customerId)).toBe(m.email);
      expect((await personEmails(m.principal.personId)).map((e) => e.email)).toEqual([
        m.email,
        m.work,
      ]);
      expect((await sessionIds(m.principal.customerId)).length).toBe(3);
    }
    expect(await accountEmail(taken.principal.customerId)).toBe(taken.email);
  });
});

// --- Criterion 8: wrong codes ------------------------------------------------------------------------

describe("wrong codes (criterion 8)", () => {
  it("five wrong codes end the change; the right one then fails", async () => {
    const m = await newMember();
    const next = address("next");
    await ask(m, next);
    const code = codeIn(lastTo(next));
    const wrong = code === "000000" ? "111111" : "000000";
    for (let n = 4; n >= 0; n -= 1) {
      expect(await refusal(confirm(m, wrong))).toMatchObject({
        code: "invalid_input",
        details: { rule: "code", triesLeft: n },
      });
    }
    expect(await refusal(confirm(m, code))).toMatchObject({ code: "invalid_input" });
    const row = await env.DB.prepare(
      "SELECT end_reason, tries_left FROM core_customer_email_change WHERE customer_id = ?",
    )
      .bind(m.principal.customerId)
      .first();
    expect(row).toEqual({ end_reason: "tries", tries_left: 0 });
    expect(await accountEmail(m.principal.customerId)).toBe(m.email);
  });

  it("a code stops working after 15 minutes", async () => {
    const m = await newMember();
    const next = address("late");
    await ask(m, next);
    const later = new Date(Date.now() + 16 * 60_000);
    // Signed in again just before, so only the code's age is in question.
    await env.DB.prepare("UPDATE core_customer_session SET created_at = ? WHERE id = ?")
      .bind(iso(later.getTime() - 60_000), m.fresh)
      .run();
    expect(await refusal(confirm(m, codeIn(lastTo(next)), m.fresh, () => later))).toMatchObject({
      code: "invalid_input",
    });
    expect(await accountEmail(m.principal.customerId)).toBe(m.email);
  });

  it("limits requests per account and per mailbox", async () => {
    const m = await newMember();
    for (let n = 0; n < 5; n += 1) await ask(m, address(`a${n}`));
    expect(await refusal(ask(m, address("a5")))).toMatchObject({ code: "rate_limited" });
    // Three asks for one mailbox, whoever asks and with whatever +tag; the fourth is refused.
    const box = address("box");
    const [local, domain] = box.split("@");
    for (let n = 0; n < 3; n += 1) await ask(await newMember(), `${local}+${n}@${domain}`);
    expect(await refusal(ask(await newMember(), box))).toMatchObject({ code: "rate_limited" });
  });
});

// --- Races and limits (the review of PR #384) -----------------------------------------------------

const changeRows = async (customerId: string) =>
  (
    await env.DB.prepare(
      "SELECT id, old_email, new_email, confirmed_at, end_reason FROM core_customer_email_change WHERE customer_id = ? ORDER BY created_at, id",
    )
      .bind(customerId)
      .all<{
        id: string;
        old_email: string;
        new_email: string;
        confirmed_at: string | null;
        end_reason: string | null;
      }>()
  ).results;

describe("races (criteria 6, 8 and 9)", () => {
  it("a confirm racing a staff cancel: one of them wins, and a cancel that answers true held", async () => {
    for (let run = 0; run < 6; run += 1) {
      const m = await newMember();
      const next = address("race");
      await ask(m, next);
      const code = codeIn(lastTo(next));
      const [confirmed, cancelled] = await Promise.allSettled([
        confirm(m, code),
        invoke("customer.cancelEmailChange", { id: m.principal.customerId }, staff()),
      ]);
      const changed = (await accountEmail(m.principal.customerId)) === next;
      const [row] = await changeRows(m.principal.customerId);
      const saidCancelled =
        cancelled.status === "fulfilled" && (cancelled.value as { cancelled: boolean }).cancelled;
      if (changed) {
        expect(confirmed.status, `run ${run}`).toBe("fulfilled");
        expect(saidCancelled, `run ${run}`).toBe(false);
        expect(row?.confirmed_at, `run ${run}`).not.toBeNull();
      } else {
        expect(confirmed.status, `run ${run}`).toBe("rejected");
        expect(saidCancelled, `run ${run}`).toBe(true);
        expect(row?.end_reason, `run ${run}`).toBe("cancelled");
        expect((await personEmails(m.principal.personId))[0]?.email).toBe(m.email);
      }
    }
  });

  it("a confirm racing a newer request never leaves an open change planned from an old address", async () => {
    for (let run = 0; run < 6; run += 1) {
      const m = await newMember();
      const first = address("first");
      await ask(m, first);
      const code = codeIn(lastTo(first));
      await Promise.allSettled([confirm(m, code), ask(m, address("second"))]);
      const current = await accountEmail(m.principal.customerId);
      const rows = await changeRows(m.principal.customerId);
      const confirmed = rows.filter((r) => r.confirmed_at);
      // The address changed only by a confirmed change, and any change still open replaces the
      // address the account has now.
      expect(current === first, `run ${run}`).toBe(confirmed.length === 1);
      for (const open of rows.filter((r) => !r.confirmed_at && !r.end_reason)) {
        expect(open.old_email, `run ${run}`).toBe(current);
      }
      if (current === first) expect(confirmed[0]?.new_email).toBe(first);
    }
  });

  it("two right codes at once, on the web and in the app: one change, one notice, one session left", async () => {
    for (let run = 0; run < 4; run += 1) {
      const m = await newMember();
      const next = address("twice");
      await ask(m, next);
      const code = codeIn(lastTo(next));
      const before = sent.filter((x) => x.to === m.email).length;
      const results = await Promise.allSettled([
        confirm(m, code, m.fresh),
        confirm(m, code, m.device),
      ]);
      expect(
        results.filter((r) => r.status === "fulfilled"),
        `run ${run}`,
      ).toHaveLength(1);
      expect(await accountEmail(m.principal.customerId)).toBe(next);
      expect((await sessionIds(m.principal.customerId)).length, `run ${run}`).toBe(1);
      expect(sent.filter((x) => x.to === m.email).length - before, `run ${run}`).toBe(1);
      const activities = await env.DB.prepare(
        `SELECT count(*) AS n FROM core_activity a JOIN core_activity_links l ON l.activity_id = a.id
         WHERE l.object_type = 'person' AND l.record_id = ? AND a.subject = 'Sign-in address changed'`,
      )
        .bind(m.principal.personId)
        .first<{ n: number }>();
      expect(activities?.n, `run ${run}`).toBe(1);
    }
  });

  it("parallel requests cannot pass the per-mailbox or per-account limit", async () => {
    const box = address("crowd");
    const members = await Promise.all(Array.from({ length: 10 }, () => newMember()));
    const before = sent.filter((x) => x.to === box).length;
    const outcomes = await Promise.allSettled(members.map((m) => ask(m, box)));
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(3);
    expect(sent.filter((x) => x.to === box).length - before).toBe(3);

    const one = await newMember();
    const targets = Array.from({ length: 12 }, (_, n) => address(`many${n}`));
    await Promise.allSettled(targets.map((t) => ask(one, t)));
    // At most five codes go out for one account in an hour, however the requests arrive.
    expect(sent.filter((x) => targets.includes(x.to)).length).toBeLessThanOrEqual(5);
    expect((await changeRows(one.principal.customerId)).length).toBeLessThanOrEqual(5);
    expect(await refusal(ask(one, address("later")))).toMatchObject({ code: "rate_limited" });
  });

  it("a code that did not go out still counts towards the limit", async () => {
    const m = await newMember();
    mailMode = "review";
    try {
      for (let n = 0; n < 5; n += 1) {
        expect(await refusal(ask(m, address(`held${n}`)))).toMatchObject({
          code: "integration_error",
        });
      }
    } finally {
      mailMode = "apply";
    }
    expect(await refusal(ask(m, address("after")))).toMatchObject({ code: "rate_limited" });
    // None of them can be confirmed: there is no open change.
    expect(await refusal(confirm(m, "123456"))).toMatchObject({ code: "invalid_input" });
  });
});

describe("a recent sign-in at confirm (criterion 8, decision 4)", () => {
  it("a member's own request is confirmed only from a session signed in within 15 minutes", async () => {
    const m = await newMember();
    const next = address("stale");
    await ask(m, next);
    const code = codeIn(lastTo(next));
    for (const sessionId of [m.old, null]) {
      expect(await refusal(confirm(m, code, sessionId))).toMatchObject({ code: "sign_in_again" });
    }
    expect(await accountEmail(m.principal.customerId)).toBe(m.email);
    await expect(confirm(m, code, m.device)).resolves.toMatchObject({ signInEmail: next });
  });
});

describe("the Person's addresses (D1's limits)", () => {
  /** env.DB, noting each statement's bound variables. */
  const bound: number[] = [];
  const counted = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(inner, name) {
              if (name === "bind") {
                return (...values: unknown[]) => {
                  bound.push(values.length);
                  return inner.bind(...values);
                };
              }
              const value = Reflect.get(inner, name);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  it("a Person with twenty addresses changes theirs with every statement under 100 variables", async () => {
    const m = await newMember();
    // Twenty in all: the sign-in address, the work one and eighteen more.
    const more = Array.from({ length: 18 }, (_, n) => ({ email: address(`extra${n}`) }));
    await invoke(
      "person.update",
      {
        id: m.principal.personId,
        emails: [{ email: m.email, primary: true }, { email: m.work }, ...more],
      },
      staff(),
    );
    const next = address("wide");
    await ask(m, next);
    const code = codeIn(lastTo(next));
    bound.length = 0;
    await invokeByName("me.email.confirm", { code }, { ...as(m), db: createCrmDb(counted) });
    expect(await accountEmail(m.principal.customerId)).toBe(next);
    expect((await personEmails(m.principal.personId)).length).toBe(20);
    expect(Math.max(...bound)).toBeLessThan(100);
  });

  it("refuses, before a try is spent, a change that would give the Person a 21st address", async () => {
    const m = await newMember();
    // Staff moved the Person's addresses on: the sign-in address is not among their twenty.
    const twenty = Array.from({ length: 20 }, (_, n) => ({ email: address(`full${n}`) }));
    await invoke("person.update", { id: m.principal.personId, emails: twenty }, staff());
    const next = address("one-more");
    await ask(m, next);
    expect(await refusal(confirm(m, codeIn(lastTo(next))))).toMatchObject({
      code: "conflict",
      details: { rule: "too_many_emails" },
    });
    const [row] = await env.DB.prepare(
      "SELECT tries_left FROM core_customer_email_change WHERE customer_id = ? AND end_reason IS NULL",
    )
      .bind(m.principal.customerId)
      .all<{ tries_left: number }>()
      .then((r) => r.results);
    expect(row?.tries_left).toBe(5);
  });

  it("a change the account moved on from is said so, not that the address is in use", async () => {
    const m = await newMember();
    const next = address("moved-on");
    await ask(m, next);
    await env.DB.prepare("UPDATE core_customer SET email = ? WHERE id = ?")
      .bind(address("elsewhere"), m.principal.customerId)
      .run();
    expect(await refusal(confirm(m, codeIn(lastTo(next))))).toMatchObject({
      code: "conflict",
      details: { rule: "change_stale" },
    });
  });
});

// --- Criterion 9: staff start a change -----------------------------------------------------------------

describe("staff start a change (criterion 9)", () => {
  it("changes nothing until the member enters the code; staff never see it", async () => {
    const m = await newMember();
    const next = address("phoned");
    const started = await invoke(
      "customer.changeEmail",
      { id: m.principal.customerId, email: next },
      staff(),
    );
    expect(started).toEqual({
      id: m.principal.customerId,
      newEmail: next,
      expiresAt: expect.any(String),
    });
    const code = codeIn(lastTo(next));
    expect(JSON.stringify(started)).not.toContain(code);
    expect(await accountEmail(m.principal.customerId)).toBe(m.email);
    // The account card shows it pending, the new address only in part.
    const { items } = await invoke("customer.list", { personId: m.principal.personId }, staff());
    expect(items[0]).toMatchObject({
      email: m.email,
      emailChange: {
        newEmail: `${next.slice(0, 1)}•••@change.example`,
        startedBy: "staff",
        expired: false,
      },
      eraseRequest: null,
    });
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'customer.changeEmail' AND user_id = ?",
    )
      .bind(admin.id)
      .all<{ input: string; result: string }>();
    expect(JSON.stringify(audit.results)).not.toContain(code);
    // Only the member's own session finishes it, signed in within 15 minutes (decision 4): an
    // older one is sent to sign in again, and the code keeps working.
    expect(await refusal(confirm(m, code, m.old))).toMatchObject({ code: "sign_in_again" });
    expect(await accountEmail(m.principal.customerId)).toBe(m.email);
    await expect(confirm(m, code, m.fresh)).resolves.toMatchObject({ signInEmail: next });
    expect(lastTo(m.email)?.subject).toMatch(/sign-in address was changed$/);
  });

  it("another member cannot finish it, and staff can cancel it", async () => {
    const m = await newMember();
    const other = await newMember();
    const next = address("cancel");
    await invoke("customer.changeEmail", { id: m.principal.customerId, email: next }, staff());
    const code = codeIn(lastTo(next));
    expect(await refusal(confirm(other, code))).toMatchObject({ code: "invalid_input" });
    expect(
      await invoke("customer.cancelEmailChange", { id: m.principal.customerId }, staff()),
    ).toEqual({ id: m.principal.customerId, cancelled: true });
    expect(await refusal(confirm(m, code))).toMatchObject({ code: "invalid_input" });
    expect(await accountEmail(m.principal.customerId)).toBe(m.email);
    expect(
      await invoke("customer.cancelEmailChange", { id: m.principal.customerId }, staff()),
    ).toEqual({ id: m.principal.customerId, cancelled: false });
  });

  it("is for human admins only: the assistant, MCP and members are refused", async () => {
    const m = await newMember();
    for (const ctx of [
      staff(admin, { actor: "assistant" }),
      staff(admin, { actor: "mcp" }),
      staff(member),
    ]) {
      for (const name of ["customer.changeEmail", "customer.cancelEmailChange"]) {
        expect(
          await refusal(
            invokeByName(name, { id: m.principal.customerId, email: address("x") }, ctx),
          ),
          `${name} ${ctx.actor}`,
        ).toMatchObject({ code: "forbidden" });
      }
    }
    expect(await accountEmail(m.principal.customerId)).toBe(m.email);
  });
});

// --- Criterion 16: erase and a former address (#302) -----------------------------------------------------

describe("erase and a former sign-in address (criterion 16, #302)", () => {
  it("A moves away from an address, B signs up with it, erasing A leaves B's account", async () => {
    const a = await newMember();
    const moved = a.email;
    const next = address("moved");
    await ask(a, next);
    await confirm(a, codeIn(lastTo(next)));
    // B, a new Person with A's old address, and B's account with it.
    const b = await invoke(
      "person.create",
      { displayName: unique("B"), emails: [{ email: moved }] },
      staff(),
    );
    const bAccount = newId("customer");
    await env.DB.prepare(
      `INSERT INTO core_customer (id, person_id, email, email_verified, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'active', ?, ?)`,
    )
      .bind(bAccount, b.id, moved, iso(), iso())
      .run();

    await invoke(
      "person.erase",
      { id: a.principal.personId },
      staff(admin, { blobs: memoryBlobs() }),
    );

    expect(await accountEmail(bAccount)).toBe(moved);
    expect((await personEmails(b.id)).map((e) => e.email)).toEqual([moved]);
    const status = (email: string) =>
      invoke("erasure.addressStatus", { email }, staff()) as Promise<{ erased: boolean }>;
    expect((await status(moved)).erased).toBe(false);
    expect((await status(next)).erased).toBe(true);
    // A's account and its change records are gone.
    expect(await accountEmail(a.principal.customerId)).toBeUndefined();
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_customer_email_change WHERE customer_id = ?",
    )
      .bind(a.principal.customerId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("the same holds for an address staff moved by editing A's emails", async () => {
    const a = await newMember();
    const moved = a.email;
    const other = address("other");
    await invoke(
      "person.update",
      { id: a.principal.personId, emails: [{ email: other, primary: true }] },
      staff(),
    );
    const b = await invoke(
      "person.create",
      { displayName: unique("B"), emails: [{ email: moved }] },
      staff(),
    );
    await invoke(
      "person.erase",
      { id: a.principal.personId },
      staff(admin, { blobs: memoryBlobs() }),
    );
    expect((await personEmails(b.id)).map((e) => e.email)).toEqual([moved]);
    const status = (email: string) =>
      invoke("erasure.addressStatus", { email }, staff()) as Promise<{ erased: boolean }>;
    expect((await status(moved)).erased).toBe(false);
    expect((await status(other)).erased).toBe(true);
  });

  it("an account signed up with A's old address and not linked yet is not A's either", async () => {
    const a = await newMember();
    const moved = a.email;
    const next = address("moved");
    await ask(a, next);
    await confirm(a, codeIn(lastTo(next)));
    const unlinked = newId("customer");
    await env.DB.prepare(
      `INSERT INTO core_customer (id, person_id, email, email_verified, status, link_state, created_at, updated_at)
       VALUES (?, NULL, ?, 1, 'active', 'needs_merge', ?, ?)`,
    )
      .bind(unlinked, moved, iso(), iso())
      .run();
    await invoke(
      "person.erase",
      { id: a.principal.personId },
      staff(admin, { blobs: memoryBlobs() }),
    );
    expect(await accountEmail(unlinked)).toBe(moved);
  });

  it("an address A moved away from that nobody took is erased with A", async () => {
    const a = await newMember();
    const moved = a.email;
    const next = address("moved");
    await ask(a, next);
    await confirm(a, codeIn(lastTo(next)));
    await invoke(
      "person.erase",
      { id: a.principal.personId },
      staff(admin, { blobs: memoryBlobs() }),
    );
    const status = (email: string) =>
      invoke("erasure.addressStatus", { email }, staff()) as Promise<{ erased: boolean }>;
    expect((await status(moved)).erased).toBe(true);
    expect((await status(next)).erased).toBe(true);
  });
});
