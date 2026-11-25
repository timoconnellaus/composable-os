// A host kind's send from host code (ADR 0670): prepare its rows, then hand each email to the
// integration host, through the org email connection an admin picked in Settings → Notification
// delivery (the one the host's own mail uses, ADR 0429), and each text to the text connection
// (ADR 0672). Pushes are their gatekeeper's (a later step); here they are only prepared and logged.
import type { CoreDatabase } from "@composable-os/db";
import type { RoutineSendResult } from "@composable-os/sdk";
import type { Kysely } from "kysely";
import type { IntegrationRuntime } from "../integrations/runtime.ts";
import { resolveChannelTarget } from "../notifications/channels.ts";
import { loadDeliverySettings } from "../notifications/preferences.ts";
import { type PrepareHostRoutineMailInput, prepareHostRoutineMail } from "./index.ts";
import { sendReadyTexts } from "./texts.ts";

/**
 * Sends a host kind's message about one record. Never throws for a send that cannot go (no email
 * channel set, the gatekeeper's queue full): its row says why, and the same occasion asked again
 * sends what is still ready.
 */
export async function sendHostRoutineMessage(
  deps: { db: Kysely<CoreDatabase>; integrations: IntegrationRuntime | undefined },
  input: Omit<PrepareHostRoutineMailInput, "connectionId">,
): Promise<RoutineSendResult> {
  const settings = await loadDeliverySettings(deps.db);
  const resolved = settings.email
    ? await resolveChannelTarget(deps.db, "email", settings.email)
    : null;
  const target = resolved && "target" in resolved ? resolved.target : null;
  const prepared = await prepareHostRoutineMail(deps.db, {
    ...input,
    connectionId: target?.connectionId ?? null,
  });
  let sent = 0;
  let held = 0;
  let off = prepared.off;
  for (const done of prepared.done) {
    if (done.status === "sent" && done.routine) sent += 1;
    else if (
      done.status === "waiting" ||
      (!done.routine && done.status !== "off" && done.status !== "stopped")
    ) {
      held += 1;
    }
  }
  const send = deps.integrations?.sendRoutineMessage;
  for (const row of prepared.toSend) {
    if (!target || !send) continue;
    try {
      const outcome = await send({
        connectionId: target.connectionId,
        resource: target.resource,
        id: row.id,
      });
      if (outcome.status === "sent") sent += 1;
      else if (outcome.status === "waiting") held += 1;
      else if (outcome.status === "off") off = true;
    } catch (error) {
      // The row is back to ready with the reason (a full queue is back-pressure, ADR 0590).
      console.warn(
        `host routine message ${row.id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  // Its texts (ADR 0672): those ready now, and held ones to put to a person. Never throws: a row
  // that did not go waits for the minute cron.
  try {
    const texts = await sendReadyTexts(deps, {
      ids: prepared.phone
        .filter((p) => p.channel === "text" && (p.status === "ready" || p.status === "held"))
        .map((p) => p.id),
    });
    sent += texts.sent;
    held += texts.waiting;
  } catch (error) {
    console.warn(`host routine texts: ${error instanceof Error ? error.message : error}`);
  }
  return { sent, held, off, none: prepared.none };
}
