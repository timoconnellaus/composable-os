# ADR 0720: The intake door, the one public write that is not a purchase

Status: accepted, 2026-11-24 (stage 29, build step 2). Amends ADRs
[0402](0402-staff-and-customers.md) (the public may create, here only),
[0412](0412-customer-scope-and-principals-as-built.md) (the seam's "the public change nothing" has
one more host-made exception) and [0438](0438-the-public-scope.md) (a public read of a form goes
through the door, beside the public scope). Builds on ADRs
[0413](0413-outside-handlers-have-no-raw-database.md), [0414](0414-pack-tools-run-as-the-customer.md),
[0428](0428-buying-without-an-account.md) (`recordHostChange`), [0446](0446-publishable-without-its-public-half.md)
and stage 29 step 1 (the question schema).

## Context
Stage 29 lets a visitor with no account send an enquiry, a sign-up or a survey answer, and Reviews
(stage 54) needs the same for a review. Until now the public could create nothing but an order: the
seam's write check refuses every change a public caller records, and the only public writes are
purchases, whose records the host makes after pricing them (ADR 0428). Opening `record.create` or
`my.create` to the public would let it create any record a tool names, with no form, version or
abuse check between. A door inside the Forms pack would need a second one for Reviews.

## Decision
- **A behaviour, `intake`, in three roles** (`packages/sdk/src/intake.ts`), declared only by shipped
  packs and the org's own extensions (a runtime extension is refused as `outside_audience`):
  - `form`: what is answered. A publishable object whose `questions` is a document field with the
    platform's `QUESTIONS_SCHEMA` in its published content, with `answeredBy` (a select among
    `public`, `customers`, `links`, `staff`), `openIn` (states), and optionally `anonymous`,
    `destination` (an object's name), `opensAt`, `closesAt`, `dailyCap` and `notify` (a user).
  - `submission`: one set of answers. A relation to its form object (one submission object per form
    object), `version`, `answers` (a document field with `ANSWERS_SCHEMA`), `person`, `certainty`
    (exactly `account`, `link`, `staff`, `address`), a `spam` state the host may create it in, and
    optionally `via` and `rating`. It may declare no `customer`, `customerVia`, `public` or
    `signedIn`: nobody outside reads a submission, not even its submitter.
  - `destination`: a record a form may also make (a Lead), with its `person`, the `fields` a form's
    questions may fill and an optional `source` the host sets to `website`.
- **Two core operations, both `toolOnly` and `hostInternal`, open to staff, customers and the
  public** (`packages/core/src/operations/intake.ts`), listed in `open-operations.json`:
  - `intake.open` (read): the form as the caller may answer it now, its published version and, for
    the public, the shown-time token (ADR 0722).
  - `intake.submit` (write): the door. It checks the form takes answers from the caller now, the
    spam checks and caps (ADR 0722), the answers against the published version answered, then
    writes in one batch, as the host's change (`recordHostChange`), the submitter's Person (ADR
    0721), the submission, any destination record and the notice to staff.
- **Only the pack's own tool reaches them, for its own forms.** A direct call (a person, MCP, the
  assistant) is the unknown operation; the calling tool's extension, from the runner
  (`ctx.callingTool`, never the input) or the staff run's extension, must own the form object.
  The tool must list the operations in its permissions, as any call. The pack adds no write of its
  own: what the public can cause is exactly what the door does.
- **A submission is the evidence, and the host's alone.** Only the door creates one: `record.create`,
  an import, `my.create` or any other create of a submission object is refused
  (`rule: "intake_host_only"`), whoever asks. Its `form`, `version`, `answers`, `certainty`, `via`
  and `rating` are written by the host only, by every path, staff and the assistant included. Its
  Person stays staff's to set (after merging People with one address) and its state staff's to
  move.
- **A form's settings that change how answers are treated are versioned.** `answeredBy`,
  `anonymous` and `destination` must be in `publishable.content`, and the door reads them, as the
  questions, from the version answered: an unpublished edit (by a person or an AI) cannot open a
  staff form to the public, turn anonymity off or send answers to another destination. The state,
  dates, cap and who is told are the working copy's (closing a form early needs no publish).
  `intake.submit` takes the `version` `intake.open` showed and refuses it once another is published
  ("load it again"). A destination's fields are filtered again at submit time by what its intake
  lists now, so a pack upgrade that lists fewer fills nothing it no longer lists.
- **A form is found only while it takes answers.** Published (a current version), in an `openIn`
  state, within its dates and open to the caller (`public`: anyone; `customers`: signed in;
  `links`: a personal link, stage 29 step 5; `staff`: staff only), else not found, the same answer
  whatever the reason. Staff, entering a phone call or paper, reach any published form.
- **The answers are checked against the version answered**, and the submission points at it: a
  form edited after publishing takes answers to its new version only once that is published, and
  old submissions keep theirs.
- **The questions are checked on every write of a form**: the record operations run
  `checkQuestions` on each create and update of a form object, with the form's anonymous flag and
  the fields its destination's intake lists; a destination that is not an installed object
  declaring `intake` (`destination`) is refused, and so is any destination on an anonymous form.
- **What the audit keeps.** `intake.submit`'s audit row holds the answers redacted and, as its
  result, the question keys answered; a refusal's error names question keys and fault codes, never
  a value. The submission record's own history holds its answers as any record's does, and goes
  with the record (erase, step 7).
- **Too many links is a refusal.** The spec listed it both as an answer fault (criterion 6) and as
  a reason to keep a submission as spam (check 7). Settled by criterion 6: a text answer with more
  than 3 links is refused naming the question's key (`checkAnswers`, fault `links`). Check 7 is the
  per-mailbox rule only.
- **The declared intake** (a pack's object answered directly by its own fields, with no form:
  Reviews' review) is the next role of this behaviour. It is not built here: stage 54 adds it as a
  fourth role with the same door, the same Person and the same checks.

## Consequences
- The seam's rule "the public change nothing" holds for every other path; a public
  `record.create` or `my.create`, directly or from a tool, is still refused.
- A form object is the pack's own: the door neither reads a public declaration nor needs one.
  The Forms pack (step 3) may still declare a public scope for its published forms.
- Staff are told of each submission: the form's `notify` user, else the admins. A per-user list,
  and the owner rule, wait for a field that holds several users.
- Not yet tried on a live host.
