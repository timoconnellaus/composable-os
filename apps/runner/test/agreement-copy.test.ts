// The copy of a signed agreement (stage 44 step 4, ADR 0645) through the real integration host and
// the fake provider's outbox, which decides it with the email-send gatekeeper's own rule:
//
// - the host's `callAsHost` with purpose `agreements` applies at once, as the system's (no AI
//   reads it: the outbound check never sees it), carrying the signed agreement;
// - a retried send with the copy's key sends nothing more;
// - every other caller with an agreement (a person, the assistant, MCP, an automation, the
//   host's orders or sign-in mail) is refused, and nothing is queued;
// - an acceptance's copy, from the acceptance's own row, reaches the address it holds.
// All text here is fixture text.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type InvocationContext,
  invokeByName,
  resolveChannelTarget,
  SYSTEM_USER,
  sendAgreementCopies,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { fakeProviderStub } from "../src/integrations/fake.ts";
import { blobStore, integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};

function op<T>(
  user: ActingUser,
  name: string,
  input: unknown,
  extra: Partial<InvocationContext> = {},
) {
  const ctx: InvocationContext = {
    actor: "human",
    user,
    origin: { surface: "ui" },
    db,
    integrations,
    blobs: blobStore(env),
    extensionHost: host,
    ...extra,
  };
  return invokeByName(name, input, ctx) as Promise<T>;
}

async function connectFakeForOrg(owner: ActingUser, address: string): Promise<string> {
  const created = await op<{ connection: { id: string }; connect: { url: string; nonce: string } }>(
    owner,
    "connection.create",
    { vendor: "fake", scope: "org", sharingLevel: "full" },
  );
  const url = `http://crm.test${created.connect.url}`;
  await runner.gatekeeperFetch("fake", new Request(url));
  const done = await runner.gatekeeperFetch(
    "fake",
    new Request(url, { method: "POST", body: new URLSearchParams({ address }) }),
  );
  const ticket = /var ticket = "([^"]+)"/.exec(await done.text())?.[1] ?? "";
  await op(owner, "connection.completeConnect", {
    connectionId: created.connection.id,
    ticket,
    nonce: created.connect.nonce,
  });
  return created.connection.id;
}

let admin: ActingUser;
let outbox: string;
let connectionId: string;
let target: { connectionId: string; resource: string };

const sentTo = async (to: string) =>
  (await fakeProviderStub(env, outbox).sent()).filter((m) => m.to.includes(to));

const agreement = (acceptanceId: string) => ({
  business: "Fixture Studio",
  title: "Fixture waiver",
  versionNumber: 1,
  versionHash: "b".repeat(64),
  body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Fixture text." }] }] },
  tickLabel: "I have read this fixture",
  record: [{ label: "For", value: "Fixture Person" }],
  acceptanceId,
  summary: "agreed by the person, 2026-11-23 09:00 UTC",
});

const copy = (to: string, acceptanceId = `aga_${unique("x")}`) => ({
  to: [to],
  subject: "Fixture Studio: your copy of Fixture waiver",
  text: "This is your copy.",
  agreement: agreement(acceptanceId),
  idempotencyKey: `agreement-copy:${acceptanceId}`,
});

beforeAll(async () => {
  await setPreset("balanced");
  admin = await createAdmin();
  await op(admin, "integration.setVendor", { vendor: "fake", enabled: true });
  outbox = `${unique("copies")}@example.com`;
  connectionId = await connectFakeForOrg(admin, outbox);
  await op(admin, "connection.bindResource", {
    id: connectionId,
    url: `fake://outbox/${encodeURIComponent(outbox)}`,
  });
  await op(admin, "notification.updateDeliverySettings", { email: connectionId });
  const resolved = await resolveChannelTarget(db.query, "email", connectionId);
  if ("problem" in resolved) throw new Error(resolved.problem);
  target = resolved.target;
});

describe("the host's agreements mail", () => {
  it("applies at once as the system's, with the signed agreement; the same key sends once", async () => {
    const to = `${unique("member")}@outside.test`;
    const message = copy(to);
    const call = () =>
      integrations.callAsHost?.({
        connectionId: target.connectionId,
        resource: target.resource,
        method: "send",
        args: [message],
        purpose: "agreements",
      });
    const first = await call();
    expect(first?.applied.map((a) => a.actionKind)).toEqual(["fake.agreement"]);
    expect(first?.pending).toEqual([]);
    const again = await call();
    expect(again?.applied).toEqual([]);
    expect((again?.value as { status?: string } | undefined)?.status).toBe("sent");
    const sent = await sentTo(to);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.attachments).toEqual(["agreement.pdf"]);
    // The system's own mail: the system user, a system origin (so no AI's outbound check reads
    // it), and its audit row names no one.
    const audit = await env.DB.prepare(
      "SELECT actor, user_id, origin, input FROM core_audit WHERE operation = 'integration.outbound' AND input LIKE ? ORDER BY at DESC",
    )
      .bind("%fake.agreement%")
      .first<{ actor: string; user_id: string; origin: string; input: string }>();
    expect(audit).toMatchObject({ actor: "automation", user_id: SYSTEM_USER.id });
    expect(JSON.parse(audit?.origin ?? "{}")).toEqual({
      surface: "system",
      automationId: "system.agreements",
    });
    expect(audit?.input).not.toContain("Fixture Person");
  });

  it("is refused to every other caller, and to the host's other purposes", async () => {
    const callers: Partial<InvocationContext>[] = [
      {},
      { actor: "mcp", origin: { surface: "mcp", sessionId: `cap_${unique("s")}`, clientId: "c" } },
      { actor: "assistant", origin: { surface: "assistant", sessionId: `ath_${unique("t")}` } },
      { actor: "automation", origin: { surface: "automation", automationId: "aut_x" } },
    ];
    for (const extra of callers) {
      const to = `${unique("victim")}@outside.test`;
      await expect(
        op(
          admin,
          "integration.call",
          { connectionId, resource: "OUTBOX", method: "send", args: [copy(to)] },
          extra,
        ),
        JSON.stringify(extra),
      ).rejects.toThrow(
        /agreement is attached only by the host|is the host's own agreements mail's/,
      );
      expect(await sentTo(to)).toEqual([]);
    }
    for (const purpose of ["orders", "sign-in"] as const) {
      const to = `${unique("other")}@outside.test`;
      await expect(
        integrations.callAsHost?.({
          connectionId: target.connectionId,
          resource: target.resource,
          method: "send",
          args: [copy(to)],
          purpose,
          ...(purpose === "sign-in" ? { origin: "system.customer-mail" as const } : {}),
        }) as Promise<unknown>,
        purpose,
      ).rejects.toThrow(
        /agreement is attached only by the host|is the host's own agreements mail's/,
      );
      expect(await sentTo(to)).toEqual([]);
    }
    // Only one send, and only `send`.
    await expect(
      integrations.callAsHost?.({
        connectionId: target.connectionId,
        resource: target.resource,
        method: "listSent",
        args: [],
        purpose: "agreements",
      }) as Promise<unknown>,
    ).rejects.toThrow(/one send/);
  });

  it("an acceptance's copy goes from its row, to the address it holds, once", async () => {
    const { id: documentId } = await op<{ id: string }>(admin, "agreement.create", {
      title: unique("Fixture waiver"),
      kind: "waiver",
    });
    const saved = await op<{ hash: string; rev: number }>(admin, "agreement.draft.save", {
      id: documentId,
      body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Fixture text." }] }] },
      tickLabel: "I have read this fixture",
    });
    const { version } = await op<{ version: { id: string; hash: string } }>(
      admin,
      "agreement.publish",
      { documentId, draftHash: saved.hash, draftRev: saved.rev, number: 1, change: "small" },
    );
    const email = `${unique("signed")}@outside.test`;
    const person = await op<{ id: string }>(admin, "person.create", {
      givenName: unique("Member"),
      emails: [{ email }],
    });
    const id = `aga_${unique("cp")}`;
    const hash = await env.DB.prepare("SELECT hash FROM core_agreement_version WHERE id = ?")
      .bind(version.id)
      .first<{ hash: string }>();
    await env.DB.prepare(
      "INSERT INTO core_agreement_acceptance (id, document_id, version_id, shown_hash, person_id, by, account_id, email, how, typed_name, channel, accepted_at) VALUES (?, ?, ?, ?, ?, 'self', 'cus_x', ?, 'typed', 'Fixture Name', 'web', ?)",
    )
      .bind(id, documentId, version.id, hash?.hash, person.id, email, new Date().toISOString())
      .run();
    await sendAgreementCopies({ db: db.query, integrations });
    await sendAgreementCopies({ db: db.query, integrations });
    const sent = await sentTo(email);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.attachments).toEqual(["agreement.pdf"]);
    expect(sent[0]?.subject).toMatch(/: your copy of Fixture waiver/);
    const row = await env.DB.prepare(
      "SELECT state FROM core_agreement_copy WHERE acceptance_id = ?",
    )
      .bind(id)
      .first<{ state: string }>();
    expect(row?.state).toBe("sent");
  });
});

describe("keys and lists kept apart by who is sending (the review of PR #283)", () => {
  const mcp = (): Partial<InvocationContext> => ({
    actor: "mcp",
    origin: { surface: "mcp", sessionId: `cap_${unique("s")}`, clientId: "c" },
  });

  async function paperAcceptance() {
    const { id: documentId } = await op<{ id: string }>(admin, "agreement.create", {
      title: unique("Fixture waiver"),
      kind: "waiver",
    });
    const saved = await op<{ hash: string; rev: number }>(admin, "agreement.draft.save", {
      id: documentId,
      body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Fixture text." }] }] },
      tickLabel: "I have read this fixture",
    });
    const { version } = await op<{ version: { id: string } }>(admin, "agreement.publish", {
      documentId,
      draftHash: saved.hash,
      draftRev: saved.rev,
      number: 1,
      change: "small",
    });
    const email = `${unique("paper")}@outside.test`;
    const person = await op<{ id: string }>(admin, "person.create", {
      givenName: unique("Member"),
      emails: [{ email }],
    });
    const hash = await env.DB.prepare("SELECT hash FROM core_agreement_version WHERE id = ?")
      .bind(version.id)
      .first<{ hash: string }>();
    const id = `aga_${unique("pp")}`;
    await env.DB.prepare(
      "INSERT INTO core_agreement_acceptance (id, document_id, version_id, shown_hash, person_id, by, how, typed_name, channel, accepted_at, signed_on, recorded_by) VALUES (?, ?, ?, ?, ?, 'paper', 'paper', 'Fixture Name', 'paper', ?, '2026-11-01', ?)",
    )
      .bind(id, documentId, version.id, hash?.hash, person.id, new Date().toISOString(), admin.id)
      .run();
    return { id, email };
  }

  it("an MCP client cannot take a paper form's copy key first: the person still gets their copy", async () => {
    const { id, email } = await paperAcceptance();
    const attacker = `${unique("attacker")}@outside.test`;
    await expect(
      op(
        admin,
        "integration.call",
        {
          connectionId,
          resource: "OUTBOX",
          method: "send",
          args: [
            {
              to: [attacker],
              subject: "hello",
              text: "hi",
              idempotencyKey: `agreement-copy:${id}`,
            },
          ],
        },
        mcp(),
      ),
    ).rejects.toThrow(/is the host's own agreements mail's/);
    expect(await sentTo(attacker)).toEqual([]);
    const preview = await op<{ to: string }>(admin, "agreement.copy.preview", { acceptanceId: id });
    const out = await op<{ state: string }>(admin, "agreement.copy.send", {
      acceptanceId: id,
      confirmTo: preview.to,
    });
    expect(out.state).toBe("sent");
    const got = await sentTo(email);
    expect(got).toHaveLength(1);
    expect(got[0]?.attachments).toEqual(["agreement.pdf"]);
  });

  it("two sessions sharing one key each get their own send, through the integration host", async () => {
    const key = `shared-${unique("k")}`;
    const theirs = `${unique("theirs")}@outside.test`;
    const ours = `${unique("ours")}@outside.test`;
    await op(
      admin,
      "integration.call",
      {
        connectionId,
        resource: "OUTBOX",
        method: "send",
        args: [{ to: [theirs], subject: "Theirs", text: "x", idempotencyKey: key }],
      },
      // A person on the staff (their own send applies), so nothing waits ahead of the host's.
      {},
    );
    expect(await sentTo(theirs)).toHaveLength(1);
    // The host's orders mail with the very same key: its own send, not the caller's answer.
    const result = await integrations.callAsHost?.({
      connectionId: target.connectionId,
      resource: target.resource,
      method: "send",
      args: [{ to: [ours], subject: "Ours", text: "y", idempotencyKey: key }],
      purpose: "orders",
    });
    expect(result?.applied).toHaveLength(1);
    expect(await sentTo(ours)).toHaveLength(1);
  });

  it("a caller's listSent does not show the host's copies", async () => {
    const to = `${unique("listed")}@outside.test`;
    await integrations.callAsHost?.({
      connectionId: target.connectionId,
      resource: target.resource,
      method: "send",
      args: [copy(to)],
      purpose: "agreements",
    });
    expect(await sentTo(to)).toHaveLength(1);
    for (const extra of [{}, mcp()]) {
      const listed = await op<{ value: unknown }>(
        admin,
        "integration.call",
        { connectionId, resource: "OUTBOX", method: "listSent", args: [] },
        extra,
      );
      expect(JSON.stringify(listed.value)).not.toContain(to);
    }
  });
});

describe("scrubbing an erased acceptance's copy (stage 44 step 8, ADR 0646)", () => {
  it("only the host's agreements mail may ask, and the copy's key is never sent again", async () => {
    const to = `${unique("scrubbed")}@outside.test`;
    const acceptanceId = `aga_${unique("scrub")}`;
    await integrations.callAsHost?.({
      connectionId: target.connectionId,
      resource: target.resource,
      method: "send",
      args: [copy(to, acceptanceId)],
      purpose: "agreements",
    });
    expect(await sentTo(to)).toHaveLength(1);
    const key = `agreement-copy:${acceptanceId}`;
    // Every other caller: a person, MCP, the assistant, an automation.
    for (const extra of [
      {},
      {
        actor: "mcp" as const,
        origin: { surface: "mcp" as const, sessionId: `cap_${unique("s")}`, clientId: "c" },
      },
      {
        actor: "assistant" as const,
        origin: { surface: "assistant" as const, sessionId: "ath_s" },
      },
      {
        actor: "automation" as const,
        origin: { surface: "automation" as const, automationId: "a" },
      },
    ]) {
      await expect(
        op(
          admin,
          "integration.call",
          { connectionId, resource: "OUTBOX", method: "scrubAgreementCopy", args: [{ key }] },
          extra,
        ),
        JSON.stringify(extra),
      ).rejects.toThrow(/only the host's own agreements mail/);
    }
    // The host's other purposes: refused by the gatekeeper, or by the integration host.
    await expect(
      integrations.callAsHost?.({
        connectionId: target.connectionId,
        resource: target.resource,
        method: "scrubAgreementCopy",
        args: [{ key }],
        purpose: "orders",
      }) as Promise<unknown>,
    ).rejects.toThrow(/only the host's own agreements mail/);
    await expect(
      integrations.callAsHost?.({
        connectionId: target.connectionId,
        resource: target.resource,
        method: "scrubAgreementCopy",
        args: [{ key }],
        purpose: "sign-in",
        origin: "system.customer-mail",
      }) as Promise<unknown>,
    ).rejects.toThrow(/one send/);
    const done = await integrations.callAsHost?.({
      connectionId: target.connectionId,
      resource: target.resource,
      method: "scrubAgreementCopy",
      args: [{ key }],
      purpose: "agreements",
    });
    expect(done?.value).toMatchObject({ done: true, found: true });
    // Never sent again under that key.
    await expect(
      integrations.callAsHost?.({
        connectionId: target.connectionId,
        resource: target.resource,
        method: "send",
        args: [copy(to, acceptanceId)],
        purpose: "agreements",
      }) as Promise<unknown>,
    ).rejects.toThrow(/^Refused:|erased/);
    expect(await sentTo(to)).toHaveLength(1);
  });
});
