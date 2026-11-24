// Installing shipped extensions at boot (ADR 0025): one that fails before another it depends on is
// installed gets a second try, and the admins are told only when that fails too.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, type ExtensionHost, installShippedExtensions } from "../src/index.ts";
import { createUser, db } from "./helpers.ts";

let admin: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
});

/** Notices to the admin about `id`. */
async function notices(id: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT title FROM core_notifications WHERE user_id = ? AND title LIKE ?",
  )
    .bind(admin.id, `%${id}%`)
    .all<{ title: string }>();
  return results.map((r) => r.title);
}

describe("shipped extensions at boot", () => {
  it("tells no one of a first try that fails when the second succeeds", async () => {
    const id = "shpretry";
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', '{}', ?, ?, ?)",
    )
      .bind(id, admin.id, now, now)
      .run();
    let tries = 0;
    const host = {
      shipped: async () => [{ id, optional: false }],
      commitShipped: async () => {
        tries += 1;
        if (tries === 1) throw new Error("waits for the extension it depends on");
        return { commit: "c1", changed: false };
      },
    } as unknown as ExtensionHost;
    expect(await installShippedExtensions({ db, host })).toEqual([{ id, outcome: "unchanged" }]);
    expect(tries).toBe(2);
    expect(await notices(id)).toEqual([]);
  });

  it("tells the admins once when both tries fail", async () => {
    const id = "shpfails";
    const host = {
      shipped: async () => [{ id, optional: false }],
      commitShipped: async () => {
        throw new Error("these records do not fit");
      },
    } as unknown as ExtensionHost;
    expect(await installShippedExtensions({ db, host })).toEqual([
      expect.objectContaining({ id, outcome: "failed" }),
    ]);
    expect(await notices(id)).toEqual([`The ${id} extension could not be upgraded`]);
  });
});
