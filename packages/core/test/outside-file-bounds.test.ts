// Stage 65 step 4 (ADR 0923), the file source's bounds on D1: 1,000 statements an invocation, 100
// bound parameters a statement, 5 terms a compound SELECT, 100 result columns. The local runtime
// enforces none of them, so this counts them, for the dry run and the load of a members list at
// two sizes: 3,000 rows (800 members, 300 of them linked) and the largest file the source takes,
// 20,000 rows, every one a member with a membership and every one linking to a Person (the most
// writes a valid file can make). A load is one batch (one transaction); its statements grow with
// the rows by at most one per 100, and the largest file stays under the bound. A file naming more
// than the source takes is refused before anything is planned.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { MAX_PLAN_STATEMENTS } from "../src/outside/ingest.ts";
import { context, createUser, unique } from "./helpers.ts";

let queries = 0;
let maxParams = 0;
let compound = 0;
let maxColumns = 0;

const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        compound = Math.max(
          compound,
          (query.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi) ?? []).length + 1,
        );
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") {
                return (...args: unknown[]) => {
                  maxParams = Math.max(maxParams, args.length);
                  return wrap(s.bind(...args));
                };
              }
              if (p === "all" || p === "run" || p === "first" || p === "raw") {
                return async (...args: unknown[]) => {
                  queries += 1;
                  const out = await (s[p] as (...a: unknown[]) => Promise<unknown>)(...args);
                  const first = (out as { results?: unknown[] })?.results?.[0];
                  if (first && typeof first === "object" && !Array.isArray(first)) {
                    maxColumns = Math.max(maxColumns, Object.keys(first).length);
                  }
                  return out;
                };
              }
              const value = Reflect.get(s, p);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
        return wrap(target.prepare(query));
      };
    }
    if (prop === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        queries += statements.length;
        return target.batch(statements);
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);
const NOW = "2026-11-24T09:00:00.000Z";

function reset() {
  queries = 0;
  maxParams = 0;
  compound = 0;
  maxColumns = 0;
}

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

/** Persons `0 … n-1` with the addresses `p<i>@<tag>.example.com`, written straight in. */
async function persons(tag: string, n: number) {
  const series = `WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i < ${n - 1})`;
  await env.DB.prepare(
    `${series} INSERT INTO core_person (id, display_name, created_at, updated_at) SELECT 'per_' || ?1 || '_' || i, 'Bound ' || i, ?2, ?2 FROM s`,
  )
    .bind(tag, NOW)
    .run();
  await env.DB.prepare(
    `${series} INSERT INTO core_person_emails (id, person_id, email, is_primary, position, created_at) SELECT 'eml_' || ?1 || '_' || i, 'per_' || ?1 || '_' || i, 'p' || i || '@' || ?1 || '.example.com', 1, 0, ?2 FROM s`,
  )
    .bind(tag, NOW)
    .run();
}

function file(tag: string, rows: number, members: number) {
  const lines = ["Client ID,First,Last,E-mail,Plan,Plan status"];
  for (let i = 0; i < rows; i++) {
    const member = i < members;
    lines.push(
      `${tag}-${i},Given${i},Family${i},p${i}@${tag}.example.com,${member ? "Unlimited" : "Casual"},${member ? "Active" : "Ended"}`,
    );
  }
  return b64(lines.join("\n"));
}

let admin: ActingUser;
beforeAll(async () => {
  admin = await createUser("admin");
});

const ctx = () => ({ ...context(admin), db, clock: () => new Date(NOW) });

describe("the file source's bounds", () => {
  it("previews and loads within D1's bounds at two sizes, the largest file included", async () => {
    const cost: { rows: number; preview: number; load: number; plan: number }[] = [];
    for (const [rows, members, linked] of [
      [3_000, 800, 300],
      [20_000, 20_000, 20_000],
    ] as const) {
      const tag = unique("fb").toLowerCase();
      await persons(tag, linked);
      const data = file(tag, rows, members);
      reset();
      const dry = (await invokeByName(
        "outside.file.preview",
        { kind: "members", file: data },
        ctx(),
      )) as { fingerprint: string; statements: number; outcome: { kept: number; linked: number } };
      const preview = queries;
      expect(dry.outcome).toMatchObject({ kept: members, linked });
      expect(maxParams).toBeLessThanOrEqual(100);
      expect(compound).toBeLessThanOrEqual(5);
      expect(maxColumns).toBeLessThanOrEqual(100);
      reset();
      await invokeByName(
        "outside.file.load",
        { kind: "members", file: data, fingerprint: dry.fingerprint },
        ctx(),
      );
      const load = queries;
      expect(maxParams).toBeLessThanOrEqual(100);
      expect(compound).toBeLessThanOrEqual(5);
      expect(maxColumns).toBeLessThanOrEqual(100);
      cost.push({ rows, preview, load, plan: dry.statements });
      expect(
        (
          await env.DB.prepare(
            "SELECT count(*) AS n FROM core_outside_person WHERE ref LIKE ? AND person_id IS NOT NULL",
          )
            .bind(`${tag}-%`)
            .first<{ n: number }>()
        )?.n,
      ).toBe(linked);
    }
    for (const c of cost) {
      // The plan within its own bound, and the whole call (its reads, the plan, the audit) under
      // D1's 1,000.
      expect(c.plan, `${c.rows}`).toBeLessThanOrEqual(MAX_PLAN_STATEMENTS);
      expect(c.load, `${c.rows}`).toBeLessThan(1_000);
      expect(c.preview, `${c.rows}`).toBeLessThan(60);
      // Reads do not grow with the file: the load is its reads, its plan and the audit.
      expect(c.load - c.plan, `${c.rows}`).toBeLessThan(60);
    }
    // The 3,000-row fixture is within the spec's 250 (acceptance criterion 11).
    expect(cost[0]?.load).toBeLessThanOrEqual(250);
  }, 300_000);

  it("refuses a file naming more than the source takes before anything is planned", async () => {
    const tag = unique("fx").toLowerCase();
    const lines = ["E-mail,Plan"];
    for (let i = 0; i < 600; i++) lines.push(`x${i}@${tag}.example.com,Plan number ${i}`);
    reset();
    const e = await invokeByName(
      "outside.file.preview",
      { kind: "members", file: b64(lines.join("\n")) },
      ctx(),
    ).catch((error: { code: string; message: string }) => error);
    expect(e).toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/more than 500 membership types/),
    });
    expect(queries).toBeLessThan(15);
  });
});
