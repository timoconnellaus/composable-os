// An invoice's money states follow its order (stage 35, ADR 0731): a hook on the order's moves, in
// the batch of the write that makes the move (ADR 0426), so no path is missed. Nothing sets an
// invoice's money state from a caller's input.
//
//   order to `part_paid`   invoice to `part_paid` (a part payment, or a paid one reversed)
//   order to `paid`        invoice to `paid` (paid, or paid and credited until nothing is owed)
//
// `credited` and `void` are set by the operations that credit and void an invoice, which cancel
// its order in the same write; this hook leaves a cancelled order's invoice to them. A refunded
// order's invoice stays `paid`: what went back is on its credit notes.
import { type MoveHook, onRecordMove } from "../records/lifecycle.ts";
import { loadDocument } from "./drafts.ts";

const FOLLOWS: Readonly<Record<string, "part_paid" | "paid" | "unpaid">> = {
  part_paid: "part_paid",
  paid: "paid",
  // Every payment reversed (ADR 0733): issued again, or sent when it was sent.
  pending: "unpaid",
};

const invoiceFollowsOrder: MoveHook = async (ctx, move) => {
  const invoiceId = move.after.invoiceId;
  if (typeof invoiceId !== "string") return;
  const follows = FOLLOWS[move.to.id];
  // Created into pending: issuing writes the invoice itself.
  if (!follows || move.from === null) return;
  const invoice = await loadDocument(ctx.db, "invoice", invoiceId);
  const to = follows === "unpaid" ? (invoice.sent_at ? "sent" : "issued") : follows;
  if (invoice.state === to || invoice.state === "draft") return;
  if (invoice.state === "credited" || invoice.state === "void") return;
  // The host's write, against the version read: a write made meanwhile fails this batch.
  ctx.write(
    ctx.db
      .updateTable("core_invoice")
      .set({ state: to, version: invoice.version + 1, updated_at: ctx.now })
      .where("id", "=", invoiceId),
  );
};

onRecordMove("order", invoiceFollowsOrder);
