// STAGE 26, HOLDS: where an order's places are confirmed and released (stage 25 leaves this
// empty; stage 26's `capacity` fills it when the two meet on main).
//
// The claim is taken in `createOrder` (orders/orders.ts, the comment marked STAGE 26). This file
// is the other half: a hook on the order's moves, in the batch of the write that makes the move.
//
//   to `part_paid` or `paid` from `pending`   confirm the order's holds
//                                             confirmStatements({ for: { type: "order", id } })
//   to `paid` from `expired` (honoured late)  claim again: the holds were released at expiry;
//                                             a refusal fails the batch, so the order stays
//                                             expired and staff refund instead
//   to `cancelled` or `expired`               release: held places from `pending`, confirmed
//                                             ones (`{ confirmed: true }`) from `part_paid`
//   to `refunded`                             release confirmed places, unless a line's object
//                                             declares `releaseOnRefund: false`
//
// A hold has no clock of its own (ADR 0404): nothing here reads a time. A part-paid order keeps
// its places until it is paid or staff cancel it, however long that is.
import { type MoveHook, onRecordMove } from "../records/lifecycle.ts";

const orderHolds: MoveHook = () => {
  // Nothing until stage 26: an order takes no places yet, so two orders can still be started for
  // the last one (stage 25's spec, "Out of scope").
};

onRecordMove("order", orderHolds);
