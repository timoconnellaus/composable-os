// Stage 66 step 6 (ADR 0616, criterion 10): no operation shows a client's secrets. An env holding
// a known value for every per-client secret name (what a client's environment holds on a
// many-client host: its derived and given secrets) runs every operation that takes no input, as
// an admin, through the UI's pipeline; no output, error or log line holds any of the values,
// and nor does the database afterwards.
import { env } from "cloudflare:workers";
import type { Principal } from "@composable-os/auth";
import { coreRegistry } from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runOperation } from "../src/server/operations.ts";
import { ensureAdmin } from "./helpers.ts";

const admin: Principal = {
  userId: "usr_01JC00000000000000000S66E6",
  email: "s66e-admin@example.com",
  name: "Secrets Admin",
  roles: [],
};

/** Every per-client secret name of the app's environment (ENV_NAMES, `per-client` secrets). */
const SECRET_NAMES = [
  "BETTER_AUTH_SECRET",
  "CUSTOMER_AUTH_SECRET",
  "DESK_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "TYPESAFE_API_KEY",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "AI_KEY_OPENAI",
  "AI_KEY_ANTHROPIC",
  "AI_KEY_GOOGLE",
  "AI_KEY_ASSEMBLYAI",
];

const values = Object.fromEntries(
  SECRET_NAMES.map((name) => [name, `s66e-known-${name.toLowerCase()}-${crypto.randomUUID()}`]),
);
const needles = Object.values(values);

const lines: string[] = [];

beforeAll(async () => {
  await ensureAdmin(admin);
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : safeText(a))).join(" "),
      );
    });
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});

function safeText(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

describe("a client's secrets in no operation's output", () => {
  it("runs every operation that takes no input and finds no secret value anywhere", async () => {
    // The AI fake keeps model calls in the Worker; the secrets are fake values made above.
    const withSecrets = { ...env, ...values, AI_FAKE_MODEL: "true" } as typeof env;
    const ran: string[] = [];
    const outputs: string[] = [];
    for (const op of coreRegistry.list()) {
      if (!op.input.safeParse({}).success) continue;
      const result = await runOperation(withSecrets, admin, { name: op.name, input: {} }).catch(
        (error: unknown) => ({ thrown: error instanceof Error ? error.message : String(error) }),
      );
      ran.push(op.name);
      outputs.push(`${op.name} ${safeText(result)}`);
    }
    // A sweep that ran nothing would prove nothing.
    expect(ran.length).toBeGreaterThan(40);
    // Among them, the ones that report on the secrets this env holds.
    expect(ran).toEqual(
      expect.arrayContaining(["ai.settings", "judge.get", "desk.status", "device.list"]),
    );
    const database = await dumpDatabase(env.DB);
    for (const needle of needles) {
      for (const output of outputs)
        expect(output.includes(needle), output.slice(0, 200)).toBe(false);
      for (const line of lines) expect(line.includes(needle), line.slice(0, 200)).toBe(false);
      expect(database.includes(needle), "the database").toBe(false);
    }
  }, 120_000);
});

/** Every row of every table, as text. */
async function dumpDatabase(db: D1Database): Promise<string> {
  const { results: tables } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")
    .all<{ name: string }>();
  const parts: string[] = [];
  for (const { name } of tables) {
    const { results } = await db.prepare(`SELECT * FROM "${name}"`).all();
    parts.push(safeText(results));
  }
  return parts.join("\n");
}
