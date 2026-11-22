// A person merge moves their subscriptions (stage 32a review, ADRs 0487 and 0489): the merged
// Person's subscriptions, checkouts and trials become the survivor's, in the merge's own batch, so
// what they pay for keeps giving access, they still see and cancel it, and the one-trial rule
// still counts the trial they had.
//
// When both had a trial row on the same plan object, one is kept: the earliest used one if either
// was used, else the earliest hold. The others are deleted (an update, then deletes: no insert, so
// the one-hold trigger is not met). A page whose hold was dropped can still be completed at the
// provider; its confirmation is then told to staff as a second trial (ADR 0489).
import type { HandlerContext } from "../operation.ts";

export async function queueMergeSubscriptions(
  ctx: HandlerContext,
  survivorId: string,
  mergedId: string,
): Promise<void> {
  const rows = await ctx.db
    .selectFrom("core_subscription_trial")
    .select(["checkout_id", "holder_person_id", "plan_object", "used_at", "created_at"])
    .where("holder_person_id", "in", [survivorId, mergedId])
    .execute();
  const drop: string[] = [];
  const byPlan = new Map<string, typeof rows>();
  for (const row of rows)
    byPlan.set(row.plan_object, [...(byPlan.get(row.plan_object) ?? []), row]);
  for (const group of byPlan.values()) {
    const holders = new Set(group.map((r) => r.holder_person_id));
    if (holders.size < 2) continue;
    const used = group.filter((r) => r.used_at !== null);
    const pool = used.length ? used : group;
    const keep = [...pool].sort((a, b) =>
      (a.used_at ?? a.created_at).localeCompare(b.used_at ?? b.created_at),
    )[0];
    for (const r of group) if (r.checkout_id !== keep?.checkout_id) drop.push(r.checkout_id);
  }
  ctx.write(
    ctx.db
      .updateTable("core_subscription")
      .set({ payer_person_id: survivorId })
      .where("payer_person_id", "=", mergedId),
    ctx.db
      .updateTable("core_subscription")
      .set({ holder_person_id: survivorId })
      .where("holder_person_id", "=", mergedId),
    ctx.db
      .updateTable("core_subscription_checkout")
      .set({ payer_person_id: survivorId })
      .where("payer_person_id", "=", mergedId),
    ctx.db
      .updateTable("core_subscription_checkout")
      .set({ holder_person_id: survivorId })
      .where("holder_person_id", "=", mergedId),
    ...(drop.length
      ? [ctx.db.deleteFrom("core_subscription_trial").where("checkout_id", "in", drop)]
      : []),
    ctx.db
      .updateTable("core_subscription_trial")
      .set({ holder_person_id: survivorId })
      .where("holder_person_id", "=", mergedId),
    // Continuation offers (ADR 0491): still tied to their address, now the survivor's Person. One
    // is taken only by a customer signed in as that address, so an offer under an address the
    // survivor's account does not sign in with waits for staff to import it under that one.
    ctx.db
      .updateTable("core_subscription_offer")
      .set({ person_id: survivorId })
      .where("person_id", "=", mergedId),
  );
}
