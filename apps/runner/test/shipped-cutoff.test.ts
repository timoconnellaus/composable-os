// An install of the shipped extensions cut off part way (issue #558): Cloudflare cancels an
// install that outlives its request (waitUntil's 30 s), so a client with many packs may need more
// than one try. Each extension's install commits on its own, so the next try leaves the ones
// already done as they are and installs the rest; no record is written until one finishes.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { shippedExtensions } from "../src/extensions/shipped-list.ts";
import { SHIPPED_STAMP_KEY } from "../src/extensions/shipped-stamp.ts";
import { ClientRunner } from "../src/index.ts";
import { createAdmin } from "./helpers.ts";

/** This deployment, with the workspace object's commit of `id` never answering: a cut-off. */
function cutOffAt(id: string): Env {
  const namespace = env.EXTENSION_WORKSPACE;
  const getByName = (name: string) => {
    const stub = namespace.getByName(name);
    return new Proxy(stub, {
      get(target, property) {
        if (property === "commitShipped") {
          return (shippedId: string) =>
            shippedId === id ? new Promise(() => {}) : target.commitShipped(shippedId);
        }
        // Every other method as the real object answers it (an RPC stub's methods are not bound).
        const methods = target as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>;
        return (...args: unknown[]) => methods[property]?.(...args);
      },
    });
  };
  return { ...env, EXTENSION_WORKSPACE: { ...namespace, getByName } as never };
}

const installed = async () =>
  (
    await env.DB.prepare(
      "SELECT id FROM core_extensions WHERE source = 'shipped' ORDER BY id",
    ).all<{
      id: string;
    }>()
  ).results.map((r) => r.id);

beforeAll(async () => {
  await createAdmin();
});

describe("an install cut off part way", () => {
  it("is finished by the next try, which installs only what is left", async () => {
    const packs = (await shippedExtensions({ COS_PACKS: "*" })).filter((p) => !p.optional);
    expect(packs.length).toBeGreaterThanOrEqual(2);
    const [first, second] = packs.map((p) => p.id) as [string, string];
    // The first try installs the first pack, then never comes back from the second.
    void new ClientRunner(cutOffAt(second), env).installShipped();
    for (let i = 0; i < 200 && !(await installed()).includes(first); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await installed()).toEqual([first]);
    expect(
      await env.DB.prepare("SELECT value FROM core_meta WHERE key = ?")
        .bind(SHIPPED_STAMP_KEY)
        .first(),
    ).toBeNull();
    // The next try: the first is left as it is, the rest installed, and the install recorded.
    const results = Object.fromEntries(
      (await new ClientRunner(env, env).installShipped()).map((r) => [r.id, r.outcome]),
    );
    expect(results[first]).toBe("unchanged");
    for (const id of packs.slice(1).map((p) => p.id)) expect(results[id]).toBe("installed");
    expect(
      await env.DB.prepare("SELECT value FROM core_meta WHERE key = ?")
        .bind(SHIPPED_STAMP_KEY)
        .first(),
    ).not.toBeNull();
  });
});
