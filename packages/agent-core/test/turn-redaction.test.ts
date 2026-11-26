// Provider error text never leaves a turn with a key in it (the second review of PR #513, S1): a
// provider that echoes its key in an error reaches neither the error event, nor `result.error`,
// nor the stored note, nor the log, and a note stored before (with a key in it) is redacted again
// before the history is sent to a model. Each model carries its runner's redactor
// (packages/core `ai/redact.ts`, tested there); here a stand-in cuts the one fake key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "../src/index.ts";
import { fakeModel } from "./fake-model.ts";

const KEY = `s66e-fake-provider-key-${crypto.randomUUID()}`;
const redact = (text: string) => text.split(KEY).join("…");

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "),
      );
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a turn whose provider echoes its key", () => {
  it("shows, returns, logs and stores the failure without the key", async () => {
    const broken = fakeModel(() => ({ fail: `Incorrect API key provided: ${KEY}` }));
    const events: unknown[] = [];
    const result = await runTurn({
      models: [{ model: broken.model, provider: "fake", modelId: "broken", params: {}, redact }],
      system: "s",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      emit: (e) => events.push(e),
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("Incorrect API key provided");
    const everything = JSON.stringify({ events, result, lines });
    expect(everything).not.toContain(KEY);
    expect(JSON.stringify(result.response)).toContain("This answer failed");
  });

  it("redacts a tool's error text (thrown, or an MCP isError result) before the model, the event and the stored response see it", async () => {
    for (const tool of [
      async () => {
        throw new Error(`token endpoint said: client_secret=${KEY}`);
      },
      async () => ({ text: `{"error":"upstream echoed ${KEY}"}`, isError: true }),
    ]) {
      let n = 0;
      const working = fakeModel(() =>
        n++ === 0 ? { toolCall: { name: "act", arguments: {} } } : { text: "Done." },
      );
      const events: unknown[] = [];
      const result = await runTurn({
        models: [{ model: working.model, provider: "fake", modelId: "m", params: {}, redact }],
        system: "s",
        messages: [{ role: "user", content: "do it" }],
        tools: [
          {
            name: "act",
            description: "Acts.",
            inputSchema: { type: "object", properties: {} },
            call: tool,
          },
        ],
        emit: (e) => events.push(e),
      });
      const everything = JSON.stringify({ events, result, requests: working.requests, lines });
      expect(everything).not.toContain(KEY);
      expect(everything).toContain("…");
    }
  });

  it("passes a successful tool result on as it is (it is the tool's own data)", async () => {
    let n = 0;
    const working = fakeModel(() =>
      n++ === 0 ? { toolCall: { name: "read", arguments: {} } } : { text: "Done." },
    );
    const data = `{"note":"${KEY}"}`;
    await runTurn({
      models: [{ model: working.model, provider: "fake", modelId: "m", params: {}, redact }],
      system: "s",
      messages: [{ role: "user", content: "read it" }],
      tools: [
        {
          name: "read",
          description: "Reads.",
          inputSchema: { type: "object", properties: {} },
          call: async () => ({ text: data, isError: false }),
        },
      ],
      emit: () => {},
    });
    expect(JSON.stringify(working.requests)).toContain(KEY);
  });

  it("redacts a failure note stored before, so an old key is never re-sent to a model", async () => {
    const working = fakeModel(() => ({ text: "Hi" }));
    await runTurn({
      models: [{ model: working.model, provider: "fake", modelId: "m", params: {}, redact }],
      system: "s",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: `(This answer failed: Incorrect API key provided: ${KEY}.)` },
        {
          role: "assistant",
          content: [{ type: "text", text: `(This answer failed partway: ${KEY}.)` }],
        },
        { role: "user", content: "again" },
      ],
      tools: [],
      emit: () => {},
    });
    expect(working.requests).toHaveLength(1);
    expect(JSON.stringify(working.requests[0])).not.toContain(KEY);
    expect(JSON.stringify(working.requests[0])).toContain("This answer failed");
  });
});
