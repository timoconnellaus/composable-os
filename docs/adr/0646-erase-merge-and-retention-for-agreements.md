# ADR 0646: Erase, merge and retention for agreements

Status: accepted, 2026-11-23 (stage 44, build step 8). Builds on
[ADR 0642](0642-acceptances-a-record-nobody-changes-and-who-may-agree-for-whom.md) (acceptances,
and what step 2 already did on erase and merge),
[ADR 0643](0643-health-answers-read-by-a-person-with-the-permission-every-read-audited.md) (health
answers), [ADR 0644](0644-enforcement-nobody-pays-or-books-without-what-is-due.md) (a guest's
acceptances), [ADR 0645](0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md)
(the copy and the email gatekeeper), [ADR 0320](0320-erase-reaches-every-store.md) (erase reaches
every store) and [ADR 0019](0019-audit-redaction-for-erasure.md) (erase and the audit). Stage 44's
spec: "Erase, merge, the Trash and keeping records", decision 15, criterion 14, and row 8 of the
build order.

## Context
An acceptance is the business's evidence (a chargeback, an injury claim, years later) and the
person's personal data. Decision 15: on erase, health answers go at once; the rest of each
acceptance is kept, detached from the person, for a retention period (default 7 years), then
deleted. Step 2 already detached acceptances and deleted answers and the minor mark on erase, and
moved acceptances on merge; migration 0851 refused every delete of a kept one, so nothing could
ever end the retention. Step 4 left the email gatekeeper holding, for an erased person, the
sent history's recipient and subject and every waiting or failed journal record of their copies
(the whole message: address, record lines, name typed, strokes), and the host's pending approval
of a copy that was waiting for a person.

## Decision
- **Erase** (`agreements/people.ts`, `queueEraseAgreements`, in erase's batch after the Person's
  row and their orders' addresses are deleted):
  - deletes at once: health answers on every acceptance it detaches; the minor mark; the "a health
    form needs a look" notice of their acceptances (it names nobody, but beside a kept acceptance
    it would still say that this person answered yes); a buyer's acceptances (`by: "guest"`) with
    their address or their Person on an unpaid order or an unconfirmed subscription checkout, with
    their signature and answers (no contract was made);
  - keeps detached (`person_id` and `account_id` cleared, `erased_at` set): their own acceptances
    (the version, when, how, the name typed, the address and the signature); those they made as a
    guardian, minus the guardian, the account, the name typed and the strokes (coordinator decision
    of 2026-11-23, owner to confirm: the record that a guardian agreed is kept for the retention
    period, the address stays as decision 15 keeps it, and the child is due again); and a buyer's
    acceptances on a paid order nobody settled, whose address erase cleared (it can never settle
    to anyone after that; migration 0855 lets `erased_at` be set on such a row only once its order
    has neither a Person nor an address, and is paid);
  - turns down and redacts the host's pending approval of a copy that was waiting (its id is read
    before the erase trigger clears it), whatever the address the copy went to;
  - adds the addresses their acceptances and copies hold (an earlier sign-in address, a purchase's
    address) to erase's terms and addresses, so the audit, approvals and orders are redacted for
    them too;
  - says what it did: `person.erase` returns `agreementsKept { count, until, deleted }`, and its
    description says what is kept and until when (the erase screen is the approval card's preview
    of that output).
- **The Trash purge** deletes a Person the same way (`trash.purge` calls the same function, with no
  addresses: it is not an erasure request).
- **Who reads a kept acceptance**: a person on the staff with `agreements:manage`, found by the
  address or the name it holds (`agreement.kept.find`, a person only, every search audited without
  what was searched for; the result carries no name, address or signature), and opened with
  `agreement.acceptance.pdf` or `agreement.acceptance.get` (both now refuse a kept one, or a
  buyer's not yet settled, without `agreements:manage`; `acceptance.get` also goes through the
  visibility seam for a Person's). Nothing lists it otherwise; no AI reads it; no customer does.
- **Retention**: `agreement_retention` in `core_settings` (`{"years": n}`, 1 to 50, default 7),
  set by a human admin (`agreement.setRetention`: `policy:manage`, `actors: ["human"]`, risk
  `destructive`, audited), counted from each erase. A missing setting means 7; a value that is not
  a whole number from 1 to 50 means nothing is purged (a broken setting never deletes evidence
  early). The database reads the setting the same way.
- **A hold** (`core_agreement_hold`, `agreement.kept.hold`, `agreements:manage`, a person): a kept
  acceptance held for a dispute or a claim is passed by until a person releases it. Who and when
  only: no free text, so a reason never becomes personal data of its own.
- **The purge** (`agreement.purgeKept`, the daily cron's host step: `hostStep: true`, system origin
  only, `records:erase`): at most 100 acceptances per round, oldest erase first, each with its copy
  row, signature and answers first; never one on hold, and never one whose copy still owes the
  email gatekeeper a scrub. `runAgreementRetention` checks first and runs nothing (no audit row)
  when none is due. Idempotent.
- **The database refuses any other delete, by any writer** (migration 0855, extending 0851's
  pattern and weakening nothing): a kept acceptance only past the period, not held, and only once
  its signature, answers and copy row are gone; those three only past the period and not held (or
  as 0851 already allowed); a copy row only then and never while a scrub is owed. Every comparison
  with the period is null-safe, so an unreadable setting refuses.
- **The email gatekeeper's storage of a copy is scrubbed** through the host's own agreements mail:
  `callAsHost` purpose `agreements`, method `scrubAgreementCopy { key }` (the copy's key,
  `agreement-copy:<acceptance id>`). The integration host allows that one method beside `send` for
  that purpose; email-send's session refuses it to every queue whose class is not `agreements`
  (an extension, an automation, the assistant, MCP, a person, the host's other mail), validates
  the key, and returns counts only. Serialized with apply and reject, it marks the key scrubbed, so
  a later send under it or a retry's (`<key>:<n>`) is refused and an apply of one is not delivered;
  drops every journal record of the copy (waiting, failed, or a submission in flight); and blanks
  the recipients and subject of its history lines (`[erased]`). It is not in the agent-facing
  types. The fake outbox does the same.
- **When the scrub runs**: a copy row whose send ever reached the gatekeeper (`attempts > 0`) owes
  a scrub from its erase (`scrub_due_at`, set by migration 0855's erase trigger). It is asked right
  after the erase commits, and by the minute cron's copy step until it is done (`scrubbed_at`); one
  that fails waits 15 minutes. **A copy whose send was in flight when the erase landed** ends not
  sent or scrubbed after: if the scrub lands first, the late send is refused; if the send lands
  first, the sender finds its claim gone when its call returns and marks the scrub owed again, so a
  scrub always follows the last send. The database clears an owed scrub only with `scrubbed_at`.
- **Merge** is unchanged from step 2: acceptances, and those made as a guardian, move to the
  survivor in the merge's batch, nothing in them changes, the minor mark is kept if either had it,
  and moving them is a person's act with `agreements:manage`. A buyer's acceptances not yet settled
  are nobody's and are not touched: paid later, they settle to whoever the payment matches (the
  survivor holds the merged Person's addresses). `agreement.mergePlan` gives the merge preview its
  counts (their own, as a guardian, the mark) and whether the caller may merge them.
- **The Trash** is unchanged: a Person in the Trash has no current acceptance; restored, theirs
  count again; acceptances are never in the Trash list.
- **The desk** (step 6) is not built: when it is, erase must also end a Person's open desk session
  and keep a closed one with the acceptances it made, detached like them.

## Consequences
- The business keeps its evidence for the period it chose, and a person who asks to be erased
  loses their health answers and their minor mark at once; the rest goes when the period ends.
- An erased person's copies leave the email gatekeeper's storage, which ADR 0320's audit listed as
  a gap (`UPSTREAMS.md`, V4) for this gatekeeper's agreements mail. Other sends to an erased
  person (callers', routine mail) still sit in email-send's history until it rotates; V4's general
  `eraseSubject` remains the proposal for them.
- A copy whose send was in flight reads `cancelled` though it was delivered; the gatekeeper's
  record of it is scrubbed. The person received their own copy before they were erased.
- Shortening the period deletes evidence for good at the next daily run: the setting is an
  admin's, and the screen says so.
- A paid purchase nobody settled whose address belonged to an erased person is kept detached:
  the Person it was for is unknown, and it is evidence of a purchase.

## Amended 2026-11-23: after the privacy review of PR #288
- **Erase takes only the erased Person's own addresses** from their agreements: those of their own
  acceptances (`self`) and of those they made as a guardian. Never the address on someone else's
  acceptance for them (a guardian's for a child, a parent's purchase settled to the child): the
  first build added those, so erasing a child deleted the guardian's sign-in, cleared their orders
  and listed their address as erased. More than 50 such addresses is refused, never cut; a buyer's
  acceptances are read in batches until none is left.
- **The scrub goes where the copy went.** Each send records the gatekeeper it reached (`via`), and
  the scrub asks each of them, whatever channel is current. A gatekeeper whose connection is gone
  is recorded `unreachable` (admins told once, naming nobody) and asked again. The gatekeeper says
  whether it held anything for the key (`found`), apart from `done`. **A scrub owed for 30 days
  (`scrub_owed_since`) no longer holds a kept acceptance past its retention period**: the purge
  deletes it and names it in its audit row (`unscrubbed`); the database's copy trigger uses the
  same 30 days.
- **Paper free text** (who signed a paper form, staff's note) may name someone: it is shown only
  to staff with `agreements:manage` (others see "recorded from paper"), and erasing a guardian
  clears both on their dependants' paper forms (coordinator decision, owner to confirm). The
  database allows only clearing them, both together, on a paper form.
- **Every `agreement.acceptance.get` is audited** (`auditReads`) with the acceptance's id and
  whether it was kept, never what it says; `agreement.kept.find` records the ids it showed.
- **Open purchases close on erase**: an order of theirs (or with their address) nothing was paid
  on is cancelled by the host, so a payment after the erase is a late one, never honoured without
  staff; an unconfirmed subscription checkout is closed (`erased_at`, its address cleared), so a
  later confirmation makes no subscription and staff are told to cancel it with the provider.
- **The retention setting is read by SQLite's JSON functions** in the host as in the triggers:
  `{"years": 7.0}` is not a whole number to either, and purges nothing. A purge the database
  refuses is reported as such, not as "immutable".
- **A change that makes more kept records due** (shorter, or set while unreadable) needs the
  person to type how many the next daily run deletes (`confirmPurgeable`, from
  `agreement.retention { years }`), and the audit row keeps the number.
- **The erase screen**: the app has no erase button (staff erase through the assistant or MCP,
  with an approval card); the Erase requests list in Settings → Storage now says, per request,
  how many agreements are kept and until when, and how many health forms' answers go
  (`agreement.erasePreview`, admins).
