// A paid order's sale takes on hand down (ADR 0680), so it may take a record to its reorder level:
// the low-stock check (ADR 0681) watches the order's stock lines when the order is paid, or
// honoured late, as orders/holds.ts writes their `sold` movements. The check runs at the end of
// the batch, after the sale, whichever hook runs first.
import "../orders/holds.ts";
import { getObject } from "../fields/index.ts";
import { onRecordMove } from "../records/lifecycle.ts";
import { watchLow } from "./low.ts";

onRecordMove("order", async (ctx, move) => {
  const to = move.to.id;
  const from = move.from?.id ?? null;
  if ((to !== "paid" && to !== "part_paid") || (from !== "pending" && from !== "expired")) return;
  const lines = await ctx.db
    .selectFrom("core_order_line")
    .select(["object_type", "record_id"])
    .where("order_id", "=", move.id)
    .execute();
  const byObject = new Map<string, string[]>();
  for (const line of lines) {
    if (!getObject(line.object_type)?.stock?.reorderAt) continue;
    byObject.set(line.object_type, [...(byObject.get(line.object_type) ?? []), line.record_id]);
  }
  for (const [object, records] of byObject) watchLow(ctx, object, records);
});
