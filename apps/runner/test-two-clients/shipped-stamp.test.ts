// A many-client host's check of each client's packs (issue #558): `installShipped`, called as
// cos-app calls it (`callAs`), installs a client's packs once, records it in that client's own
// database, and then answers from the record; the record names its client, so another client's
// (or a copy of it in another client's database) never matches.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { runnerCallerProps } from "@composable-os/db/client-entries";
import { environmentFor } from "@composable-os/db/client-environment";
import { setUpTwoClients, TWO_CLIENTS } from "@composable-os/db/testing/two-clients";
import { beforeAll, describe, expect, it } from "vitest";
import { SHIPPED_STAMP_KEY } from "../src/extensions/shipped-stamp.ts";
import Runner from "../src/index.ts";

const { a, b } = TWO_CLIENTS;
const TEST_PROPS_KEY = (env as unknown as { COS_PROPS_KEY: string }).COS_PROPS_KEY;

function entry(): Runner {
  const ctx = createExecutionContext();
  Object.assign(ctx, { props: runnerCallerProps(TEST_PROPS_KEY, "live") });
  return new Runner(ctx, env as unknown as Env);
}

const installShipped = (client: string) =>
  entry().callAs(client, "installShipped", []) as Promise<{ id: string; outcome: string }[]>;

async function record(client: string): Promise<{ list: string } | null> {
  const found = await environmentFor(env as unknown as Env, client);
  if (!found.served) throw new Error(`${client} is not served`);
  const row = await found.env.DB.prepare("SELECT value FROM core_meta WHERE key = ?")
    .bind(SHIPPED_STAMP_KEY)
    .first<{ value: string }>();
  return row ? (JSON.parse(row.value) as { list: string }) : null;
}

beforeAll(async () => {
  await setUpTwoClients(env);
  // Both have the Ticketing pack (`cos client add … --setting COS_PACKS=ticketing`): the same
  // list, so only the client tells their records apart (review of #559, S2).
  for (const id of [a.id, b.id]) {
    await (env as unknown as { REGISTRY: D1Database }).REGISTRY.prepare(
      "INSERT INTO registry_settings (client, name, value) VALUES (?, 'COS_PACKS', 'ticketing')",
    )
      .bind(id)
      .run();
  }
});

describe("each client's record of its shipped install", () => {
  it("installs a client's packs once, then answers from its own record", async () => {
    expect(await installShipped(a.id)).toEqual([{ id: "ticketing", outcome: "installed" }]);
    expect(await installShipped(a.id)).toEqual([{ id: "ticketing", outcome: "unchanged" }]);
    expect(await installShipped(b.id)).toEqual([{ id: "ticketing", outcome: "installed" }]);
    const [ofA, ofB] = [await record(a.id), await record(b.id)];
    expect(ofA).not.toBeNull();
    expect(ofB).not.toBeNull();
    // The same packs, the same release: each record still names its own client, so one copied
    // into the other's database would not match.
    expect(ofA?.list).not.toBe(ofB?.list);
  });
});
