# ADR 0724: The receipt to a public address, and the form-link slot

Status: accepted, 2026-11-25 (stage 29, build step 5: `feat/stage-29-personal-links`, block BG).
Amends ADR [0590](0590-routine-mail.md) (routine mail: who a kind's email may go to, and a slot
the host fills with a link it makes). Builds on ADRs [0723](0723-personal-links-used-once.md)
(personal links), [0675](0675-consent-to-be-contacted.md) (the register, the stop link) and
[0721](0721-the-submitters-person-and-certainty.md) (certainty).

## Context

Two emails of stage 29 are routine mail that ADR 0590 could not send:

1. **The receipt** (decision 3): a short email to whoever sent answers. A visitor's typed address
   carries the public's mark (ADR 0590's default deny), so a receipt to it was always held; and a
   submission has no customer declaration (nobody outside reads one, ADR 0720), so routine mail had
   no recipient for it at all.
2. **Feedback after a class** (decision 4): an email carrying a personal link, which the host must
   make for the right Person while it prepares the email, and which must never go to a child's own
   address.

## Decision

### The receipt

A kind may declare `receipt: true`. The contract check (`personalLinkIssues`,
`packages/sdk/src/routine-mail.ts`) requires it to be about one of the extension's intake
submissions, by email only, with purpose `account`, no guardian's words, no calendar file, no list,
and slots that read only the submission's form (`form.<field>`): never an answer, a name or
anything the sender typed. The host (`receiptRecipientsOf`, `packages/core/src/routine-mail/`):

- **Who:** the submission's Person, at, by certainty: `account`, their own verified sign-in
  address; `link`, their primary address (where the host sent the link); `address`, the address
  they typed, when the same-email rule says it is that Person's. `staff` (answers staff entered),
  an anonymous submission (no Person), one kept as spam, and a Person erased, merged away or in the
  Trash get none.
- **The amendment to ADR 0590:** for a receipt only, the address may carry any mark but an AI's
  (the public's included), and the submission's link to its Person, its state and its link to its
  form may be the door's (the public's): the email shows nothing the public stands behind (its
  values still need a person's or a default mark), and it goes to the address its sender gave.
  Which address is primary is not checked: the receipt goes to the one given.
- **At most three a day to one mailbox** (`RECEIPT_DAILY_CAP`, counted by `mailboxKey` over the
  kind's rows of the last 24 hours that were not off, stopped, failed or over the limit): the
  fourth is kept `over_limit`, with no words, and never sent or held. ADR 0590's 20 a day and the
  organisation's cap still apply at the claim. The count is at preparing, not in the claim's
  statement: two answers prepared at the same instant may both pass (bounded by the caps above).
- Consent and the suppression list are asked as for every routine email; a receipt is essential
  (purpose `account`), so it carries no stop link.

The Forms pack declares `forms.receipt` ("We got your answers: {form}", the form's title only)
and the automation that asks for it when a submission is created, when the form's receipt is on
and it is not anonymous. The business's name is not in the words: routine mail has no slot for
the organisation's name that a person stands behind (its general settings others may change, the
review of PR #339); the email comes from the business's own address.

### The form-link slot

A slot may be `{ formLink: { object, setting, days?, once? } }`: a form object's registry name
(`forms.form`), a text setting of the extension a person approves (`personApproves`) holding the
form's address, how long the link stays good (default 7 days, at most 30) and, with `once`, how
many days a Person is not asked again about another record. The contract check: at most one per
kind, email only (never a text or a push), never in a subject or an optional part, and the kind is
about an object with a customer (the link is for the record's own Person).

While preparing the send (`planLink`), the host:

1. drops an order's address and, when the record's Person has a live guardian, the Person's own
   address: a child's link goes to their guardians only;
2. finds the form by the setting, open to answers by link now (published, open, within its dates,
   not a staff form, not anonymous); with none, each email that would go is kept `failed` with the
   reason (an email asking for feedback without its link is never sent);
3. with `once`, sends nothing (no rows) when the Person was sent a link to that form about another
   record within that many days;
4. finds or makes the link for (Person, form, record): made by an earlier send about the same
   record, nothing is sent; found by a retried step of the same send (`made_for` is the kind and
   the run its chain began with), it is reused;
5. for each email that may go (consent asked first, ADR 0675: one that is stopped or suppressed
   makes no link and no token), makes a token and writes the link's address on the business's site
   (`<site>/form?t=<token>`, `PERSONAL_LINK_PATH`). Without the site set no link can be made, and
   the email is kept `failed` with the reason.

The link is on the business's site, so the email gatekeeper's rule (every link in a routine email
on the site) holds unchanged; the stop link is still the last line, and the `List-Unsubscribe`
header still equals it (PR #451): there is no second way to send.

Bookings declares `bookings.feedback` (purpose `follow_up`: optional, with its one-tap stop) with
the slot (`feedbackForm`, 7 days, once in 30) and the automation `feedbackAfterClass`: a
`dateRelative` on the booking's `markedAt`, `feedbackMinutes` after it (default 180), while the
booking is `attended` and a feedback form is chosen. The pack holds no rule: who is asked, how
often, by which form and with which link is the host's.

## Consequences

- A visitor gets a receipt once the pack's routine email is on; a fourth to one mailbox in a day,
  and any to answers staff entered, never go.
- Feedback after a class needs the business's site set (Settings → Routine email), a feedback form
  chosen in Bookings' settings, and the client web app's form page at `/form` (stage 29 step 4).
- Trades' "after a job" and Reviews' ask use the same slot.
- Not yet tried on a live host.

## Proof

| Check | Test |
| --- | --- |
| A receipt's declaration: submission, email only, the form's fields only, no guardian | `packages/sdk/test/routine-mail-links.test.ts` |
| A form-link slot's declaration: a person's setting, email only, not in a subject or optional part | `packages/sdk/test/routine-mail-links.test.ts` |
| The receipt to a signed-in member's own address, fixed words; the fourth in a day not sent; none for staff's answers or a receipt off | `apps/runner/test/forms-links.test.ts` ("the receipt") |
| Feedback after the set minutes, once a month; a child's to the guardian only | `apps/runner/test/forms-links.test.ts` ("feedback after a class") |
| A Person who stopped follow-ups, or is suppressed, is not asked and no link is made | `apps/runner/test/forms-links.test.ts` ("nobody who stopped is asked") |
