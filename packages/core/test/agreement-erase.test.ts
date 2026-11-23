// Stage 44 step 8 (ADR 0646): erase, merge, the Trash and keeping records (acceptance criterion
// 14, and the deferrals of steps 2 to 4). Erase deletes health answers, the minor mark, the
// health notice and a buyer's unpaid acceptances at once, and keeps the rest of each acceptance
// detached as the business's evidence, read only by a person with agreements:manage, until the
// retention period ends; then the purge deletes it, never one on hold. A copy waiting for a person
// has its approval turned down and redacted, and the email gatekeeper's storage of every copy is
// scrubbed through the host's own agreements mail; a copy whose send was in flight ends not sent
// or scrubbed after. Merge moves acceptances and changes nothing in them. All text here is fixture
// text, not wording anyone should use.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { agreementsDue } from "../src/agreements/due.ts";
import { runAgreementRetention } from "../src/agreements/retention.ts";
import type {
  ActingUser,
  Actor,
  CustomerPrincipal,
  IntegrationCallResult,
  IntegrationRuntime,
  InvocationContext,
} from "../src/index.ts";
import { memoryEventSink, newId, sendAgreementCopies, submitOutbound } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import { CURRENCY, createBuyer, outside, PUBLIC, refusal, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const DAY = 86_400_000;
const GYM = extId("ers");
const PASS = `${GYM}.pass`;
const PLAN = `${GYM}.plan`;
const tag = Date.now().toString(36);
const POINT = `pr${tag}`;
const RETURN = "https://gym.example.com/account";
const QUESTIONS = [{ key: "q1", text: "Fixture question?", noteOnYes: true }];
const SECRET_NOTE = "Fixture health note 51c2";
const SIGNATURE = {
  width: 1000,
  height: 400,
  strokes: [
    [
      [100, 200],
      [200, 100],
      [300, 300],
      [400, 100],
    ],
  ],
};

// --- The email gatekeeper, as the host's callAsHost reaches it -----------------------------------

interface Sent {
  to: string[];
  subject: string;
  text: string;
  agreement?: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * What email-send does with the host's agreements mail, for this step: a send is delivered (or
 * held for a person, as a real pending approval in the host), its recipients and subject go to
 * the sent history, and `scrubAgreementCopy` (the agreements queue only) drops a waiting send,
 * refuses any later send under the copy's key and blanks the history line. `during` runs between
 * the gatekeeper's delivery and its answer to the host: an erase that lands mid-send.
 */
function mailDouble(payments: IntegrationRuntime, connection: () => string) {
  const delivered: Sent[] = [];
  const waiting = new Map<string, Sent>();
  const history = new Map<string, { to: string[]; subject: string }>();
  const scrubbed = new Set<string>();
  const scrubCalls: { purpose: string; key: string }[] = [];
  const modes: ("apply" | "pending")[] = [];
  let during: (() => Promise<void>) | null = null;
  let next = 0;
  const base = (key: string) => key.split(":").slice(0, 2).join(":");
  const runtime: IntegrationRuntime = {
    ...payments,
    async callAsHost(input): Promise<IntegrationCallResult> {
      if (input.method === "scrubAgreementCopy") {
        if (input.purpose !== "agreements") {
          throw new Error("Refused: only the host's own agreements mail scrubs a copy.");
        }
        const key = (input.args[0] as { key: string }).key;
        scrubCalls.push({ purpose: input.purpose, key });
        scrubbed.add(key);
        for (const k of [...waiting.keys()]) if (base(k) === key) waiting.delete(k);
        for (const [k] of history) {
          if (base(k) === key) history.set(k, { to: [], subject: "[erased]" });
        }
        return { value: { done: true, dropped: 0, redacted: 0 }, pending: [], applied: [] };
      }
      if (input.method !== "send") {
        return (payments.callAsHost as NonNullable<IntegrationRuntime["callAsHost"]>)(input);
      }
      const message = input.args[0] as Sent;
      const key = message.idempotencyKey ?? "";
      if (scrubbed.has(base(key))) {
        throw new Error("Refused: this copy's agreement was erased, and it is not sent.");
      }
      next += 1;
      const id = next;
      if (modes.shift() === "pending") {
        waiting.set(key, message);
        // A real pending approval in the host, as the integration host mirrors one.
        const decision = await submitOutbound(db, {
          connectionId: connection(),
          connectionTitle: "Mail",
          vendor: "email-send",
          facetKey: "k1",
          resourceTitle: "Mail",
          action: id,
          description: {
            title: `Send email: ${message.subject}`,
            description: `To ${message.to.join(", ")}`,
            fields: [
              { label: "To", value: message.to.join(", ") },
              { label: "Subject", value: message.subject },
            ],
            implementsRevert: false,
            autoApprovable: false,
            actionKind: { tag: "email.agreement", label: "Send copies of signed agreements" },
          },
          actor: "automation",
          user: admin,
          origin: { surface: "automation", automationId: "x.mail" },
        });
        if (decision.decision !== "review") throw new Error("expected a person's approval");
        return {
          value: { status: "pending", id },
          pending: [decision.pending],
          applied: [],
        };
      }
      delivered.push(message);
      history.set(key, { to: message.to, subject: message.subject });
      const hook = during;
      during = null;
      if (hook) await hook();
      return {
        value: { status: "sent", id },
        pending: [],
        applied: [{ action: id, actionKind: "email.agreement", title: "Send email" }],
      };
    },
  };
  return {
    runtime,
    delivered,
    waiting,
    history,
    scrubCalls,
    modes,
    setDuring: (hook: () => Promise<void>) => {
      during = hook;
    },
  };
}

// --- Fixtures --------------------------------------------------------------------------------------

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
let connectionId = "";
const mail = mailDouble(payments.runtime, () => connectionId);
let admin: ActingUser;
let member: ActingUser;
let pass: string;
let plan: string;

const staff = (user: ActingUser = admin, extra: Partial<InvocationContext> = {}) =>
  context(user, { integrations: mail.runtime, events, ...extra });
const as = (principal: CustomerPrincipal | { kind: "public" }) =>
  outside(principal as CustomerPrincipal, { integrations: mail.runtime, events });

const body = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

interface Doc {
  id: string;
  versionId: string;
  kind: string;
}

async function publish(
  kind: "waiver" | "health" | "guardian",
  options: { how?: "typed" | "drawn"; forWhom?: "everyone" | "dependants" } = {},
): Promise<Doc> {
  const { id } = await run<{ id: string }>(
    "agreement.create",
    { title: unique(`Fixture ${kind}`), kind },
    staff(),
  );
  const saved = await run<{ hash: string; rev: number }>(
    "agreement.draft.save",
    {
      id,
      body: body("Fixture text: not a real document."),
      tickLabel: "I have read this fixture",
      ...(options.how ? { how: options.how } : {}),
      ...(options.forWhom ? { forWhom: options.forWhom } : {}),
      ...(kind === "health" ? { questions: QUESTIONS } : {}),
    },
    staff(),
  );
  const { version } = await run<{ version: { id: string } }>(
    "agreement.publish",
    { documentId: id, draftHash: saved.hash, draftRev: saved.rev, number: 1, change: "small" },
    staff(),
  );
  await run("agreement.attach", { documentId: id, points: [POINT] }, staff());
  return { id, versionId: version.id, kind };
}

let drawn: Doc;
let health: Doc;
let guardianDoc: Doc;

const accept = (
  principal: CustomerPrincipal,
  doc: Doc,
  extra: Record<string, unknown> = {},
  typedName = "Fixture Typed Name",
) =>
  run<{ id: string }>(
    "me.agreements.accept",
    {
      versionId: doc.versionId,
      typedName,
      ...(doc.kind === "health" ? { answers: [{ key: "q1", yes: true, note: SECRET_NOTE }] } : {}),
      ...(doc === drawn || doc === guardianDoc ? { signature: SIGNATURE } : {}),
      ...extra,
    },
    as(principal),
  );

/** What a visitor carries with their purchase: the drawn waiver and the health form. */
const guestAgrees = () => [
  { versionId: drawn.versionId, typedName: "Fixture Visitor", signature: SIGNATURE },
  {
    versionId: health.versionId,
    typedName: "Fixture Visitor",
    answers: [{ key: "q1", yes: true }],
  },
];

const row = (table: string, column: string, value: string) =>
  env.DB.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first<Record<string, unknown>>();
const rows = async (table: string, column: string, value: string) =>
  (
    await env.DB.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`)
      .bind(value)
      .all<Record<string, unknown>>()
  ).results;

const AI_ACTORS: { actor: Actor; origin: InvocationContext["origin"] }[] = [
  { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_erase" } },
  { actor: "mcp", origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "cap_e" } },
  { actor: "automation", origin: { surface: "automation", automationId: "x.y" } },
];

beforeAll(async () => {
  events = memoryEventSink();
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(
    manifest(GYM, {
      objects: {
        pass: {
          label: "Pass",
          plural: "Passes",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
          },
          sellable: { price: "price" },
          public: { read: ["name", "price"] },
          agreements: { point: POINT, label: "Buying a pass" },
        },
        plan: {
          label: "Plan",
          plural: "Plans",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price per month", currency: CURRENCY },
          },
          sellable: { price: "price", recurring: { interval: "month" } },
          public: { read: ["name", "price"] },
          agreements: { point: POINT, label: "Buying a plan" },
        },
      },
    }),
  );
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://gym.example.com"] },
    staff(),
  );
  pass = (
    await run<{ id: string }>(
      "record.create",
      { object: PASS, values: { name: "Ten", price: 90 } },
      staff(),
    )
  ).id;
  plan = (
    await run<{ id: string }>(
      "record.create",
      { object: PLAN, values: { name: "Monthly", price: 40 } },
      staff(),
    )
  ).id;
  await payments.connect(admin.id);
  connectionId = newId("connection");
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'email-send', 'org', ?, 'Mail', 'active', ?, ?, ?)",
  )
    .bind(
      connectionId,
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
  await run("notification.updateDeliverySettings", { email: connectionId }, staff());
  drawn = await publish("waiver", { how: "drawn" });
  health = await publish("health");
  guardianDoc = await publish("guardian", { forWhom: "dependants", how: "drawn" });
}, 120_000);

/** A customer who agreed to everything attached for themselves (drawn waiver, health form). */
async function agreedBuyer(label: string) {
  const buyer = await createBuyer(admin, label);
  const signed = await accept(buyer.principal, drawn);
  const answered = await accept(buyer.principal, health);
  return { buyer, signed: signed.id, answered: answered.id };
}

const erase = (personId: string, extra: Partial<InvocationContext> = {}) =>
  run<{
    agreementsKept?: { count: number; until: string | null; deleted: number };
  }>("person.erase", { id: personId }, staff(admin, extra));

// --- Erase -----------------------------------------------------------------------------------------

describe("erase (criterion 14)", () => {
  it("deletes health answers, the minor mark, the health notice and a buyer's unpaid acceptances at once, and keeps the rest detached", async () => {
    const { buyer, signed, answered } = await agreedBuyer("erase");
    const personId = buyer.principal.personId;
    await run("agreement.setMinor", { personId, minor: true }, staff());
    expect(await row("core_notifications", "dedupe_key", `agreement-health:${answered}`)).not.toBe(
      null,
    );
    // A visit bought as a guest with their address, still unpaid; and a membership checkout the
    // provider never confirmed.
    const order = await run<{ id: string }>(
      "order.start",
      {
        lines: [{ object: PASS, id: pass, quantity: 1 }],
        email: buyer.email,
        agreements: guestAgrees(),
      },
      as(PUBLIC),
    );
    const checkout = await run<{ subscriptionId: string }>(
      "subscription.start",
      {
        plan: { object: PLAN, id: plan },
        returnUrl: RETURN,
        email: buyer.email,
        agreements: guestAgrees(),
      },
      as(PUBLIC),
    );
    const guestRows = [
      ...(await rows("core_agreement_acceptance", "order_id", order.id)),
      ...(await rows(
        "core_agreement_acceptance",
        "subscription_checkout",
        checkout.subscriptionId,
      )),
    ].map((r) => r.id as string);
    expect(guestRows).toHaveLength(4);

    const before = await row("core_agreement_acceptance", "id", signed);
    const out = await erase(personId);

    // What goes at once.
    expect(await row("core_agreement_answer", "acceptance_id", answered)).toBeNull();
    expect(await row("core_agreement_minor", "person_id", personId)).toBeNull();
    expect(
      await row("core_notifications", "dedupe_key", `agreement-health:${answered}`),
    ).toBeNull();
    for (const id of guestRows) {
      expect(await row("core_agreement_acceptance", "id", id)).toBeNull();
      expect(await row("core_agreement_signature", "acceptance_id", id)).toBeNull();
      expect(await row("core_agreement_answer", "acceptance_id", id)).toBeNull();
    }
    // What is kept: everything the record says, detached from the deleted Person.
    const kept = await row("core_agreement_acceptance", "id", signed);
    expect(kept).toEqual({
      ...before,
      person_id: null,
      account_id: null,
      erased_at: expect.any(String),
    });
    expect(kept?.typed_name).toBe("Fixture Typed Name");
    expect(kept?.email).toBe(buyer.email);
    expect(await row("core_agreement_signature", "acceptance_id", signed)).not.toBeNull();
    // The copy keeps no address, error or pending action.
    expect(await row("core_agreement_copy", "acceptance_id", signed)).toMatchObject({
      to_address: null,
      error: null,
      pending_action_id: null,
    });
    // The erase says what is kept and until when.
    expect(out.agreementsKept).toMatchObject({ count: 2, deleted: 4 });
    const until = Date.parse(out.agreementsKept?.until ?? "");
    expect(until - Date.now()).toBeGreaterThan(6.9 * 365 * DAY);
    expect(until - Date.now()).toBeLessThan(7.1 * 365 * DAY);
  });

  it("a buyer's paid purchase nobody settled is kept detached, and can never settle to anyone after", async () => {
    // Two People share the address: the payment cannot say whose it is, and staff have not said.
    const email = `${unique("shared")}@buyers.example`.toLowerCase();
    const a = await run<{ id: string }>(
      "person.create",
      { givenName: "Shared A", emails: [{ email }] },
      staff(),
    );
    const b = await run<{ id: string }>(
      "person.create",
      { givenName: "Shared B", emails: [{ email: `${unique("b")}@buyers.example` }] },
      staff(),
    );
    // As an import or an older record may leave it (the enforcement suite does the same).
    await env.DB.prepare("DROP INDEX IF EXISTS core_person_emails_live_email_uq").run();
    await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE person_id = ?")
      .bind(email, b.id)
      .run();
    const order = await run<{ id: string; total: number }>(
      "order.start",
      { lines: [{ object: PASS, id: pass, quantity: 1 }], email, agreements: guestAgrees() },
      as(PUBLIC),
    );
    await run(
      "fixture.verifiedPayment",
      { eventId: unique("evt"), orderId: order.id, amount: order.total },
      staff(),
    );
    const unsettled = await rows("core_agreement_acceptance", "order_id", order.id);
    expect(unsettled.map((r) => r.person_id)).toEqual([null, null]);
    // A raw writer cannot mark it erased while its order still holds the address.
    await expect(
      env.DB.prepare("UPDATE core_agreement_acceptance SET erased_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), unsettled[0]?.id)
        .run(),
    ).rejects.toThrow(/immutable/);
    await erase(a.id);
    for (const r of await rows("core_agreement_acceptance", "order_id", order.id)) {
      expect(r).toMatchObject({ person_id: null, erased_at: expect.any(String) });
      expect(await row("core_agreement_answer", "acceptance_id", r.id as string)).toBeNull();
    }
  });

  it("what is kept is read only by a person with agreements:manage: no other staff, customer or AI", async () => {
    const { buyer, signed } = await agreedBuyer("keptread");
    await erase(buyer.principal.personId);
    // A member of staff without agreements:manage: refused, as for the PDF.
    for (const name of ["agreement.acceptance.get", "agreement.acceptance.pdf"]) {
      const input = name.endsWith(".get") ? { id: signed } : { acceptanceId: signed };
      expect((await refusal(run(name, input, staff(member)))).details.rule, name).toBe(
        "agreement_kept",
      );
      for (const ai of AI_ACTORS) {
        const outcome = await run(name, input, staff(admin, ai)).then(
          () => "read",
          (error: { code: string }) => error.code,
        );
        expect(`${name} ${ai.actor}: ${outcome}`).not.toMatch(/: read$/);
      }
    }
    // Nothing lists it: not the acceptances list, not anyone's tab.
    const listed = await run<{ items: { id: string }[] }>(
      "agreement.acceptances",
      { documentId: drawn.id, limit: 200 },
      staff(),
    );
    expect(listed.items.map((i) => i.id)).not.toContain(signed);
    // Their sign-in went with them; even a principal naming the erased Person reads nothing.
    const mine = await run("me.agreements.list", {}, as(buyer.principal)).catch(() => null);
    expect(JSON.stringify(mine ?? {})).not.toContain(signed);
    expect(
      (await refusal(run("me.agreements.pdf", { acceptanceId: signed }, as(buyer.principal)))).code,
    ).toBe("not_found");
    // The manager finds it by the address or the name, and opens it: the evidence is all there.
    for (const by of [{ email: buyer.email.toUpperCase() }, { name: "typed na" }]) {
      const found = await run<{ items: { id: string; until: string | null }[] }>(
        "agreement.kept.find",
        by,
        staff(),
      );
      expect(found.items.map((i) => i.id)).toContain(signed);
      // The search result itself carries no name, address or signature.
      expect(JSON.stringify(found)).not.toContain(buyer.email);
      expect(JSON.stringify(found)).not.toContain("Fixture Typed Name");
    }
    for (const ai of AI_ACTORS) {
      expect(
        (await refusal(run("agreement.kept.find", { email: buyer.email }, staff(admin, ai)))).code,
      ).not.toBe("ok");
    }
    expect(
      (await refusal(run("agreement.kept.find", { email: buyer.email }, staff(member)))).code,
    ).toBe("forbidden");
    const full = await run<{ typedName: string | null; signature: unknown }>(
      "agreement.acceptance.get",
      { id: signed },
      staff(),
    );
    expect(full.typedName).toBe("Fixture Typed Name");
    expect(full.signature).toEqual(SIGNATURE);
    const pdf = await run<{ document: { record: unknown; signature?: unknown } }>(
      "agreement.acceptance.pdf",
      { acceptanceId: signed },
      staff(),
    );
    expect(JSON.stringify(pdf.document.record)).toContain("A person whose record was erased");
    expect(pdf.document.signature).toEqual(SIGNATURE);
    // The search is audited, without what was searched for.
    const audits = await env.DB.prepare(
      "SELECT input FROM core_audit WHERE operation = 'agreement.kept.find' AND user_id = ?",
    )
      .bind(admin.id)
      .all<{ input: string }>();
    expect(audits.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits.results)).not.toContain(buyer.email);
    expect(JSON.stringify(audits.results)).not.toContain("typed na");
    // The audit keeps nothing of them readable: every row naming their address is redacted.
    const naming = await env.DB.prepare(
      "SELECT a.id FROM core_audit a WHERE (a.input || coalesce(a.result, '')) LIKE ? AND NOT EXISTS (SELECT 1 FROM core_audit_redactions r WHERE r.audit_id = a.id)",
    )
      .bind(`%${buyer.email}%`)
      .all();
    expect(naming.results).toEqual([]);
  });

  it("erasing a guardian: their name, signature and account leave the child's acceptance, which is kept, and the child is due again", async () => {
    const parent = await createBuyer(admin, "gparent");
    const other = await createBuyer(admin, "gother");
    const child = await createBuyer(admin, "gchild");
    for (const guardian of [parent, other]) {
      await run(
        "person.link.add",
        { guardianId: guardian.principal.personId, dependantId: child.principal.personId },
        staff(),
      );
    }
    const childId = child.principal.personId;
    const consent = await accept(
      parent.principal,
      guardianDoc,
      { forPersonId: childId },
      "Fixture Parent Typed",
    );
    const childHealth = await accept(parent.principal, health, { forPersonId: childId });
    const due = async () =>
      (
        await agreementsDue(db.query, {
          point: POINT,
          participant: childId,
          payer: childId,
          now: new Date().toISOString(),
        })
      ).due.map((d) => d.documentId);
    expect(await due()).not.toContain(guardianDoc.id);

    await erase(parent.principal.personId);
    const kept = await row("core_agreement_acceptance", "id", consent.id);
    expect(kept).toMatchObject({
      person_id: childId,
      by: "guardian",
      agent_person_id: null,
      account_id: null,
      typed_name: null,
      email: parent.email,
      erased_at: expect.any(String),
    });
    expect(await row("core_agreement_signature", "acceptance_id", consent.id)).toBeNull();
    // The child's own health answers are the child's: kept with the record.
    expect(await row("core_agreement_answer", "acceptance_id", childHealth.id)).not.toBeNull();
    // It no longer counts: the child is due again, for the remaining guardian to agree.
    expect(await due()).toEqual(expect.arrayContaining([guardianDoc.id, health.id]));
    // The other guardian sees only that a parent or guardian agreed.
    const theirs = await run<{ document: { record: unknown; signature?: unknown } }>(
      "me.agreements.pdf",
      { acceptanceId: consent.id },
      as(other.principal),
    ).catch((error: { code: string }) => ({ refused: error.code }));
    const text = JSON.stringify(theirs);
    expect(text).not.toContain("Fixture Parent Typed");
    expect(text).not.toContain(parent.email);
    if (!("refused" in theirs)) {
      expect(text).toContain("A parent or guardian");
      expect(theirs.document.signature).toBeUndefined();
    }
  });
});

// --- The copy, the gatekeeper and approvals --------------------------------------------------------

describe("erase reaches the copy, its approval and the email gatekeeper", () => {
  it("a copy waiting for a person: its approval is turned down and redacted, the gatekeeper's send dropped, never sent", async () => {
    const buyer = await createBuyer(admin, "waitcopy");
    mail.modes.push("pending");
    const done = await accept(buyer.principal, drawn);
    const copy = await row("core_agreement_copy", "acceptance_id", done.id);
    expect(copy).toMatchObject({ state: "waiting" });
    const actionId = copy?.pending_action_id as string;
    expect(await row("core_pending_action", "id", actionId)).toMatchObject({ status: "pending" });
    expect(mail.waiting.has(`agreement-copy:${done.id}`)).toBe(true);

    await erase(buyer.principal.personId);
    const action = await row("core_pending_action", "id", actionId);
    expect(action).toMatchObject({ status: "rejected", input: JSON.stringify("[erased]") });
    expect(JSON.stringify(action)).not.toContain(buyer.email);
    expect(await row("core_agreement_copy", "acceptance_id", done.id)).toMatchObject({
      state: "cancelled",
      to_address: null,
      pending_action_id: null,
      scrub_due_at: null,
      scrubbed_at: expect.any(String),
    });
    // Scrubbed through the host's own agreements mail, by the copy's key alone.
    expect(mail.scrubCalls).toContainEqual({
      purpose: "agreements",
      key: `agreement-copy:${done.id}`,
    });
    expect(mail.waiting.has(`agreement-copy:${done.id}`)).toBe(false);
    expect(mail.delivered.filter((m) => m.idempotencyKey?.includes(done.id))).toHaveLength(0);
  });

  it("a copy already sent: the gatekeeper's history line loses who it went to and what it said", async () => {
    const buyer = await createBuyer(admin, "sentcopy");
    const done = await accept(buyer.principal, drawn);
    const key = `agreement-copy:${done.id}`;
    expect(mail.history.get(key)?.to).toEqual([buyer.email]);
    await erase(buyer.principal.personId);
    expect(mail.history.get(key)).toEqual({ to: [], subject: "[erased]" });
    expect(await row("core_agreement_copy", "acceptance_id", done.id)).toMatchObject({
      state: "sent",
      to_address: null,
      scrub_due_at: null,
    });
  });

  it("a scrub that fails stays owed, and the minute cron's copy step asks again until it is done", async () => {
    const buyer = await createBuyer(admin, "owedcopy");
    const done = await accept(buyer.principal, drawn);
    // No integration host reachable during the erase: nothing can be asked then.
    await run("person.erase", { id: buyer.principal.personId }, context(admin, { events }));
    expect(await row("core_agreement_copy", "acceptance_id", done.id)).toMatchObject({
      scrub_due_at: expect.any(String),
      scrubbed_at: null,
    });
    // The database keeps it owed until a scrub is recorded.
    await expect(
      env.DB.prepare("UPDATE core_agreement_copy SET scrub_due_at = NULL WHERE acceptance_id = ?")
        .bind(done.id)
        .run(),
    ).rejects.toThrow(/core_agreement_copy_fixed/);
    await sendAgreementCopies({ db: db.query, integrations: mail.runtime });
    expect(await row("core_agreement_copy", "acceptance_id", done.id)).toMatchObject({
      scrub_due_at: null,
      scrubbed_at: expect.any(String),
    });
    expect(mail.history.get(`agreement-copy:${done.id}`)).toEqual({ to: [], subject: "[erased]" });
  });

  it("an erase that lands while the copy's send is in flight: the send's record is scrubbed after it", async () => {
    const buyer = await createBuyer(admin, "inflight");
    const done = await run<{ id: string }>(
      "me.agreements.accept",
      { versionId: drawn.versionId, typedName: "Fixture Typed Name", signature: SIGNATURE },
      // Recorded without sending now: the minute cron sends it.
      outside(buyer.principal, { events }),
    );
    const key = `agreement-copy:${done.id}`;
    mail.setDuring(async () => {
      await erase(buyer.principal.personId);
    });
    await sendAgreementCopies({ db: db.query, integrations: mail.runtime });
    // The gatekeeper delivered it before the erase; the erase cancelled the row while the send
    // was in flight, so the sender marked the scrub owed again once its call returned.
    const after = await row("core_agreement_copy", "acceptance_id", done.id);
    expect(after).toMatchObject({ state: "cancelled", to_address: null });
    await sendAgreementCopies({ db: db.query, integrations: mail.runtime });
    expect(await row("core_agreement_copy", "acceptance_id", done.id)).toMatchObject({
      scrub_due_at: null,
      scrubbed_at: expect.any(String),
    });
    expect(mail.history.get(key)).toEqual({ to: [], subject: "[erased]" });
  });

  it("an erase while a crashed sender held the claim: the scrub comes first, and the late send is refused", async () => {
    const buyer = await createBuyer(admin, "lateclaim");
    const done = await run<{ id: string }>(
      "me.agreements.accept",
      { versionId: drawn.versionId, typedName: "Fixture Typed Name", signature: SIGNATURE },
      outside(buyer.principal, { events }),
    );
    await env.DB.prepare(
      "UPDATE core_agreement_copy SET state = 'sending', claimed_at = ?, next_at = ?, attempts = 1 WHERE acceptance_id = ?",
    )
      .bind(new Date().toISOString(), new Date(Date.now() + 600_000).toISOString(), done.id)
      .run();
    await erase(buyer.principal.personId);
    expect(await row("core_agreement_copy", "acceptance_id", done.id)).toMatchObject({
      state: "cancelled",
      scrubbed_at: expect.any(String),
    });
    // The crashed sender's send arrives late: the gatekeeper refuses it.
    const late = await mail.runtime
      .callAsHost?.({
        connectionId,
        resource: "k1",
        method: "send",
        args: [
          {
            to: [buyer.email],
            subject: "x",
            text: "x",
            idempotencyKey: `agreement-copy:${done.id}`,
          },
        ],
        purpose: "agreements",
      })
      .catch((error: Error) => error.message);
    expect(late).toMatch(/^Refused:/);
    expect(mail.delivered.filter((m) => m.idempotencyKey?.includes(done.id))).toHaveLength(0);
  });
});

// --- Merge ----------------------------------------------------------------------------------------

describe("merge (criterion 14)", () => {
  it("moves acceptances to the survivor unchanged, with a waiting copy and an unpaid guest order untouched; the preview counts them", async () => {
    const survivor = await createBuyer(admin, "msurv");
    const merged = await createBuyer(admin, "mgone");
    // The duplicate's own sign-in moves to the survivor only when one of them has none.
    await env.DB.prepare("DELETE FROM core_customer WHERE person_id = ?")
      .bind(survivor.principal.personId)
      .run();
    mail.modes.push("pending");
    const signed = await accept(merged.principal, drawn);
    const answered = await accept(merged.principal, health);
    const order = await run<{ id: string; total: number }>(
      "order.start",
      {
        lines: [{ object: PASS, id: pass, quantity: 1 }],
        email: merged.email,
        agreements: guestAgrees(),
      },
      as(PUBLIC),
    );
    const plan = await run<{
      acceptances: number;
      asGuardian: number;
      minor: boolean;
      needs: string | null;
    }>(
      "agreement.mergePlan",
      { survivorId: survivor.principal.personId, mergedId: merged.principal.personId },
      staff(),
    );
    expect(plan).toEqual({ acceptances: 2, asGuardian: 0, minor: false, needs: null });
    for (const ai of AI_ACTORS.slice(0, 2)) {
      const asAi = await run<{ needs: string | null }>(
        "agreement.mergePlan",
        { survivorId: survivor.principal.personId, mergedId: merged.principal.personId },
        staff(admin, {
          ...ai,
          ...(ai.actor === "mcp" ? { grantedPermissions: ["records:read"] } : {}),
        }),
      ).catch(() => null);
      if (asAi) expect(asAi.needs).toBe("person");
    }
    const before = {
      signed: await row("core_agreement_acceptance", "id", signed.id),
      answered: await row("core_agreement_acceptance", "id", answered.id),
      copy: await row("core_agreement_copy", "acceptance_id", signed.id),
      answers: await row("core_agreement_answer", "acceptance_id", answered.id),
      guests: await rows("core_agreement_acceptance", "order_id", order.id),
    };
    await run(
      "person.merge",
      { survivorId: survivor.principal.personId, mergedId: merged.principal.personId },
      staff(),
    );
    expect(await row("core_agreement_acceptance", "id", signed.id)).toEqual({
      ...before.signed,
      person_id: survivor.principal.personId,
    });
    expect(await row("core_agreement_acceptance", "id", answered.id)).toEqual({
      ...before.answered,
      person_id: survivor.principal.personId,
    });
    expect(await row("core_agreement_answer", "acceptance_id", answered.id)).toEqual(
      before.answers,
    );
    expect(await row("core_agreement_copy", "acceptance_id", signed.id)).toEqual(before.copy);
    // A buyer's acceptances are nobody's until the purchase settles: not moved, not changed.
    expect(await rows("core_agreement_acceptance", "order_id", order.id)).toEqual(before.guests);
    // The survivor's current acceptances are the best of both: nothing is due for them.
    const due = await agreementsDue(db.query, {
      point: POINT,
      participant: survivor.principal.personId,
      payer: survivor.principal.personId,
      now: new Date().toISOString(),
    });
    expect(due.due.map((d) => d.documentId)).not.toContain(drawn.id);
    // Paid later, the guest's purchase settles to the survivor, who now holds the address.
    await run(
      "fixture.verifiedPayment",
      { eventId: unique("evt"), orderId: order.id, amount: order.total },
      staff(),
    );
    for (const r of await rows("core_agreement_acceptance", "order_id", order.id)) {
      expect(r.person_id).toBe(survivor.principal.personId);
    }
  });
});

// --- The Trash -------------------------------------------------------------------------------------

describe("the Trash", () => {
  it("a Person in the Trash has no current acceptance; restored, theirs count again; none is in the Trash list", async () => {
    const { buyer } = await agreedBuyer("trash");
    const personId = buyer.principal.personId;
    const dueNow = async () =>
      (
        await agreementsDue(db.query, {
          point: POINT,
          participant: personId,
          payer: personId,
          now: new Date().toISOString(),
        })
      ).due.map((d) => d.documentId);
    expect(await dueNow()).toEqual([]);
    await run("person.delete", { id: personId }, staff());
    expect(await dueNow()).toEqual(expect.arrayContaining([drawn.id, health.id]));
    const trash = await run<{ items: { object: string; id: string }[] }>("trash.list", {}, staff());
    expect(trash.items.filter((i) => i.object !== "person" && i.id.startsWith("aga_"))).toEqual([]);
    expect(JSON.stringify(trash)).not.toContain("aga_");
    await run("person.restore", { id: personId }, staff());
    expect(await dueNow()).toEqual([]);
  });
});

// --- Retention and the purge -----------------------------------------------------------------------

describe("retention and the purge (criterion 14)", () => {
  const longAgo = () => new Date(Date.now() - 8 * 365 * DAY);

  it("the setting is a human admin's: 1 to 50 years, default 7", async () => {
    expect(await run("agreement.retention", {}, staff(member))).toMatchObject({
      years: 7,
      defaultYears: 7,
    });
    expect((await refusal(run("agreement.setRetention", { years: 3 }, staff(member)))).code).toBe(
      "forbidden",
    );
    for (const ai of AI_ACTORS) {
      expect(
        (await refusal(run("agreement.setRetention", { years: 3 }, staff(admin, ai)))).code,
      ).not.toBe("ok");
    }
    for (const years of [0, 51, 2.5]) {
      expect((await refusal(run("agreement.setRetention", { years }, staff()))).code).toBe(
        "invalid_input",
      );
    }
    expect(await run("agreement.setRetention", { years: 7 }, staff())).toMatchObject({ years: 7 });
  });

  it("deletes what is past the period with what sits beside it, never one on hold, one still owing a scrub, or one within the period", async () => {
    // Three erased long ago (one held, one whose copy still owes the gatekeeper a scrub), one now.
    const old = await agreedBuyer("purgeold");
    await erase(old.buyer.principal.personId, { clock: longAgo });
    const held = await agreedBuyer("purgeheld");
    await erase(held.buyer.principal.personId, { clock: longAgo });
    await run("agreement.kept.hold", { acceptanceId: held.signed, held: true }, staff());
    const recent = await agreedBuyer("purgerecent");
    await erase(recent.buyer.principal.personId);
    // Last: an erase that reaches the integration host scrubs every copy then owed.
    const owed = await agreedBuyer("purgeowed");
    await run(
      "person.erase",
      { id: owed.buyer.principal.personId },
      context(admin, { events, clock: longAgo }),
    );

    // The database refuses an early delete by any writer.
    for (const [statement, id] of [
      ["DELETE FROM core_agreement_acceptance WHERE id = ?", recent.signed],
      ["DELETE FROM core_agreement_signature WHERE acceptance_id = ?", recent.signed],
      ["DELETE FROM core_agreement_copy WHERE acceptance_id = ?", recent.signed],
      ["DELETE FROM core_agreement_signature WHERE acceptance_id = ?", held.signed],
      ["DELETE FROM core_agreement_copy WHERE acceptance_id = ?", owed.signed],
      // Past the period, but its signature and copy are still beside it.
      ["DELETE FROM core_agreement_acceptance WHERE id = ?", old.signed],
    ] as const) {
      const outcome = await env.DB.prepare(statement)
        .bind(id)
        .run()
        .then(
          (r) => `deleted ${r.meta.changes}`,
          (error: Error) => error.message,
        );
      expect(`${statement} ${id}: ${outcome}`).toMatch(/immutable|core_agreement_copy_fixed/);
    }
    // A shorter setting a broken value never makes: nothing is purged while it is unreadable.
    await env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at) VALUES ('agreement_retention', '{\"years\":0}', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(new Date().toISOString())
      .run();
    expect(await runAgreementRetention(db)).toMatchObject({ purged: 0, rounds: 0 });
    await run("agreement.setRetention", { years: 7 }, staff());

    const result = await runAgreementRetention(db);
    expect(result.purged).toBeGreaterThanOrEqual(2);
    for (const id of [old.signed, old.answered]) {
      expect(await row("core_agreement_acceptance", "id", id)).toBeNull();
      expect(await row("core_agreement_copy", "acceptance_id", id)).toBeNull();
      expect(await row("core_agreement_signature", "acceptance_id", id)).toBeNull();
    }
    for (const id of [held.signed, owed.signed, recent.signed]) {
      expect(await row("core_agreement_acceptance", "id", id), id).not.toBeNull();
    }
    expect(await row("core_agreement_signature", "acceptance_id", held.signed)).not.toBeNull();

    // Idempotent and silent when nothing is due: no operation runs, no audit row is written.
    const count = async () =>
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM core_audit WHERE operation = 'agreement.purgeKept'",
        ).first<{ n: number }>()
      )?.n;
    const audits = await count();
    expect(await runAgreementRetention(db)).toEqual({ purged: 0, rounds: 0, more: false });
    expect(await count()).toBe(audits);

    // Released, the held one goes at the next run; the owed one once its scrub is done.
    await run("agreement.kept.hold", { acceptanceId: held.signed, held: false }, staff());
    await sendAgreementCopies({ db: db.query, integrations: mail.runtime });
    expect((await runAgreementRetention(db)).purged).toBeGreaterThanOrEqual(3);
    for (const id of [held.signed, held.answered, owed.signed]) {
      expect(await row("core_agreement_acceptance", "id", id)).toBeNull();
    }
    expect(await row("core_agreement_acceptance", "id", recent.signed)).not.toBeNull();
  });

  it("the purge is the host's own step: refused from any other origin", async () => {
    for (const ctx of [staff(), staff(admin, AI_ACTORS[2])]) {
      expect((await refusal(run("agreement.purgeKept", {}, ctx))).code).not.toBe("ok");
    }
    expect(
      (await refusal(run("agreement.kept.hold", { acceptanceId: "aga_nope", held: true }, staff())))
        .code,
    ).toBe("not_found");
  });
});
