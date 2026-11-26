// The proof's own probes (review of PR #507, S8 and S1), run with those of
// @composable-os/db/testing/conformance: behaviours most likely to differ between D1 and a
// Durable Object on Cloudflare, where they are different services. Locally both are SQLite in a
// Durable Object, so none differs here. `read-over-32mib`, on the allow-list until stage 66 step 2,
// is now answered as D1 answers it (ADR 0614: an answer over one call is held and fetched in
// parts); the allow-list (conformance-allow.json) is empty.
import {
  dropProbeTables,
  PROBES,
  type Probe,
  type ProbeAnswer,
  runProbe,
} from "@composable-os/db/testing/conformance";
import allow from "../conformance-allow.json";

export const EXTRA_PROBES: Probe[] = [
  {
    name: "number-binding",
    about:
      "how a bound JS integer, float, boolean and integer past 2^53 are typed (no column affinity)",
    async run(db) {
      return (
        db
          .prepare(
            "SELECT typeof(?1) AS t_int, ?1 / 2 AS half_int, json_array(?1) AS j_int, typeof(?2) AS t_float, json_array(?2) AS j_float, typeof(?3) AS t_bool, typeof(?4) AS t_big, ?4 AS big, ?1 = 42 AS eq_int",
          )
          // 2^53 + 2: past 2^53, and exact as a double.
          .bind(42, 1.5, true, 2 ** 53 + 2)
          .first()
      );
    },
  },
  {
    name: "trigger-raise",
    about:
      "a trigger's RAISE(ABORT, …) error text (errors.ts matches on core_order_stale and others)",
    async run(db, t) {
      const name = t("raise");
      await db.batch([
        db.prepare(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, v INTEGER)`),
        db.prepare(
          `CREATE TRIGGER ${name}_guard BEFORE INSERT ON ${name} WHEN new.v < 0 BEGIN SELECT RAISE(ABORT, 'core_order_stale'); END`,
        ),
      ]);
      return db.prepare(`INSERT INTO ${name} (v) VALUES (-1)`).run();
    },
  },
  {
    name: "json-more",
    about: "json_tree, json_group_object, -> and json_set (JSON1 as the host uses it)",
    async run(db) {
      return db
        .prepare(
          "SELECT (SELECT count(*) FROM json_tree(?1)) AS nodes, (SELECT json_group_object(key, value) FROM json_each(?1)) AS obj, ?1 -> '$.b' AS b, json_set(?1, '$.c', 3) AS set_c",
        )
        .bind('{"a":1,"b":[1,2]}')
        .first();
    },
  },
  {
    name: "sqlite-version",
    about: "the SQLite version each service runs",
    async run(db) {
      return db.prepare("SELECT sqlite_version() AS v").first();
    },
  },
  {
    name: "batch-in-parts",
    about: "a batch of about 11 MB (sent in parts by ClientDb), all or nothing, then applied",
    async run(db, t) {
      const name = t("parts");
      await db.prepare(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, v TEXT)`).run();
      const value = "x".repeat(1_900_000);
      const insert = (id: number) =>
        db.prepare(`INSERT INTO ${name} VALUES (?, ?)`).bind(id, value);
      let refused: string | null = null;
      try {
        await db.batch([1, 2, 3, 1].map(insert));
      } catch (error) {
        refused = (error as Error).message;
      }
      const after = await db.prepare(`SELECT count(*) AS n FROM ${name}`).first("n");
      await db.batch([1, 2, 3].map(insert));
      const applied = await db.prepare(`SELECT count(*) AS n FROM ${name}`).first("n");
      return { refused, after, applied };
    },
  },
  {
    name: "read-over-32mib",
    about: "a result of 40 rows of 1 MB (over Workers RPC's 32 MiB a call)",
    async run(db, t) {
      const name = t("bigread");
      await db.prepare(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, v TEXT)`).run();
      for (let i = 0; i < 40; i += 1) {
        await db.prepare(`INSERT INTO ${name} VALUES (?, ?)`).bind(i, "y".repeat(1_000_000)).run();
      }
      const { results } = await db.prepare(`SELECT * FROM ${name}`).all();
      return results.length;
    },
  },
];

/** Probes whose answers may differ, each with the reason; anything else differing fails the run. */
export const ALLOWED_DIFFERENCES: Record<string, string> = allow;

export interface Compared {
  name: string;
  about: string;
  same: boolean;
  allowed: string | null;
  d1: ProbeAnswer;
  clientDb: ProbeAnswer;
}

/** Every probe, the platform's and the proof's, on both databases. */
export async function compareAll(d1: D1Database, clientDb: D1Database): Promise<Compared[]> {
  const prefix = `p${Date.now().toString(36)}`;
  const out: Compared[] = [];
  try {
    for (const probe of [...PROBES, ...EXTRA_PROBES]) {
      const a = await runProbe(probe, d1, prefix);
      const b = await runProbe(probe, clientDb, prefix);
      const same = JSON.stringify(a) === JSON.stringify(b);
      out.push({
        name: probe.name,
        about: probe.about,
        same,
        allowed: same ? null : (ALLOWED_DIFFERENCES[probe.name] ?? null),
        d1: a,
        clientDb: b,
      });
    }
  } finally {
    await dropProbeTables(d1, prefix);
    await dropProbeTables(clientDb, prefix);
  }
  return out;
}
