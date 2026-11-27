// A new cos-app isolate's check of the shipped extensions (issue #558): when the last install
// finished and nothing has changed since, `installShipped` is one read of the client's database,
// with no call to the workspace object and no install (shipped-stamp.ts). The real runner, the
// real workspace object and Worker Loader, on a fresh database: a single-client deployment, whose
// packs are still installed on first use.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { SHIPPED_STAMP_KEY } from "../src/extensions/shipped-stamp.ts";
import { ClientRunner } from "../src/index.ts";
import { createAdmin } from "./helpers.ts";

/** This deployment with no workspace object or Worker Loader: any install work throws. */
const withoutWorkspace = (): Env => {
  const refuse = () => {
    throw new Error("the workspace object was called");
  };
  return {
    ...env,
    EXTENSION_WORKSPACE: { getByName: refuse, get: refuse, idFromName: refuse } as never,
    LOADER: { get: refuse, load: refuse } as never,
  };
};

const outcomes = (results: { id: string; outcome: string }[]) =>
  Object.fromEntries(results.map((r) => [r.id, r.outcome]));

const stamp = () =>
  env.DB.prepare("SELECT value FROM core_meta WHERE key = ?").bind(SHIPPED_STAMP_KEY).first();

beforeAll(async () => {
  await createAdmin();
});

describe("installShipped's record of the last install", () => {
  it("installs a single-client deployment's packs on first use, and records it", async () => {
    const results = await new ClientRunner(env, env).installShipped();
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.outcome === "installed")).toBe(true);
    expect(results.some((r) => r.outcome === "failed")).toBe(false);
    expect(await stamp()).not.toBeNull();
  });

  it("answers from one read once they are installed: no workspace call, no install", async () => {
    const before = outcomes(await new ClientRunner(env, env).installShipped());
    const after = await new ClientRunner(withoutWorkspace(), env).installShipped();
    expect(outcomes(after)).toEqual(before);
    expect(Object.values(before)).not.toContain("installed");
  });

  it("installs again when the extensions table changed since (an admin's rollback)", async () => {
    const { results } = await env.DB.prepare(
      "SELECT id FROM core_extensions WHERE source = 'shipped' ORDER BY id LIMIT 1",
    ).all<{ id: string }>();
    const id = results[0]?.id as string;
    await env.DB.prepare("UPDATE core_extensions SET commit_oid = 'rolled-back' WHERE id = ?")
      .bind(id)
      .run();
    // The record no longer matches: the full path runs, and needs the workspace object.
    await expect(new ClientRunner(withoutWorkspace(), env).installShipped()).rejects.toThrow(
      "the workspace object was called",
    );
    const reinstalled = await new ClientRunner(env, env).installShipped();
    expect(outcomes(reinstalled)[id]).toBe("installed");
    // And recorded again.
    const again = await new ClientRunner(withoutWorkspace(), env).installShipped();
    expect(outcomes(again)[id]).toBe("unchanged");
  });

  it("installs again when the list changed (another COS_PACKS)", async () => {
    const other = { ...withoutWorkspace(), COS_PACKS: "ticketing" };
    await expect(new ClientRunner(other, env).installShipped()).rejects.toThrow(
      "the workspace object was called",
    );
  });

  it("records nothing when an install failed, so the next one tries again", async () => {
    const { results } = await env.DB.prepare(
      "SELECT id FROM core_extensions WHERE source = 'shipped' ORDER BY id LIMIT 1",
    ).all<{ id: string }>();
    const id = results[0]?.id as string;
    await env.DB.prepare("UPDATE core_extensions SET commit_oid = 'rolled-back' WHERE id = ?")
      .bind(id)
      .run();
    // The pack's own install fails (no Worker Loader to check it with): no record is written.
    const noLoader = { ...env, LOADER: withoutWorkspace().LOADER };
    const failed = await new ClientRunner(noLoader, env).installShipped();
    expect(outcomes(failed)[id]).toBe("failed");
    await expect(new ClientRunner(withoutWorkspace(), env).installShipped()).rejects.toThrow(
      "the workspace object was called",
    );
    expect(outcomes(await new ClientRunner(env, env).installShipped())[id]).toBe("installed");
  });
});
