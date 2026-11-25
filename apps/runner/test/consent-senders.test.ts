// Every sender asks (stage 30, ADR 0678), in the real integration host: a caller's email (an
// automation's own gatekeeper call, the assistant, MCP, a person) passes the host's consent check
// before the gatekeeper queues it, whatever the approval preset, and again when a person approves
// one that waited.
//   (a) under Autonomous, an automation's and the assistant's follow-up to a Person who stopped
//       follow-ups, and to a suppressed address, is refused: nothing sent or queued;
//   (b) a staff member's own email to a Person who turned news and offers off goes; their text to
//       a number that said STOP does not;
//   (c) a follow-up to five, two stopped, sends three (each with their own stop link) and says
//       two were dropped;
//   (d) an approval card for a message to someone who stopped while it waited says so, and
//       approving it sends nothing;
//   (e) the assistant's refusal is the one plain answer, whatever the reason.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  addressHash,
  invokeByName,
  readStopToken,
  recordFromForm,
  STOP_PARAM,
  saltedHash,
  stopToken,
  suppress,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeProviderStub } from "../src/integrations/fake.ts";
import { HostQueue } from "../src/integrations/queue.ts";
import { blobStore, integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, unique } from "./helpers.ts";
import { meterStatements } from "./statement-meter.ts";

const integrations = integrationRuntime(env);
const SITE = "https://gym.example";

let admin: ActingUser;
let connectionId: string;
let address: string;

const AUTOMATION = {
  actor: "automation",
  origin: { surface: "automation", automationId: "aut_consent" },
} as const;
const ASSISTANT = () =>
  ({
    actor: "assistant",
    origin: { surface: "assistant", sessionId: `ath_${unique("t")}` },
  }) as const;
const MCP = () =>
  ({ actor: "mcp", origin: { surface: "mcp", sessionId: `cap_${unique("s")}` } }) as const;

function op<T>(name: string, input: unknown, extra: Record<string, unknown> = {}) {
  return invokeByName(name, input, {
    actor: "human",
    user: admin,
    origin: { surface: "ui" },
    db,
    integrations,
    blobs: blobStore(env),
    ...extra,
  } as never) as Promise<T>;
}

type CallResult = {
  value: { id: number; status: string; dropped?: number };
  pending: { actionId: string; changeSetId: string }[];
  applied: unknown[];
};
const send = (message: Record<string, unknown>, extra: Record<string, unknown>) =>
  op<CallResult>(
    "integration.call",
    { connectionId, resource: "OUTBOX", method: "send", args: [message] },
    extra,
  );

/** A Person with one address. */
async function person(label: string) {
  const email = `${unique(label).toLowerCase()}@members.test`;
  const p = await op<{ id: string }>("person.create", { givenName: label, emails: [{ email }] });
  return { id: p.id, email };
}

/** Follow-ups stopped by the one-tap link, as the member would. */
async function stopFollowUps(personId: string) {
  const token = await stopToken(db.query, {
    person: personId,
    channel: "email",
    scope: "follow_up",
  });
  await invokeByName("contact.stop", { token }, { principal: { kind: "public" }, db });
}

const sent = () => fakeProviderStub(env, address).sent();
async function pendingOnConnection(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_pending_action WHERE connection_id = ? AND status = 'pending'",
  )
    .bind(connectionId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  admin = await createAdmin();
  await op("integration.setVendor", { vendor: "fake", enabled: true });
  await op("routineMail.settings.update", { siteOrigin: SITE });
});

beforeEach(async () => {
  // A fresh outbox each test, so `sent()` and the pending count are this test's alone.
  address = `${unique("outbox")}@fake.test`;
  const created = await op<{ connection: { id: string }; connect: { url: string; nonce: string } }>(
    "connection.create",
    { vendor: "fake", scope: "org", sharingLevel: "full" },
  );
  const runner = (await import("cloudflare:workers")).exports.default as unknown as {
    gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
  };
  const url = `http://crm.test${created.connect.url}`;
  await runner.gatekeeperFetch("fake", new Request(url));
  const done = await runner.gatekeeperFetch(
    "fake",
    new Request(url, { method: "POST", body: new URLSearchParams({ address }) }),
  );
  const ticket = /var ticket = "([^"]+)"/.exec(await done.text())?.[1] ?? "";
  await op("connection.completeConnect", {
    connectionId: created.connection.id,
    ticket,
    nonce: created.connect.nonce,
  });
  connectionId = created.connection.id;
  await op("connection.bindResource", { id: connectionId, url: `fake://outbox/${address}` });
  await setPreset("balanced");
});

describe("(a) under Autonomous, a machine's email to someone who stopped is refused", () => {
  it("an automation's and the assistant's follow-up: refused, nothing sent or queued", async () => {
    await setPreset("autonomous");
    const stopped = await person("Stopped");
    await stopFollowUps(stopped.id);
    const bounced = await person("Bounced");
    await suppress(
      db.query,
      "email",
      await addressHash(db.query, bounced.email),
      "provider_unsubscribed",
      new Date().toISOString(),
    );
    const stranger = `${unique("gone")}@elsewhere.test`;
    await suppress(
      db.query,
      "email",
      await addressHash(db.query, stranger),
      "provider_unsubscribed",
      new Date().toISOString(),
    );
    for (const who of [AUTOMATION, ASSISTANT()]) {
      for (const to of [stopped.email, bounced.email, stranger]) {
        await expect(
          send({ to: [to], subject: "We miss you", text: "Come back", purpose: "follow_up" }, who),
          `${who.actor} to ${to}`,
        ).rejects.toThrow(/recipient_stopped/);
      }
    }
    expect(await sent()).toEqual([]);
    expect(await pendingOnConnection()).toBe(0);

    // The control: the same follow-up to someone who did not stop goes at once under Autonomous.
    const open = await person("Open");
    const ok = await send(
      { to: [open.email], subject: "We miss you", text: "Come back", purpose: "follow_up" },
      AUTOMATION,
    );
    expect(ok.applied).toHaveLength(1);
    expect((await sent()).map((s) => s.to)).toEqual([[open.email]]);
  });

  it("without a purpose, a machine's email to a Person is refused (and queues nothing)", async () => {
    await setPreset("autonomous");
    const p = await person("NoPurpose");
    await expect(send({ to: [p.email], subject: "Hi", text: "Hi" }, AUTOMATION)).rejects.toThrow(
      /purpose_required/,
    );
    expect(await sent()).toEqual([]);
    expect(await pendingOnConnection()).toBe(0);
  });
});

describe("(b) a staff member's own message", () => {
  it("their one-to-one email to someone who turned news and offers off goes", async () => {
    const p = await person("NoNews");
    await recordFromForm(db.query, {
      personId: p.id,
      channel: "email",
      yes: false,
      wording: "Send me news and offers",
      how: "form",
      at: new Date().toISOString(),
    }).then((s) => s.execute());
    await stopFollowUps(p.id);
    const result = await send({ to: [p.email], subject: "About your visit", text: "Hi" }, {});
    expect(result.applied).toHaveLength(1);
    // A person's own email carries no stop link.
    expect((await sent()).map((s) => [s.to, s.text])).toEqual([[[p.email], "Hi"]]);
  });

  it("their text to a number that said STOP is refused at the host", async () => {
    const number = `+614${String(Date.now()).slice(-8)}`;
    await suppress(
      db.query,
      "text",
      await saltedHash(db.query, number),
      "stop_reply",
      new Date().toISOString(),
    );
    const queue = new HostQueue(
      {
        env,
        connectionId,
        connectionTitle: "Texts",
        vendor: "text",
        ownerUserId: admin.id,
        facetKey: "k",
        resourceTitle: "Sender",
        apply: async () => {},
        reject: async () => {},
        stashController: async () => "h",
        enableHook: async () => {},
        recordAgentHook: async () => {},
      },
      {
        kind: "actor",
        caller: {
          actor: "human",
          userId: admin.id,
          userName: admin.name,
          role: admin.role,
          origin: { surface: "ui" },
        },
        user: admin,
      },
    );
    await expect(queue.contactCheck({ channel: "text", to: [number] })).rejects.toThrow(
      /recipient_stopped/,
    );
    const other = `+614${String(Date.now() + 7).slice(-8)}`;
    await expect(queue.contactCheck({ channel: "text", to: [other] })).resolves.toEqual({
      allowed: [{ to: other, stop: false }],
      dropped: 0,
    });
  });
});

describe("(c) a follow-up to five, two stopped", () => {
  it("sends three, each with their own stop link, and says two were dropped", async () => {
    await setPreset("autonomous");
    const five = await Promise.all(["A", "B", "C", "D", "E"].map((l) => person(`Five${l}`)));
    await stopFollowUps(five[1]?.id as string);
    await stopFollowUps(five[3]?.id as string);
    const result = await send(
      {
        to: five.map((p) => p.email),
        subject: "Come back",
        text: "We have new classes.",
        purpose: "follow_up",
      },
      MCP(),
    );
    expect(result.value.dropped).toBe(2);
    const copies = await sent();
    expect(copies.map((c) => c.to)).toEqual([[five[0]?.email], [five[2]?.email], [five[4]?.email]]);
    for (const [i, copy] of copies.entries()) {
      const link = /https:\/\/gym\.example\/stop\?t=([A-Za-z0-9_-]{43})/.exec(copy.text);
      expect(link, copy.text).not.toBeNull();
      expect(await readStopToken(db.query, link?.[1] as string)).toEqual({
        person: five[[0, 2, 4][i] as number]?.id,
        channel: "email",
        scope: "follow_up",
      });
    }
    // The links never reach the caller, the approval's words, or the audit log.
    expect(JSON.stringify(result)).not.toContain(`?${STOP_PARAM}=`);
    const audit = await env.DB.prepare(
      "SELECT input FROM core_audit WHERE operation = 'integration.outbound' AND input LIKE '%Come back%'",
    ).all<{ input: string }>();
    expect(audit.results.length).toBeGreaterThan(0);
    for (const row of audit.results) expect(row.input).not.toContain(`?${STOP_PARAM}=`);
  });
});

describe("(d) an approval card for a message to someone who stopped while it waited", () => {
  it("says so, and approving it sends nothing", async () => {
    const a = await person("WaitA");
    const b = await person("WaitB");
    const queued = await send(
      { to: [a.email, b.email], subject: "Waiting", text: "Hello", purpose: "follow_up" },
      MCP(),
    );
    const changeSetId = queued.pending[0]?.changeSetId as string;
    expect(changeSetId).toBeTruthy();
    const before = await op<{ actions: { outbound: { contactBlocked: number | null } | null }[] }>(
      "approval.get",
      { changeSetId },
    );
    expect(before.actions[0]?.outbound?.contactBlocked).toBeNull();

    await stopFollowUps(b.id);
    const card = await op<{
      actions: { outbound: { contactBlocked: number | null } | null; input: unknown }[];
    }>("approval.get", { changeSetId });
    expect(card.actions[0]?.outbound?.contactBlocked).toBe(1);
    // An AI reading the same change set is not told (only the plain refusal ever reaches it).
    const asMcp = await op<{ actions: { outbound: { contactBlocked: number | null } | null }[] }>(
      "approval.get",
      { changeSetId },
      MCP(),
    );
    expect(asMcp.actions[0]?.outbound?.contactBlocked).toBeNull();

    const decided = await op<{ results: { status: string; statusReason: string | null }[] }>(
      "approval.approve",
      { changeSetId },
    );
    expect(decided.results[0]).toMatchObject({ status: "skipped" });
    expect(decided.results[0]?.statusReason).toMatch(/cannot be contacted this way/);
    expect(await sent()).toEqual([]);
  });
});

describe("(e) the assistant's refusal reveals nothing but the one answer", () => {
  it("the same words whether stopped, suppressed, a child, or no yes to news", async () => {
    const stopped = await person("Why1");
    await stopFollowUps(stopped.id);
    const bounced = await person("Why2");
    await suppress(
      db.query,
      "email",
      await addressHash(db.query, bounced.email),
      "provider_unsubscribed",
      new Date().toISOString(),
    );
    const parent = await person("Why3Parent");
    const kid = await person("Why3Kid");
    await op("person.link.add", { guardianId: parent.id, dependantId: kid.id });
    const silent = await person("Why4");
    const cases: [string, string][] = [
      [stopped.email, "follow_up"],
      [bounced.email, "follow_up"],
      [kid.email, "follow_up"],
      [silent.email, "news_and_offers"],
    ];
    const messages = new Set<string>();
    for (const [to, purpose] of cases) {
      const error = await send({ to: [to], subject: "Hi", text: "Hi", purpose }, ASSISTANT()).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(error).not.toBeNull();
      messages.add((error as string).replace(/^.*?(Refused:)/s, "$1"));
      for (const leak of [
        "follow-up",
        "follow_up",
        "news",
        "suppress",
        "child",
        "guardian",
        "consent",
        "turned",
        "off",
        stopped.id,
        kid.id,
      ]) {
        expect((error as string).toLowerCase()).not.toContain(leak.toLowerCase());
      }
    }
    expect([...messages]).toEqual([
      "Refused: recipient_stopped. The recipient cannot be contacted this way; nothing was sent or queued.",
    ]);
    expect(await sent()).toEqual([]);
    // Nothing of it was written where an AI could read it back: no pending action, no audit row.
    expect(await pendingOnConnection()).toBe(0);
  });
});

// --- The review of PR #469: every kind that sends to people, connected servers, the person's own
// draft, refusals recorded, tokens made when a message goes, and sends queued before the check.

type Description = Parameters<HostQueue["submitAction"]>[1];

/** A queue as the integration host opens one for `actor` on the outbox's connection, as `vendor`. */
function queueAs(vendor: string, actor: "human" | "assistant" | "mcp" | "automation") {
  const origin =
    actor === "human"
      ? { surface: "ui" as const }
      : actor === "automation"
        ? { surface: "automation" as const, automationId: "aut_consent" }
        : actor === "mcp"
          ? { surface: "mcp" as const, sessionId: `cap_${unique("s")}` }
          : { surface: "assistant" as const, sessionId: `ath_${unique("t")}` };
  return new HostQueue(
    {
      env,
      connectionId,
      connectionTitle: "A connection",
      vendor,
      ownerUserId: admin.id,
      facetKey: "k",
      resourceTitle: "Resource",
      apply: async () => {},
      reject: async () => {},
      stashController: async () => "h",
      enableHook: async () => {},
      recordAgentHook: async () => {},
    },
    {
      kind: "actor",
      caller: { actor, userId: admin.id, userName: admin.name, role: admin.role, origin },
      user: admin,
    },
  );
}

const calendarInvite = (to: string): Description => ({
  title: "Create calendar event: 20% off this week only",
  description: "Create an event.",
  fields: [
    { label: "Calendar ID", value: "primary" },
    { label: "Send updates", value: "all" },
    { label: "Event", value: JSON.stringify({ title: "20% off", attendees: [{ email: to }] }) },
  ],
});
const outlookInvite = (to: string): Description => ({
  title: "Invite to a meeting",
  description: "Sends invitations.",
  fields: [{ label: "Invites", items: [`Member <${to}> (required)`] }] as never,
  actionKind: { tag: "calendar.invitations", label: "Send meeting invitations" },
});
const gmailSend = (to: string[], cc: string[] = []): Description => ({
  title: "Send email: Hello",
  description: "Sends an email.",
  fields: [
    { label: "From", value: address },
    { label: "To", items: to },
    ...(cc.length ? [{ label: "Cc", items: cc }] : []),
    { label: "Subject", value: "Hello" },
  ] as never,
});
const mcpCall = (args: Record<string, unknown>): Description => ({
  title: "Call send_message on Messenger",
  description: "Tool send_message",
  fields: [{ label: "Arguments", value: JSON.stringify(args), syntax: "json" }],
  actionKind: { tag: "mcp:messenger:send_message", label: "Send messages" },
});

async function refusedRows(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_audit WHERE operation = 'contact.refused'",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("B1: calendar invitations are messages", () => {
  it("a machine's Google or Outlook invitation to a Person who stopped is refused; a person's own goes", async () => {
    await setPreset("autonomous");
    const stopped = await person("InviteStopped");
    await stopFollowUps(stopped.id);
    for (const description of [calendarInvite(stopped.email), outlookInvite(stopped.email)]) {
      const vendor = description.actionKind ? "microsoft" : "google";
      for (const actor of ["assistant", "automation", "mcp"] as const) {
        await expect(
          queueAs(vendor, actor).submitAction(1, description),
          `${vendor} ${actor}`,
        ).rejects.toThrow(/calendar invitation/);
      }
      // A person's own invitation follows the person's-own-message rule.
      const q = queueAs(vendor, "human");
      await q.submitAction(2, description);
      await q.settle();
    }
    // An update that tells attendees the host cannot see: a machine's is refused.
    await expect(
      queueAs("google", "assistant").submitAction(3, {
        title: "Update calendar event e1",
        description: "Update an event.",
        fields: [
          { label: "Send updates", value: "all" },
          { label: "Changes", value: JSON.stringify({ title: "Moved" }) },
        ],
      }),
    ).rejects.toThrow(/calendar invitation/);
  });
});

describe("B2: connected MCP servers' tool calls", () => {
  it("are scanned for addresses and numbers: a machine's naming a Person, or a STOP'd number, is refused", async () => {
    await setPreset("autonomous");
    const p = await person("McpKnown");
    const number = `+614${String(Date.now()).slice(-8)}`;
    await env.DB.prepare(
      "INSERT INTO core_person_phones (id, person_id, number, number_normalised, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(`pph_${unique("p")}`, p.id, number, number, new Date().toISOString())
      .run();
    const stoppedNumber = `+614${String(Date.now() + 3).slice(-8)}`;
    await suppress(
      db.query,
      "text",
      await saltedHash(db.query, stoppedNumber),
      "stop_reply",
      new Date().toISOString(),
    );
    for (const args of [{ to: p.email }, { to: number }, { phone: stoppedNumber }]) {
      await expect(
        queueAs("mcp", "assistant").submitAction(1, mcpCall(args)),
        JSON.stringify(args),
      ).rejects.toThrow(/Refused/);
    }
    // A person's own call: the suppression list holds; otherwise it goes.
    await expect(
      queueAs("mcp", "human").submitAction(2, mcpCall({ phone: stoppedNumber })),
    ).rejects.toThrow(/recipient_stopped/);
    const q = queueAs("mcp", "human");
    await q.submitAction(3, mcpCall({ to: p.email }));
    await q.settle();
    // A call naming nobody the host can read is not a send it can check.
    const plain = queueAs("mcp", "assistant");
    await plain.submitAction(4, mcpCall({ listId: "L1" }));
    await plain.settle();
  });
});

describe("a person's own draft: an AI's one-to-one email from their mailbox", () => {
  it("always waits for the mailbox's owner, under Autonomous too, and is theirs once they approve it", async () => {
    await setPreset("autonomous");
    const p = await person("DraftFor");
    await stopFollowUps(p.id);
    const q = queueAs("google", "assistant");
    await q.submitAction(11, gmailSend([p.email]));
    await q.settle();
    expect(q.pending).toHaveLength(1);
    const calls: unknown[] = [];
    const stub = {
      ...integrations,
      applyOutbound: async (i: unknown) => {
        calls.push(i);
      },
      rejectOutbound: async () => ({}),
    };
    // Someone other than the mailbox's owner cannot make it theirs.
    const other = await createAdmin();
    const byOther = await invokeByName(
      "approval.approve",
      { changeSetId: q.pending[0]?.changeSetId },
      { actor: "human", user: other, origin: { surface: "ui" }, db, integrations: stub } as never,
    );
    expect(JSON.stringify(byOther)).toMatch(/only the owner of the mailbox/);
    expect(calls).toEqual([]);

    const again = queueAs("google", "assistant");
    await again.submitAction(12, gmailSend([p.email]));
    await again.settle();
    const owned = (await op(
      "approval.approve",
      { changeSetId: again.pending[0]?.changeSetId },
      { integrations: stub },
    )) as { results: { status: string }[] };
    expect(owned.results[0]?.status).toBe("applied");
    expect(calls).toHaveLength(1);
  });

  it("to two people, with a Cc, or from an automation, it stays refused, and says what works", async () => {
    await setPreset("autonomous");
    const a = await person("DraftA");
    const b = await person("DraftB");
    for (const [actor, description] of [
      ["assistant", gmailSend([a.email, b.email])],
      ["assistant", gmailSend([a.email], [b.email])],
      ["automation", gmailSend([a.email])],
    ] as const) {
      const error = await queueAs("google", actor)
        .submitAction(1, description)
        .then(
          () => "",
          (e: unknown) => String(e),
        );
      expect(error).toMatch(/Save a draft/);
      // Never "add a purpose" where the gatekeeper cannot take one.
      expect(error).not.toMatch(/purpose: "follow_up"/);
    }
  });
});

describe("refusals are recorded, for people only", () => {
  it("a refused send writes an audit row staff read and no AI actor can", async () => {
    await setPreset("autonomous");
    const p = await person("Audited");
    await stopFollowUps(p.id);
    const before = await refusedRows();
    await expect(
      send({ to: [p.email], subject: "Hi", text: "Hi", purpose: "follow_up" }, AUTOMATION),
    ).rejects.toThrow(/recipient_stopped/);
    expect(await refusedRows()).toBe(before + 1);
    const asStaff = (await op("audit.list", { limit: 200 })) as {
      items: { operation: string; actor: string }[];
    };
    const row = asStaff.items.find((i) => i.operation === "contact.refused");
    expect(row).toMatchObject({ actor: "automation" });
    expect(JSON.stringify(row)).not.toContain(p.id);
    expect(JSON.stringify(row)).not.toContain(p.email);
    const asMcp = (await op("audit.list", { limit: 200 }, MCP())) as {
      items: { operation: string }[];
    };
    expect(asMcp.items.some((i) => i.operation === "contact.refused")).toBe(false);
  });

  it("an AI cannot read a person's choices", async () => {
    const p = await person("Private");
    await expect(op("contact.forPerson", { personId: p.id }, ASSISTANT())).rejects.toThrow();
    await expect(op("contact.forPerson", { personId: p.id })).resolves.toBeTruthy();
  });
});

describe("stop tokens are made when the message goes", () => {
  async function tokensOf(personId: string): Promise<number> {
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_contact_stop_token WHERE person_id = ?",
    )
      .bind(personId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("a waiting or rejected send leaves no token and no link; an applied one makes one per Person", async () => {
    const p = await person("Tokens");
    const queued = await send(
      { to: [p.email], subject: "Waiting", text: "Hello", purpose: "follow_up" },
      MCP(),
    );
    expect(await tokensOf(p.id)).toBe(0);
    const pending = await env.DB.prepare("SELECT input FROM core_pending_action WHERE id = ?")
      .bind(queued.pending[0]?.actionId)
      .first<{ input: string }>();
    expect(pending?.input).toBeTruthy();
    expect(pending?.input).not.toContain(`?${STOP_PARAM}=`);
    const card = await op("approval.get", { changeSetId: queued.pending[0]?.changeSetId });
    expect(JSON.stringify(card)).not.toContain(`?${STOP_PARAM}=`);
    await op("approval.reject", { actionIds: [queued.pending[0]?.actionId] });
    expect(await tokensOf(p.id)).toBe(0);

    await setPreset("autonomous");
    await send({ to: [p.email], subject: "Now", text: "Hello", purpose: "follow_up" }, MCP());
    expect(await tokensOf(p.id)).toBe(1);
  });
});

describe("a send queued before the host kept its check", () => {
  it("is checked at approval by who sent it", async () => {
    const p = await person("Legacy");
    const queued = await send(
      { to: [p.email], subject: "Old", text: "Hi", purpose: "follow_up" },
      MCP(),
    );
    // As a row written before ADR 0678: no consent record on it.
    const row = await env.DB.prepare("SELECT id, input FROM core_pending_action WHERE id = ?")
      .bind(queued.pending[0]?.actionId)
      .first<{ id: string; input: string }>();
    const input = JSON.parse(row?.input ?? "{}") as Record<string, unknown>;
    delete input.contact;
    await env.DB.prepare("UPDATE core_pending_action SET input = ? WHERE id = ?")
      .bind(JSON.stringify(input), row?.id)
      .run();
    const decided = (await op("approval.approve", {
      changeSetId: queued.pending[0]?.changeSetId,
    })) as { results: { status: string }[] };
    // An MCP client's email to a Person with no purpose on record: not sent.
    expect(decided.results[0]?.status).toBe("skipped");
    expect(await sent()).toEqual([]);
  });
});

describe("the inbox asks consent for its whole page at once", () => {
  it("a change set of five waiting emails reads what a change set of one does", async () => {
    const consentStatements = async (count: number) => {
      const mcp = MCP();
      let changeSetId = "";
      for (let i = 0; i < count; i += 1) {
        const p = await person(`Page${count}x${i}`);
        const queued = await send(
          { to: [p.email], subject: `Page ${i}`, text: "Hi", purpose: "follow_up" },
          mcp,
        );
        changeSetId = queued.pending[0]?.changeSetId ?? changeSetId;
      }
      const meter = meterStatements(env.DB);
      meter.reset();
      const card = (await op("approval.get", { changeSetId }, { db: createCrmDb(meter.db) })) as {
        actions: unknown[];
      };
      expect(card.actions).toHaveLength(count);
      return meter.statements.filter((s) =>
        /core_contact_suppression|core_person_emails|core_person_phones|core_contact_choice|core_routine_mail/.test(
          s.sql,
        ),
      ).length;
    };
    const one = await consentStatements(1);
    const five = await consentStatements(5);
    expect(five).toBe(one);
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThanOrEqual(3);
  });
});
