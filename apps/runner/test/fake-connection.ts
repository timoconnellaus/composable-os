// Connecting the fake provider as a person does it: create the connection, walk the fake's consent
// page and handoff with an address, then complete it (integrations.test.ts checks each step).
import { exports } from "cloudflare:workers";

const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};

/** Calls an operation as the connection's owner. */
type Call = (name: string, input: unknown) => Promise<unknown>;

/** A connected fake-provider connection signed in as `address`; its id. */
export async function connectFake(
  call: Call,
  address: string,
  scope: "personal" | "org" = "org",
): Promise<string> {
  const created = (await call("connection.create", {
    vendor: "fake",
    scope,
    sharingLevel: "full",
  })) as { connection: { id: string }; connect: { url: string; nonce: string } };
  const url = `http://crm.test${created.connect.url}`;
  await runner.gatekeeperFetch("fake", new Request(url));
  const done = await runner.gatekeeperFetch(
    "fake",
    new Request(url, { method: "POST", body: new URLSearchParams({ address }) }),
  );
  const ticket = /var ticket = "([^"]+)"/.exec(await done.text())?.[1] ?? "";
  await call("connection.completeConnect", {
    connectionId: created.connection.id,
    ticket,
    nonce: created.connect.nonce,
  });
  return created.connection.id;
}
