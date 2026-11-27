// Email sending per client on one runner (stage 66; ADR 0616, "Email sending per client"): the
// real email-send gatekeeper, as a many-client deployment runs it (SENDER_DOMAINS_PER_CLIENT),
// behind each client's own integration host. A client sends only from its own verified sender
// domains, read from its environment (the registry's rows, never a caller's argument): gym-a from
// mail.gym-a.test; never from gym-b's, nor from gym-b's unverified one, nor from the deployment's
// list; a client with none is refused; a sign-in code, an invite and a notification for gym-a are
// from gym-a's domain with gym-a's links; and nothing of gym-b's is in gym-a's mail or its stored bodies.
import { env } from "cloudflare:test";
import {
  type ActingUser,
  customerCodeEmail,
  customerCodeTarget,
  hostMailCall,
  type InvocationContext,
  invokeByName,
  newId,
  notifyStatements,
  STAFF_MAIL_ORIGIN,
  sendCustomerCode,
  sendEmail,
  signInMailCall,
  staffInviteEmail,
} from "@composable-os/core";
import { CORE_SCHEMA_VERSION, createCrmDb, type Migration } from "@composable-os/db";
import type { ClientDb } from "@composable-os/db/client-db";
import { gatekeeperOffered } from "@composable-os/db/client-entries";
import { environmentFor, REGISTRY_REFRESH_MS } from "@composable-os/db/client-environment";
import type { ClientId } from "@composable-os/db/registry";
import {
  addSenderDomain,
  listSenderDomains,
  verifySenderDomain,
} from "@composable-os/db/registry-senders";
import {
  addClientRows,
  recordSchemaVersion,
  removeClientRows,
  setClientStatus,
} from "@composable-os/db/registry-writes";
import {
  SENDER_DOMAINS,
  setUpTwoClients,
  TWO_CLIENTS,
} from "@composable-os/db/testing/two-clients";
import { beforeAll, describe, expect, it } from "vitest";
import { inClientScope } from "../src/client-scope.ts";
import { extensionHost } from "../src/index.ts";
import { availableVendors, integrationRuntime } from "../src/integrations/runtime.ts";
import { clientSenderDomains, senderOptions } from "../src/integrations/senders.ts";
import { runNotificationCron } from "../src/notifications/deliver.ts";

const { a, b } = TWO_CLIENTS;
const host = env as unknown as Env & {
  REGISTRY: D1Database;
  TEST_EMAIL_OUTBOX: { list(): Promise<OutboxMessage[]> };
};

interface OutboxMessage {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}

/** A fresh `env` object, so a fresh directory reads the registry now (hostDirectory is per env). */
const freshHost = () => ({ ...host }) as unknown as Env;

async function clientEnv(id: string, from: Env = host): Promise<Env> {
  const found = await environmentFor(from, id);
  if (!found.served) throw new Error(`no environment for ${id}`);
  return found.env;
}

async function adminIn(clientEnvironment: Env): Promise<ActingUser> {
  const id = newId("user");
  const email = `admin-${id}@staff.test`;
  const now = new Date().toISOString();
  await clientEnvironment.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Admin', ?, 1, ?, ?, 'admin')",
  )
    .bind(id, email, now, now)
    .run();
  return { id, email, name: "Admin", role: "admin" };
}

/** One client's operations, as its staff's calls reach the runner. */
function client(clientEnvironment: Env, admin: ActingUser) {
  const integrations = integrationRuntime(clientEnvironment);
  const ctx = (): InvocationContext => ({
    actor: "human",
    user: admin,
    origin: { surface: "ui" },
    db: createCrmDb(clientEnvironment.DB),
    integrations,
    extensionHost: extensionHost(clientEnvironment),
  });
  return {
    env: clientEnvironment,
    integrations,
    op: <T>(name: string, input: unknown) => invokeByName(name, input, ctx()) as Promise<T>,
  };
}

type Client = ReturnType<typeof client>;
let clientA: Client;
let clientB: Client;

const senderUrl = (address: string) => `email-send://sender/${encodeURIComponent(address)}`;

async function emailConnection(c: Client): Promise<string> {
  const created = await c.op<{ connection: { id: string } }>("connection.create", {
    vendor: "email-send",
    scope: "org",
  });
  return created.connection.id;
}

const outboxTo = async (to: string) =>
  (await host.TEST_EMAIL_OUTBOX.list()).filter((m) => m.to.includes(to));

let unique = 0;
const someone = (where: string) => `person-${++unique}-${crypto.randomUUID().slice(0, 8)}@${where}`;

beforeAll(async () => {
  await setUpTwoClients(env);
  const aEnv = await clientEnv(a.id);
  const bEnv = await clientEnv(b.id);
  clientA = client(aEnv, await adminIn(aEnv));
  clientB = client(bEnv, await adminIn(bEnv));
  for (const c of [clientA, clientB]) {
    await c.op("integration.setVendor", { vendor: "email-send", enabled: true });
  }
});

describe("each client's sender domains", () => {
  it("are its own verified ones, from the registry, in its environment only", () => {
    expect(clientSenderDomains(clientA.env)).toEqual(["mail.gym-a.test"]);
    // gym-b's unverified domain is held, never used.
    expect(clientSenderDomains(clientB.env)).toEqual(["mail.gym-b.test"]);
    expect(SENDER_DOMAINS.find((d) => !d.verified)?.domain).toBe("news.gym-b.test");
    // A single-client deployment's env has none: its gatekeeper reads its own list.
    expect(clientSenderDomains(host)).toBeNull();
    expect(senderOptions(clientA.env, "google")).toBeNull();
  });

  it("offer email sending to each client that has one", () => {
    for (const c of [clientA, clientB]) {
      expect(gatekeeperOffered(c.env, "GATEKEEPER_EMAIL_SEND")).toEqual({ offered: true });
      expect(availableVendors(c.env)).toContain("email-send");
    }
  });
});

describe("binding a sender", () => {
  it("lets gym-a bind an address at its own domain, and answers its domains in the configurator", async () => {
    const id = await emailConnection(clientA);
    const bound = await clientA.op<{ resource: { url: string } }>("connection.bindResource", {
      id,
      url: senderUrl("hello@mail.gym-a.test"),
    });
    expect(JSON.stringify(bound)).toContain("hello%40mail.gym-a.test");
    expect(
      await clientA.integrations.configure({
        connectionId: id,
        pattern: "email-send://sender/:address",
        method: "allowedDomains",
        args: [],
      }),
    ).toEqual(["mail.gym-a.test"]);
  });

  it("refuses gym-a an address at gym-b's domain, gym-b's unverified one, or the deployment's list", async () => {
    const id = await emailConnection(clientA);
    for (const address of [
      "hello@mail.gym-b.test",
      "hello@news.gym-b.test",
      "hello@everyone.test",
      "hello@sub.mail.gym-a.test",
    ]) {
      await expect(
        clientA.op("connection.bindResource", { id, url: senderUrl(address) }),
        address,
      ).rejects.toThrow(/not one of this business's verified sender domains \(mail\.gym-a\.test\)/);
    }
    // The refusal names gym-a's own domains only, never gym-b's.
    await expect(
      clientA.op("connection.bindResource", { id, url: senderUrl("x@mail.gym-b.test") }),
    ).rejects.not.toThrow(/mail\.gym-b\.test\)/);
  });

  it("refuses gym-b its own domain until it is verified", async () => {
    const id = await emailConnection(clientB);
    await expect(
      clientB.op("connection.bindResource", { id, url: senderUrl("hello@news.gym-b.test") }),
    ).rejects.toThrow(/not one of this business's verified sender domains \(mail\.gym-b\.test\)/);
  });
});

let connectionA: string;

describe("gym-a's mail", () => {
  beforeAll(async () => {
    connectionA = await emailConnection(clientA);
    await clientA.op("connection.bindResource", {
      id: connectionA,
      url: senderUrl("hello@mail.gym-a.test"),
    });
    await clientA.op("customer.settings.update", { emailConnectionId: connectionA });
    // A human admin lets the host's sign-in kind apply (ADR 0456), in gym-a's own database.
    await clientA.op("outbound.setAutoApprove", { tag: "email.signin", enabled: true });
  });

  it("sends a customer's sign-in code from gym-a's domain, with nothing of gym-b's", async () => {
    const target = await customerCodeTarget(createCrmDb(clientA.env.DB).query);
    if ("problem" in target) throw new Error(target.problem);
    const to = someone("customer.test");
    await sendCustomerCode(
      signInMailCall(clientA.integrations, "system.customer-mail"),
      target.target,
      {
        to,
        code: "482913",
      },
    );
    const sent = await outboxTo(to);
    expect(sent).toHaveLength(1);
    const [mail] = sent as [OutboxMessage];
    expect(mail.from).toBe("hello@mail.gym-a.test");
    expect(mail.text).toBe(customerCodeEmail("482913").text);
    expect(mail.replyTo).toBeUndefined();
    expect(JSON.stringify(mail)).not.toMatch(/gym-b/);
  });

  it("sends a staff invite from gym-a's domain with gym-a's own sign-in link, once approved", async () => {
    // As the app's host mail makes it on a many-client host: the link from the client's
    // environment (APP_ORIGIN, its staff hostname), never the request's.
    expect(clientA.env.APP_ORIGIN).toBe(`https://${a.hostname}`);
    const target = await customerCodeTarget(createCrmDb(clientA.env.DB).query);
    if ("problem" in target) throw new Error(target.problem);
    const to = someone("new-staff.test");
    const outcome = await sendEmail(
      hostMailCall(clientA.integrations, "Admin invited a staff member", STAFF_MAIL_ORIGIN),
      target.target,
      { to, ...staffInviteEmail("The CRM", "Admin", `${clientA.env.APP_ORIGIN}/sign-in`) },
    );
    expect(outcome.status).toBe("pending");
    const pending = await clientA.env.DB.prepare(
      "SELECT id FROM core_pending_action WHERE connection_id = ? AND status = 'pending' ORDER BY created_at DESC",
    )
      .bind(connectionA)
      .first<{ id: string }>();
    await clientA.op("approval.approve", { actionIds: [pending?.id] });
    const [mail] = (await outboxTo(to)) as [OutboxMessage];
    expect(mail.from).toBe("hello@mail.gym-a.test");
    expect(mail.text).toContain(`https://${a.hostname}/sign-in`);
    expect(JSON.stringify(mail)).not.toMatch(/gym-b/);
  });
});

describe("gym-a's routine mail", () => {
  it("sends a notification email from gym-a's domain with gym-a's own link, nothing of gym-b's", async () => {
    // The minute cron's delivery tick for gym-a (its fan-out message enters gym-a's scope): the
    // notification's link from gym-a's environment (APP_ORIGIN), its sender gym-a's connection.
    const member = await adminIn(clientA.env);
    await clientA.op("notification.updateDeliverySettings", { email: connectionA });
    await client(clientA.env, member).op("notification.setPreferences", {
      channels: { "system.message": ["email"] },
    });
    const personId = (await clientA.op<{ id: string }>("person.create", { givenName: "Ada" })).id;
    const title = `Notice ${crypto.randomUUID().slice(0, 8)}`;
    await inClientScope(clientA.env, async () => {
      const plan = await notifyStatements(
        createCrmDb(clientA.env.DB).query,
        {
          to: [{ userId: member.id }],
          type: "system.message",
          title,
          body: "From the two-client suite",
          link: { kind: "record", object: "person", id: personId } as never,
          source: { actor: "human", userId: member.id },
        },
        new Date().toISOString(),
      );
      await createCrmDb(clientA.env.DB).batch(plan.statements);
      const report = await runNotificationCron(clientA.env, new Date(Date.now() + 31_000));
      expect(report.notifications).toEqual([{ key: expect.any(String), status: "pending" }]);
    });
    // It waits for review (no internal domains here); approving it sends it.
    const pending = await clientA.env.DB.prepare(
      "SELECT id FROM core_pending_action WHERE connection_id = ? AND status = 'pending'",
    )
      .bind(connectionA)
      .first<{ id: string }>();
    expect(pending?.id).toBeTruthy();
    await clientA.op("approval.approve", { actionIds: [pending?.id] });
    const [mail] = (await outboxTo(member.email)) as [OutboxMessage];
    expect(mail.from).toBe("hello@mail.gym-a.test");
    expect(mail.subject).toContain(title);
    expect(mail.text).toContain(`https://${a.hostname}/people/${personId}`);
    expect(JSON.stringify(mail)).not.toMatch(/gym-b/);
  });
});

describe("gym-b's mail", () => {
  it("goes from gym-b's own domain, never gym-a's", async () => {
    const id = await emailConnection(clientB);
    await clientB.op("connection.bindResource", { id, url: senderUrl("desk@mail.gym-b.test") });
    await clientB.op("customer.settings.update", { emailConnectionId: id });
    await clientB.op("outbound.setAutoApprove", { tag: "email.signin", enabled: true });
    const target = await customerCodeTarget(createCrmDb(clientB.env.DB).query);
    if ("problem" in target) throw new Error(target.problem);
    const to = someone("customer.test");
    await sendCustomerCode(
      signInMailCall(clientB.integrations, "system.customer-mail"),
      target.target,
      {
        to,
        code: "771204",
      },
    );
    const [mail] = (await outboxTo(to)) as [OutboxMessage];
    expect(mail.from).toBe("desk@mail.gym-b.test");
    expect(JSON.stringify(mail)).not.toMatch(/gym-a/);
  });
});

describe("stored email bodies", () => {
  it("are each client's own under the same key: gym-b never reads gym-a's", async () => {
    // A synced body is stored as `email-bodies/<external key>` (packages/core sync/ingest.ts): two
    // clients syncing the same message id write the same key, kept apart by the files wrapper.
    const key = `email-bodies/${encodeURIComponent(`<same-${crypto.randomUUID()}@mail.test>`)}`;
    await clientA.env.BLOBS?.put(key, "gym-a's body");
    expect(await clientB.env.BLOBS?.get(key)).toBeNull();
    await clientB.env.BLOBS?.put(key, "gym-b's body");
    expect(await (await clientA.env.BLOBS?.get(key))?.text()).toBe("gym-a's body");
    expect(await (await clientB.env.BLOBS?.get(key))?.text()).toBe("gym-b's body");
    // Listing the prefix shows each only its own, by its own key.
    const listed = await clientA.env.BLOBS?.list({ prefix: "email-bodies/" });
    expect(listed?.objects.map((o) => o.key)).toContain(key);
    for (const o of listed?.objects ?? []) expect(o.key.startsWith("email-bodies/")).toBe(true);
    // In the one bucket, under each client's own prefix.
    expect(await (await host.BLOBS?.get(`clients/${a.id}/${key}`))?.text()).toBe("gym-a's body");
    expect(await (await host.BLOBS?.get(`clients/${b.id}/${key}`))?.text()).toBe("gym-b's body");
    expect(await host.BLOBS?.get(key)).toBeNull();
    // gym-a cannot climb out of its part to reach gym-b's.
    await expect(clientA.env.BLOBS?.get(`../${b.id}/${key}`) as Promise<unknown>).rejects.toThrow();
  });
});

describe("once the operator unverifies gym-a's only sender domain", () => {
  it("offers gym-a no email sending, and its gatekeeper binds, sends and applies nothing", async () => {
    // Made while gym-a had its domain: a connection with no sender yet, and an invite waiting.
    const unbound = await emailConnection(clientA);
    const target = await customerCodeTarget(createCrmDb(clientA.env.DB).query);
    if ("problem" in target) throw new Error(target.problem);
    const to = someone("later.test");
    await sendEmail(
      hostMailCall(clientA.integrations, "Admin invited a staff member", STAFF_MAIL_ORIGIN),
      target.target,
      { to, ...staffInviteEmail("The CRM", "Admin", `${clientA.env.APP_ORIGIN}/sign-in`) },
    );
    const pending = await clientA.env.DB.prepare(
      "SELECT id FROM core_pending_action WHERE connection_id = ? AND status = 'pending' ORDER BY created_at DESC",
    )
      .bind(connectionA)
      .first<{ id: string }>();
    const domain = "mail.gym-a.test";
    await host.REGISTRY.prepare(
      "UPDATE registry_sender_domains SET verified = 0, verified_at = NULL WHERE domain = ?",
    )
      .bind(domain)
      .run();
    try {
      const none = await clientEnv(a.id, freshHost());
      expect(clientSenderDomains(none)).toEqual([]);
      expect("COS_SENDER_DOMAINS" in none).toBe(false);
      expect(gatekeeperOffered(none, "GATEKEEPER_EMAIL_SEND")).toEqual({
        offered: false,
        why: expect.stringMatching(/no verified sender domain/),
      });
      expect(availableVendors(none)).not.toContain("email-send");
      expect(senderOptions(none, "email-send")).toEqual({ senderDomains: [] });
      // A running host serves a registry change at its next stamp check (REGISTRY_REFRESH_MS):
      // past it, the connections' own objects read gym-a's environment without the domain.
      await new Promise((resolve) => setTimeout(resolve, REGISTRY_REFRESH_MS + 500));
      const later = client(await clientEnv(a.id, freshHost()), await adminIn(none));
      // No sender is bound, from its old domain or the deployment's list.
      for (const address of ["hello@mail.gym-a.test", "hello@everyone.test"]) {
        await expect(
          later.op("connection.bindResource", { id: unbound, url: senderUrl(address) }),
          address,
        ).rejects.toThrow(/no verified sender domain/);
      }
      // No new connection is made.
      await expect(emailConnection(later)).rejects.toThrow(/no verified sender domain/);
      // No new send is queued from the sender already bound.
      await expect(
        sendEmail(
          hostMailCall(later.integrations, "Admin invited a staff member", STAFF_MAIL_ORIGIN),
          target.target,
          { to: someone("later.test"), subject: "Hello", text: "Hello." },
        ),
      ).rejects.toThrow(/no verified sender domain/);
      // And the invite queued before is refused at approval: nothing is sent.
      const decided = await later
        .op<{ results: { status: string; error: unknown }[] }>("approval.approve", {
          actionIds: [pending?.id],
        })
        .catch((error: unknown) => error);
      const said = decided instanceof Error ? decided.message : JSON.stringify(decided);
      expect(said).toMatch(/no verified sender domain/);
      expect(await outboxTo(to)).toEqual([]);
    } finally {
      await host.REGISTRY.prepare(
        "UPDATE registry_sender_domains SET verified = 1, verified_at = '2026-11-27T00:00:00Z' WHERE domain = ?",
      )
        .bind(domain)
        .run();
    }
  }, 40_000);
});

// A client the operator pauses, then removes (ADR 0618, "A fleet's gatekeepers"; issue #529): its
// integration host refuses every send and apply as soon as the registry's change is read, even
// from an environment taken while it was served; a send it queued before is not sent while it is
// paused (once resumed it may be approved again) and never after it is removed. A
// third client of this file's own, added and removed as `cos client add` and `cos client remove`
// write the registry, so gym-a's and gym-b's rows stay as the other tests need them.
describe("a client paused, then removed, by the operator", () => {
  const c = { id: "gym-c-stopped", hostname: "gym-c-stopped.test", domain: "mail.gym-c.test" };
  const bindings = env as unknown as {
    OPERATOR_CLIENT_DB: DurableObjectNamespace<ClientDb>;
    TEST_MIGRATIONS: Migration[];
  };
  /** Past the directory's stamp check: a running host has read the registry's change. */
  const afterRefresh = () =>
    new Promise((resolve) => setTimeout(resolve, REGISTRY_REFRESH_MS + 500));

  let clientC: Client;
  let connectionC: string;

  beforeAll(async () => {
    await addClientRows(host.REGISTRY, {
      id: c.id,
      environment: "live",
      tier: "standard",
      hostnames: [{ hostname: c.hostname, surface: "staff" }],
    });
    const operator = bindings.OPERATOR_CLIENT_DB;
    await operator.get(operator.idFromName(c.id)).migrate(bindings.TEST_MIGRATIONS);
    await recordSchemaVersion(host.REGISTRY, c.id as ClientId, CORE_SCHEMA_VERSION);
    await addSenderDomain(host.REGISTRY, c.id, c.domain);
    await verifySenderDomain(host.REGISTRY, c.id, c.domain);
    await setClientStatus(host.REGISTRY, c.id as ClientId, "active");
    // The runner's objects read the registry at their next stamp check, as a running host does.
    await afterRefresh();
    const cEnv = await clientEnv(c.id, freshHost());
    clientC = client(cEnv, await adminIn(cEnv));
    await clientC.op("integration.setVendor", { vendor: "email-send", enabled: true });
    connectionC = await emailConnection(clientC);
    await clientC.op("connection.bindResource", {
      id: connectionC,
      url: senderUrl(`hello@${c.domain}`),
    });
    await clientC.op("customer.settings.update", { emailConnectionId: connectionC });
    await clientC.op("outbound.setAutoApprove", { tag: "email.signin", enabled: true });
  });

  const signInCode = async (from: Client, to: string) => {
    const target = await customerCodeTarget(createCrmDb(from.env.DB).query);
    if ("problem" in target) throw new Error(target.problem);
    await sendCustomerCode(
      signInMailCall(from.integrations, "system.customer-mail"),
      target.target,
      { to, code: "305118" },
    );
  };

  it("sends from its own domain while served, and never as gym-a", async () => {
    const to = someone("customer.test");
    await signInCode(clientC, to);
    expect((await outboxTo(to)).map((m) => m.from)).toEqual([`hello@${c.domain}`]);
    const id = await emailConnection(clientC);
    await expect(
      clientC.op("connection.bindResource", { id, url: senderUrl("hello@mail.gym-a.test") }),
    ).rejects.toThrow(/not one of this business's verified sender domains \(mail\.gym-c\.test\)/);
  });

  it("sends nothing while paused, a send queued before included, and sends again once resumed", async () => {
    const queuedTo = someone("paused.test");
    const target = await customerCodeTarget(createCrmDb(clientC.env.DB).query);
    if ("problem" in target) throw new Error(target.problem);
    await sendEmail(
      hostMailCall(clientC.integrations, "Admin invited a staff member", STAFF_MAIL_ORIGIN),
      target.target,
      {
        to: queuedTo,
        ...staffInviteEmail("The CRM", "Admin", `${clientC.env.APP_ORIGIN}/sign-in`),
      },
    );
    const pending = await clientC.env.DB.prepare(
      "SELECT id FROM core_pending_action WHERE connection_id = ? AND status = 'pending' ORDER BY created_at DESC",
    )
      .bind(connectionC)
      .first<{ id: string }>();
    expect(pending?.id).toBeTruthy();
    expect(await setClientStatus(host.REGISTRY, c.id as ClientId, "paused")).toBe(true);
    try {
      // No entry serves it: a fresh environment is refused.
      expect(await environmentFor(freshHost(), c.id)).toMatchObject({
        served: false,
        refused: "paused",
      });
      await afterRefresh();
      // From the environment taken while it was served (a warm object, a message in flight): its
      // integration host refuses a new send and the queued one alike.
      const to = someone("paused.test");
      await expect(signInCode(clientC, to)).rejects.toThrow(/not served now \(paused\)/);
      const decided = await clientC
        .op("approval.approve", { actionIds: [pending?.id] })
        .catch((error: unknown) => error);
      const said = decided instanceof Error ? decided.message : JSON.stringify(decided);
      expect(said).toMatch(/not served now \(paused\)/);
      expect(await outboxTo(to)).toEqual([]);
      expect(await outboxTo(queuedTo)).toEqual([]);
    } finally {
      await setClientStatus(host.REGISTRY, c.id as ClientId, "active");
    }
    await afterRefresh();
    const to = someone("resumed.test");
    await signInCode(clientC, to);
    expect((await outboxTo(to)).map((m) => m.from)).toEqual([`hello@${c.domain}`]);
  }, 60_000);

  it("sends nothing once removed, and its sender domain goes with it", async () => {
    await removeClientRows(host.REGISTRY, c.id as ClientId);
    expect((await listSenderDomains(host.REGISTRY)).map((d) => d.domain)).not.toContain(c.domain);
    expect(await environmentFor(freshHost(), c.id)).toMatchObject({
      served: false,
      refused: "unknown",
    });
    await afterRefresh();
    const to = someone("removed.test");
    await expect(signInCode(clientC, to)).rejects.toThrow(/not served now \(unknown\)/);
    expect(await outboxTo(to)).toEqual([]);
  }, 40_000);
});
