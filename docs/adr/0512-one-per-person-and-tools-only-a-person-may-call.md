# ADR 0512: Bought once per Person (the intro offer), and tools only a person may call

Status: accepted, 2026-11-22 (stage 32b, build step 6). Builds on ADRs
[0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md),
[0436](0436-pack-roles-and-the-door-role.md), [0489](0489-one-free-trial-per-person-per-plan.md) and
[0494](0494-which-holder-pays-and-what-happens-to-uses.md) (which put "one per Person" here: a rule
on buying, not on spending). Migration 0581.

## Context
A gym's intro offer is a cheap first pass, once per person. It must hold for every actor, be safe
under two purchases at once, and not be consumable by a guest typing someone else's email: the
same three dangers the one-trial rule closed (ADR 0489). Separately, giving a pass by hand is free
value; the spec asks for it to be a person's own act, as refunds and cancels are.

## Decision
**`sellable.onePerPerson: "<boolean field>"`.** While the field is true on a record, a Person buys
it once, across every record of the object with it true (one intro offer of any kind, as the trial
is one per plan object). Not on a plan (its trial is already one per Person).

The host, in `createOrder` (`orders/once.ts`), for every actor and in the dry run:
- **only a proved buyer**: a guest who typed an address is refused (`invalid_input`, `rule:
  "once_per_person"`, `reason: "sign_in"`), the same for every address, so nobody spends someone
  else's or learns whether they had one. A signed-in customer buys for themselves; staff buy for the
  address's Person (an address several people share is refused, `no_person`).
- **one on one order**: quantity 1, one such line per object (`one`).
- **held from the order's start**: a `core_sellable_once` row (`held`) in the batch that writes
  the order; refused first when the Person has one held (`held`) or used (`used`). The partial
  unique index on (Person, object) where held or used makes the database refuse the second of two
  orders started at once: its whole batch fails, no order exists for it, and the caller gets a
  conflict (`once_per_person`, `held`), passed through to a customer as their own.
- **used when paid** (the order's first move to paid or part paid), in that batch; **given back**
  only when the order expires or is cancelled unpaid. A refund keeps it used. A late payment staff
  honour on an expired order takes it again, used, and is refused by the index when the Person has
  had one since: the batch fails, the order stays expired, staff refund (as places are, ADR 0432).
- **a merge** moves the rows to the survivor; where both had one, the merged Person's is released
  first, so the survivor keeps exactly one.
Unlike a trial page, an order's expiry is the host's own move, so no provider read is needed to
release a hold: a payment arriving after expiry is the late-payment path above.

**`humanOnly` on a tool** (ToolSpec, manifest): its operation is `actors: ["human"]`, so the
assistant, an MCP client, an automation and other extensions' code are refused by the pipeline, as
for a core operation. It only narrows who may call, so any extension may declare it; a tool open to
customers or the public may not. The Memberships pack's `givePass` and `voidPass` declare it, with
the pack's grantable permission `memberships:passes`.

## Consequences
- A new visitor buys an intro offer signed in: with "anyone starting a subscription" on and a plan
  on sale (ADR 0459) any address gets a code; otherwise customer sign-up must let them in.
- The staff holdings block and the pass page's void button are the person's path; the void move
  itself is also staff's through `record.update` (the transition engine has no human-only move), so
  "human only" is enforced for giving (which creates value) and for the pack's void tool, not for a
  staff state move on a pass.

## Amended 2026-11-24: one person per folded address (ADR 0692)
"A Person" for `sellable.onePerPerson` now counts every Person sharing a folded address with
them (`a+1@x` and `a+2@x`, issue #225): an order held or paid by any of them refuses the line, a
late payment is refused when any of them has had one since, and migration 0955's trigger refuses
the second of two holds at once by such People. A pass given by hand (ADR 0513) is still checked
for its Person only: a person's override, which counts against the others.
