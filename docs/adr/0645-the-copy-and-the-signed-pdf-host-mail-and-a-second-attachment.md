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
- **One PDF writer of our own** (`packages/gatekeeper-email-send/src/agreement-pdf.ts`, no imports):
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
- A copy held for a person by the floor stays `waiting` once approved; the row does not learn of
  the later send.
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
