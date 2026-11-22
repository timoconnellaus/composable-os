# ADR 0494: Which holder pays, and what happens to uses when a holder or its Person changes

Status: accepted, 2026-11-22 (stage 32b, build step 5). Builds on
[ADR 0493](0493-the-allowance-behaviour.md) (the behaviour) and
[ADR 0487](0487-the-payer-and-the-holder.md) (payer and holder). Stage 32's decisions 9, 13 and
15; stage 31's amendment 5 ("the holder is the spender's Person's").

## Context
A member may hold a membership and a class pack at once, and the spec says only "the holder that
expires first". Holders end, are paused, voided by a refund, put in the Trash, change their limit
(a plan change), and their Person may be merged into another or erased. Each needs a rule, decided
once in the host.

## Decision

**Whose holder.** Only the spender's own Person's: a holder pays for a spender whose Person is the
holder's, checked by the host and by the use's trigger. A payer who is not the holder (a parent
paying a child's membership, decision 13) pays the subscription; the child's uses are the child's;
there is no shared pool. When a guardian books for a child (stage 31's family link), the booking's
Person is the child, so only the child's holders can pay, whoever made the booking; a guardian's
own pass never pays for the child. The guardian's read of the child's holders is the family link's
(stage 31): `allowance.get` asks the visibility seam whether the caller may see the holder, so when
the link lets a guardian read the child's memberships and passes, `allowance.get` answers for them
with no change here.

**Named, or chosen.** A caller may name a holder (the spender's `holder` field): it must be the
Person's, live, valid at the spender's time and cover the spender, or the write is refused with the
reason; its room is the database's to refuse. Otherwise the host chooses, deterministically:

1. among the Person's holders that cover the spender, are live and are valid at its time;
2. an unlimited one first (spending it costs the member nothing);
3. then the one whose use would lapse first: for a week or a month, the end of the period (or the
   holder's end, if sooner), since an unused weekly use is lost at the week's end (no carry-over);
   for a total, its `until` (none: last). This is how "the holder that expires first" is read: the
   use that would expire first;
4. then by object name and id;
5. the first in that order with a use left in the period (read; if two spends race for it, the
   database refuses one and it is made again); if none has room, the first is spent and refused
   with its numbers; if none covers the spender, the first one's reason (a paused membership says
   `not_live`), or `no_holder`.

**When a holder changes.**
- *Ends* (`until` passes or is moved earlier, as when a membership is set to end at its period's
  end): no new spend for a time at or after it. Uses already spent stay spent, including for a
  class after the end; giving those back is the spender's own move (stage 31 cancels bookings past a
  membership's end).
- *Paused, used up, void* (a state outside `live`, for example after a full refund): no new spend;
  uses spent stay spent (stage 32's "a full refund of a pass voids it; uses already spent stay").
  Unpaused, it can be spent again; nothing is replayed.
- *In the Trash*: as not live; restored, as before.
- *Its limit changes* (an upgrade at once, a downgrade later): the new limit applies to the current
  and future periods' counters, never below what a period has already spent, so a downgrade keeps
  what was booked and refuses more. Past periods keep the limit they had. A change of `per` counts
  new spends in the new periods.
- *Its object is dropped*: its terms, periods and uses go with it; a dropped spender object's open
  uses are given back first.

**A Person merged or erased** (as 32a does for subscriptions). A merge moves the merged Person's
holders' terms and uses to the survivor in the merge's batch (the records themselves are repointed
by the merge), so the survivor keeps what was held and spent. An erase deletes the Person's
allowance rows: their holders' terms, counters and uses, and every use they spent (an open one is
given back first). Uses are attendance, not money; an order's books are kept as before.

**The intro offer** ("a pass type limited to one per Person", decision 8) is not this behaviour:
the allowance governs spending, and "one per Person" governs buying. It belongs to step 6 (the
Memberships pack's pass type, `sellable`'s purchase), with the same shape as the one-trial rule
(ADR 0489). A drop-in is a pass of one use: nothing here.

## Consequences
- Who has the better deal is not weighed: a member with a weekly membership and a pack spends the
  membership's use first while one is left, then the pack, so no weekly use is wasted.
- A member who wants their pack spent instead names it.
- An erased member's past attendance no longer counts in "uses spent per week".

## Amended 2026-11-22, after the independent review (before merge)

- **The terms row is derived from the stored record** in SQL, queued after the record's own write
  in every batch, so two writes to different fields of a holder at once both land in it; and the
  reconciler derives it again for every record of a holder object at each install or change of the
  declaration (a holder made before its object declared the behaviour, or other live states).
- **Zones.** A holder with a zone field of its own counts in it. One without is given the
  organisation's zone when its terms are first written and keeps it: a later change of the
  organisation's setting does not move it (its periods would otherwise change meaning under its
  spent uses). To move a holder to another zone, staff set its zone field.
- **A change of period or zone** (a holder's `per` or zone field) applies from the end of the
  period running when it was made (now, for a total): before then spends are counted the old way,
  so the week running keeps its count; uses already spent for times from then are moved to their
  new periods in the change's batch, even past their limit, as a lowered limit leaves them.
- **Limit changes** apply the real new limit to current and future periods (see ADR 0493's
  amendment): a period over it accepts no spend until it is back under.
- **Which holder**: after precedence, the first covering holder with room by its period's own
  numbers; when none has room, `no_uses_left` with the first's numbers.
- **A customer's `allowance.get`** returns only the terms whose fields the holder's `customer.read`
  lists (never the Person), and the period's numbers; an object that is not a holder, or that they
  cannot read, is not found exactly as another's record is. A refusal reaches a customer as its
  reason in words, with the numbers only for no uses left, and never a record id.

## Note (2026-11-22, stage 32b build step 6)
The intro offer is built as decided here, on buying: `sellable.onePerPerson` ([ADR
0512](0512-one-per-person-and-tools-only-a-person-may-call.md)). A pass voided by a full refund
keeps the uses it spent, as "*Paused, used up, void*" above says.

## Note, 2026-11-23 (ADR 0540)
A guardian reads a linked dependant's holders and their uses: the Memberships pack's membership
and pass declare `customer.guardians: {}` (read only), and `mine` takes the child's `personId`.
What pays stays the booking's Person's own holder, whoever booked.
