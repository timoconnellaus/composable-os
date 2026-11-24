// What the assistant tests share: a turn and the thread, through the host's own HTTP handlers.
import { env } from "cloudflare:workers";
import type { Principal } from "@composable-os/auth";
import type { AssistantEvent, AssistantThreadState } from "@composable-os/core";
import { expect } from "vitest";
import { type AssistantHttpEnv, handleState, handleTurn } from "../src/server/assistant/http.ts";

const ORIGIN = "https://crm.test";
const appEnv = env as unknown as AssistantHttpEnv;

/** One turn of `principal`'s thread; the events it streamed. */
export async function turn(
  principal: Principal,
  body: Record<string, unknown>,
): Promise<AssistantEvent[]> {
  const response = await handleTurn(
    new Request(`${ORIGIN}/api/assistant/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    appEnv,
    principal,
  );
  expect(response.status).toBe(200);
  return (await response.text())
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as AssistantEvent);
}

/** `principal`'s thread as the app reads it. */
export async function threadState(principal: Principal): Promise<AssistantThreadState> {
  const response = await handleState(
    new Request(`${ORIGIN}/api/assistant/thread`),
    appEnv,
    principal,
  );
  return (await response.json()) as AssistantThreadState;
}
