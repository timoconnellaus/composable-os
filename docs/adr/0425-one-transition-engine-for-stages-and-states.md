# ADR 0425: One transition engine for stages and states

Status: accepted, 2026-11-20 (stage 25 build, first half). Builds on ADRs
[0100](0100-stage-behaviour-and-object-contract-additions.md) and
[0404](0404-behaviours-are-the-vocabulary.md).

## Context
ADR 0100 gave the host one behaviour, `stages`: positions are records an admin edits, and the
rules (required fields, probability, status, history) were written as one function inside the
record operations. Stage 25 needs a second kind of lifecycle: an order is pending, paid or
refunded, the set is fixed in code, and one move (to paid) must be impossible for any caller.
The stage 25 interview decided that these are one engine with two declarations, with one history
table, and that nothing installed anywhere needs an upgrade path.

## Decision

**One engine** (`packages/core/src/records/transitions.ts`). For a write to a record with a
lifecycle it answers three questions and produces two things:

- is the move allowed, which fields does it require, and who may make it;
- the history statements for the write's own batch, and the names the timeline post uses.

It knows nothing about stages or states. A declaration is a `Lifecycle`:

- `place(write)` works out where the write leaves the record: the position before, the position
  after, who may make that move (`by`), the fields the position requires, and the history group.
  It sets defaults and refuses what the declaration alone can judge (a stage of another
  pipeline, a move that is not declared).
- `follow(write, placement, moved)` sets the values that follow the position.
- `refusal(...)` builds the form's error from the engine's refusal.

The engine then does, once, what both forms share: it refuses a mover the move does not list,
refuses entering a position while a required field is empty (and emptying one later), closes the
record's current history row and opens the next, and names the move ("Moved to <position>").
`records/lifecycle.ts` picks an object's declaration and is what `record.create`,
`record.update` and the record CSV import call. The approval queue's dry run runs the same
handlers with their writes discarded, so it reports the same refusals and writes nothing.

**`stages` is the data-driven declaration** (`records/stages.ts`). Its `place` is ADR 0100's
defaulting and group rules; its `follow` is probability, status and the closed date; its required
fields are the stage's own list plus `requiredByType`. A stage move is for `staff` and the `host`:
a customer never moves a record through a pipeline, and is refused with
`stage_move_not_permitted`. Every caller ADR 0100 names is staff, so nothing in its contract
changed.

**`states` is the declared form** (`StatesSpec`, `packages/sdk/src/states.ts`; host side
`records/states.ts`):

```ts
states: {
  field: "state",            // a select; its options are the states
  initial: "pending",
  moves: [
    { from: "pending", to: "paid", by: ["host"], requires: ["reference"] },
    { from: "pending", to: "cancelled", by: ["staff", "customer"], final: true },
  ],
}
```

- A record is created in `initial`. Creating it in another state is judged as the move from
  `initial` to that state, so an import cannot create a record already paid.
- The state field's column has `DEFAULT <initial>` where the reconciler creates it, so a state
  field added to an object that already has records is never empty. Nothing is backfilled: an
  existing select that later gains `states` is put in the initial state by its next update.
- A move is named by where it starts and ends. `final` marks the state entered as the end of the
  lifecycle: nothing moves out of it, and every move into one state must agree.
- A refusal is `invalid_input` with details in the shape of a stage rule's:
  `{ rule, object, field, fields, labels, state: { id, title, final }, from }`, plus `by` (who
  may) or `allowed` (the states reachable). The rules are `state_move_not_declared`,
  `state_move_not_permitted`, `state_final`, `state_required_fields` and `no_state`.
- While a record stays in a state, the fields that every move into that state requires cannot be
  emptied.
- The contract checks validate a declaration (`checkObjectStates`), so `extension.check` and
  `cos ext check` report a bad one. An object declares `stages` or `states`, never both.

**Who moves.** A move lists `staff`, `customer` or `host`.

- Every caller of an operation today is `staff`: people, the assistant, MCP clients, automations
  and extensions (`callerMover`). Stage 22's customer principal is what will answer `customer`;
  until then a customer-only move has no caller and is refused to staff.
- `host` is never a caller. The record operations pass the caller's mover; only a function
  platform code calls from inside its own handler (`updateRecordAsHost`, or `applyTransition`
  with `by: "host"` for a core object) passes `host`, and no operation takes the mover from its
  input. An extension's own code is staff on its own objects. The host is held to the
  declaration too: it can make only declared moves, with their required fields.

**One history table.** `core_stage_history` becomes `core_transition_history`, the engine's
history for both forms (migration 0420). `stage_id` and `stage_type` become `position_id` and
`position_type`, and it gains `form` (`stages` or `states`) and `entered_as` (who moved). A state
row holds the state's value in `position_id`, no group, and `open` or `final` in
`position_type`. Every row is copied with its id. `rec_stage_history` keeps its name and columns
(`stage_id`, `stage_type`) and reads stage rows; `rec_state_history` reads state rows.

**Deals' tests are unchanged except the table's name in two queries.** Two tests read the table
directly, so the rename edits their SQL and nothing else (no assertion):
`apps/runner/test/deals.test.ts:74` (`position_id AS stage_id`, `position_type AS stage_type`,
`FROM core_transition_history`) and `packages/core/test/deals.test.ts:341`
(`FROM core_transition_history`). `apps/runner/test/stage-history-parity.test.ts` holds what
`rec_stage_history` and `x.deals.stageMetrics` returned on the seeded data before the engine, and
still passes unedited.

## Why
- One place for the rules that must not differ between forms: who may move, required fields,
  history written with the write. A third lifecycle form would be a third `Lifecycle`, not a
  third copy.
- The mover is an argument code passes, not data a caller sends, so "only the platform can mark
  an order paid" does not depend on a permission that policy could loosen.
- The table is named for what it holds. The rename is free now (nothing is installed, and the
  migration rebuilds the table anyway) and the view names, which are what extensions and
  dashboards read, do not change.

## Consequences
- Stage rules cost what they did: the same reads, the same two history statements per move.
  A state move reads nothing extra (the declaration is in the registry).
- `StageRuleError` and `StateRuleError` are both `TransitionRuleError`s.
- A timeline post is written when the position's field is `track: "timeline"`, as for stages.
- The second half of stage 25 declares the order's machine on a core object and calls the engine
  from its own operations. `capacity` (stage 26) and `sellable` (stage 27) are separate
  behaviours that will want to act when a move happens; the engine has no such hook yet.
- Deleting a record leaves its history, as before. `core_transition_history` is not yet in the
  erase stores; it joins them in the second half, when a Person's orders have history.
