// Stage 66 step 6 (ADR 0616, criterion 10): no operation shows a client's secrets. An env holding
// a known value for every per-client secret name (what a client's environment holds on a
// many-client host: its derived and given secrets) runs every operation that takes no input, as
// an admin, through the UI's pipeline; no output, error or log line holds any of the values,
// and nor does the database afterwards.
import { env } from "cloudflare:workers";
import { runTurn } from "@composable-os/agent-core";
import type { Principal } from "@composable-os/auth";
import { coreRegistry } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aiContextFor } from "../src/server/ai.ts";
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

  it("shows no key in the provider error text an operation passes on (ai.testRole, judge.test)", async () => {
    // A provider that echoes the key it was sent, in the worst place: its error message.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(
        (init?.headers as HeadersInit | undefined) ??
          (input instanceof Request ? input.headers : undefined),
      );
      const sent = [...headers.entries()].map(([k, v]) => `${k}: ${v}`).join("; ");
      return new Response(
        JSON.stringify({ error: { message: `Incorrect API key provided: ${sent}` } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const withSecrets = {
        ...env,
        ...values,
        AI_PROVIDERS: "openai,google,deepseek",
        AI_KEY_DEEPSEEK: values.AI_KEY_OPENAI,
      } as typeof env;
      const outputs: string[] = [];
      const calls = [
        { name: "judge.test", input: {} },
        ...[
          ["openai", "gpt-4.1-mini"],
          ["google", "gemini-2.5-flash"],
          ["deepseek", "deepseek-flash"],
        ].map(([provider, model]) => ({
          name: "ai.testRole",
          input: { role: "summarise", target: { provider, model } },
        })),
      ];
      for (const call of calls) {
        const result = await runOperation(withSecrets, admin, call).catch((error: unknown) => ({
          thrown: error instanceof Error ? error.message : String(error),
        }));
        outputs.push(`${call.name} ${safeText(result)}`);
      }
      // The stub was reached, so the key was sent and could have come back.
      expect(fetchSpy).toHaveBeenCalled();
      for (const needle of needles) {
        for (const output of outputs)
          expect(output.includes(needle), output.slice(0, 300)).toBe(false);
        for (const line of lines) expect(line.includes(needle), line.slice(0, 300)).toBe(false);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  }, 120_000);

  it("shows no key on any route provider text takes out of the model runner (turns, jobs, runs, embeddings)", async () => {
    // A provider that echoes every header it was sent, plain, URL-encoded, base64 and cut short.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(
        (init?.headers as HeadersInit | undefined) ??
          (input instanceof Request ? input.headers : undefined),
      );
      const sent = [...headers.entries()].map(([k, v]) => `${k}: ${v}`).join("; ");
      const token = (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const echo = [
        sent,
        encodeURIComponent(token),
        btoa(`user:${token}`),
        token.slice(0, 20),
      ].join(" | ");
      return new Response(JSON.stringify({ error: { message: `Incorrect API key: ${echo}` } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const withSecrets = {
        ...env,
        ...values,
        AI_PROVIDERS: "openai",
        AI_FAKE_MODEL: "",
        AI_MODEL_ROLES: JSON.stringify({
          summarise: { provider: "openai", model: "gpt-4.1-mini" },
          "assistant.core": { provider: "openai", model: "gpt-4.1-mini" },
          embed: { provider: "openai", model: "text-embedding-3-small" },
        }),
      } as typeof env;
      const models = aiContextFor(withSecrets, createCrmDb(env.DB)).models;
      if (!models?.chatModels || !models.embed) throw new Error("no model runner");
      const outputs: string[] = [];
      const caught = async (label: string, work: Promise<unknown>) => {
        const out = await work.then(
          (value) => ({ value }),
          (error: unknown) => ({ thrown: error instanceof Error ? error.message : String(error) }),
        );
        outputs.push(`${label} ${safeText(out)}`);
      };
      // Summaries, routines, the adjudicator, digests, dictation clean-up: `run`.
      await caught("run", models.run("summarise", [{ role: "user", content: "hi" }]));
      // Search indexing and hybrid search: `embed`.
      await caught("embed", models.embed(["hello"]));
      // The assistant's turns, its compaction and its jobs: `chatModels` through `runTurn`.
      const events: unknown[] = [];
      const turn = await runTurn({
        models: await models.chatModels("assistant.core"),
        system: "s",
        messages: [
          { role: "user", content: "first" },
          // A note stored before this fix, with a key in it: never re-sent to the model.
          { role: "assistant", content: `(This answer failed: ${values.AI_KEY_OPENAI}.)` },
          { role: "user", content: "again" },
        ],
        tools: [],
        emit: (e) => events.push(e),
      });
      outputs.push(`turn ${safeText({ turn, events })}`);
      // What the turn sent to the provider: the old note's key is cut out of the history.
      const sentBodies = fetchSpy.mock.calls.map(([, init]) => String(init?.body ?? ""));
      expect(turn.status).toBe("error");
      expect(fetchSpy).toHaveBeenCalled();
      const key = values.AI_KEY_OPENAI as string;
      const forms = [key, encodeURIComponent(key), btoa(`user:${key}`), key.slice(0, 20)];
      for (const form of forms) {
        for (const output of outputs)
          expect(output.includes(form), output.slice(0, 300)).toBe(false);
        for (const line of lines) expect(line.includes(form), line.slice(0, 300)).toBe(false);
        for (const body of sentBodies) expect(body.includes(form), "a request body").toBe(false);
      }
    } finally {
      fetchSpy.mockRestore();
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
