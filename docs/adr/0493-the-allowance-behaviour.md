# ADR 0493: The allowance behaviour: holders, spenders, and a limit the database keeps

Status: accepted, 2026-11-22 (stage 32b, build step 5). Builds on ADRs
[0404](0404-behaviours-are-the-vocabulary.md), [0425](0425-one-transition-engine-for-stages-and-states.md),
[0430](0430-capacity-is-refused-by-the-database.md) (capacity's pattern, followed here),
[0437](0437-a-move-is-made-from-a-current-read.md) and
[0487](0487-the-payer-and-the-holder.md). Stage 32's spec ("The `allowance` behaviour", decisions
9, 13 and 15, and its amendment of 2026-11-22 by stage 31's agreed spec) and stage 31's spec
("Spending and returning an allowance use"). [ADR 0494](0494-which-holder-pays-and-what-happens-to-uses.md)
decides which holder is spent and what happens to uses when a holder or its Person changes.

## Context
A pass grants ten visits, a membership three classes a week or unlimited ones; a booking spends
one. The rule must hold for every actor (a member on the web or in the app, staff, an MCP client,
the assistant, an import, an approved action), and two bookings at once for the last use must not
both succeed. Extension code cannot run several writes as one transaction and cannot hook a write
(ADR 0404), so the behaviour is the host's. Stage 26's capacity is the same problem for places; this
follows it.

## Decision

**Two declarations** (`allowance` on an object, `packages/sdk/src/allowance.ts`): an object
`holds` uses or `spends` them, never both.

- A **holder** names its Person (`person`), its uses per period (`uses`, a number field; empty is
  unlimited), the period (`per`: `total`, `week` or `month`, or a select field with those options,
  since a membership plan's period varies by record), when it is valid (`from`, `until`: date or
  datetime fields), the states it can be spent in (`live`, required when it has `states`), its zone
  (`zone`, a timezone field; else the organisation's), and what it pays for (`spendsOn`: one or
  several spender objects, each with conditions). None of these fields may be in the holder's
  `customer.write`. Its records carry read-only `used` (this period) and `left` (what can be spent
  now: 0 when not live or outside its dates, empty when unlimited), view columns over its counters.
- A **spender** declares `states` and names its Person, a text field for the holder it spent from
  (`holder`: a caller may set it to choose; the host fills it otherwise), the states that spend
  (`spendIn`) and those that give back (`returnIn`), its time (`at`: a datetime of its own or one
  relation away, `class.startsAt`), fields the host copies onto it from one relation away
  (`copy`: `{ kind: "class.kind" }`), local values it fills from `at` (`local.weekday` 1 to 7 from
  Monday, `local.minute` since local midnight, in `local.zone` or the organisation's), and
  `movedFrom` (below). Copied and local fields must be read-only, so no caller sets what pays
  for it; a field a condition reads must not be in the spender's `customer.write`.
- **Conditions** (`spendsOn.when`) compare a spender field with a holder field or a literal:
  `in` (a holder list such as a membership's class types; empty means any), `atLeast` and `below`
  (a time window by minute of the day). They deliver "limits by class type and by time of day"
  (stage 32's decision 8) without the behaviour knowing what a class is.

**When a use is spent or given back.** In the spender's own write, on the transition engine's
move: entering a `spendIn` state with no open use spends one; entering a `returnIn` state gives
the open one back; every other move keeps it (a late cancel, a no-show, an attendance, decision
15). So a booking created `waiting` spends nothing and spends when promoted to `booked` (stage 31's
amendment 1). A spender holds at most one open use (a partial unique index); a holder field cannot
be changed under an open use. A spender holding a use cannot go to the Trash until it gives it back.

**The period is the spender's time** (amendment 2): the use counts in the holder's period
containing `at`, and the holder must be valid at `at` (a pass that ends before the class cannot pay
for it). Periods are `total`, a week from Monday 00:00 and a month from the 1st at 00:00, in the
holder's zone, named by their local start (`week:2026-11-23`, `month:2026-11`). A week across a
change of clocks is Monday to Monday on the wall clock (167 or 169 hours). A date `until` includes
that day. Unused uses never carry over (decision 9): a period starts at nought.

**The limit is the database's.** `core_allowance` holds each holder's terms, kept by every write to
the holder in its batch (and written at a holder's first spend if it predates its object's
declaration). A spend is three statements with no read of the count first: the period's counter
(made at nought, its limit copied from the terms), `used = used + 1` on it, and the use row
(`core_allowance_use`). A CHECK and a trigger refuse a counter past its limit; a trigger on the use
refuses a holder that is not the spender's Person's, not live, in the Trash, or not valid at `at`.
Either fails the whole batch, the booking with it. D1 runs one statement at a time, so concurrent
spends cannot both take the last use (20 at once for 5 uses make exactly 5). The refusal is
`invalid_input` with `{ rule: "allowance", reason, … }` (`no_uses_left` with the numbers,
`not_theirs`, `not_live`, `not_yet_valid`, `ended`, `not_covered`, `no_holder`); a customer is told
the reason and, for no uses left, the numbers, never another's record. The approval queue's dry
run reports what the database would refuse, counting what the same call spent or gave back.

**Unlimited holders still write a use** (amendment 6): the counter has no limit and counts.

**Moving a use** (amendment 4): a spender created into a spend state with `movedFrom` set to
another of the same object, for the same Person, moves that one into the declared state (a return
state), which gives its use back, and spends from the same holder, all in the new record's batch.
In the same period the move nets nought, so it never fails for want of a use the member had; into
a full period it is refused whole and the old booking stays. Staff make it (the move into that
state must be declared for staff); a customer cancels and books again.

**Who can cause a spend or a return**: whoever the spender's `states` lets make the move (staff, a
customer on their own record, the host). No operation spends or returns by itself, and no
extension hooks a write. `allowance.get` (staff any, a customer their own; read only,
`hostInternal` to read the counters after the seam shows the holder) gives a holder's numbers for
the period containing a time; `rec_allowance`, `rec_allowance_period` and `rec_allowance_use` are
queryable.

**The shared local-time helper.** The zone offset and the real-wall-clock check move from
`subscriptions/offers.ts` to `packages/core/src/time/local.ts` unchanged; below them, wall clock to
instant (a skipped time moves forward by the gap, a repeated one is the first) and an instant's
local parts, which the periods use and stage 31 can.

## Consequences
- A pack declares a pass or a membership a holder and a booking a spender; nothing in the
  behaviour knows either. Stage 31's booking declares `spendIn: ["booked"]`, `returnIn:
  ["cancelled", "cancelled_by_us", "moved"]`, `at: "class.startsAt"`, copies of class type, and the
  local weekday and minute.
- A class whose time changes after a booking does not move its use to another period: the use is
  counted where it was spent (stage 31's series changes ask staff before moving booked classes).
- `cos ext test`'s harness does not simulate the behaviour; a pack's allowance is tested against
  the host.

## Amended 2026-11-22, after the independent review (before merge)

- **The limit is the real limit.** A period's counter stores the holder's limit as it is, never
  raised to what was spent. A limit lowered below what a period spent leaves the period over it, and
  the database then refuses every spend until gives-back bring it under (the trigger refuses any
  rise of `used` past the limit; the CHECK that forced the limit up is gone). The host refuses a
  spend when every holder that covers it is full, with the period's real numbers, before the batch,
  in the real run and the dry run alike; a refusal by the database after the host saw room is a
  race and is answered as a conflict to try again (`spent_meanwhile`). The host reads a period's
  own limit (a past period keeps the limit it had), and passes to the next covering holder with room.
- **What a spender points at changes under a use** (its `at` relation, a `copy` or `local.zone`
  relation, or an own `at` or zone field): in the same batch the use is given back and spent again
  for the new target under every rule, from the same holder if it still pays and has room,
  otherwise as the host chooses; if nothing can pay, the whole update is refused and nothing moves.
  The new use records the one it replaced (`moved_from`). **A class rescheduled** follows the same
  rule from the class's side: when a record that spenders read their time or copies from changes
  those fields, each spender holding a use gives it back and spends again for the class as the
  write leaves it, in the class's batch, and its copied and local values are written again. A
  booking moved across a week or month boundary so has its use counted in the new week or month;
  if any booking can no longer be paid there (no use left, its pass ended, not covered), the
  reschedule is refused naming that booking, so staff move or cancel it first. This replaces the
  consequence above ("does not move its use to another period").
- **Whose spender it is** cannot change while it holds a use, as its holder cannot.
- **A holder named on a write that does not spend** is checked then (the spender's Person's own) and
  refused otherwise; when the spender later enters a spend state, the stored holder is the one spent.
- **Conditions read only host-filled fields**: every field a condition reads must be a `copy` or
  `local` field of the spender, which no caller sets, the extension's own code and staff included
  (the record code refuses them to everyone but the host). A holder's terms, its Person (other than
  its customer field) and the holder fields its conditions compare with are never customer-writable,
  by `customer.write` or a tool's `customerFields`. An empty `uses` is none unless the holder object
  declares `emptyIsUnlimited: true`. A customer never creates a holder.
- **Across extensions**, a spender declares `paidBy` (holder objects or extensions); left out, only
  its own extension's holders pay for it. The host checks a holder naming another extension's
  spender at install and `cos ext check` (`allowance/check.ts`): the spender must exist, allow it,
  and fill every field its conditions read; and a spender's `at`, `copy` and `local.zone` one
  relation away into another extension or a core object must exist with the right type. A spend
  finds only holders whose object the spender allows.
- **A spender with no return state** may go to the Trash; its use is kept (it gives nothing back).
- **A Person in the Trash** spends nothing (the use's trigger checks the Person); purged, their
  allowance rows go as an erased Person's do.
- **For stage 31's build:** the transition engine has no time windows yet, so a customer move into
  a `returnIn` state gives the use back whenever it is made, even after the class. The Bookings pack
  must not ship a customer cancel until the windows exist (a cancel limited to before the class's
  "late from" moment); until then cancels that return a use are staff's.
- **Cost of a spend**: one indexed query of the Person's holders' terms (`core_allowance` by Person
  and object), one read by id per holder for its conditions, one counter read per holder by its
  primary key, the spender's open use by its partial unique index; bounded by the Person's holders.
