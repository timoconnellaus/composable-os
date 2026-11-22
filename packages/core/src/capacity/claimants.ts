// Capacity claimants (stage 31, ADR 0501): a record whose own states hold, take and give back one
// place on the record its relation `on` points to (a booking on its class). Orders claim through
// their move hook (orders/holds.ts); a claimant declares the same thing, and the transition
// engine (records/lifecycle.ts) calls `claimantMove` on every move of one, for every actor, in the
// batch of the write that makes it:
//
//   into a `held` state from neither           a hold of one place (claimStatements)
//   into a `confirmed` state from neither      a hold, taken at once (claim, then confirm)
//   from `held` into `confirmed`               the hold taken (confirmStatements)
//   from `held` into neither                   the hold given back (releaseStatements)
//   from `confirmed` into neither              the place given back (releaseStatements, confirmed)
//   between two states of one kind             nothing
//
// The claim is `for: { type: <the claimant's object>, id: <the record> }`, so the confirm and the
// release name it without a read. The places are refused by the database past the counter, as
// an order's are (migration 0440): of 20 bookings at once for the last place, one is made.
import { ConflictError, ValidationError } from "../errors.ts";
import type { ClaimsDefinition, ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { type ClaimTarget, confirmStatements, releaseStatements } from "./holds.ts";
import { queueClaim } from "./records.ts";
import { releaseAllWaitlistHoldsStatements } from "./waitlist.ts";

type ClaimKind = "held" | "confirmed" | null;

function kindOf(claims: ClaimsDefinition, state: unknown): ClaimKind {
  if (typeof state !== "string") return null;
  if (claims.held.includes(state)) return "held";
  if (claims.confirmed.includes(state)) return "confirmed";
  return null;
}

/** What a claimant's record holds in its state as stored. */
export function claimKind(object: ObjectDefinition, values: Record<string, unknown> | null) {
  if (!object.claims || !object.states || !values) return null;
  return kindOf(object.claims, values[object.states.field]);
}

/**
 * Queues the claim statements for a claimant's move from `before` (null on create) to `after`.
 * Throws when a record entering a claiming state names no record to claim on.
 */
export async function claimantMove(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  const claims = object.claims;
  const field = object.states?.field;
  if (!claims || !field) return;
  const from = before === null ? null : kindOf(claims, before[field]);
  const to = kindOf(claims, after[field]);
  if (from === to) return;
  const target: ClaimTarget = { for: { type: object.name, id } };
  if (from === "held") {
    ctx.write(
      ...(to === "confirmed"
        ? confirmStatements(target, ctx.now)
        : releaseStatements(target, ctx.now)),
    );
    return;
  }
  if (from === "confirmed") {
    ctx.write(...releaseStatements(target, ctx.now, { confirmed: true }));
    if (to === null) return;
  }
  const on = after[claims.on];
  if (typeof on !== "string" || on === "") {
    const label = object.fields.find((f) => f.name === claims.on)?.label ?? claims.on;
    throw new ValidationError(`${object.label} needs ${label} to hold a place`, {
      field: claims.on,
      rule: "capacity",
    });
  }
  const claim = await queueClaim(ctx, {
    object: claims.object,
    record: on,
    quantity: 1,
    for: { type: object.name, id },
  });
  if (to === "confirmed") ctx.write(...confirmStatements({ claim }, ctx.now));
}

/**
 * Refuses changing a claimant's `on` while its record holds or takes a place there: moving a
 * booking to another class is a new booking, so the place is given back where it was taken.
 */
export function assertClaimRelationKept(
  object: ObjectDefinition,
  before: Record<string, unknown> | null,
  written: Record<string, unknown>,
): void {
  const claims = object.claims;
  if (!claims || before === null || !Object.hasOwn(written, claims.on)) return;
  if ((written[claims.on] ?? null) === (before[claims.on] ?? null)) return;
  if (claimKind(object, before) === null) return;
  const label = object.fields.find((f) => f.name === claims.on)?.label ?? claims.on;
  throw new ValidationError(
    `${object.label} holds a place on its ${label.toLowerCase()}, so its ${label.toLowerCase()} cannot change`,
    { field: claims.on, rule: "claim_relation_kept" },
  );
}

/** Refuses moving a claimant to Trash while it holds or takes a place: move it out first. */
export async function assertNoLiveClaim(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<void> {
  if (!object.claims) return;
  const row = await ctx.db
    .selectFrom("core_capacity_claim")
    .select("state")
    .where("for_type", "=", object.name)
    .where("for_id", "=", id)
    .where("state", "in", ["held", "confirmed"])
    .executeTakeFirst();
  if (row) {
    throw new ConflictError(
      `${object.label} holds a place; move it to a state that gives the place back before deleting it`,
      { rule: "capacity", reason: "claim_live", object: object.name, record: id },
    );
  }
}

/** The statements that give back every place a claimant object's records hold or take. */
export function releaseAllClaimsStatements(object: string, now: string) {
  const target: ClaimTarget = { forType: object };
  return [
    ...releaseStatements(target, now),
    ...releaseStatements(target, now, { confirmed: true }),
    // And the places its waitlist held for its waiters (ADR 0520).
    ...releaseAllWaitlistHoldsStatements(object, now),
  ];
}

/** The statements that give back every place one claimant record holds or takes (an erase). */
export function releaseAllClaimsOfStatements(object: string, id: string, now: string) {
  const target: ClaimTarget = { for: { type: object, id } };
  return [
    ...releaseStatements(target, now),
    ...releaseStatements(target, now, { confirmed: true }),
  ];
}
