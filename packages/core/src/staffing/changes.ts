// What a write to a shift tells people, and what it does to the shift's open offer (stage 45 step
// 3, ADRs 0623 and 0624). Called by staffing/index.ts for every write the record operations make
// to a staffed object (a person editing a class's coach, a rosterer's assign, the assistant once a
// person approved it, an import, a change of a series), in the write's own batch, so whatever
// wrote it the same people are told:
//
// - the shift's open offer is cancelled when the shift goes to someone else or stops being live
//   (its offerer told), except by the take of that offer itself; the cancel is by the shift, at
//   commit, so an offer made while this write was in flight is cancelled too;
// - the person put on a shift, or taken off one, by someone else is told, and so is the person
//   whose shift changed time, was cancelled or removed; a series' generation tells nobody here;
// - a live shift in the uncovered window left with nobody on it is told to the rosterers.
//
// The notices of one call are gathered and sent once it has queued everything: one notice per
// person when the call touched one of their shifts, one summary (how many, and the dates) when it
// touched several (a change of a series, an import), never one per shift.
import type { ObjectDefinition } from "../fields/types.ts";
import type { NotificationLink } from "../notifications/types.ts";
import type { HandlerContext } from "../operation.ts";
import type { Mover } from "../records/transitions.ts";
import type { Shift } from "./index.ts";
import { kindObjectOf } from "./kinds.ts";
import { cancelOpenOfferStatement, followShiftStatement, openOfferOn, whenOf } from "./offers.ts";
import { actingAccount, queueNotice, rosterers, shiftLink, staffName } from "./rosterers.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** One write of a shift, as staffing/index.ts read it. */
export interface ShiftWrite {
  object: ObjectDefinition;
  id: string;
  /** The values before (null: a create). */
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  beforeShift: Shift | null;
  shift: Shift;
  by: Mover | undefined;
  /** The offer this batch is taking, if any (its take tells its own people). */
  taking: string | null;
  /** The shift starts within the uncovered window. */
  inWindow: boolean;
}

/** A shift's title as notices show it. */
export function shiftTitle(object: ObjectDefinition, values: Record<string, unknown>): string {
  return (object.titleField ? text(values[object.titleField]) : null) ?? object.label;
}

/** A shift's zone (its own field), or null for the org's. */
export function shiftZone(object: ObjectDefinition, values: Record<string, unknown>) {
  const field = object.staffed?.zone;
  return field ? text(values[field]) : null;
}

// --- Gathering one call's notices -----------------------------------------------------------------

type Kind = "on" | "off" | "moved" | "cancelled" | "uncovered" | "offer";

interface Gathered {
  to: string;
  kind: Kind;
  title: string;
  body: string;
  /** The line it is in a summary. */
  line: string;
  starts: number | null;
  link: NotificationLink;
}

const gatheredBy = new WeakMap<object, Gathered[]>();

/** Notes a notice for the end of the call (or queues it now when the call cannot gather). */
async function gather(ctx: HandlerContext, notice: Gathered): Promise<void> {
  if (!notice.to || notice.to === actingAccount(ctx)) return;
  if (!ctx.beforeCommit) {
    await queueNotice(ctx, {
      to: [notice.to],
      title: notice.title,
      body: notice.body,
      link: notice.link,
    });
    return;
  }
  let list = gatheredBy.get(ctx.write);
  if (!list) {
    const fresh: Gathered[] = [];
    list = fresh;
    gatheredBy.set(ctx.write, fresh);
    ctx.beforeCommit(() => sendGathered(ctx, fresh));
  }
  list.push(notice);
}

const SUMMARY: Record<Kind, (n: number) => string> = {
  on: (n) => `You are on ${n} shifts`,
  off: (n) => `You are off ${n} shifts`,
  moved: (n) => `${n} of your shifts changed time`,
  cancelled: (n) => `${n} of your shifts were cancelled`,
  uncovered: (n) => `${n} shifts have nobody on them`,
  offer: (n) => `${n} of your offers were cancelled`,
};

/** One notice per person: theirs as it was when there is one, else a summary. */
async function sendGathered(ctx: HandlerContext, list: readonly Gathered[]): Promise<void> {
  const byPerson = new Map<string, Gathered[]>();
  for (const n of list) byPerson.set(n.to, [...(byPerson.get(n.to) ?? []), n]);
  for (const [to, mine] of byPerson) {
    const first = mine[0] as Gathered;
    // About one shift (its offer cancelled and its person off it): each as it is.
    const shifts = new Set(mine.map((n) => JSON.stringify(n.link)));
    if (shifts.size === 1) {
      for (const n of mine) {
        await queueNotice(ctx, { to: [to], title: n.title, body: n.body, link: n.link });
      }
      continue;
    }
    const kinds = new Set(mine.map((n) => n.kind));
    const title =
      kinds.size === 1 ? SUMMARY[first.kind](mine.length) : `${mine.length} changes to your shifts`;
    const starts = mine.map((n) => n.starts).filter((s): s is number => s !== null);
    const range = starts.length
      ? `From ${await whenOf(ctx, Math.min(...starts), null)} to ${await whenOf(ctx, Math.max(...starts), null)}, by ${await staffName(ctx.db, actingAccount(ctx))}.`
      : `By ${await staffName(ctx.db, actingAccount(ctx))}.`;
    const lines = [...mine]
      .sort((a, b) => (a.starts ?? 0) - (b.starts ?? 0))
      .slice(0, 15)
      .map((n) => n.line);
    if (mine.length > 15) lines.push(`and ${mine.length - 15} more`);
    await queueNotice(ctx, { to: [to], title, body: [range, ...lines].join("\n") });
  }
}

// --- A write of a shift ---------------------------------------------------------------------------

export async function shiftWritten(ctx: HandlerContext, w: ShiftWrite): Promise<void> {
  const def = w.object.staffed;
  if (!def) return;
  const title = shiftTitle(w.object, w.after);
  const link = shiftLink(w.object.name, w.id);
  const zone = shiftZone(w.object, w.after);
  const whoChanged = w.before !== null && !same(w.before[def.who.field], w.after[def.who.field]);
  const timeChanged =
    w.before !== null &&
    (!same(w.before[def.starts], w.after[def.starts]) ||
      !same(w.before[def.ends], w.after[def.ends]));
  const kindChanged = w.before !== null && !same(w.before[def.kind], w.after[def.kind]);
  const wasLive = w.beforeShift?.live ?? false;
  const ended = wasLive && !w.shift.live;
  const when = () => whenOf(ctx, w.shift.starts, zone);

  // Its open offer: cancelled when it goes to someone else or is no longer a shift, by the shift
  // at commit (an offer made meanwhile is caught too). A take is the one write that keeps it.
  if (w.before !== null && (whoChanged || ended) && !w.taking) {
    const why = ended
      ? "The shift was cancelled."
      : "The shift was given to someone else, so the offer was cancelled.";
    ctx.write(cancelOpenOfferStatement(ctx, w.object.name, w.id, why));
    const offer = await openOfferOn(ctx.db, w.object.name, w.id);
    if (offer) {
      await gather(ctx, {
        to: offer.from_account ?? offer.made_by,
        kind: "offer",
        title: `Your offer was cancelled: ${title}`,
        body: why,
        line: `${title}, ${await when()}: ${why}`,
        starts: w.shift.starts,
        link,
      });
    }
  } else if ((timeChanged || kindChanged) && w.shift.starts !== null) {
    // The cut-off follows the shift's time, and the taker's list its kind.
    const kindObject = kindObjectOf(w.object);
    ctx.write(
      followShiftStatement(ctx, w.object.name, w.id, {
        starts: w.shift.starts,
        kind: kindObject && w.shift.kind ? { object: kindObject, id: w.shift.kind } : null,
      }),
    );
  }

  // A take tells its own people; a series' generation (the host making records) tells nobody.
  if (w.taking || (w.by === "host" && w.before === null)) return;
  let actor: string | null = null;
  const actorName = async () => {
    actor ??= await staffName(ctx.db, actingAccount(ctx));
    return actor;
  };
  const was = w.beforeShift?.account ?? null;
  const now = w.shift.account;
  if (was !== now) {
    if (now && w.shift.live) {
      await gather(ctx, {
        to: now,
        kind: "on",
        title: `You are on a shift: ${title}`,
        body: `${await actorName()} put you on ${title}, ${await when()}.`,
        line: `On: ${title}, ${await when()}`,
        starts: w.shift.starts,
        link,
      });
    }
    if (was && wasLive) {
      const before = await whenOf(ctx, w.beforeShift?.starts ?? null, zone);
      await gather(ctx, {
        to: was,
        kind: "off",
        title: `You are off a shift: ${title}`,
        body: `${await actorName()} took you off ${title}, ${before}.`,
        line: `Off: ${title}, ${before}`,
        starts: w.beforeShift?.starts ?? null,
        link,
      });
    }
  } else if (now && wasLive) {
    if (ended) {
      await gather(ctx, {
        to: now,
        kind: "cancelled",
        title: `Your shift was cancelled: ${title}`,
        body: `${title}, ${await when()}, was cancelled by ${await actorName()}.`,
        line: `Cancelled: ${title}, ${await when()}`,
        starts: w.shift.starts,
        link,
      });
    } else if (timeChanged) {
      const before = await whenOf(ctx, w.beforeShift?.starts ?? null, zone);
      await gather(ctx, {
        to: now,
        kind: "moved",
        title: `Your shift changed time: ${title}`,
        body: `It was ${before}; it is now ${await when()}. Changed by ${await actorName()}.`,
        line: `Moved: ${title}, ${before} to ${await when()}`,
        starts: w.shift.starts,
        link,
      });
    }
  }

  // Left with nobody on it, inside the uncovered window: the rosterers hear.
  const nowUncovered =
    w.shift.live && !w.shift.covered && (w.before === null || !wasLive || w.beforeShift?.covered);
  if (nowUncovered && w.inWindow) {
    for (const r of await rosterers(ctx.db)) {
      await gather(ctx, {
        to: r,
        kind: "uncovered",
        title: `A shift has nobody on it: ${title}`,
        body: `${title}, ${await when()}, has nobody on it.`,
        line: `${title}, ${await when()}`,
        starts: w.shift.starts,
        link,
      });
    }
  }
}

/**
 * A shift sent to the Trash (by a person, or by a series no longer making that date): its open
 * offer is cancelled (its offerer told), and its person, if it was live and ahead, is told.
 */
export async function shiftRemoved(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  values: Record<string, unknown> | null,
  shift: Shift | null,
): Promise<void> {
  const title = values ? shiftTitle(object, values) : object.label;
  const link = shiftLink(object.name, id);
  const why = "The shift was removed.";
  ctx.write(cancelOpenOfferStatement(ctx, object.name, id, why));
  const offer = await openOfferOn(ctx.db, object.name, id);
  const zone = values ? shiftZone(object, values) : null;
  if (offer) {
    await gather(ctx, {
      to: offer.from_account ?? offer.made_by,
      kind: "offer",
      title: `Your offer was cancelled: ${title}`,
      body: why,
      line: `${title}: ${why}`,
      starts: shift?.starts ?? null,
      link,
    });
  }
  if (shift?.live && shift.account && values) {
    const starts = shift.starts;
    if (starts !== null && starts * 1000 > Date.parse(ctx.now)) {
      const when = await whenOf(ctx, starts, zone);
      await gather(ctx, {
        to: shift.account,
        kind: "cancelled",
        title: `Your shift was removed: ${title}`,
        body: `${title}, ${when}, was removed by ${await staffName(ctx.db, actingAccount(ctx))}.`,
        line: `Removed: ${title}, ${when}`,
        starts,
        link,
      });
    }
  }
}
