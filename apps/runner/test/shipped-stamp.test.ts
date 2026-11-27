// A new cos-app isolate's check of the shipped extensions (issue #558): when the last install
// finished and nothing has changed since, `installShipped` is one read of the client's database
// and one check that the workspace object holds the recorded commits, with no install
// (shipped-stamp.ts). The real runner, the
// real workspace object and Worker Loader, on a fresh database: a single-client deployment, whose
// packs are still installed on first use.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { HOST_ONLY_META } from "@composable-os/db/sql-export";
import { beforeAll, describe, expect, it } from "vitest";
import { SHIPPED_STAMP_KEY } from "../src/extensions/shipped-stamp.ts";
import Runner, { ClientRunner } from "../src/index.ts";
import { createAdmin } from "./helpers.ts";

/**
 * This deployment with a workspace object that answers only `holdsShipped` (the fast path's one
 * check) and no Worker Loader: any install work throws.
 */
const withoutWorkspace = (): Env => {
  const refuse = () => {
    throw new Error("the workspace object was called");
  };
  const getByName = (name: string) => {
    const real = env.EXTENSION_WORKSPACE.getByName(name);
    return {
      holdsShipped: (commits: { id: string; commit: string }[]) => real.holdsShipped(commits),
      shipped: refuse,
      commitShipped: refuse,
    };
  };
  return {
    ...env,
    EXTENSION_WORKSPACE: { getByName, get: refuse, idFromName: refuse } as never,
    LOADER: { get: refuse, load: refuse } as never,
  };
};

/** This deployment as another host sees it: the same database, a workspace object of its own. */
const onAnotherHost = (): Env => ({
  ...env,
  EXTENSION_WORKSPACE: {
    getByName: (name: string) => env.EXTENSION_WORKSPACE.getByName(`${name}-another-host`),
  } as never,
});

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

  it("installs again where the workspace object does not hold the recorded commits (a copied database, review of #559 M1)", async () => {
    await new ClientRunner(env, env).installShipped();
    expect(await stamp()).not.toBeNull();
    // The database on another host, its record with it (as an older export carried it).
    const there = onAnotherHost();
    await new ClientRunner(there, env).installShipped();
    // Every shipped pack's code is there at its installed commit. (Its outcome may be
    // `unchanged`: a commit made in the same second with the same identity has the same id.)
    const { results: rows } = await env.DB.prepare(
      "SELECT id, commit_oid FROM core_extensions WHERE source = 'shipped'",
    ).all<{ id: string; commit_oid: string }>();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const files = await there.EXTENSION_WORKSPACE.getByName("workspace").files(
        row.id,
        row.commit_oid,
      );
      expect(Object.keys(files).length, row.id).toBeGreaterThan(0);
    }
  });

  it("keeps an install going after its caller has gone (the runner's own waitUntil)", async () => {
    const ctx = createExecutionContext();
    const kept: Promise<unknown>[] = [];
    const waitUntil = ctx.waitUntil.bind(ctx);
    ctx.waitUntil = (work: Promise<unknown>) => {
      kept.push(work);
      waitUntil(work);
    };
    await new Runner(ctx, env).installShipped();
    expect(kept).toHaveLength(1);
    await waitOnExecutionContext(ctx);
  });

  it("is a record exports leave out and imports delete", () => {
    expect(HOST_ONLY_META).toContain(SHIPPED_STAMP_KEY);
  });
});
