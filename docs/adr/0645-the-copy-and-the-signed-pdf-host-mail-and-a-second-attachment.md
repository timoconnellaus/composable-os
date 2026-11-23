# ADR 0645: The copy and the signed PDF: host mail, and the gatekeeper's second attachment

Status: accepted, 2026-11-23 (stage 44, build step 4). Builds on
[ADR 0642](0642-acceptances-a-record-nobody-changes-and-who-may-agree-for-whom.md) (acceptances),
[ADR 0643](0643-health-answers-read-by-a-person-with-the-permission-every-read-audited.md) (health
answers), [ADR 0644](0644-enforcement-nobody-pays-or-books-without-what-is-due.md) (a guest's
acceptances), [ADR 0429](0429-payments-gatekeeper-verified-events-and-refunds.md) (the host's own
message), [ADR 0574](0574-an-idempotency-key-on-an-email-send.md) (idempotency keys), and amends
[ADR 0571](0571-a-calendar-file-made-by-the-email-gatekeeper.md) (the only attachment). Stage 44's
spec: "The copy and the signed PDF", criterion 10.

## Context
Decision 3: each acceptance is emailed to the person, and the business can download a PDF. The
copy is the person's own evidence against a forged record (ADR 0642's consequences), so it must go
exactly once, to an address nobody but the host chose, and carry nothing an AI wrote, read or
could redirect. Health answers are health information and decision 21 keeps them out of email.
Email-send accepted only the calendar file as an attachment; an attachment of bytes a caller
supplies would let anyone send any file to anyone.

## Decision
- **The copy is the host's own mail.** `agreements/copy.ts` sends it through `callAsHost` with a
  new purpose, `agreements`: one `send`, by the system user, with a system origin
  (`system.agreements`), so the gate applies it at once unless the deploy-time floor denies it
  (`hostMessage`, as an order's confirmation) and the outbound check never reads it (an AI reads
  nothing of it). Routine mail (ADR 0590) is a pack's automation's mail, held per run; it is not a
  general host template path, so the copy does not use it.
- **Whether it went is kept beside the acceptance** (`core_agreement_copy`, migration 0854); the
  acceptance and 0851's triggers are untouched. Triggers make the row when a person agrees (`self`,
  `guardian`: to the acceptance's own address, the account's sign-in address) and when a guest's
  acceptance settles to its purchase's Person (to the address it was bought with; an order that
  closes unpaid deletes its guest rows before any copy exists). For paper, `agreement.copy.send`
  (staff, `agreements:paper`, `actors: ["human"]`) makes it, to the Person's sign-in address or
  else their primary email. **No input names an address**: the insert trigger checks it against
  the acceptance (or, for paper, the Person's own addresses) and no update can change it, or the
  acceptance it is for. Erasing the acceptance cancels a copy not yet sent.
- **Exactly once.** It is sent right after the commit and by the minute cron for what did not go.
  A row is claimed by one sender (`queued` to `sending` in one statement); the idempotency key is
  `agreement-copy:<acceptance id>`, so a sender that crashed (its claim taken again after ten
  minutes, or an answer lost) sends again with the same key and the gatekeeper answers the first
  send. A new key (`…:<n>`) is used only after a try the gatekeeper proved was not sent (a rate
  limit); an outcome that is unknown is `failed` and never tried again. One the floor holds for a
  person is `waiting`.
- **The gatekeeper's second attachment** (amending ADR 0571). A message may carry `agreement`: the
  business's name, title, version number and hash, the body (ADR 0440's rich text, only the blocks
  a version may hold), the tick label, a health form's questions, the record as label and value,
  the strokes and the acceptance's id, each checked in `validate.ts` and rebuilt from the schema's
  keys. **Health answers have no field**: only `answers: "in-app"`. Email-send accepts it only when
  the session's queue says it is the host's agreements mail (`isHostAgreementMail`, answered only
  for `callAsHost` with that purpose) and only in the copy's shape (one recipient, plain text, no
  cc, bcc, reply-to, HTML or calendar); anything else carrying it is refused before it is queued.
  It is its own kind (`email.agreement`), never sign-in or routine mail. The approval card, if the
  floor ever sends it to review, says "Signed agreement: [title], version [n], [how], [when]": no
  name, no strokes, no answer.
- **One PDF writer of our own** (`packages/agreement-pdf/src/writer.ts`, its own package since the second review; no imports):
  PDF 1.4 with the standard Helvetica and Courier fonts (nothing embedded, nothing remote, no
  annotation, action or form), no compression and no dates, so the same values give the same
  bytes. Every text is written as a hex string of WinAnsi bytes, so nothing in a document, a name
  typed or a note can close a string, start an operator or end a stream; control, bidirectional and
  zero-width characters are dropped, and a character the standard fonts cannot draw is `?` with a
  line saying so. Strokes are drawn as lines. The gatekeeper makes the attachment when the send is
  applied; the host's download route draws with the same module, so a download and the attachment
  are the same bytes for the same values. A vendored library was weighed: the smallest well-known
  pure-JS PDF library is several hundred KiB and brings font embedding and parsing this needs none
  of; a writer of about 800 lines does exactly this.
- **Downloads are operations; the route only draws.** `me.agreements.pdf` (a customer, their own
  and their live dependants', through the seam's family; a name typed and strokes only to whoever
  agreed, as `me.agreements.get`; health answers included), `agreement.acceptance.pdf` (staff, a
  person, `records:read`, the Person read through the seam, answers only with `agreements:health`
  and otherwise "withheld", an acceptance kept after erase or a guest's not yet settled only with
  `agreements:manage`, every download audited with `auditReads`, its summary naming no value) and
  `agreement.version.pdf` (staff, a person: the blank form for paper, with boxes for a health
  form). Each returns what the PDF says; `apps/app/src/server/http/agreement-pdf.ts` serves
  `GET /api/agreements/…` and `/api/v1/agreements/…` (`acceptances/<id>.pdf`, `versions/<id>.pdf`)
  as a download nobody caches (`no-store`, `nosniff`, a sandboxing CSP), and the client-app
  binding serves a customer's own. None is in MCP; no AI actor reads one.

## Consequences
- A deployment with no email channel set (Settings, Notification delivery) keeps copies queued
  until one is: they go when it is set, not lost.
- A copy held for a person was left `waiting` after approval (superseded below, 2026-11-23: it is
  asked about again until it is sent).
- The standard fonts draw Latin text only: a name in another script is `?` in the file (the record
  keeps it exactly). A publish does not yet refuse what the PDF cannot draw (the spec's open
  check); a later step can, or embed a font.
- Email Service is passed the PDF as bytes (`Uint8Array`), which its binding's types accept; this
  was not tried against the real service.

## Proof
`packages/gatekeeper-email-send/test/agreement.test.ts`: only the host's agreements queue, only in
the copy's shape, its own kind, a card with no name; answers, a blank, pictures, unknown blocks and
keys refused; the attachment is exactly the writer's bytes; the writer's cross-reference offsets,
determinism, nothing remote, injection attempts (strings closing, `endstream`, actions, a forged
trailer, bidirectional controls), characters it cannot draw, a blank form's hash on every page.
`packages/core/test/agreement-copy.test.ts`: one copy per path (one's own, a guardian's, a guest's
at settlement and none when unpaid, paper on request only), a crash, three senders at once, a stale
claim, a rate limit and an unknown outcome, a held copy, an erased acceptance; addresses refused by
the database; health answers in no copy, audit row or copy row; who may download (another
customer, the public, every AI actor, a pack-role coach, staff without `agreements:health`, a kept
acceptance); the same bytes for a download and the attachment; the blank form.
`apps/runner/test/agreement-copy.test.ts`: through the real integration host, applied at once as
the system's, once per key, refused to every other caller and purpose.
`apps/app/test/agreement-pdf.test.ts`: the routes, over the host's hostname and the binding.

## Amended 2026-11-23: after the security review of PR #283 (before it merged)

- **Idempotency keys are kept apart by who is sending.** Email-send remembered one key space per
  sender facet for every caller, and answered a known key before it checked the message, the
  queue or the kind; the copy's key is predictable and its acceptance id listable by MCP, so a
  caller could take `agreement-copy:<id>` first and the person got nothing. Now:
  - the integration host's queue says which of its purposes opened it (`hostPurpose`:
    agreements, sign-in, routine-mail, orders; a caller's queue says none), and email-send reads
    the class from it (`queue-class.ts`, the fake outbox too);
  - a key is remembered under its class and the send's kind, and looked up only after the
    message is checked and its kind decided, so a key answers only a send from the same class of
    caller, of the same kind;
  - `agreement-copy:` keys are refused from every queue but the agreements mail's.
  Sign-in and order mail pass no key today; routine mail's `routine:<row id>` had the same
  exposure and is now apart too. Callers' queues (a person, MCP, the assistant, automations,
  extensions) still share one class among themselves, as before. Keys remembered before this
  change no longer match (a retry within that window may send again).
- **A copy never waits for nothing.**
  - The floor refusing it is `failed`, not `waiting` (`callAsHost` now returns `denied`).
  - When a retried copy's key finds the send still waiting in the journal (its first submission
    was cut off before the host applied it), email-send submits it to the queue again; the host's
    queue answers with a person's approval if one already waits for it, and decides it otherwise.
    One turned down or failed is refused plainly (`Refused: …`) and recorded `failed`.
  - A copy held for a person is asked about again (15 minutes, doubling, at most a day) until it
    is sent (then `sent`, as `agreement.acceptance.get` reports) or turned down.
  - **When a copy can wait for a person at all:** under today's gate, never in practice. The host's
    own message applies at once unless the deploy-time floor denies it (`hostMessage` overrides a
    floor or policy that would review); `waiting` exists for a change of that rule, and for a send
    the host could not see decided (re-asked as above).
- **`listSent()`** shows the host's agreements, sign-in and orders mail only to that same queue:
  no caller reads who agreed to what, who signed in or who bought.
- **The backlog.** The sender reads nothing until the integration host and an email channel are
  there; then each open state's due rows in index order (`next_at` is set on every row it still
  has work for), stopping at its limit. With copies queued and no channel, admins are told once.
- **Paper for a child** (coordinator's decision, the owner being asked): not emailed; staff give
  the guardian the PDF download. One function decides (`paperCopyRecipient`). "Email a copy" first
  shows the address (`agreement.copy.preview`) and `agreement.copy.send` takes it back as
  `confirmTo`, refused if it is not the host's address now. A paper form's name, signer and note
  are in a person's download only for an adult's own form; for a minor's, only staff's.
- **A guest's copy names the buyer as typed**, never the Person staff matched the address to.
- **Erase** clears a copy's address and cancels any copy not yet sent, a claimed one included.
  Cancelling a person's pending approval of such a copy and scrubbing the gatekeeper's journal
  entry are step 8's.
- **The PDF writer measures publishing**: `agreement.publish` refuses a body whose signed PDF,
  with the longest record and answers it may carry, would pass 400 pages. Core now imports the
  writer for that measure, so cos-runner carries it.

## Amended 2026-11-23: after the second review of PR #283 (before it merged)

- **Keys are kept per class of queue, not per kind.** The kind can change between a send and its
  retry (the host holds a routine email it first decided routine; a caller's recipients make it
  internal one time and not the next), so a key keyed by kind missed its first send and a second
  one was made. A key is remembered as `idemc:<class>:<key>` and answers any retry from the same
  class. The fake outbox keys them the same way.
- **Each class's keys are pruned by its own volume**: callers' 2,000 most recent, the agreements
  mail's 20,000 (bounded by acceptances), so no class's keyed sends evict another's.
- **Upgrade**: a key remembered before (`idem:<key>`) is still read on a miss, except a copy's,
  so a retried routine email or automation step finds its first send across the deploy. **This
  fallback is dropped after one release.**
- **Pending sends are held to two pools**: callers' (with the host's routine and orders mail), at
  most 500 waiting; and the host's independent mail (agreements, sign-in), at most 100 waiting, so
  callers' sends never block a copy or a sign-in code. A copy refused because its pool is full
  stays `queued` (15 minutes), the try is not counted, and admins are told once.
- **The writer is its own package** (`@composable-os/agreement-pdf`, no dependencies), imported by
  the email gatekeeper and the host's download route. The host's core asks only its page estimate
  (`@composable-os/agreement-pdf/estimate`: every character as wide as the widest, a greedy line
  break's waste, the narrowest indent, the tallest block kept together), which never says fewer
  pages than the writer draws (tested against the writer over seeded random documents), so core
  and cos-runner carry no writer.
- **What went wrong is a category** (`queue_full`, `refused`, `rate_limited`, `outcome_unknown`,
  `floor_denied`, `turned_down`, `invalid`, `unreachable`, `not_decided`, `not_drawable`), never
  the gatekeeper's or the provider's words, which may name the recipient; the audit row of a copy
  that failed to apply says only its outcome. Erase clears the category and the pending approval's
  id with the address.
- **What stays in the email gatekeeper's storage until step 8** (erase does not reach it yet): the
  sent history's recipient and subject for its last 200 sends (`listSent`, shown only to the same
  class of queue), and every pending, failed or not-yet-forgotten journal record of a copy, with
  the whole message: the address, the record lines, the name typed and the strokes.
