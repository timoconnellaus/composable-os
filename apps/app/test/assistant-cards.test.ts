// Cards in the person's thread (ADR 0346), end to end in workerd through their AssistantAgent
// Durable Object with the scripted model: a model's card streams and is stored with its fallback,
// the model reads only that fallback, an invalid card shows the words, and a saved producer's card
// lands in the thread with no model call at all.
import { env } from "cloudflare:workers";
import type { A2uiPart } from "@composable-os/agent-a2ui";
import type { Principal } from "@composable-os/auth";
import { resolveActingUser, type TranscriptItem } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { describe, expect, it } from "vitest";
import { runOperation } from "../src/server/operations.ts";
import { turn as assistantTurn, threadState as state } from "./assistant-helpers.ts";

const db = createCrmDb(env.DB);

let n = 0;
async function member(): Promise<Principal> {
  n += 1;
  const principal: Principal = {
    userId: `auth-cards-${Date.now()}-${n}`,
    email: `cards-${Date.now()}-${n}@example.com`,
    name: `Card tester ${n}`,
    roles: [],
  };
  await resolveActingUser(db, principal);
  return principal;
}

const turn = (principal: Principal, text: string) => assistantTurn(principal, { text });

const cards = (items: TranscriptItem[]) =>
  items.flatMap((i) => (i.kind === "card" ? [i.part] : [])) as A2uiPart[];

describe("cards in the thread", () => {
  it("streams a model's card and stores it with its fallback", async () => {
    const principal = await member();
    const events = await turn(principal, "Show me a card about renewals");
    const result = events.find((e) => e.type === "tool-result" && e.tool === "show_card");
    expect(result).toMatchObject({ card: { source: "model" } });
    const [stored] = cards((await state(principal)).items);
    expect(stored?.document?.root.type).toBe("card");
    expect(stored?.fallback).toContain("A card about renewals.");
    const replies = (await state(principal)).items.filter((i) => i.kind === "assistant");
    expect(replies.at(-1)).toMatchObject({ text: "Here it is." });
  });

  it("shows an invalid card as the model's words, stored with the reason", async () => {
    const principal = await member();
    await turn(principal, "Show me a broken card about renewals");
    const [stored] = cards((await state(principal)).items);
    expect(stored?.document).toBeNull();
    expect(stored?.fallback).toBe("Plain words about renewals.");
    expect(stored?.problems?.join()).toContain("unknown component marquee");
  });

  it("finds a card's words in search", async () => {
    const principal = await member();
    await turn(principal, "Show me a card about zebrafish");
    const out = (await runOperation(env as never, principal, {
      name: "thread.search",
      input: { query: "zebrafish" },
    })) as { ok: boolean; data: { hits: { role: string; text: string }[] } };
    expect(out.data.hits.map((h) => h.role)).toContain("tool");
  });

  it("posts a saved producer's card in the thread with no model call", async () => {
    const principal = await member();
    // A person who never chatted: there is no turn, no model, and the thread opens itself.
    const out = (await runOperation(env as never, principal, {
      name: "a2ui.produce",
      input: { producer: "tasks.overdueCard", post: true },
    })) as { ok: boolean; data: { part: A2uiPart; seq: number } };
    expect(out).toMatchObject({ ok: true, data: { part: { source: "producer" } } });
    const thread = await state(principal);
    expect(thread.items.map((i) => i.kind)).toEqual(["card"]);
    expect(cards(thread.items)[0]).toMatchObject({
      producer: "tasks.overdueCard@1",
      fallback: expect.stringContaining("From the stub runner"),
    });
    expect(thread.unread).toBe(1);
    expect(thread.running).toBeNull();
  });

  it("gives the model a posted card's words on the next turn, and a turn still works after", async () => {
    const principal = await member();
    await runOperation(env as never, principal, {
      name: "a2ui.produce",
      input: { producer: "tasks.overdueCard", post: true },
    });
    const events = await turn(principal, "Hello");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", status: "done" });
    const kinds = (await state(principal)).items.map((i) => i.kind);
    expect(kinds).toEqual(["card", "user", "assistant"]);
  });

  it("indexes a posted card's records for erase", async () => {
    const principal = await member();
    await runOperation(env as never, principal, {
      name: "a2ui.produce",
      input: { producer: "tasks.overdueCard", post: true },
    });
    const refs = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_assistant_thread_refs WHERE ref = ?",
    )
      .bind("per_01KA8ZQ7Y2V3N4M5P6R7S8T9W0")
      .first<{ n: number }>();
    expect(refs?.n).toBeGreaterThan(0);
  });
});
