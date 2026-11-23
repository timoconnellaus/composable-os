// What a record write does to its checklist run (ADR 0650, the review of PR #298), called by every
// path that writes a record (operations/record.ts: create, update, its batch forms and imports, the
// Trash and restore, a series' changes):
// - **ending a record that has started** (moving it out of its live states, or to the Trash) is a
//   rosterer's where a pack declares who rosters, as moving its times is (ADR 0627): otherwise the
//   person on a shift could cancel it to make its checklist disappear;
// - the run of a record ended after its window opened is **marked** with who ended it: someone who
//   rosters (or the host) closes it as cancelled, anyone else as missed; a record coming back to a
//   live state clears the mark.

import { ForbiddenError } from "../errors.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import type { Mover } from "../records/transitions.ts";
import {
  actingAccount,
  assertMayRoster,
  mayRoster,
  rosteringDeclared,
} from "../staffing/rosterers.ts";
import { endedStatement } from "./index.ts";

const liveIn = (object: ObjectDefinition, values: Record<string, unknown> | null) => {
  const def = object.checklists;
  const field = object.states?.field;
  if (!def || !values || !field) return false;
  return def.live.includes(String(values[field] ?? ""));
};

const startedBy = (object: ObjectDefinition, values: Record<string, unknown>, now: string) => {
  const at = Date.parse(String(values[object.checklists?.opens ?? ""] ?? ""));
  return Number.isFinite(at) && at <= Date.parse(now);
};

/**
 * A record of an object declaring `checklists` leaves its live states (`after` null: to the
 * Trash): refused for a caller who does not roster once it has started (where a pack declares who
 * rosters), and its open, opened run marked with who ended it. Coming back clears the mark.
 */
export async function checklistRecordWritten(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  by: Mover | undefined,
): Promise<void> {
  if (!object.checklists || before === null) return;
  const was = liveIn(object, before);
  const is = after !== null && liveIn(object, after);
  if (!was && is) {
    // Back on (restored, or moved back to a live state): the run is no longer ended.
    ctx.write(endedStatement(object.name, id, null, 0));
    return;
  }
  if (!was || is || !startedBy(object, before, ctx.now)) return;
  const host = by === "host";
  if (!host) {
    // An AI never ends a started shift on its own: only a person who rosters, or an approval a
    // rosterer gave (approvals.ts checks the approver).
    if (ctx.actor !== "human" && ctx.actor !== "extension" && !ctx.approval) {
      throw new ForbiddenError(
        `Cancelling or removing a ${object.label.toLowerCase()} that has started is a person's to do.`,
        { rule: "person_applies" },
      );
    }
    await assertMayRoster(ctx, `cancel or remove a ${object.label.toLowerCase()} that has started`);
  }
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  const rosters = host || ((await rosteringDeclared(ctx.db)) && (await mayRoster(ctx)));
  ctx.write(
    endedStatement(object.name, id, { at: ctx.now, by: rosters ? actingAccount(ctx) : null }, now),
  );
}

/** A record of an object declaring `checklists` restored from the Trash: its run is not ended. */
export function checklistRecordRestored(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): void {
  if (object.checklists) ctx.write(endedStatement(object.name, id, null, 0));
}
