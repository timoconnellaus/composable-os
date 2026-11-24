// The minute cron's publishing step (stage 28, ADR 0441): scheduled publishes whose time has
// come go live through the operations pipeline, as `record.publishDue` called by an automation
// (SYSTEM_USER, origin `system`), so each round is gated, audited and in one batch with its
// record changes and the cache's generation bump. cos-runner's minute tick calls it. Each step
// first reads whether it has anything to do, outside the pipeline, so a quiet minute writes
// nothing, not even an audit row.
import type { CrmDb } from "@composable-os/db";
import type { EventSink } from "../automations/types.ts";
import { refreshSchemaRegistry } from "../extensions/schema.ts";
import type { GateFloor } from "../gate.ts";
import { invoke } from "../invoke.ts";
import { PUBLISH_DUE_BATCH } from "../operations/record-versions.ts";
import { publishScheduleDue } from "../records/publish.ts";
import { SYSTEM_USER } from "../users.ts";
import { reindexPending } from "./published-text.ts";

export interface PublishDueOptions {
  floor?: GateFloor;
  clock?: () => Date;
  events?: EventSink;
  /** Upper bound on rounds per tick; the next tick picks up anything left. Default 5. */
  maxRounds?: number;
}

/** Publishes what is due, a batch a round. With nothing due it is one indexed read and no write. */
export async function runPublishDue(
  db: CrmDb,
  { floor, clock, events, maxRounds = 5 }: PublishDueOptions = {},
): Promise<{ published: number; dropped: number; rounds: number }> {
  let published = 0;
  let dropped = 0;
  let rounds = 0;
  if (!(await publishScheduleDue(db.query, (clock?.() ?? new Date()).toISOString()))) {
    return { published, dropped, rounds };
  }
  while (rounds < maxRounds) {
    rounds += 1;
    const result = (await invoke(
      "record.publishDue",
      { limit: PUBLISH_DUE_BATCH },
      {
        actor: "automation",
        user: SYSTEM_USER,
        origin: { surface: "system", automationId: "system.publish" },
        db,
        ...(floor ? { floor } : {}),
        ...(clock ? { clock } : {}),
        ...(events ? { events } : {}),
      },
    )) as { published: unknown[]; dropped: number };
    published += result.published.length;
    dropped += result.dropped;
    if (result.published.length + result.dropped < PUBLISH_DUE_BATCH) break;
  }
  return { published, dropped, rounds };
}

/**
 * The published-text index caught up with the objects' declarations (ADR 0700): `content.reindex`
 * a round at a time, through the pipeline as the minute cron's automation. With nothing to do it
 * is the registry's check and one settings read, and no write.
 */
export async function runReindexDue(
  db: CrmDb,
  { floor, clock, events, maxRounds = 5 }: PublishDueOptions = {},
): Promise<{ records: number; rounds: number; more: boolean }> {
  let records = 0;
  let rounds = 0;
  let more = false;
  // The registry first: what the objects declare is what the index is compared with.
  await refreshSchemaRegistry(db.query);
  if (!(await reindexPending(db.query))) return { records, rounds, more };
  while (rounds < maxRounds) {
    rounds += 1;
    const result = (await invoke(
      "content.reindex",
      {},
      {
        actor: "automation",
        user: SYSTEM_USER,
        origin: { surface: "system", automationId: "system.reindex" },
        db,
        ...(floor ? { floor } : {}),
        ...(clock ? { clock } : {}),
        ...(events ? { events } : {}),
      },
    )) as { records: number; more: boolean };
    records += result.records;
    more = result.more;
    if (!more) break;
  }
  return { records, rounds, more };
}
