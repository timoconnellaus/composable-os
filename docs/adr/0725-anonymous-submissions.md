# ADR 0725: Anonymous submissions

Status: accepted, 2026-11-24 (stage 29, build step 2). Builds on
[ADR 0720](0720-the-intake-door-one-public-write.md) and
[ADR 0590](0590-routine-mail.md) (value marks).

## Context
Decision 6: a form is anonymous or named, chosen per form, and anonymous really means anonymous:
no link to the person is kept at all. A signed-in member may answer one, and nothing may record
that they did.

## Decision
- **An anonymous form** (its `intake.anonymous` field true) has no question mapped to the Person
  and no destination: the record operations refuse either on every write of the form
  (`checkQuestions` with `anonymous`, and the destination check).
- **Its submission names no one**: no Person, no certainty, no personal link id, and its records'
  `created_by` is `public` whoever sent it.
- **Nothing of the call names the account.** On a signed-in customer's call, `intake.submit` asks
  the pipeline to forget the caller (`ctx.anonymise`, given only to a `hostInternal` core
  operation on a customer's call): from then on its audit row has no `user_id` and no session, its
  values' marks no `by_id`, and its record events no user. The audit row still says the actor was a
  customer (or the public).
- **Not available on an anonymous form**: a receipt, a destination, a personal link and "once per
  person" (steps 3 and 5 hold them to it).

## Consequences
- **The pack's own tool call is the pack's to keep anonymous.** A customer's call of the pack tool
  that calls the door (Forms' `x.forms.submit`, step 3) is itself an outside call with its own
  audit row and tool run, outside this one. Step 3 must keep the answers out of it (the tool's
  input redacted) and, for an anonymous form, the account: the block sends an anonymous form's
  answers without the customer's session, or the host's tool starter learns to forget the caller
  as `intake.submit` does. Until step 3 there is no such tool.
- Staff entering an anonymous form's answers are named in the audit row, as for any staff write.
- Not yet tried on a live host.
