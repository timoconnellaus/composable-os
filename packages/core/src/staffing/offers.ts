// Offers of shifts (stage 45 step 3, ADR 0623): what an offer is in the database and the
// statements that move it. An offer leaves `open` once; migration 0812's trigger refuses every
// later move, so of two writes that would both end one offer (twenty takes at once, a take and a
// rosterer's reassignment) exactly one commits and the others fail whole.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { loadGeneralSettings } from "../settings.ts";
import { localParts } from "../time/local.ts";

/**
 * How long before a shift starts its offer closes (minutes): it can be made and taken until then,
 * and lapses at it (decision 21). The Rostering pack's setting from step 4.
 */
export const OFFER_CUTOFF_MINUTES = 60;

/** Why an offer left `open` without being taken. */
export type OfferEnd = "withdrawn" | "cancelled" | "lapsed";

export type OfferRow = NonNullable<Awaited<ReturnType<typeof openOfferOn>>>;

/** The open offer of a shift, or null. */
export async function openOfferOn(db: Kysely<CoreDatabase>, object: string, id: string) {
  return (
    (await db
      .selectFrom("core_staff_offer")
      .selectAll()
      .where("object_type", "=", object)
      .where("record_id", "=", id)
      .where("state", "=", "open")
      .executeTakeFirst()) ?? null
  );
}

/** An offer by its id, in any state. */
export async function offerById(db: Kysely<CoreDatabase>, id: string) {
  return (
    (await db.selectFrom("core_staff_offer").selectAll().where("id", "=", id).executeTakeFirst()) ??
    null
  );
}

/** The statement that makes an offer (refused by the database if the shift has one open). */
export function makeOfferStatement(
  ctx: HandlerContext,
  offer: {
    object: string;
    id: string;
    from: string | null;
    to: string | null;
    starts: number;
    kind: { object: string; id: string } | null;
  },
) {
  const id = newId("staffOffer");
  return {
    id,
    statement: ctx.db.insertInto("core_staff_offer").values({
      id,
      object_type: offer.object,
      record_id: offer.id,
      from_account: offer.from,
      made_by: ctx.user.id,
      to_account: offer.to,
      starts: offer.starts,
      kind_object: offer.kind?.object ?? null,
      kind_record: offer.kind?.id ?? null,
      state: "open",
      made_at: ctx.now,
      taken_by: null,
      taken_at: null,
      ended_at: null,
      ended_by: null,
      why: null,
    }),
  };
}

/**
 * The statement that ends an open offer. By its id alone: the database refuses it, failing the
 * whole batch, if the offer left `open` meanwhile.
 */
export function endOfferStatement(
  ctx: HandlerContext,
  offerId: string,
  end: OfferEnd,
  why: string,
) {
  return ctx.db
    .updateTable("core_staff_offer")
    .set({ state: end, ended_at: ctx.now, ended_by: ctx.user.id, why: why.slice(0, 200) })
    .where("id", "=", offerId);
}

/**
 * The statement that cancels the shift's open offer, if there is one at commit (an offer made
 * while the write that cancels it was in flight included). Matching nothing is not an error.
 */
export function cancelOpenOfferStatement(
  ctx: HandlerContext,
  object: string,
  id: string,
  why: string,
) {
  return ctx.db
    .updateTable("core_staff_offer")
    .set({ state: "cancelled", ended_at: ctx.now, ended_by: ctx.user.id, why: why.slice(0, 200) })
    .where("object_type", "=", object)
    .where("record_id", "=", id)
    .where("state", "=", "open");
}

/**
 * The shift of an open offer moved, or became another kind of work: the offer follows (the minute
 * cron lapses by its start; a taker's list reads by its kind).
 */
export function followShiftStatement(
  ctx: HandlerContext,
  object: string,
  id: string,
  shift: { starts: number; kind: { object: string; id: string } | null },
) {
  return ctx.db
    .updateTable("core_staff_offer")
    .set({
      starts: shift.starts,
      kind_object: shift.kind?.object ?? null,
      kind_record: shift.kind?.id ?? null,
    })
    .where("object_type", "=", object)
    .where("record_id", "=", id)
    .where("state", "=", "open");
}

/** The take: the offer is the caller's. Refused by the database if it is no longer open. */
export function takeOfferStatement(ctx: HandlerContext, offerId: string) {
  return ctx.db
    .updateTable("core_staff_offer")
    .set({
      state: "taken",
      taken_by: ctx.user.id,
      taken_at: ctx.now,
      ended_at: ctx.now,
      ended_by: ctx.user.id,
      why: null,
    })
    .where("id", "=", offerId);
}

/** Whether a shift starting at `starts` (unix seconds) is past its offer's cut-off at `now`. */
export function pastCutoff(starts: number | null, now: string): boolean {
  if (starts === null) return true;
  return starts - OFFER_CUTOFF_MINUTES * 60 <= Math.floor(Date.parse(now) / 1000);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A shift's start as notices show it: its local date and time in its zone (or the org's). */
export async function whenOf(
  ctx: Pick<HandlerContext, "db">,
  starts: number | null,
  zone: string | null,
): Promise<string> {
  if (starts === null) return "no time set";
  const tz = zone ?? (await loadGeneralSettings(ctx.db)).timezone;
  try {
    const p = localParts(starts * 1000, tz);
    return `${p.date} ${pad(p.hour)}:${pad(p.minute)}`;
  } catch {
    return new Date(starts * 1000).toISOString();
  }
}
