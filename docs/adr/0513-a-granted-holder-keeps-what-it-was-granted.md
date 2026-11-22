# ADR 0513: A granted holder keeps what it was granted: the Trash, moves only a person's tool makes, and its terms

Status: accepted, 2026-11-22 (stage 32b, build step 6, after the independent review). Amends ADRs
[0510](0510-what-a-subscription-grants.md), [0511](0511-the-memberships-pack-and-passes.md) and
[0512](0512-one-per-person-and-tools-only-a-person-may-call.md); builds on ADRs
[0425](0425-one-transition-engine-for-stages-and-states.md),
[0493](0493-the-allowance-behaviour.md) and [0503](0503-time-windows-and-staff-only-on-the-transition-engine.md).

## Context
The review of step 6 found ways a pass or a membership could give uses nobody paid for, or lose
the one-per-Person rule:
- a membership in the Trash when its subscription ended (or a pass in the Trash when its order was
  refunded) was not followed, and came back live on restore;
- any staff caller (the assistant, an MCP client, an automation) could void a pass through
  `record.update`, past `voidPass`'s human-only rule, its permission and its refusal of a bought
  pass; and any code of the pack could write a holder's terms;
- a person merge could leave a survivor with a held intro offer beside a used one, and a paid order
  could then grant a second; a hand-given intro pass did not count as the Person's one.

## Decision
**A holder and the Trash.** A holder in a live state cannot be moved to the Trash, and neither can
a granted one (a `core_order_grant` or `core_subscription_grant` row) that is not in a final
state: void or end it first (`invalid_input`, `rule: "allowance"`, `reason: "holder_live"`). A
granted holder in the Trash that is not final (only data from before this rule) is not restored
(`reason: "holder_granted"`). So the grant, not the Trash, decides what it gives, and following a
record in the Trash is never needed: a granted record there is final, and nothing moves a final
record. (The review asked for following trashed records and re-syncing on restore; refusing the
Trash for anything a grant still moves closes the same hole with no second path to keep right.)

**A move only named tools may make** (`states.moves[].tools`, the transition engine). A move
`{ by: ["host"], tools: ["voidPass"] }` is made by the host and by a staff write from inside that
tool of the same extension, and by no other staff write. The contract requires each tool to be
`humanOnly` with a `permission`, and the move not to list `staff` too. The tool a write comes from
is the runtime's own (`ExtensionCaller.tool`, set by the runner from the installed manifest, with
the person who called it), never input. The Bookings session's branch has no human-only move or
setting yet; this is the one mechanism, and its name is `tools` (stage 31 should reuse it for any
human-only booking rule that is a move).

**A holder's terms** (its Person, uses, period, dates, zone and the holder fields its conditions
compare with: `holderTerms`) are written by the host, or by the holder's own extension only from a
tool `personsTool` accepts (humanOnly, with a permission). Any other code of the pack (another
tool, an automation) is refused, as staff are. The contract adds, for a granted holder (`grants`
or `recurring.grants`): every term `readOnly`, none customer-writable, and no `staff` or
`customer` move into a state it can be spent in (`checkGrantedHolder`, in `cos ext check` and at
install).

**Given by hand.** A granted object created from a person's tool (a pass from `givePass`) gets its
dates from the host as a paid line's are (`grants.valid`: from now, the item's days in local days),
whatever the tool sent; and when its item is sold once per Person, the Person's one is used then
(`core_sellable_once`, `source: "by_hand"`, `given_by` the person), or the write is refused when
they have had it. `givePass` takes fewer uses than the type's, never more, and no days of its own.

**A merge and the intro offer.** Of the survivor's and the merged Person's held or used rows for one
object, one is kept, `used` over `held`, then the survivor's, then the earliest; the others are
released first. A pending order whose hold was released so, if it is paid later, grants nothing for
that line, and staff are told to refund it ("A one-per-person purchase granted nothing"). A late
payment honoured for an intro offer the Person has had since is refused with words saying so
(`reason: "had_since"`).

**Dropping what a plan grants.** An upgrade that drops or changes a plan's `recurring.grants`
(object, states, from, until) is refused while a subscription not ended holds a grant of it
(`grants_conflict`, naming the subscriptions and records); its records would otherwise stop
following their subscriptions and keep giving.

**Also from the review.**
- `staffInput` on an operation: input keys only staff may pass, left out of the customer's and the
  public's contract and refused from them by the pipeline (`rule: "staff_input"`):
  `subscription.start`'s `holderPersonId` and `subscription.cancel`'s `now`.
- `allowance.list` (staff, customer; read; `hostInternal`): `allowance.get` for up to 50 holders of
  one object in one call; both now say `payable` (it can pay now: live, out of the Trash, within its
  dates). The Memberships tools report `live` as that and read their counts in two calls.
- A plan's `per` is required.
- A membership's `until` is compared as a moment, so a read with the same end writes nothing.
- A refund in full of a paid period of a subscription that grants something tells staff that the
  subscription, and what it grants, keep running.
- Two events granting at once fail on `core_subscription_grant` as a conflict the event's adapter
  applies again (`reason: "subscription_grant"`); the second reads the grant and is a no-op.

## Consequences
- Disputes (chargebacks) are not read by the host at all yet: a disputed period changes nothing
  here, and staff learn of it from the provider. Recorded for the dispute work.
- The core fixture's and the pack's pass void moves are the host's only (the pack's, and
  `voidPass`'s). A holder's own staff-made state moves (an allowance test's pause) are unchanged.
