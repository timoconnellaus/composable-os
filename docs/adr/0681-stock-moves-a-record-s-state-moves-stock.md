# ADR 0681: `stockMoves`: a record's state moves stock in its batch, and low stock is the host's notice

Status: accepted, 2026-11-24 (stage 37, build step 2). Builds on
[ADR 0680](0680-the-stock-behaviour.md) (the `stock` behaviour), [ADR 0425](0425-one-transition-engine-for-stages-and-states.md) (the
transition engine) and [ADR 0624](0624-the-rosters-notices-uncovered-shifts-and-leaving.md) (the
host's notices, gathered at the end of a call).

## Context
Stock changes for reasons a shop's records hold: a delivery received, a count applied, a breakage
written off, later a part fitted on a job. These are a pack's records, but a pack may not hook a
write (ADR 0404) and its code cannot keep the counter: a movement must commit in the batch of the
write that causes it, for every actor, or a receipt could be marked received without its stock, or
twice. A count must set on hand to what was counted even while sales go on, and must never make
stock that unpaid orders hold vanish. Staff need to hear when something runs low, whatever wrote
it: a sale on the website, a count, a write-off, an import.

## Decision
- **An object declares `stockMoves`** (SDK `packages/sdk/src/stock.ts`): `{ move, on, quantity,
  when, through?, kind?, unitCost?, note? }`. `on` is a relation (one record) to an object of the
  same extension with stock; `quantity` a number field; `move` is `add`, `remove` or `set`. When a
  record enters `when`, the host writes a movement of its quantity on the record `on` points to.
  `kind` is the ledger's (`received` for add; `written_off`, the default, or `used` for remove;
  `counted` for set); `unitCost` (add only) and `note` feed the ledger row. **No declared move may
  leave `when`**: stock moves once per record. A runtime extension cannot declare it (install
  refuses it, as `stock`).
- **Moving stock is a person's act** (the review of PR #422). Every declared move into `when` is
  by `["host"]` alone, with the `tools` a person makes it through (ADR 0513: each `humanOnly` or
  `personApproves`, with a permission: the pack's `shop:stock`), and nothing is created in `when`
  but by the host. So `record.update` or `record.create` by a member, an automation, a customer,
  the assistant or an MCP client never moves stock; the pack's tool does, and an AI's call of a
  `personApproves` tool waits for a person who holds its permission, as `stock.adjust` does. A
  quick stock-in is a receipt made and moved through the tool in one call.
- **`through`**: the state is another record's. A count line declares `through: "count"`, `when:
  "applied"`: the count entering `applied` moves every live line pointing to it, in one batch (up
  to 500 lines; more is refused, split the count). The line object needs no states.
- **The transition engine runs it** (`records/lifecycle.ts`, `stock/moves.ts`), beside claimants,
  so record.create, record.update, the import and platform moves all move stock, and the approval
  queue's dry run judges it.
- **Three statements whatever the number of lines**, the lines as one JSON parameter: the counters
  made if missing; for add and remove, each counter's places moved by its lines' sum and a ledger
  row per line; for set, a `counted` row per line whose number differs from on hand **as the batch
  commits** (by that difference), then each counter set so on hand is the number counted. A sale
  between reading the lines and committing is counted in the difference. Too few on hand for a
  removal, or a count below what unpaid orders hold, fails the whole batch through migration
  0440's trigger, with the record, on hand and held (`rule: "stock"`; "Count again in a few
  minutes" when orders hold some). A set counting one record on two lines is refused.
- **What moved stock stays as it moved.** A record in its `when` cannot change `on`, `quantity`,
  `unitCost` or `note`; a line cannot be added to, moved to, changed on or restored from the
  Trash onto a record that is in its `when` (one read per parent per call). Other fields stay
  editable.
- **A count and its lines never race** (the review of PR #422). A line's write queues an
  `unmoved` guard on its parent's state history (migration 0670), so a count applied between the
  line's read and its commit fails the line's batch. The apply queues a guard on its lines' count
  and latest change as read, so a line added, edited, trashed or restored between the apply's read
  and its commit fails the apply. Either way the answer is a conflict (`moved_meanwhile`: look
  again), and what commits is consistent.
- **Low stock is the host's notice** (`stock/low.ts`). `stock.notify` names a tool permission of
  the same extension (with `reorderAt`); its holders are told, as a tool naming it would let them
  in: admins, members unless it is restricted, an account whose pack role of that pack lists it,
  and an account a human admin granted it while the pack declares it grantable. Without `notify`,
  the admins. Every write that changes on hand notes its records: `stock.opening`, `stock.adjust`,
  `stockMoves`, a paid order's sale (an order move hook, `stock/sold.ts`) and a change of a
  record's reorder level. At the end of the call (`beforeCommit`, ADR 0624) four statements per
  object run after everything else in the batch: records now above their level (or with none) end
  their crossing; records at or below begin one if they have none (`core_stock_low`, migration
  0931); each keeper gets one in-app notice (`system.message`, linked to the record, title "<name>
  is low: N on hand") for each crossing not yet told; the crossing is marked told (`told_at`). A
  record that stays low tells nobody again, however long, even after its notices are purged (90
  days); after rising above and falling again it tells everyone again. A simulated call tells
  nobody. An account with a pack role is told only when its role reads the object with no limit
  (`today`, `looksAfter`): the notice names the record and its numbers.

## Consequences
- Receipts, quick stock-in entries, counts and write-offs are plain pack records with states; the
  Shop pack (step 6) adds no stock code. A job's parts (stage 39) can declare `stockMoves` with
  `used`. A target in another extension (a Jobs pack moving Shop's variants) is not allowed yet:
  the contract checks the target's `stock` in the same manifest. Stage 39 widens it.
- A count's apply costs the same statements for 2 lines as for 500, and a paid order's confirm
  adds four per stock object (`test/stock-moves.test.ts`, `test/stock.test.ts`).
- Step 1's rule that a stock object is "sellable with goods or used by stockMoves" is checked as
  "sellable, or the target of a `stockMoves` of its extension"; step 3 narrows sellable to
  `sellable.goods`.
- The spec names `shop:stock` as who is told; core cannot name a pack's permission, so the pack
  names it in `stock.notify`.
- Moving a line or a received record to Trash changes nothing in stock: the ledger keeps the
  movement and its source. A correction is a write-off, a receipt or `stock.adjust`.
- A keeper given the permission after a crossing began is not told of it: the crossing was told
  to the keepers of its time. The next crossing tells them.
- The outside pipeline (customers, the public) has no `beforeCommit`, so a write there runs no
  low-stock check. No such write changes on hand: the contract keeps customers out of stock-moving
  states, and a paid order confirms on the staff pipeline (`order.applyPaymentEvent`).
- The counter's refusal of a removal with nothing held now reads "Not enough on
  hand: this would leave N" rather than naming held stock.
