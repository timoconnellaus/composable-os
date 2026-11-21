// The host's sign-in mail (ADR 0456), through the real integration host and the fake provider's
// outbox, which decides the sign-in kind with the email-send gatekeeper's own rule:
//
// - a code reaches an outside address at once once a human admin lets the sign-in kind apply;
// - until then the host's mail says it is not ready, and nothing is queued;
// - every other caller sending the very same text (a staff call, an extension, an automation,
//   the assistant, MCP, and the system user over the ordinary call) gets the ordinary, reviewed
//   kind; so does the host itself with a message that is not the template;
// - a send waiting for review does not hold back a code.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  CUSTOMER_MAIL_ORIGIN,
  customerCodeEmail,
  customerCodeTarget,
  hostMailCall,
  type InvocationContext,
  invokeByName,
  SYSTEM_USER,
  sendCustomerCode,
  signInMailCall,
  signInMailState,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const kindOf = async (actionId: string) =>
  (
    await env.DB.prepare("SELECT action_kind FROM core_pending_action WHERE id = ?")
      .bind(actionId)
      .first<{ action_kind: string }>()
  )?.action_kind;

const sentTo = async (to: string) =>
  (await fakeProviderStub(env, outbox).sent()).filter((m) => m.to.includes(to));

const setSignInKind = (enabled: boolean) =>
  op(admin, "outbound.setAutoApprove", { tag: "fake.signin", enabled });

/** The template, to an outside address. */
const codeMail = (to: string, code = "482913") => ({ to: [to], ...customerCodeEmail(code) });

beforeAll(async () => {
  await setPreset("balanced");
  admin = await createAdmin();
  await op(admin, "integration.setVendor", { vendor: "fake", enabled: true });
  outbox = `${unique("host-mail")}@example.com`;
  connectionId = await connectFakeForOrg(admin, outbox);
  await op(admin, "connection.bindResource", {
    id: connectionId,
    url: `fake://outbox/${encodeURIComponent(outbox)}`,
  });
  await op(admin, "customer.settings.update", { emailConnectionId: connectionId });
});

afterAll(() => setPreset("balanced"));

describe("the host's sign-in mail", () => {
  it("is known as soon as the host's mail connection is chosen, and not auto-approved", async () => {
    const row = await env.DB.prepare(
      "SELECT auto_approvable, auto_approve FROM core_outbound_kind WHERE tag = 'fake.signin'",
    ).first();
    expect(row).toEqual({ auto_approvable: 1, auto_approve: 0 });
    const state = await signInMailState(db.query);
    expect(state).toMatchObject({ ready: false, kind: { tag: "fake.signin" } });
    expect(state.problem).toContain('"Send sign-in codes" (fake.signin)');
  });

  it("reaches an outside address at once once an admin lets the kind apply", async () => {
    await setSignInKind(true);
    expect(await signInMailState(db.query)).toMatchObject({ ready: true, problem: null });
    const target = await customerCodeTarget(db.query);
    if ("problem" in target) throw new Error(target.problem);
    const to = `${unique("buyer")}@outside.test`;
    await sendCustomerCode(signInMailCall(integrations, "system.customer-mail"), target.target, {
      to,
      code: "482913",
    });
    expect((await sentTo(to)).map((m) => m.text)).toEqual([customerCodeEmail("482913").text]);
    // The host's, for customer mail: the system user, no staff member.
    const audit = await env.DB.prepare(
      "SELECT actor, user_id, origin, input FROM core_audit WHERE operation = 'integration.outbound' AND input LIKE ? ORDER BY at DESC",
    )
      .bind("%fake.signin%")
      .first<{ actor: string; user_id: string; origin: string }>();
    expect(audit).toMatchObject({ actor: "automation", user_id: SYSTEM_USER.id });
    expect(JSON.parse(audit?.origin ?? "{}")).toEqual(CUSTOMER_MAIL_ORIGIN);
  });

  it("is not ready while the kind is reviewed, and a code sent anyway waits and is refused", async () => {
    await setSignInKind(false);
    expect((await signInMailState(db.query)).ready).toBe(false);
    const target = await customerCodeTarget(db.query);
    if ("problem" in target) throw new Error(target.problem);
    const to = `${unique("late")}@outside.test`;
    await expect(
      sendCustomerCode(signInMailCall(integrations, "system.customer-mail"), target.target, {
        to,
        code: "111111",
      }),
    ).rejects.toThrow(/queued for review/);
    expect(await sentTo(to)).toEqual([]);
  });

  it("is the ordinary reviewed kind for every other caller sending the same text", async () => {
    await setSignInKind(true);
    const callers: { name: string; extra: Partial<InvocationContext>; user?: ActingUser }[] = [
      { name: "a person (staff call)", extra: {} },
      {
        name: "MCP",
        extra: {
          actor: "mcp",
          origin: { surface: "mcp", sessionId: `cap_${unique("s")}`, clientId: "c" },
        },
      },
      {
        name: "the assistant",
        extra: {
          actor: "assistant",
          origin: { surface: "assistant", sessionId: `ath_${unique("t")}` },
        },
      },
      {
        name: "an automation",
        extra: { actor: "automation", origin: { surface: "automation", automationId: "aut_x" } },
      },
      {
        name: "the system user claiming customer mail",
        extra: { actor: "automation", origin: { ...CUSTOMER_MAIL_ORIGIN } },
        user: SYSTEM_USER,
      },
    ];
    for (const caller of callers) {
      const to = `${unique("victim")}@outside.test`;
      const result = await op<{
        pending: { actionId: string }[];
        applied: { actionKind: string | null }[];
      }>(
        caller.user ?? admin,
        "integration.call",
        { connectionId, resource: "OUTBOX", method: "send", args: [codeMail(to)] },
        caller.extra,
      );
      // A person's own send applies under Balanced; everyone else's waits. Either way it is the
      // ordinary kind, never the host's sign-in mail.
      const kinds = [
        ...result.applied.map((a) => a.actionKind),
        ...(await Promise.all(result.pending.map((p) => kindOf(p.actionId)))),
      ];
      expect(kinds, caller.name).toEqual(["fake.send"]);
    }
    // An extension's tool reaches the gatekeeper through the integration host's ordinary call.
    const target0 = await customerCodeTarget(db.query);
    if ("problem" in target0) throw new Error(target0.problem);
    const fromExtension = await integrations.call({
      connectionId,
      resource: target0.target.resource,
      method: "send",
      args: [codeMail(`${unique("ext")}@outside.test`)],
      caller: {
        actor: "extension",
        userId: admin.id,
        userName: admin.name,
        role: admin.role,
        origin: { surface: "extension", extensionId: "x" },
      },
    });
    expect(fromExtension.applied).toEqual([]);
    expect(await kindOf((fromExtension.pending[0] as { actionId: string }).actionId)).toBe(
      "fake.send",
    );
    // The ordinary call as the host would have made it before (ADR 0419) is not sign-in mail.
    const to = `${unique("old")}@outside.test`;
    const target = await customerCodeTarget(db.query);
    if ("problem" in target) throw new Error(target.problem);
    await expect(
      sendCustomerCode(hostMailCall(integrations), target.target, { to, code: "222222" }),
    ).rejects.toThrow(/queued for review/);
    expect(await sentTo(to)).toEqual([]);
  });

  it("is the ordinary kind for the host itself when the message is not the template", async () => {
    await setSignInKind(true);
    const to = `${unique("phish")}@outside.test`;
    const mail = codeMail(to);
    const result = await integrations.callAsHost?.({
      connectionId,
      resource: ((await customerCodeTarget(db.query)) as { target: { resource: string } }).target
        .resource,
      method: "send",
      args: [{ ...mail, text: `${mail.text}\n\nSign in at https://evil.test` }],
      purpose: "sign-in",
      origin: "system.customer-mail",
    });
    expect(result?.applied).toEqual([]);
    expect(await kindOf((result?.pending[0] as { actionId: string }).actionId)).toBe("fake.send");
  });

  it("is refused for another method or an origin that is not the host's sign-in mail", async () => {
    const resource = ((await customerCodeTarget(db.query)) as { target: { resource: string } })
      .target.resource;
    const base = { connectionId, resource, purpose: "sign-in" as const };
    await expect(
      integrations.callAsHost?.({
        ...base,
        method: "listSent",
        args: [],
        origin: "system.staff-mail",
      }),
    ).rejects.toThrow(/one send/);
    await expect(
      integrations.callAsHost?.({
        ...base,
        method: "send",
        args: [codeMail("x@outside.test")],
        origin: "system.digest" as never,
      }),
    ).rejects.toThrow(/Not an origin/);
  });

  it("does not wait behind a send still waiting for review", async () => {
    await setSignInKind(true);
    // An MCP client's send waits for review (as an invite notice may).
    const waiting = await op<{ pending: unknown[] }>(
      admin,
      "integration.call",
      {
        connectionId,
        resource: "OUTBOX",
        method: "send",
        args: [{ to: ["someone@outside.test"], subject: "An invite", text: "Hello" }],
      },
      { actor: "mcp", origin: { surface: "mcp", sessionId: `cap_${unique("w")}`, clientId: "c" } },
    );
    expect(waiting.pending).toHaveLength(1);
    const target = await customerCodeTarget(db.query);
    if ("problem" in target) throw new Error(target.problem);
    const to = `${unique("after")}@outside.test`;
    await sendCustomerCode(signInMailCall(integrations, "system.staff-mail"), target.target, {
      to,
      code: "333333",
    });
    expect(await sentTo(to)).toHaveLength(1);
  });
});
