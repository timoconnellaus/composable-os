// The gatekeeper on a host of many clients (`SENDER_DOMAINS_PER_CLIENT`, stage 66; ADR 0616,
// "Email sending per client"): a sender is allowed only on the domains the host gives for the
// client, at bind, at send and at apply; the deployment's ALLOWED_SENDER_DOMAINS is never read;
// no domains, a malformed answer or another domain refuses, and nothing is sent.
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assertSenderOfClient,
  clientSenderDomains,
  NO_CLIENT_SENDER_DOMAINS,
  sendsPerClient,
} from "../src/sender";
import type { EmailSendReceipt } from "../src/types";
import { resetFakes, sentEmails, submissions } from "./fakes";

// A sender at a domain the deployment's list allows (vitest.config.ts: example.com), which on a
// host of many clients is no client's unless the host says so.
const SENDER_URL = "email-send://sender/crm%40example.com";
const external = { to: ["buyer@customer.test"], subject: "Your quote", text: "Hi." };

let seq = 0;
async function host(domains?: unknown) {
  seq += 1;
  const stub = env.TEST_HOST.getByName(`per-client-${seq}-${crypto.randomUUID()}`);
  await stub.open(SENDER_URL, { perClient: domains === undefined ? {} : { domains } });
  return stub;
}
const send = async (h: Awaited<ReturnType<typeof host>>) =>
  (await h.call("send", [external])) as EmailSendReceipt;

beforeEach(resetFakes);

describe("the client's sender domains", () => {
  it("are read only from a list of plain domains, never guessed", () => {
    expect(sendsPerClient({ SENDER_DOMAINS_PER_CLIENT: "true" })).toBe(true);
    expect(sendsPerClient({ SENDER_DOMAINS_PER_CLIENT: "" })).toBe(false);
    expect(sendsPerClient({})).toBe(false);
    expect(clientSenderDomains(["gym-a.example", "mail.gym-a.example"])).toEqual([
      "gym-a.example",
      "mail.gym-a.example",
    ]);
    for (const bad of [
      "gym-a.example",
      ["Gym-A.example"],
      ["gym-a.example,gym-b.example"],
      [""],
      [1],
      null,
      { 0: "gym-a.example" },
    ]) {
      expect(clientSenderDomains(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(() => assertSenderOfClient("crm@gym-a.example", null)).toThrow(NO_CLIENT_SENDER_DOMAINS);
    expect(() => assertSenderOfClient("crm@gym-a.example", [])).toThrow(NO_CLIENT_SENDER_DOMAINS);
    // Exactly the domain: not one under it, nor one over it.
    expect(() => assertSenderOfClient("crm@mail.gym-a.example", ["gym-a.example"])).toThrow(
      /not one of this business's verified sender domains \(gym-a.example\)/,
    );
    expect(() => assertSenderOfClient("crm@gym-a.example", ["mail.gym-a.example"])).toThrow();
    assertSenderOfClient("crm@GYM-A.example", ["gym-a.example"]);
  });
});

describe("binding a sender", () => {
  type Account = {
    getGatekeeperClassFor(url: string, options?: unknown): Promise<{ resource: unknown }>;
    startResourceConfigurator(
      pattern: string,
    ): Promise<{ ui: { allowedDomains(): Promise<string[]> } }>;
  };
  const account = () =>
    (exports as unknown as Record<string, (o: object) => Account>).PerClientEmailSendAccount?.(
      {},
    ) as Account;

  it("allows a sender on one of the client's domains only", async () => {
    await expect(
      account().getGatekeeperClassFor("email-send://sender/crm%40gym-a.example", {
        senderDomains: ["gym-a.example"],
      }),
    ).resolves.toMatchObject({ resource: { urlPattern: "email-send://sender/:address" } });
    // Another client's domain, or the deployment's list (example.com), with these domains.
    for (const url of [
      "email-send://sender/crm%40gym-b.example",
      "email-send://sender/crm%40example.com",
    ]) {
      await expect(
        account().getGatekeeperClassFor(url, { senderDomains: ["gym-a.example"] }),
      ).rejects.toThrow(/not one of this business's verified sender domains/);
    }
  });

  it("refuses with no domains, whatever the deployment's list says", async () => {
    for (const options of [undefined, {}, { senderDomains: [] }, { senderDomains: "example.com" }]) {
      await expect(
        account().getGatekeeperClassFor(SENDER_URL, options),
        JSON.stringify(options),
      ).rejects.toThrow(/no verified sender domain/);
    }
  });

  it("offers no domain of the deployment's in the configurator (the host answers the client's)", async () => {
    const { ui } = await account().startResourceConfigurator("email-send://sender/:address");
    expect(await ui.allowedDomains()).toEqual([]);
  });
});

describe("sending", () => {
  it("queues a send from one of the client's domains, as the host answers them", async () => {
    const h = await host(["example.com"]);
    expect(await send(h)).toEqual({ status: "pending", id: 1 });
    expect(submissions).toHaveLength(1);
  });

  it("refuses a send when the host gives no domain, another domain, or anything else", async () => {
    // The method missing (a queue of a single-client host), an empty list, another client's
    // domain, a malformed answer: nothing is queued.
    for (const domains of [undefined, [], ["gym-b.example"], "example.com", [42]]) {
      const h = await host(domains);
      await expect(send(h), JSON.stringify(domains)).rejects.toThrow(/Refused/);
    }
    expect(submissions).toEqual([]);
    expect(sentEmails).toEqual([]);
  });
});

describe("applying", () => {
  it("sends only with the client's domains as the host reads them at apply", async () => {
    const h = await host(["example.com"]);
    const { id } = await send(h);
    // The plain apply has no client's domains: refused, and the action stays as it was.
    await expect(h.apply(id)).rejects.toThrow(/applyForClient/);
    await expect(h.applyStoppable(id, {})).rejects.toThrow(/applyForClient/);
    expect(sentEmails).toEqual([]);
    await h.applyForClient(id, { senderDomains: ["example.com"] });
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.from).toBe("crm@example.com");
  });

  it("refuses at apply a domain the client lost since it was queued, and never sends it", async () => {
    for (const input of [
      { senderDomains: [] },
      { senderDomains: ["gym-b.example"] },
      { senderDomains: "example.com" },
      {},
      null,
    ]) {
      resetFakes();
      const h = await host(["example.com"]);
      const { id } = await send(h);
      await expect(h.applyForClient(id, input), JSON.stringify(input)).rejects.toThrow(/Refused/);
      expect(sentEmails).toEqual([]);
      // Refused before anything was sent, so it is settled as failed: applying again sends
      // nothing either.
      await h.applyForClient(id, { senderDomains: ["example.com"] }).catch(() => undefined);
      expect(sentEmails).toEqual([]);
    }
  });

  it("a single-client deployment's facet refuses the many-client apply", async () => {
    seq += 1;
    const h = env.TEST_HOST.getByName(`single-${seq}`);
    await h.open(SENDER_URL);
    const { id } = (await h.call("send", [external])) as EmailSendReceipt;
    await expect(h.applyForClient(id, { senderDomains: ["anything.example"] })).rejects.toThrow(
      /host of many clients only/,
    );
    expect(sentEmails).toEqual([]);
  });
});
