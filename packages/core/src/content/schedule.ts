// The minute cron's publishing step (stage 28, ADR 0441): scheduled publishes whose time has
// come go live through the operations pipeline, as `record.publishDue` called by an automation
// (SYSTEM_USER, origin `system`), so each round is gated, audited and in one batch with its
// record changes and the cache's generation bump. cos-runner's minute tick calls it.
import type { CrmDb } from "@composable-os/db";
import type { EventSink } from "../automations/types.ts";
import type { GateFloor } from "../gate.ts";
import { invoke } from "../invoke.ts";
import { PUBLISH_DUE_BATCH } from "../operations/record-versions.ts";
import { SYSTEM_USER } from "../users.ts";

export interface PublishDueOptions {
  floor?: GateFloor;
  clock?: () => Date;
  events?: EventSink;
  /** Upper bound on rounds per tick; the next tick picks up anything left. Default 5. */
  maxRounds?: number;
}

/** Publishes what is due, a batch a round. With nothing due it is one indexed read. */
export async function runPublishDue(
  db: CrmDb,
  { floor, clock, events, maxRounds = 5 }: PublishDueOptions = {},
): Promise<{ published: number; dropped: number; rounds: number }> {
  let published = 0;
  let dropped = 0;
  let rounds = 0;
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
