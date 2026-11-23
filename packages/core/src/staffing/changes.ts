// What a write to a shift tells people, and what it does to the shift's open offer (stage 45 step
// 3, ADRs 0623 and 0624). Called by staffing/index.ts for every write the record operations make
// to a staffed object (a person editing a class's coach, a rosterer's assign, the assistant once a
// person approved it, an import), in the write's own batch, so whatever wrote it the same people
// are told:
//
// - the shift's open offer is cancelled when the shift goes to someone else or stops being live
//   (its offerer told), except by the take of that offer itself;
// - the person put on a shift, or taken off one, by someone else is told, and so is the person
//   whose shift changed time or was cancelled; the host's own writes (a series' generation and
//   changes) tell nobody here;
// - a live shift in the uncovered window left with nobody on it is told to the rosterers at once.
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import type { Mover } from "../records/transitions.ts";
import type { Shift } from "./index.ts";
import { endOfferStatement, openOfferOn, whenOf } from "./offers.ts";
import { queueNotice, rosterers, shiftLink, staffName } from "./rosterers.ts";

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
  const wasLive = w.beforeShift?.live ?? false;
  const ended = wasLive && !w.shift.live;

  // Its open offer: cancelled when it goes to someone else or is no longer a shift. The statement
  // fails the batch if the offer was taken meanwhile, so a reassignment and a take never both land.
  if (w.before !== null && (whoChanged || ended)) {
    const offer = await openOfferOn(ctx.db, w.object.name, w.id);
    if (offer && offer.id !== w.taking) {
      const why = ended
        ? "The shift was cancelled."
        : "The shift was given to someone else, so the offer was cancelled.";
      ctx.write(endOfferStatement(ctx, offer.id, "cancelled", why));
      await queueNotice(ctx, {
        to: [offer.from_account ?? offer.made_by],
        title: `Your offer was cancelled: ${title}`,
        body: why,
        link,
      });
    }
  }

  if (w.by === "host" || w.taking) return;
  let actor: string | null = null;
  const actorName = async () => {
    actor ??= await staffName(ctx.db, ctx.user.id);
    return actor;
  };
  const was = w.beforeShift?.account ?? null;
  const now = w.shift.account;
  const when = () => whenOf(ctx, w.shift.starts, zone);
  if (was !== now) {
    if (now && w.shift.live) {
      await queueNotice(ctx, {
        to: [now],
        title: `You are on a shift: ${title}`,
        body: `${await actorName()} put you on ${title}, ${await when()}.`,
        link,
      });
    }
    if (was && wasLive) {
      await queueNotice(ctx, {
        to: [was],
        title: `You are off a shift: ${title}`,
        body: `${await actorName()} took you off ${title}, ${await whenOf(ctx, w.beforeShift?.starts ?? null, zone)}.`,
        link,
      });
    }
  } else if (now && wasLive) {
    if (ended) {
      await queueNotice(ctx, {
        to: [now],
        title: `Your shift was cancelled: ${title}`,
        body: `${title}, ${await when()}, was cancelled by ${await actorName()}.`,
        link,
      });
    } else if (timeChanged) {
      const before = await whenOf(ctx, w.beforeShift?.starts ?? null, zone);
      await queueNotice(ctx, {
        to: [now],
        title: `Your shift changed time: ${title}`,
        body: `It was ${before}; it is now ${await when()}. Changed by ${await actorName()}.`,
        link,
      });
    }
  }

  // Left with nobody on it, inside the uncovered window: the rosterers hear at once.
  const nowUncovered =
    w.shift.live && !w.shift.covered && (w.before === null || !wasLive || w.beforeShift?.covered);
  if (nowUncovered && w.inWindow) {
    await queueNotice(ctx, {
      to: await rosterers(ctx.db),
      title: `A shift has nobody on it: ${title}`,
      body: `${title}, ${await when()}, has nobody on it.`,
      link,
    });
  }
}

/**
 * A shift sent to the Trash: its open offer is cancelled (its offerer told), and its person, if
 * it was live and someone else removed it, is told.
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
  const offer = await openOfferOn(ctx.db, object.name, id);
  if (offer) {
    const why = "The shift was removed.";
    ctx.write(endOfferStatement(ctx, offer.id, "cancelled", why));
    await queueNotice(ctx, {
      to: [offer.from_account ?? offer.made_by],
      title: `Your offer was cancelled: ${title}`,
      body: why,
      link,
    });
  }
  if (shift?.live && shift.account && values) {
    const starts = shift.starts;
    if (starts !== null && starts * 1000 > Date.parse(ctx.now)) {
      await queueNotice(ctx, {
        to: [shift.account],
        title: `Your shift was removed: ${title}`,
        body: `${title}, ${await whenOf(ctx, starts, shiftZone(object, values))}, was removed by ${await staffName(ctx.db, ctx.user.id)}.`,
        link,
      });
    }
  }
}
