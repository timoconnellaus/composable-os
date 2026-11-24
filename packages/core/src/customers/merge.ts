// Customer accounts when two people merge (stage 22, ADR 0402), queued in person.merge's batch.
//
// - The duplicate's account moves to the survivor.
// - When both people have an account the merge is refused while both are active: staff disable
//   one first (customer.disable). The disabled one is then deleted with its sessions, and the
//   other stays on, or moves to, the survivor. When both are disabled, the duplicate's goes.
// - An account waiting for staff to merge people (`needs_merge`) whose address is the survivor's
//   alone once the merge is done is linked to the survivor, unless the survivor already has one.
// - Erase requests about the duplicate move to the survivor (except an open one, while the
//   survivor has its own: person.erase on the survivor still reaches it, with the merged record).
//
// Accounts are not records: this reads `core_customer` and `core_erase_request` only. Who has an
// address is the same-email rule's answer (`checkPerson`), as at sign-in.
import { sql } from "kysely";
import { checkPerson } from "../duplicates/check.ts";
import { ConflictError } from "../errors.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";

interface AccountRow {
  id: string;
  person_id: string | null;
  status: "active" | "disabled";
}

/**
 * Queues what merging `mergedId` into `survivorId` does to their customer accounts. `addresses`
 * are both people's email addresses. Throws a ConflictError, before anything is queued, when
 * both have an active account.
 */
export async function queueMergeCustomers(
  ctx: HandlerContext,
  survivorId: string,
  mergedId: string,
  addresses: readonly string[],
): Promise<void> {
  const accounts = (await ctx.db
    .selectFrom("core_customer")
    .select(["id", "person_id", "status"])
    .where("person_id", "in", [survivorId, mergedId])
    .execute()) as AccountRow[];
  const survivors = accounts.find((a) => a.person_id === survivorId);
  const merged = accounts.find((a) => a.person_id === mergedId);

  const remove = (account: AccountRow) => {
    ctx.write(
      ctx.db.deleteFrom("core_customer_session").where("customer_id", "=", account.id),
      // A deleted account's calendar link goes with it (ADR 0890); the kept account keeps its own.
      ctx.db.deleteFrom("core_customer_feed").where("customer_id", "=", account.id),
      ctx.db.deleteFrom("core_customer").where("id", "=", account.id),
    );
    ctx.recordChange({
      object: "customer",
      id: account.id,
      action: "delete",
      before: { personId: account.person_id, status: account.status },
    });
  };
  const move = (account: AccountRow) => {
    ctx.write(
      ctx.db
        .updateTable("core_customer")
        .set({ person_id: survivorId, updated_at: ctx.now })
        .where("id", "=", account.id),
    );
    ctx.recordChange({
      object: "customer",
      id: account.id,
      action: "update",
      before: { personId: mergedId },
      after: { personId: survivorId },
    });
  };

  let survivorHasAccount = Boolean(survivors);
  if (survivors && merged) {
    if (survivors.status === "active" && merged.status === "active") {
      throw new ConflictError(
        "Both people have a customer account. Disable one of them (customer.disable), then " +
          "merge again: the disabled account is deleted and the other one is kept.",
        { accounts: [survivors.id, merged.id] },
      );
    }
    if (merged.status === "disabled") {
      remove(merged);
    } else {
      // The survivor's own is the disabled one: it goes first, so the other can take its place.
      remove(survivors);
      move(merged);
    }
  } else if (merged) {
    move(merged);
    survivorHasAccount = true;
  }

  // Accounts waiting for this merge: linked when their address is now the survivor's alone.
  const waiting = addresses.length
    ? await ctx.db
        .selectFrom("core_customer")
        .select(["id", "email"])
        .where("link_state", "=", "needs_merge")
        .where("email", "in", jsonList(addresses))
        .orderBy("created_at")
        .orderBy("id")
        .execute()
    : [];
  for (const account of waiting) {
    if (survivorHasAccount) break;
    const { conflicts } = await checkPerson(ctx.db, { emails: [account.email] });
    const holders = new Set(conflicts.map((c) => c.id));
    if (![...holders].every((id) => id === survivorId || id === mergedId)) continue;
    ctx.write(
      ctx.db
        .updateTable("core_customer")
        .set({ person_id: survivorId, link_state: "linked", updated_at: ctx.now })
        .where("id", "=", account.id),
    );
    ctx.recordChange({
      object: "customer",
      id: account.id,
      action: "update",
      before: { personId: null, linkState: "needs_merge" },
      after: { personId: survivorId, linkState: "linked" },
    });
    survivorHasAccount = true;
  }

  // Erase requests follow the Person.
  const survivorOpen = await ctx.db
    .selectFrom("core_erase_request")
    .select("id")
    .where("person_id", "=", survivorId)
    .where("status", "=", "open")
    .executeTakeFirst();
  ctx.write(
    ctx.db
      .updateTable("core_erase_request")
      .set({ person_id: survivorId })
      .where("person_id", "=", mergedId)
      .where(survivorOpen ? sql<boolean>`status <> 'open'` : sql<boolean>`1 = 1`),
  );
}
