# ADR 0426: Who moves a record, and what follows a move

Status: accepted, 2026-11-21 (stage 25 build, second half). Builds on
[ADR 0425](0425-one-transition-engine-for-stages-and-states.md), which listed these as what the
second half needed from the engine.

## Context
ADR 0425 gave a move three possible movers (`staff`, `customer`, `host`) and left two of them
without a caller: every call through an operation moved as `staff`, and the engine wrote
`ctx.user.id` as the author of every history row. Stage 22 then made `ctx.user` throw on a
customer's or the public's call. Orders also need platform code to act when an order moves
(confirm its places, grant what it paid for) in the same batch, and a Person's erase has to reach
the engine's history.

## Decision

**A signed-in customer is the `customer` mover.** `callerMover(ctx)` answers `staff` for anyone
who works for the organisation, `customer` for a customer, and refuses the public: they move no
record. It reads who the call is really for. When a customer changes their own record through
the seam, the host writes it for them with a context whose `principal` is the org's (the host's
own reads are org-wide), so the pipeline now sets `onBehalfOf` on that context to the real
caller, and the engine reads that first (`callerOf`). A move for `staff` only is refused to a
customer whether their handler asks or the host writes for them.

**A move by someone outside the org names no staff author.** `entered_by` is the staff user for a
staff call and null otherwise; `entered_as` says who moved it (`customer`, or `host` for platform
code acting during their call).

**A hook when a record moves, for platform code only.** `onRecordMove(object, hook)`
(`records/lifecycle.ts`) registers a function the engine calls after it has allowed a move and
before the write is queued. The hook gets the move (from, to, who, the record before and as the
write leaves it), queues its own statements with `ctx.write` and may throw to refuse the write.
So what follows a move commits with it or not at all, for every actor, and the approval queue's
dry run runs it with its writes discarded. It is registered at module load by code in the host.
It is not in the SDK or the contract: ADR 0404 stands, and no extension hooks a write.

**State titles for an object declared in core.** The engine reads a state's title from the state
field's `choices`. A core object's field may carry them (`fields/order.ts`), so an order's states
read "Part paid", not `part_paid`, in refusals and history.

**Platform code moves a core object by calling the engine itself.** `updateRecordAsHost` is the
way for an extension object. A base record in core has its own write code, which calls
`applyTransition` with the mover (`orders/orders.ts`, `changeOrder`). Both pass `host` only from
code that has itself established why.

**Erase reaches the history.** `core_transition_history` rows whose record is the erased Person or
Organisation are deleted with it (`queueEraseOrders` in `records/erase-stores.ts`). An erased
Person's orders are kept as amounts with no one on them: the order loses its person, the address
it was placed with and the guest's token. Its lines, payments and history name the order, never
the person, and stay, so the organisation's books still add up.

## Why
- The mover has to be who is really acting, or "a customer may cancel their own booking and
  nothing else" cannot be declared. Reading it from the context keeps it out of any input.
- A hook the host owns is the smallest thing that lets `capacity` and `sellable` act in the paid
  batch without teaching the engine about either, and without giving extensions a write hook.
- Deleting an erased person's orders would change what the organisation was paid. Keeping them
  with nothing that identifies the buyer is what an erase can do without falsifying the totals.

## Consequences
- `HandlerContext` gains an optional `onBehalfOf`. It is set in one place (the outside path's
  host context) and read in one place (`callerOf`).
- A hook runs inside the write path, so it must stay cheap and must not read what it can be
  handed. Stage 26 registers the first real one for orders (`orders/holds.ts` is its marked,
  empty place).
- The public can still create a record in its initial state through platform code that passes
  `host` (a guest's order): creating is not a move a caller makes.
