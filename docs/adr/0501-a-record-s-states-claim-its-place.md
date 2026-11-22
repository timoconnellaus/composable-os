# ADR 0501: Capacity claimants: a record's states hold, take and give back its place

Status: accepted, 2026-11-22 (stage 31, build step 2). Extends
[ADR 0430](0430-capacity-is-refused-by-the-database.md) and
[ADR 0432](0432-holds-have-no-clock.md).

## Context
Until now only an order claimed places (`orders/holds.ts`, the order's move hook). A booking paid
for with a membership has no order, but it must hold a place on its class exactly as an order's
line does: refused by the database past the places, for every actor, however many book at once.
A pack may not hook a write (ADR 0404), so this has to be a declaration the host acts on.

## Decision
- **The declaration** is a key of its own on the claimant: `claims: { on, held?, confirmed? }`.
  `on` is a relation (one record) to another of the extension's objects that declares a
  `capacity`; `held` and `confirmed` are states of the claimant's `states`. The spec guessed
  `capacity: { claims }`; a separate key keeps `capacity` meaning "this record has places" (every
  reader of `capacity` assumes `places`) and reads as what it is: the booking claims.
- **The transition engine acts on every move of a claimant** (`records/lifecycle.ts` →
  `capacity/claimants.ts`), in the write's own batch: into a held state, a hold of one place
  (`claimStatements`); into a confirmed state from neither, a hold taken at once; held to
  confirmed, the hold taken; out of both, the place given back. Moves within one kind (booked to
  attended) change nothing. The claim is `for: { type: <claimant object>, id: <record> }`, so
  confirms and releases name it with no read.
- **The database refuses** past the places, as for orders (migration 0440's trigger and CHECK):
  of 20 bookings at once for the last place, exactly one is made and the rest are told
  `rule: "capacity"`. The approval queue's dry run judges the claim against the counter as it is.
- **What a claimant may not do**: go from a confirmed state back to a held one (a contract
  error); change `on` while it holds or takes a place (`claim_relation_kept`: moving a booking to
  another class is a new booking); go to Trash while it holds one (`claim_live`). A claimant
  object dropped for good gives back every place its records held and took.
- **Orders are unchanged**: they keep their hook and `for: { type: "order" }`. Release targets
  gain `{ forType }` for the drop.

## Consequences
- One place per record. A claimant that needs several (a group booking) is a later change.
- The waitlist's hold (step 5) builds on this: the release that frees a place can hand it to the
  waitlist in the same statement.

## Amended 2026-11-22 (review, before merge)
- **A place is never held by nobody.** Erasing a Person releases every claim of every claimant
  record the erase reaches, in its batch: one whose relation to the Person is required is deleted;
  one whose relation is only cleared is kept, anonymous, in its state but holding nothing (its
  history counts; moving it later releases nothing). Purge after Trash deletes only core records,
  and a claimant cannot be in Trash holding a place, so it orphans no claim. Dropping a claimant
  object releases its records' claims; dropping the claimed object deletes its counters and
  claims (as before).
- **Trash of a claimant holds at commit**: besides the read that gives the message,
  `record.delete` (and the host's own removal of a series' record) guards in its batch that the
  record has no live claim (`core_write_guard`, migration 0560), so a claim taken meanwhile fails
  the Trash (`conflict`, `claim_live`).
- **A claims declaration does not change under live records.** The reconciler refuses a change
  to `claims` (added, removed, or its relation or states changed) while any live record is in a
  state the old or the new declaration names (`claims_conflict`, naming up to ten records): their
  claims would otherwise be missing (overbooking later) or never given back. Staff move those
  records out first; backfilling claims within capacity was not chosen, since it would have to
  refuse whenever the places do not fit anyway.

## Amended 2026-11-22 (stage 31a step 5, the waitlist)
- The waitlist's hold builds on this as the Consequences said: a claimant may declare
  `claims.waitlist`, and a place it gives back before the cut-off is handed to whoever waits, in
  the same batch, as a claim `for_type 'waitlist'` ([ADR 0520](0520-a-waitlist-on-a-claimant.md)).
- The reconciler's refusal of a claims change under live records now compares only `on`, `held`
  and `confirmed`: a waitlist added to, or changed on, a claimant with live records holds no
  record's place, so it is allowed. Dropping a waitlist that holds places is refused.
