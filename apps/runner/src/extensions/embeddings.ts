// Semantic search's half of the automation events consumer (ADR 0154 amendment): committed record
// changes arrive here as stage 5 record events, and the records whose text changed are embedded
// straight away (hash-checked, batched), with no queue row on the write path. Only with a real
// Vectorize binding and a model: without them (local dev, tests) cos-app's queue path does it.
import {
  type AutomationQueueMessage,
  embedRecordEvents,
  type ModelRunner,
  type VectorizeLike,
  vectorizeStore,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { runnerModels } from "./ai.ts";

interface EmbedEnv {
  DB: D1Database;
  VECTORIZE?: unknown;
}

/** The Vectorize index and the models to embed from events with, or null without either. */
function embedder(env: object): { index: VectorizeLike; models: ModelRunner } | null {
  const index = (env as EmbedEnv).VECTORIZE as VectorizeLike | undefined;
  if (!index || typeof index.query !== "function") return null;
  const models = runnerModels(env);
  return models?.embed ? { index, models } : null;
}

/** Does this Worker embed from events (a Vectorize binding and a model that can embed)? */
export function embedsFromEvents(env: object): boolean {
  return embedder(env) !== null;
}

/** Embeds the records a batch of events changed. Never throws (failures are queued for the cron). */
export async function embedFromEvents(
  env: EmbedEnv,
  messages: readonly AutomationQueueMessage[],
): Promise<void> {
  const changes = messages.flatMap((m) => (m.kind === "record" ? m.changes : []));
  if (!changes.length) return;
  const found = embedder(env);
  if (!found) return;
  try {
    await embedRecordEvents(
      { db: createCrmDb(env.DB), models: found.models, vectors: vectorizeStore(found.index) },
      changes,
    );
  } catch (error) {
    console.error("embedding from events failed", error);
  }
}
