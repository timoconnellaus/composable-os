// Stage 44 step 4 (ADR 0645): the copy and the signed PDF (acceptance criterion 10, and the
// download rules of steps 2 and 4). Each acceptance by a person is emailed to them once, as the
// host's own mail (`callAsHost`, purpose `agreements`), to the address the host's records hold,
// with the signed PDF the email gatekeeper makes from checked values: under a retry, a crash, two
// senders at once and a refusal, it goes once. Every path sends its copy: one's own, a guardian's
// for a child, a guest's once its purchase settles, paper when staff ask. Health answers are never
// in the copy, a log, the audit or an error. Who may download which PDF follows the seam: the
// person and their guardian, staff (a person) with answers only for agreements:health; never
// another customer, the public or an AI. A download and the attachment are the same bytes for the
// same values. All text here is fixture text, not wording anyone should use.
import { env } from "cloudflare:workers";
// The email gatekeeper's own check and PDF writer, as it runs them on the copy (relative paths, as
// cos-runner's fake outbox imports its rules: core holds no copy of either).
import { type AgreementPdf, agreementPdf } from "@composable-os/agreement-pdf";
import { beforeAll, describe, expect, it } from "vitest";
import { parseMessage } from "../../gatekeeper-email-send/src/validate.ts";
import { sendAgreementCopies } from "../src/agreements/copy.ts";
import type {
  ActingUser,
  Actor,
  CustomerPrincipal,
  IntegrationCallResult,
  IntegrationRuntime,
  InvocationContext,
} from "../src/index.ts";
import { memoryEventSink, newId } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import { CURRENCY, createBuyer, outside, PUBLIC, refusal, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const SECRET_NOTE = "Fixture secret note 7f3a";
const QUESTIONS = [{ key: "q1", text: "Fixture question?", noteOnYes: true }];
const GYM = extId("cpy");
const PASS = `${GYM}.pass`;
const tag = Date.now().toString(36);
const POINT = `pc${tag}`;
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

// --- The mail double: the email gatekeeper as the host's callAsHost reaches it --------------------

type Mode = "apply" | "pending" | "crash" | "retryable" | "unknown" | "invalid" | "deny" | "full";
interface Sent {
  to: string[];
  subject: string;
  text: string;
  agreement?: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * What email-send and the integration host do with the host's agreements mail (ADR 0574, ADR
 * 0645): a known key answers the first send's receipt and sends nothing more; one still waiting
 * for a person is answered with that person's pending approval again; one turned down (by a
 * person, or the floor) is refused. `crash` delivers and then fails before answering, as a host
 * that dies mid-call. `approve` and `turnDown` stand in for a person deciding a waiting one.
 */
function mailDouble(payments: IntegrationRuntime) {
  const delivered: Sent[] = [];
  const calls: { purpose: string; message: Sent }[] = [];
  const keys = new Map<
    string,
    { id: number; state: "sent" | "waiting" | "unsent" | "turned_down"; message: Sent }
  >();
  const modes: Mode[] = [];
  let next = 0;
  const waiting = (id: number): IntegrationCallResult["pending"][number] => ({
    status: "pending_approval",
    changeSetId: "chs_x",
    actionId: `act_${id}`,
    operation: "outbound",
    provisionalIds: [],
    dependsOn: [],
    expiresAt: "2099-01-01T00:00:00.000Z",
    simulated: null,
    message: "waiting",
  });
  const runtime: IntegrationRuntime = {
    ...payments,
    async callAsHost(input): Promise<IntegrationCallResult> {
      if (input.method !== "send") {
        return (payments.callAsHost as NonNullable<IntegrationRuntime["callAsHost"]>)(input);
      }
      const message = input.args[0] as Sent;
      calls.push({ purpose: input.purpose, message });
      if (message.agreement && input.purpose !== "agreements") {
        throw new Error("Invalid email: agreement is attached only by the host");
      }
      const key = message.idempotencyKey;
      const known = key ? keys.get(key) : undefined;
      if (known) {
        if (known.state === "turned_down") {
          throw new Error("Refused: this email was turned down or failed, and is not sent again.");
        }
        return {
          value: { status: known.state === "sent" ? "sent" : "pending", id: known.id },
          pending: known.state === "waiting" ? [waiting(known.id)] : [],
          applied: [],
        };
      }
      const mode = modes.shift() ?? "apply";
      if (mode === "invalid") throw new Error("Invalid email: agreement.title must be a line.");
      if (mode === "full") {
        throw new Error(
          "Too many pending actions; approve or reject some in the approval queue first.",
        );
      }
      next += 1;
      const id = next;
      const action = { action: id, actionKind: "email.agreement", title: "Send email" };
      if (mode === "pending") {
        if (key) keys.set(key, { id, state: "waiting", message });
        return { value: { status: "pending", id }, pending: [waiting(id)], applied: [] };
      }
      if (mode === "deny") {
        if (key) keys.set(key, { id, state: "turned_down", message });
        return { value: { status: "pending", id }, pending: [], applied: [], denied: [id] };
      }
      if (mode === "retryable" || mode === "unknown") {
        if (key)
          keys.set(key, { id, state: mode === "unknown" ? "turned_down" : "unsent", message });
        return {
          value: { status: "pending", id },
          pending: [],
          applied: [],
          failed: [
            {
              ...action,
              outcome: mode,
              message: mode === "retryable" ? "Email Service refused for now" : "connection reset",
            },
          ],
        };
      }
      delivered.push(message);
      if (key) keys.set(key, { id, state: "sent", message });
      if (mode === "crash") throw new Error("The integration host stopped answering");
      return { value: { status: "sent", id }, pending: [], applied: [action] };
    },
  };
  /** A person approves the send waiting under `key`: it goes. */
  const approve = (key: string) => {
    const entry = keys.get(key);
    if (entry?.state !== "waiting") throw new Error(`nothing waits under ${key}`);
    entry.state = "sent";
    delivered.push(entry.message);
  };
  /** A person turns it down (or the approval expires). */
  const turnDown = (key: string) => {
    const entry = keys.get(key);
    if (entry) entry.state = "turned_down";
  };
  return { runtime, delivered, calls, modes, approve, turnDown };
}

// --- Fixtures --------------------------------------------------------------------------------------

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const mail = mailDouble(payments.runtime);
let admin: ActingUser;
let member: ActingUser;
let pass: string;

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

const accept = (principal: CustomerPrincipal, doc: Doc, extra: Record<string, unknown> = {}) =>
  run<{ id: string }>(
    "me.agreements.accept",
    {
      versionId: doc.versionId,
      typedName: "Fixture Name",
      ...(doc.kind === "health" ? { answers: [{ key: "q1", yes: true, note: SECRET_NOTE }] } : {}),
      ...extra,
    },
    as(principal),
  );

const copyRow = (acceptanceId: string) =>
  env.DB.prepare("SELECT * FROM core_agreement_copy WHERE acceptance_id = ?")
    .bind(acceptanceId)
    .first<Record<string, unknown>>();

const deliveredFor = (acceptanceId: string) =>
  mail.delivered.filter(
    (m) => (m.agreement as { acceptanceId?: string })?.acceptanceId === acceptanceId,
  );

/** Every call the host made for one acceptance's copy, sent or not. */
const callsFor = (acceptanceId: string) =>
  mail.calls.filter(
    (c) => (c.message.agreement as { acceptanceId?: string })?.acceptanceId === acceptanceId,
  );

/** The gatekeeper's PDF of the values a message carried, as it attaches it. */
function attachedPdf(message: Sent): Uint8Array {
  // The gatekeeper takes the key off before it checks the rest (ADR 0574).
  const { idempotencyKey: _key, ...rest } = message;
  const parsed = parseMessage(rest);
  const { summary: _summary, ...values } = parsed.agreement as unknown as Record<string, unknown>;
  return agreementPdf(values as unknown as AgreementPdf);
}

const AI_ACTORS: { actor: Actor; origin: InvocationContext["origin"] }[] = [
  { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_copy" } },
  { actor: "mcp", origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "cap_c" } },
  { actor: "automation", origin: { surface: "automation", automationId: "x.y" } },
  { actor: "extension", origin: { surface: "extension", extensionId: "bookings" } },
];

let waiver: Doc;
let drawn: Doc;
let health: Doc;
let guardianDoc: Doc;

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
      },
    }),
  );
  await run("order.settings.update", { currency: CURRENCY }, staff());
  pass = (
    await run<{ id: string }>(
      "record.create",
      { object: PASS, values: { name: "Ten", price: 90 } },
      staff(),
    )
  ).id;
  await payments.connect(admin.id);
  // The host's mail connection (Settings → Notification delivery), as for an order's confirmation.
  const connection = newId("connection");
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'email-send', 'org', ?, 'Mail', 'active', ?, ?, ?)",
  )
    .bind(
      connection,
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
  await run("notification.updateDeliverySettings", { email: connection }, staff());
  waiver = await publish("waiver");
  drawn = await publish("waiver", { how: "drawn" });
  health = await publish("health");
  guardianDoc = await publish("guardian", { forWhom: "dependants", how: "drawn" });
}, 120_000);

// --- The copy ---------------------------------------------------------------------------------------

describe("the copy (criterion 10)", () => {
  it("one's own acceptance sends one copy, at once, to the account's address, as the host's agreements mail", async () => {
    const buyer = await createBuyer(admin, "own");
    const done = await accept(buyer.principal, drawn, { signature: SIGNATURE });
    const sent = deliveredFor(done.id);
    expect(sent).toHaveLength(1);
    const message = sent[0] as Sent;
    expect(message.to).toEqual([buyer.email]);
    expect(message.idempotencyKey).toBe(`agreement-copy:${done.id}`);
    expect(message.subject).toMatch(/: your copy of Fixture waiver/);
    expect(mail.calls.find((c) => c.message === message)?.purpose).toBe("agreements");
    expect(await copyRow(done.id)).toMatchObject({ state: "sent", to_address: buyer.email });
    // The gatekeeper's own check takes it; its PDF holds the name typed and the strokes.
    const pdf = new TextDecoder("latin1").decode(attachedPdf(message));
    expect(pdf).toContain(" m ");
    // Agreeing again to the same version records nothing and sends nothing.
    await accept(buyer.principal, drawn, { signature: SIGNATURE });
    expect(deliveredFor(done.id)).toHaveLength(1);
    // The minute cron finds nothing more to send.
    await sendAgreementCopies({ db: db.query, integrations: mail.runtime });
    expect(deliveredFor(done.id)).toHaveLength(1);
  });

  it("is the same bytes as the person's own download, for the same values", async () => {
    const buyer = await createBuyer(admin, "bytes");
    const done = await accept(buyer.principal, drawn, { signature: SIGNATURE });
    const download = await run<{ document: AgreementPdf; filename: string }>(
      "me.agreements.pdf",
      { acceptanceId: done.id },
      as(buyer.principal),
    );
    expect(download.filename).toMatch(/\.pdf$/);
    expect([...agreementPdf(download.document)]).toEqual([
      ...attachedPdf(deliveredFor(done.id)[0] as Sent),
    ]);
  });

  it("a guardian's acceptance for a child goes to the guardian, and names them only to themselves", async () => {
    const parent = await createBuyer(admin, "parent");
    const other = await createBuyer(admin, "otherparent");
    const stranger = await createBuyer(admin, "stranger");
    const child = await createBuyer(admin, "child");
    for (const guardian of [parent, other]) {
      await run(
        "person.link.add",
        { guardianId: guardian.principal.personId, dependantId: child.principal.personId },
        staff(),
      );
    }
    const done = await accept(parent.principal, guardianDoc, {
      forPersonId: child.principal.personId,
      typedName: "Fixture Guardian Typed",
      signature: SIGNATURE,
    });
    const sent = deliveredFor(done.id);
    expect(sent.map((m) => m.to)).toEqual([[parent.email]]);
    expect(JSON.stringify(sent[0]?.agreement)).toContain("Fixture Guardian Typed");
    // Their own download: the name typed and the signature.
    const own = await run<{ document: AgreementPdf }>(
      "me.agreements.pdf",
      { acceptanceId: done.id },
      as(parent.principal),
    );
    expect(own.document.signature).toBeDefined();
    // The child and the other guardian see that a parent or guardian agreed, not who or how.
    for (const viewer of [child, other]) {
      const theirs = await run<{ document: AgreementPdf }>(
        "me.agreements.pdf",
        { acceptanceId: done.id },
        as(viewer.principal),
      );
      const text = JSON.stringify(theirs.document);
      expect(text).not.toContain("Fixture Guardian Typed");
      expect(theirs.document.signature).toBeUndefined();
      expect(text).toContain("A parent or guardian");
    }
    // Anyone else: as if it did not exist.
    expect(
      (await refusal(run("me.agreements.pdf", { acceptanceId: done.id }, as(stranger.principal))))
        .code,
    ).toBe("not_found");
  });

  it("a guest's acceptance sends nothing until its purchase settles, then goes to the address it was bought with", async () => {
    const email = `${unique("visitor")}@buyers.example`.toLowerCase();
    const started = await run<{ id: string; total: number }>(
      "order.start",
      {
        lines: [{ object: PASS, id: pass, quantity: 1 }],
        email,
        agreements: [waiver, drawn, health, guardianDoc]
          .filter((d) => d.kind !== "guardian")
          .map((d) => ({
            versionId: d.versionId,
            typedName: "Fixture Visitor",
            ...(d === drawn ? { signature: SIGNATURE } : {}),
            ...(d.kind === "health" ? { answers: [{ key: "q1", yes: false }] } : {}),
          })),
      },
      as(PUBLIC),
    );
    const rows = (
      await env.DB.prepare("SELECT id FROM core_agreement_acceptance WHERE order_id = ?")
        .bind(started.id)
        .all<{ id: string }>()
    ).results;
    expect(rows.length).toBe(3);
    for (const row of rows) expect(await copyRow(row.id)).toBeNull();
    await run(
      "fixture.verifiedPayment",
      { eventId: unique("evt"), orderId: started.id, amount: started.total },
      staff(),
    );
    for (const row of rows) {
      expect(await copyRow(row.id)).toMatchObject({ state: "queued", to_address: email });
    }
    // The Person the purchase matched has a name of their own (staff named them, or chose them
    // with order.setPerson among People sharing the address): the copy never shows it.
    await env.DB.prepare(
      "UPDATE core_person SET display_name = 'Fixture Matched Person' WHERE id = (SELECT person_id FROM core_order WHERE id = ?)",
    )
      .bind(started.id)
      .run();
    // The minute cron sends them, once each.
    await sendAgreementCopies({ db: db.query, integrations: mail.runtime });
    await sendAgreementCopies({ db: db.query, integrations: mail.runtime });
    for (const row of rows) {
      expect(deliveredFor(row.id).map((m) => m.to)).toEqual([[email]]);
      expect(await copyRow(row.id)).toMatchObject({ state: "sent" });
      // The buyer's address may be shared by more than one Person (staff then say whose it is,
      // order.setPerson): the copy names the buyer as they typed it, never the Person matched.
      const record =
        (
          deliveredFor(row.id)[0]?.agreement as
            | { record?: { label: string; value: string }[] }
            | undefined
        )?.record ?? [];
      expect(record.find((r) => r.label === "For")?.value).toBe(
        "Fixture Visitor (as typed when buying)",
      );
    }
    for (const row of rows) {
      expect(JSON.stringify(deliveredFor(row.id))).not.toContain("Fixture Matched Person");
    }
  });

  it("a guest's order that expires unpaid leaves no copy to send", async () => {
    const email = `${unique("lapsed")}@buyers.example`.toLowerCase();
    const started = await run<{ id: string }>(
      "order.start",
      {
        lines: [{ object: PASS, id: pass, quantity: 1 }],
        email,
        agreements: [waiver, drawn, health].map((d) => ({
          versionId: d.versionId,
          typedName: "Fixture Visitor",
          ...(d === drawn ? { signature: SIGNATURE } : {}),
          ...(d.kind === "health" ? { answers: [{ key: "q1", yes: false }] } : {}),
        })),
      },
      as(PUBLIC),
    );
    await run(
      "order.expireDue",
      {},
      staff(admin, { actor: "automation", clock: () => new Date(Date.now() + 3 * 86_400_000) }),
    );
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_agreement_copy c JOIN core_agreement_acceptance a ON a.id = c.acceptance_id WHERE a.order_id = ?",
    )
      .bind(started.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect(mail.delivered.some((m) => m.to.includes(email))).toBe(false);
  });

  it("paper sends nothing until a person with agreements:paper asks, then once, to the address they were shown", async () => {
    const buyer = await createBuyer(admin, "paper");
    const paper = await run<{ id: string }>(
      "agreement.recordPaper",
      {
        personId: buyer.principal.personId,
        versionId: waiver.versionId,
        signedOn: new Date().toISOString().slice(0, 10),
        typedName: "Fixture Paper Name",
      },
      staff(),
    );
    expect(await copyRow(paper.id)).toBeNull();
    expect(deliveredFor(paper.id)).toHaveLength(0);
    // Never an AI's act, never a member's without the permission: neither the preview nor the send.
    for (const ai of AI_ACTORS) {
      for (const [name, input] of [
        ["agreement.copy.preview", { acceptanceId: paper.id }],
        ["agreement.copy.send", { acceptanceId: paper.id, confirmTo: buyer.email }],
      ] as const) {
        const refused = await refusal(
          run(
            name,
            input,
            staff(admin, {
              ...ai,
              ...(ai.actor === "mcp"
                ? { grantedPermissions: ["records:read", "records:write"] }
                : {}),
            }),
          ),
        );
        expect(refused.code, `${ai.actor} ${name}`).toBe("forbidden");
      }
    }
    expect(
      (
        await refusal(
          run(
            "agreement.copy.send",
            { acceptanceId: paper.id, confirmTo: buyer.email },
            staff(member),
          ),
        )
      ).code,
    ).toBe("forbidden");
    // The person is shown the host's own address, and confirms that one; nothing else is taken.
    const preview = await run<{ to: string; refused: null; state: null }>(
      "agreement.copy.preview",
      { acceptanceId: paper.id },
      staff(),
    );
    expect(preview).toMatchObject({ to: buyer.email, refused: null, state: null });
    expect(
      (
        await refusal(
          run(
            "agreement.copy.send",
            { acceptanceId: paper.id, confirmTo: buyer.email, to: "x@evil.test" },
            staff(),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    // An address other than the host's (an AI edited the primary address after the preview, or
    // anyone typed another): refused, nothing queued.
    expect(
      (
        await refusal(
          run(
            "agreement.copy.send",
            { acceptanceId: paper.id, confirmTo: "someone@else.test" },
            staff(),
          ),
        )
      ).details.rule,
    ).toBe("agreement_copy_address_changed");
    expect(await copyRow(paper.id)).toBeNull();
    const sentNow = await run<{ state: string }>(
      "agreement.copy.send",
      { acceptanceId: paper.id, confirmTo: preview.to.toUpperCase() },
      staff(),
    );
    expect(sentNow.state).toBe("sent");
    expect(deliveredFor(paper.id).map((m) => m.to)).toEqual([[buyer.email]]);
    const text = JSON.stringify(deliveredFor(paper.id)[0]);
    expect(text).toContain("Recorded from paper by admin user");
    // Asked again: how it went, nothing more sent.
    expect(
      (
        await run<{ state: string }>(
          "agreement.copy.send",
          { acceptanceId: paper.id, confirmTo: buyer.email },
          staff(),
        )
      ).state,
    ).toBe("sent");
    expect(deliveredFor(paper.id)).toHaveLength(1);
    // Only a paper form's is sent on request.
    const own = await accept(buyer.principal, drawn, { signature: SIGNATURE });
    expect(
      (await refusal(run("agreement.copy.preview", { acceptanceId: own.id }, staff()))).details
        .rule,
    ).toBe("agreement_copy_not_paper");
  });

  it("a Person with no address has no paper copy", async () => {
    const lone = (
      await run<{ id: string }>("person.create", { givenName: unique("Lone") }, staff())
    ).id;
    const paper = await run<{ id: string }>(
      "agreement.recordPaper",
      {
        personId: lone,
        versionId: waiver.versionId,
        signedOn: new Date().toISOString().slice(0, 10),
        typedName: "Fixture Paper Name",
      },
      staff(),
    );
    expect(await run("agreement.copy.preview", { acceptanceId: paper.id }, staff())).toMatchObject({
      to: null,
      refused: "no_address",
    });
    expect(
      (
        await refusal(
          run("agreement.copy.send", { acceptanceId: paper.id, confirmTo: "x@y.test" }, staff()),
        )
      ).details.rule,
    ).toBe("agreement_copy_no_address");
  });

  it("a child's paper form is never emailed to the child; only staff see the name on it", async () => {
    const parent = await createBuyer(admin, "ppar");
    const child = await createBuyer(admin, "pchild");
    await run(
      "person.link.add",
      { guardianId: parent.principal.personId, dependantId: child.principal.personId },
      staff(),
    );
    const paper = await run<{ id: string }>(
      "agreement.recordPaper",
      {
        personId: child.principal.personId,
        versionId: waiver.versionId,
        signedOn: new Date().toISOString().slice(0, 10),
        typedName: "Fixture Parent Written",
        signedBy: "Fixture Parent Signer",
        note: "Fixture staff note",
      },
      staff(),
    );
    expect(await run("agreement.copy.preview", { acceptanceId: paper.id }, staff())).toMatchObject({
      to: null,
      refused: "minor",
    });
    const refused = await refusal(
      run("agreement.copy.send", { acceptanceId: paper.id, confirmTo: child.email }, staff()),
    );
    expect(refused.details.rule).toBe("agreement_copy_minor");
    expect(refused.message).toMatch(/parent or guardian/);
    expect(await copyRow(paper.id)).toBeNull();
    // The guardian's (and the child's) own download says it was recorded from paper, without
    // the name on the form, who signed it or the note; staff's has all three.
    for (const viewer of [parent, child]) {
      const theirs = await run<{ document: AgreementPdf }>(
        "me.agreements.pdf",
        { acceptanceId: paper.id },
        as(viewer.principal),
      );
      const text = JSON.stringify(theirs.document);
      expect(text).toContain("Recorded from paper");
      for (const hidden of [
        "Fixture Parent Written",
        "Fixture Parent Signer",
        "Fixture staff note",
      ]) {
        expect(text).not.toContain(hidden);
      }
    }
    const staffPdf = JSON.stringify(
      (
        await run<{ document: AgreementPdf }>(
          "agreement.acceptance.pdf",
          { acceptanceId: paper.id },
          staff(),
        )
      ).document,
    );
    for (const shown of ["Fixture Parent Written", "Fixture Parent Signer", "Fixture staff note"]) {
      expect(staffPdf).toContain(shown);
    }
  });
});

describe("exactly once", () => {
  const sweep = async (at?: Date) =>
    sendAgreementCopies({
      db: db.query,
      integrations: mail.runtime,
      ...(at ? { clock: () => at } : {}),
    });
  const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  it("a send whose answer was lost goes again with the same key, and the gatekeeper sends nothing more", async () => {
    const buyer = await createBuyer(admin, "crash");
    mail.modes.push("crash");
    const done = await accept(buyer.principal, waiver);
    // Delivered, but the host never heard: queued again with the same key.
    expect(deliveredFor(done.id)).toHaveLength(1);
    expect(await copyRow(done.id)).toMatchObject({
      state: "queued",
      send_key: `agreement-copy:${done.id}`,
    });
    await sweep(later(5));
    expect(await copyRow(done.id)).toMatchObject({ state: "sent" });
    expect(deliveredFor(done.id)).toHaveLength(1);
    const keyed = mail.calls.filter(
      (c) => c.message.idempotencyKey === `agreement-copy:${done.id}`,
    );
    expect(keyed).toHaveLength(2);
  });

  it("two senders at once: one claims the copy, it goes once", async () => {
    const buyer = await createBuyer(admin, "race");
    // Recorded without its at-once send (no integration host on that call).
    const done = await run<{ id: string }>(
      "me.agreements.accept",
      { versionId: waiver.versionId, typedName: "Fixture Name" },
      outside(buyer.principal, { events }),
    );
    expect(await copyRow(done.id)).toMatchObject({ state: "queued" });
    await Promise.all([sweep(), sweep(), sweep()]);
    expect(deliveredFor(done.id)).toHaveLength(1);
    expect(await copyRow(done.id)).toMatchObject({ state: "sent" });
  });

  it("a sender that crashed mid-claim is taken over after ten minutes, with the same key", async () => {
    const buyer = await createBuyer(admin, "stale");
    const done = await run<{ id: string }>(
      "me.agreements.accept",
      { versionId: waiver.versionId, typedName: "Fixture Name" },
      outside(buyer.principal, { events }),
    );
    await env.DB.prepare(
      "UPDATE core_agreement_copy SET state = 'sending', claimed_at = ?, next_at = ?, attempts = 1 WHERE acceptance_id = ?",
    )
      .bind(new Date().toISOString(), later(10).toISOString(), done.id)
      .run();
    await sweep();

    expect(deliveredFor(done.id)).toHaveLength(0);
    await sweep(later(11));
    expect(deliveredFor(done.id)).toHaveLength(1);
    expect(deliveredFor(done.id)[0]?.idempotencyKey).toBe(`agreement-copy:${done.id}`);
  });

  it("a send known not to have gone (a rate limit) goes again with a new key; one whose outcome is unknown never again", async () => {
    const retry = await createBuyer(admin, "retry");
    mail.modes.push("retryable");
    const first = await accept(retry.principal, waiver);
    expect(await copyRow(first.id)).toMatchObject({
      state: "queued",
      send_key: `agreement-copy:${first.id}:2`,
    });
    await sweep(later(5));
    expect(deliveredFor(first.id)).toHaveLength(1);
    expect(await copyRow(first.id)).toMatchObject({ state: "sent" });

    const unknown = await createBuyer(admin, "unknown");
    mail.modes.push("unknown");
    const second = await accept(unknown.principal, waiver);
    expect(await copyRow(second.id)).toMatchObject({ state: "failed" });
    await sweep(later(120));
    expect(
      mail.calls.filter(
        (c) => (c.message.agreement as { acceptanceId?: string })?.acceptanceId === second.id,
      ),
    ).toHaveLength(1);
  });

  it("held for a person: asked about again until it is sent, and recorded sent then", async () => {
    const buyer = await createBuyer(admin, "held");
    mail.modes.push("pending");
    const done = await accept(buyer.principal, waiver);
    expect(await copyRow(done.id)).toMatchObject({
      state: "waiting",
      pending_action_id: expect.stringMatching(/^act_/),
    });
    // Not asked again before it is due, then still waiting while nobody decided.
    await sweep();
    expect(callsFor(done.id)).toHaveLength(1);
    await sweep(later(20));
    expect(callsFor(done.id)).toHaveLength(2);
    expect(await copyRow(done.id)).toMatchObject({ state: "waiting" });
    // A person approves it: the next ask finds it sent, and so does the staff read.
    mail.approve(`agreement-copy:${done.id}`);
    await sweep(later(24 * 60 + 1));
    expect(await copyRow(done.id)).toMatchObject({ state: "sent" });
    expect(deliveredFor(done.id)).toHaveLength(1);
    const read = await run<{ copy: { state: string } }>(
      "agreement.acceptance.get",
      { id: done.id },
      staff(),
    );
    expect(read.copy.state).toBe("sent");
  });

  it("held, then turned down (or expired): failed, never asked again", async () => {
    const buyer = await createBuyer(admin, "turned");
    mail.modes.push("pending");
    const done = await accept(buyer.principal, waiver);
    mail.turnDown(`agreement-copy:${done.id}`);
    await sweep(later(20));
    expect(await copyRow(done.id)).toMatchObject({ state: "failed" });
    await sweep(later(24 * 60 * 3));
    expect(callsFor(done.id)).toHaveLength(2);
    expect(deliveredFor(done.id)).toHaveLength(0);
  });

  it("the sender's queue full of other sends: the copy waits, the try is not counted, admins are told once", async () => {
    const buyer = await createBuyer(admin, "full");
    mail.modes.push(...Array.from({ length: 10 }, () => "full" as const));
    const done = await accept(buyer.principal, waiver);
    expect(await copyRow(done.id)).toMatchObject({
      state: "queued",
      error: "queue_full",
      attempts: 0,
    });
    // More full queues than a copy has tries: still waiting, never failed.
    for (let i = 1; i <= 9; i++) await sweep(later(16 * i));
    expect(await copyRow(done.id)).toMatchObject({ state: "queued", attempts: 0 });
    const notices = await env.DB.prepare(
      "SELECT body FROM core_notifications WHERE user_id = ? AND dedupe_key = 'agreement-copy:queue-full'",
    )
      .bind(admin.id)
      .all<{ body: string }>();
    expect(notices.results).toHaveLength(1);
    expect(JSON.stringify(notices.results)).not.toContain(buyer.email);
    // Once the queue has room it goes.
    mail.modes.length = 0;
    await sweep(later(16 * 10));
    expect(await copyRow(done.id)).toMatchObject({ state: "sent", error: null });
    expect(deliveredFor(done.id)).toHaveLength(1);
  });
  it("refused by the deploy-time floor: failed, not waiting", async () => {
    const buyer = await createBuyer(admin, "denied");
    mail.modes.push("deny");
    const done = await accept(buyer.principal, waiver);
    expect(await copyRow(done.id)).toMatchObject({
      state: "failed",
      error: "floor_denied",
      next_at: null,
    });
    await sweep(later(24 * 60 * 3));
    expect(callsFor(done.id)).toHaveLength(1);
  });

  it("an acceptance erased before its copy went: never sent, and its address cleared", async () => {
    const buyer = await createBuyer(admin, "erased");
    const done = await run<{ id: string }>(
      "me.agreements.accept",
      { versionId: waiver.versionId, typedName: "Fixture Name" },
      outside(buyer.principal, { events }),
    );
    await run("person.erase", { id: buyer.principal.personId }, staff());
    expect(await copyRow(done.id)).toMatchObject({ state: "cancelled", to_address: null });
    await sweep(later(5));
    expect(deliveredFor(done.id)).toHaveLength(0);
  });

  it("erased while a crashed sender held its claim: the sender that takes it over sends nothing", async () => {
    const buyer = await createBuyer(admin, "erasesend");
    const done = await run<{ id: string }>(
      "me.agreements.accept",
      { versionId: waiver.versionId, typedName: "Fixture Name" },
      outside(buyer.principal, { events }),
    );
    // A sender claimed it and stopped; then the Person was erased.
    await env.DB.prepare(
      "UPDATE core_agreement_copy SET state = 'sending', claimed_at = ?, next_at = ?, attempts = 1 WHERE acceptance_id = ?",
    )
      .bind(new Date().toISOString(), later(10).toISOString(), done.id)
      .run();
    await run("person.erase", { id: buyer.principal.personId }, staff());
    expect(await copyRow(done.id)).toMatchObject({ state: "cancelled", to_address: null });
    // Nothing can put it back in the sender's way: no writer reopens it with an address.
    await expect(
      env.DB.prepare(
        "UPDATE core_agreement_copy SET state = 'sending', next_at = ? WHERE acceptance_id = ?",
      )
        .bind(new Date().toISOString(), done.id)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare("UPDATE core_agreement_copy SET to_address = ? WHERE acceptance_id = ?")
        .bind(buyer.email, done.id)
        .run(),
    ).rejects.toThrow(/core_agreement_copy_fixed/);
    await sweep(later(11));
    expect(await copyRow(done.id)).toMatchObject({ state: "cancelled" });
    expect(callsFor(done.id)).toHaveLength(0);
  });

  it("the sender itself sends nothing for an acceptance it finds erased", async () => {
    const buyer = await createBuyer(admin, "erasedfacts");
    const done = await run<{ id: string }>(
      "me.agreements.accept",
      { versionId: waiver.versionId, typedName: "Fixture Name" },
      outside(buyer.principal, { events }),
    );
    // The sender's own check, apart from the erase trigger: a copy row still open whose
    // acceptance is erased (the trigger dropped, as a future migration might).
    await env.DB.prepare("DROP TRIGGER core_agreement_copy_on_erase").run();
    try {
      await run("person.erase", { id: buyer.principal.personId }, staff());
      expect(await copyRow(done.id)).toMatchObject({ state: "queued" });
      await sweep(later(1));
      expect(await copyRow(done.id)).toMatchObject({ state: "cancelled" });
      expect(callsFor(done.id)).toHaveLength(0);
    } finally {
      await env.DB.prepare(
        `CREATE TRIGGER core_agreement_copy_on_erase
         AFTER UPDATE OF erased_at ON core_agreement_acceptance
         WHEN OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
         BEGIN
           UPDATE core_agreement_copy
           SET to_address = NULL, next_at = NULL, error = NULL, pending_action_id = NULL,
             state = CASE WHEN state IN ('sent', 'failed') THEN state ELSE 'cancelled' END
           WHERE acceptance_id = NEW.id;
         END`,
      ).run();
    }
  });
});

describe("where a copy goes is the host's", () => {
  it("the database refuses a copy to any other address, and any change of it", async () => {
    const buyer = await createBuyer(admin, "addr");
    const done = await run<{ id: string }>(
      "me.agreements.accept",
      { versionId: waiver.versionId, typedName: "Fixture Name" },
      outside(buyer.principal, { events }),
    );
    await expect(
      env.DB.prepare(
        "UPDATE core_agreement_copy SET to_address = 'x@evil.test' WHERE acceptance_id = ?",
      )
        .bind(done.id)
        .run(),
    ).rejects.toThrow(/core_agreement_copy_fixed/);
    await expect(
      env.DB.prepare(
        "INSERT OR REPLACE INTO core_agreement_copy (acceptance_id, to_address, state, send_key, attempts, queued_at) VALUES (?, 'x@evil.test', 'queued', ?, 0, ?)",
      )
        .bind(done.id, `agreement-copy:${done.id}`, new Date().toISOString())
        .run(),
    ).rejects.toThrow(/core_agreement_copy_fixed/);
    const paper = await run<{ id: string }>(
      "agreement.recordPaper",
      {
        personId: buyer.principal.personId,
        versionId: waiver.versionId,
        signedOn: new Date().toISOString().slice(0, 10),
        typedName: "Fixture Paper Name",
      },
      staff(),
    );
    await expect(
      env.DB.prepare(
        "INSERT INTO core_agreement_copy (acceptance_id, to_address, state, send_key, attempts, queued_at, next_at) VALUES (?, 'x@evil.test', 'queued', ?, 0, ?, ?)",
      )
        .bind(
          paper.id,
          `agreement-copy:${paper.id}`,
          new Date().toISOString(),
          new Date().toISOString(),
        )
        .run(),
    ).rejects.toThrow(/core_agreement_copy_address/);
    // A sent copy stays sent.
    await env.DB.prepare("UPDATE core_agreement_copy SET state = 'sent' WHERE acceptance_id = ?")
      .bind(done.id)
      .run();
    await expect(
      env.DB.prepare("UPDATE core_agreement_copy SET state = 'queued' WHERE acceptance_id = ?")
        .bind(done.id)
        .run(),
    ).rejects.toThrow(/core_agreement_copy_fixed/);
  });

  it("an agreement goes only through the agreements purpose", async () => {
    const message = {
      to: ["a@buyers.example"],
      subject: "x",
      text: "y",
      agreement: { title: "x" },
    };
    await expect(
      mail.runtime.callAsHost?.({
        connectionId: "c",
        resource: "r",
        method: "send",
        args: [message],
        purpose: "orders",
      }),
    ).rejects.toThrow(/Invalid email/);
  });
});

// --- Health answers ---------------------------------------------------------------------------------

describe("health answers never leak (decision 21)", () => {
  it("not in the copy, the audit or the copy's row; in the person's download and for staff with agreements:health only", async () => {
    const buyer = await createBuyer(admin, "health");
    const done = await accept(buyer.principal, health);
    const sent = deliveredFor(done.id);
    expect(sent).toHaveLength(1);
    const message = JSON.stringify(sent[0]);
    expect(message).not.toContain(SECRET_NOTE);
    expect(message).toContain('"answers":"in-app"');
    expect(message).not.toMatch(/"yes":/);
    expect(sent[0]?.text).toContain("not in this email or the attached file");
    // The gatekeeper refuses answers outright, whatever the host might send.
    expect(() =>
      parseMessage({
        to: sent[0]?.to,
        subject: sent[0]?.subject,
        text: sent[0]?.text,
        agreement: { ...(sent[0]?.agreement as object), answers: [{ key: "q1", yes: true }] },
      }),
    ).toThrow(/Invalid email: agreement/);
    const pdfText = new TextDecoder("latin1").decode(attachedPdf(sent[0] as Sent));
    expect(pdfText).not.toContain(Buffer.from(SECRET_NOTE, "latin1").toString("hex").toUpperCase());
    // The person's own download holds them.
    const own = await run<{ document: AgreementPdf }>(
      "me.agreements.pdf",
      { acceptanceId: done.id },
      as(buyer.principal),
    );
    expect(JSON.stringify(own.document)).toContain(SECRET_NOTE);
    // Staff: an admin (agreements:health) has them; a member does not.
    const withHealth = await run<{ document: AgreementPdf }>(
      "agreement.acceptance.pdf",
      { acceptanceId: done.id },
      staff(),
    );
    expect(JSON.stringify(withHealth.document)).toContain(SECRET_NOTE);
    const without = await run<{ document: AgreementPdf }>(
      "agreement.acceptance.pdf",
      { acceptanceId: done.id },
      staff(member),
    );
    expect(without.document.answers).toBe("withheld");
    expect(JSON.stringify(without.document)).not.toContain(SECRET_NOTE);
    // Nothing of them in any audit row, the copy's row or a notice.
    const audit = await env.DB.prepare(
      "SELECT input, result, error FROM core_audit WHERE operation LIKE '%agreement%' OR operation LIKE 'me.agreements.%'",
    ).all();
    expect(JSON.stringify(audit.results)).not.toContain(SECRET_NOTE);
    expect(JSON.stringify(await copyRow(done.id))).not.toContain(SECRET_NOTE);
    // Every staff download is audited: who, whose, and whether answers were in it.
    const rows = (
      await env.DB.prepare(
        "SELECT user_id, result FROM core_audit WHERE operation = 'agreement.acceptance.pdf' AND result LIKE ?",
      )
        .bind(`%${done.id}%`)
        .all<{ user_id: string; result: string }>()
    ).results;
    expect(rows.map((r) => r.user_id).sort()).toEqual([admin.id, member.id].sort());
  });
});

// --- Who may download -------------------------------------------------------------------------------

describe("who may download", () => {
  it("staff: a person with records:read through the seam; never an AI, a pack-role coach, another customer or the public", async () => {
    const buyer = await createBuyer(admin, "dl");
    const other = await createBuyer(admin, "dlother");
    const done = await accept(buyer.principal, drawn, { signature: SIGNATURE });
    const staffPdf = await run<{ document: AgreementPdf }>(
      "agreement.acceptance.pdf",
      { acceptanceId: done.id },
      staff(member),
    );
    expect(staffPdf.document.signature).toBeDefined();
    for (const ai of AI_ACTORS) {
      for (const [name, input] of [
        ["agreement.acceptance.pdf", { acceptanceId: done.id }],
        ["agreement.version.pdf", { versionId: drawn.versionId }],
      ] as const) {
        const refused = await refusal(
          run(
            name,
            input,
            staff(admin, {
              ...ai,
              ...(ai.actor === "mcp" ? { grantedPermissions: ["records:read"] } : {}),
            }),
          ),
        );
        expect(refused.code, `${ai.actor} ${name}`).toBe("forbidden");
      }
    }
    const coach = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET pack_role = 'bookings.coach' WHERE id = ?")
      .bind(coach.id)
      .run();
    expect(
      (await refusal(run("agreement.acceptance.pdf", { acceptanceId: done.id }, staff(coach))))
        .code,
    ).toBe("forbidden");
    // Another customer: not found. The public, and a customer on staff's operation: not theirs.
    expect(
      (await refusal(run("me.agreements.pdf", { acceptanceId: done.id }, as(other.principal))))
        .code,
    ).toBe("not_found");
    expect(
      (await refusal(run("me.agreements.pdf", { acceptanceId: done.id }, as(PUBLIC)))).code,
    ).toBe("unknown_operation");
    expect(
      (
        await refusal(
          run("agreement.acceptance.pdf", { acceptanceId: done.id }, as(other.principal)),
        )
      ).code,
    ).toBe("unknown_operation");
  });

  it("a kept acceptance after erase is the manager's", async () => {
    const buyer = await createBuyer(admin, "kept");
    const done = await accept(buyer.principal, waiver);
    await run("person.erase", { id: buyer.principal.personId }, staff());

    expect(
      (await refusal(run("agreement.acceptance.pdf", { acceptanceId: done.id }, staff(member))))
        .details.rule,
    ).toBe("agreement_kept");
    const kept = await run<{ document: AgreementPdf }>(
      "agreement.acceptance.pdf",
      { acceptanceId: done.id },
      staff(),
    );
    expect(JSON.stringify(kept.document.record)).toContain("A person whose record was erased");
  });
});

describe("the blank PDF of a version", () => {
  it("is a person's on the staff: the version's words, boxes for a health form, and its hash at the foot", async () => {
    const blank = await run<{ document: AgreementPdf; filename: string }>(
      "agreement.version.pdf",
      { versionId: health.versionId },
      staff(member),
    );
    expect(blank.document.blank).toBe(true);
    expect(blank.document.record).toBeUndefined();
    expect(blank.document.acceptanceId).toBeUndefined();
    expect(blank.document.questions).toEqual([{ key: "q1", text: "Fixture question?" }]);
    expect(blank.filename).toMatch(/version-1\.pdf$/);
    const file = new TextDecoder("latin1").decode(agreementPdf(blank.document));
    const hex = Buffer.from(`SHA-256 ${blank.document.versionHash}`, "latin1")
      .toString("hex")
      .toUpperCase();
    expect(file).toContain(hex);
    // The version as stored is what is drawn: a forged one is refused.
    const v = await env.DB.prepare("SELECT hash FROM core_agreement_version WHERE id = ?")
      .bind(health.versionId)
      .first<{ hash: string }>();
    expect(blank.document.versionHash).toBe(v?.hash);
    expect(
      (await refusal(run("agreement.version.pdf", { versionId: "agv_nope" }, staff()))).code,
    ).toBe("not_found");
  });
});

describe("the backlog (after the review of PR #283)", () => {
  it("each open state's due rows are read in index order, and the read stops at its limit", async () => {
    for (const state of ["queued", "sending", "waiting"]) {
      const plan = await env.DB.prepare(
        "EXPLAIN QUERY PLAN SELECT acceptance_id FROM core_agreement_copy WHERE state = ? AND next_at <= ? ORDER BY next_at LIMIT 25",
      )
        .bind(state, "2099-01-01")
        .all<{ detail: string }>();
      const details = plan.results.map((r) => r.detail).join(" | ");
      expect(details, state).toContain("core_agreement_copy_due_idx");
      expect(details, state).not.toContain("TEMP B-TREE");
    }
  });

  it("with no email channel set, nothing is read or sent, and admins are told once", async () => {
    const buyer = await createBuyer(admin, "nochannel");
    const setting = await env.DB.prepare(
      "SELECT value FROM core_settings WHERE key = 'notification_delivery'",
    ).first<{ value: string }>();
    await run("notification.updateDeliverySettings", { email: null }, staff());
    try {
      const done = await run<{ id: string }>(
        "me.agreements.accept",
        { versionId: waiver.versionId, typedName: "Fixture Name" },
        as(buyer.principal),
      );
      expect(await copyRow(done.id)).toMatchObject({ state: "queued" });
      const first = await sendAgreementCopies({ db: db.query, integrations: mail.runtime });
      expect(first.notSetUp).toMatch(/no email channel/);
      await sendAgreementCopies({ db: db.query, integrations: mail.runtime });
      expect(callsFor(done.id)).toHaveLength(0);
      const notices = await env.DB.prepare(
        "SELECT title, body FROM core_notifications WHERE user_id = ? AND dedupe_key = 'agreement-copy:no-channel'",
      )
        .bind(admin.id)
        .all<{ title: string; body: string }>();
      expect(notices.results).toHaveLength(1);
      expect(JSON.stringify(notices.results)).not.toContain(buyer.email);
    } finally {
      await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'notification_delivery'")
        .bind(setting?.value ?? "{}")
        .run();
    }
  });
});

describe("a body the signed PDF can hold (after the review of PR #283)", () => {
  it("is measured by the PDF writer, with the longest record and answers it may carry", async () => {
    const { fitsSignedPdf } = await import("../src/agreements/copy.ts");
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    expect(
      fitsSignedPdf({
        title: "Fixture",
        body: { blocks: [paragraph("Fixture text.")] },
        tickLabel: "I agree",
        questions: QUESTIONS,
      }),
    ).toBe(true);
    // Far more than 400 pages of lines.
    const lines = Array.from({ length: 1000 }, () => ({
      type: "paragraph",
      content: Array.from({ length: 40 }, (_, i) =>
        i % 2 ? { type: "break" } : { type: "text", text: "x" },
      ),
    }));
    expect(
      fitsSignedPdf({
        title: "Fixture",
        body: { blocks: lines },
        tickLabel: "I agree",
        questions: null,
      }),
    ).toBe(false);
  });
});
