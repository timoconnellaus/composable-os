# ADR 0673: Which number is textable: marks on phone numbers, checking by code

Status: accepted, 2026-11-24 (stage 30, build step 3: `feat/stage-30-text`, block BB: migration
0911). Builds on ADR [0590](0590-routine-mail.md) (value marks, and its third amendment: an address
is routine one by one) and ADR [0672](0672-the-text-gatekeeper.md) (the text gatekeeper). Issue
#302's rule (a former address now another Person's), for numbers.

## Context

A text goes to a phone, and a wrong number texts a stranger at the business's cost. Texting only
numbers a member confirmed by a code is safe, but most members would never confirm one, so the
text fallback would reach almost nobody (the draft's rule, rejected at the interview). An address
is already routine one by one (`emails:<address>` marks): routine when a person stands behind it,
never when an AI wrote it. Phone numbers were written by staff and AI like any field and not
marked.

## Decision

**Numbers are marked one by one**, as addresses (`packages/core/src/routine-mail/marks.ts`): each
number on a Person (`phones:<digits>`, digits and a leading `+`) carries the mark of whoever added
it, whoever rewrites the list later; a removed number loses its mark; which number is primary is
marked too (`phones:$primary`). A merge's numbers carry their sources' marks.

**A number is textable for a Person** (`textReach`, `packages/core/src/routine-mail/texts.ts`) when:

1. it is their primary mobile (or, when the primary is not a mobile, their first mobile) in a
   country texts may go to (`textCountries`, the business's own first: a number written without
   its country code is read as that country's; `routine-mail/numbers.ts` knows Australia, New
   Zealand, the United Kingdom, Ireland, the United States and Canada, where a mobile cannot be told
   from a landline and any number is taken as one); and
2. a person or a default stands behind it (its mark), **or** this Person checked it by a code sent
   to it; and
3. no other Person checked it by code (a number checked by one Person is never texted for another),
   and it has not replied STOP (ADR 0672).

A number an AI added, or a primary an AI chose, is never textable until its owner checks it by
code. A member's own number (`me.update`, a customer's mark) is textable once they check it. One
text per recipient, to that number. The answer costs six statements whatever the Person holds (a
statement-count test), and the caps and stops know the number only as a salted hash
(`text:<hash>`; the salt is made once for the deployment by migration 0911).

**Checking by code** (`me.phone.startCheck`, `me.phone.check`, customer audience, `hostInternal`,
not in MCP):

- only a number on the member's own record, and a mobile in a country texts may go to: a code is
  never sent to a number someone just typed;
- at most three codes a day for the member and three a day for the number whoever asks (and three
  a day per number at the gatekeeper too), each counted against the month's text limit, refused to
  a number that replied STOP;
- the code is the provider's: the text gatekeeper's `phone-check` queue sends and checks it, and
  the host never sees it; a code may be typed back within 10 minutes;
- a match records `core_phone_check` (the number, its hash, when) and marks the number the
  member's own (`customer`), unless a person already stands behind it.

An erase deletes a Person's checks; their stops stay as salted hashes tied to nobody.

## Consequences

- Staff and a member's own account keep writing numbers as before; only texting reads the marks.
  A number staff typed in is texted, a number an AI found is not.
- The customer screens (checking a number in Your details) are the base-layer blocks of stage 30
  step 5; the operations are here.
- A country the table does not know cannot be chosen; adding one is a line in `numbers.ts`.

## Amendment, 2026-11-24 (the review of PR #435)

- **The three codes a day are counted in the statement that writes the check**
  (`INSERT … SELECT … WHERE` both counts are under three), so calls at once cannot pass them.
- **Three tries a code at the host**, counted before the provider is asked, whatever the provider
  allows: a real provider module need not be trusted to limit guesses.
- **A residual risk, accepted:** each code counts against the month's text limit, and any signed-in
  member can put a mobile on their own record, so many accounts asking for codes (three a day
  each) can bring the month to its limit, after which routine texts are `over_limit` until it turns.
  The per-Person, per-number and limit caps are the mitigation the spec names; admins are told at
  80%. A separate allowance for codes is left until a business needs one.
