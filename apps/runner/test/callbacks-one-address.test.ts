// Stage 66 step 6 (ADR 0616): gatekeeper callbacks on one address per deployment. Every client's
// OAuth redirects arrive on one hostname of the fleet's domain, so what the callback carries must
// say which client's connection it is for, be unguessable, single use and verified before
// anything acts, and a callback carrying client A's state must never act on client B.
//
// The host chooses no client from a callback: the gatekeeper checks the state (here the fake
// gatekeeper's account object id and its single-use nonce) against what it stored when that
// connection's own integration host started the flow, and then acts only through the capability
// that integration host gave it. On a many-client host the integration host of each client's
// connection is its own object (its name carries the client, step 4); here two connections, one
// for each of two clients, each started from that client's own address.
import { env, exports } from "cloudflare:workers";
import { type ActingUser, type IntegrationRuntime, invokeByName } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { blobStore, integrationRuntime } from "../src/integrations/runtime.ts";
import { createAdmin, createMember, db } from "./helpers.ts";

const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};

/** The one callback address of the deployment, for every client. */
const CALLBACK = "https://callbacks.fleet.example";
const ORIGIN = { a: "https://gym-a-admin.fleet.example", b: "https://gym-b-admin.fleet.example" };

/** The runtime as client `which`'s app reaches it: its own address added to connect flows. */
function runtimeFrom(origin: string): IntegrationRuntime {
  const base = integrationRuntime(env);
  return {
    ...base,
    startConnect: (input) => base.startConnect({ ...input, appOrigin: origin }),
  };
}

let admin: ActingUser;
let member: ActingUser;

function op<T>(user: ActingUser, origin: string, name: string, input: unknown) {
  return invokeByName(name, input, {
    actor: "human" as const,
    user,
    origin: { surface: "ui" as const },
    db,
    integrations: runtimeFrom(origin),
    blobs: blobStore(env),
  }) as Promise<T>;
}

interface Started {
  connection: { id: string; status: string };
  connect: { url: string; nonce: string };
}

/** The consent page and its answer, on the one callback address; the handoff's ticket and target. */
async function consentAt(path: string, address: string) {
  const page = await runner.gatekeeperFetch("fake", new Request(`${CALLBACK}${path}`));
  if (page.status !== 200) return { status: page.status, ticket: "", target: "" };
  const done = await runner.gatekeeperFetch(
    "fake",
    new Request(`${CALLBACK}${path}`, { method: "POST", body: new URLSearchParams({ address }) }),
  );
  const html = await done.text();
  const match = /var ticket = "([^"]+)";\s*var target = "([^"]+)"/.exec(html);
  return { status: done.status, ticket: match?.[1] ?? "", target: match?.[2] ?? "" };
}

/** `/gatekeeper/fake/connect/<account object id>/<nonce>`: the fake's state, in its path. */
function stateOf(url: string): { account: string; nonce: string } {
  const [, , , , account, nonce] = url.split("/");
  return { account: account as string, nonce: nonce as string };
}

beforeAll(async () => {
  admin = await createAdmin();
  member = await createMember();
  await op(admin, ORIGIN.a, "integration.setVendor", { vendor: "fake", enabled: true });
});

describe("gatekeeper callbacks on one address", () => {
  it("act only on the connection whose state they carry, handing back to that client's address", async () => {
    const a = await op<Started>(member, ORIGIN.a, "connection.create", {
      vendor: "fake",
      scope: "personal",
    });
    const b = await op<Started>(member, ORIGIN.b, "connection.create", {
      vendor: "fake",
      scope: "personal",
    });
    // Each state is unguessable: a 256-bit object id and a fresh 144-bit nonce, never the same.
    const sa = stateOf(a.connect.url);
    const sb = stateOf(b.connect.url);
    expect(sa.account).toMatch(/^[0-9a-f]{64}$/);
    // 18 random bytes (144 bits), base64url.
    expect(sa.nonce).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(sa.account).not.toBe(sb.account);
    expect(sa.nonce).not.toBe(sb.nonce);

    // Client A's state, mixed with client B's nonce, acts on nothing.
    const mixed = await consentAt(
      `/gatekeeper/fake/connect/${sa.account}/${sb.nonce}`,
      "x@fake.test",
    );
    expect(mixed.status).toBeGreaterThanOrEqual(400);

    // A's callback arrives on the one address and hands back to A's own address, with a ticket
    // for A's connection only.
    const done = await consentAt(a.connect.url, "a@fake.test");
    expect(done.target).toBe(ORIGIN.a);
    expect(done.ticket.startsWith(`${a.connection.id}.`)).toBe(true);

    // B's own callback, on the same address, hands back to B's address with a ticket for B.
    const doneB = await consentAt(b.connect.url, "b@fake.test");
    expect(doneB.target).toBe(ORIGIN.b);
    expect(doneB.ticket.startsWith(`${b.connection.id}.`)).toBe(true);

    // A's ticket does nothing to B's connection, even with B's own nonce: it is refused, and the
    // refusal ends B's flow (fail closed) without B ever holding A's account.
    await expect(
      op(member, ORIGIN.b, "connection.completeConnect", {
        connectionId: b.connection.id,
        ticket: done.ticket,
        nonce: b.connect.nonce,
      }),
    ).rejects.toThrow();
    // A's connection completes with A's ticket and the nonce A's own window holds.
    const completed = await op<{ connection: { status: string; accountLabel: string } }>(
      member,
      ORIGIN.a,
      "connection.completeConnect",
      { connectionId: a.connection.id, ticket: done.ticket, nonce: a.connect.nonce },
    );
    expect(completed.connection).toMatchObject({ status: "active", accountLabel: "a@fake.test" });

    // Single use: A's state again does nothing.
    const replay = await runner.gatekeeperFetch("fake", new Request(`${CALLBACK}${a.connect.url}`));
    expect(replay.status).toBe(410);

    // B's connection never became active with A's account.
    const listed = await op<{
      items: { id: string; status: string; accountLabel: string | null }[];
    }>(member, ORIGIN.b, "connection.list", { scope: "mine" });
    const bNow = listed.items.find((c) => c.id === b.connection.id);
    expect(bNow?.status).not.toBe("active");
    expect(bNow?.accountLabel).not.toBe("a@fake.test");
  });
});
