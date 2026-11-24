# ADR 0644: Enforcement: nobody pays, subscribes or books without what is due

Status: accepted, 2026-11-23 (stage 44, build step 3). Builds on
[ADR 0641](0641-agreement-points-a-pack-declares-documents-a-person-attaches.md) (points,
`agreementsDue` and its guard) and [ADR 0642](0642-acceptances-a-record-nobody-changes-and-who-may-agree-for-whom.md)
(acceptances); amends ADRs [0428](0428-buying-without-an-account.md),
[0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md),
[0491](0491-continuation-offers.md),
[0503](0503-time-windows-and-staff-only-on-the-transition-engine.md),
[0540](0540-the-family-link.md) and [0560](0560-a-paid-line-moves-a-record-that-exists.md) with
dated notes. Stage 44's spec, "The one question", "How a person agrees" and acceptance criteria 1
to 3, 6, 11 and 13.

## Context
Steps 1 and 2 built the documents, the points, the acceptances and the one question, and nothing
asked it: a member could pay, subscribe or book with every document due. Decision 6 says agreement
is required before a person can pay for or start a membership or pass and before their first
booking, and the spec's goal says: not a member, not staff for them, not the assistant, not an API
call. The checks must hold for every actor on every path, and a pack cannot hook a write (ADRs
0404, 0405), so they live where every path already goes: the orders pipeline, subscription start
and the transition engine.

## Decision

**Three places ask, all the host's** (`packages/core/src/agreements/enforce.ts`), before the
write's batch is planned, and the batch carries the `agreements` guard on the counter it read
(migration 0851):

- **Purchase** (`enforcePurchase`): `createOrder` asks at the points the bought objects declare
  (every order: `order.start`, `order.startHeld`, so the pack tools `x.memberships.buy`,
  `x.ticketing.orderStart`, `x.courses.buy` and `x.bookings.buy`), and `startSubscription` asks at
  the plan's point, before the provider's page is opened and before an open page (its trial, a
  continuation offer's) is handed out again. Participant documents are judged for whom it is for
  (the holder, a drop-in's booking Person, a guardian's child), payer documents for who pays.
  `order.honourLate` asks again for the order's Person: keeping a late payment makes the
  purchase, and a guest's acceptances went with the order when it expired.
- **Entry** (`enforceEntry`, called by `applyTransition` for every object, after the state rules):
  a caller's record entering a state its point lists, for the Person its `person` relation names.
  It counts when the record is created in such a state; moves into one from any other state (a
  waiter taking a free place), except, for an object with `claims`, a move between two states
  that both hold the place (a coach unticking a name: attended to booked is the same booking);
  or stays in one while its Person changes (staff giving a booking to someone else). The host's
  own moves (`by: "host"`: a promotion, a paid drop-in booked, timed moves, a series' records)
  are never asked, so "agree again" is not retroactive.
- **Guests** (the public, buying without an account): the acceptances travel in the buying call
  (`agreements` on `order.start`, `order.startHeld` and `subscription.start`, passed on by the
  packs' buying tools). They must cover every live document attached at the points that is for
  everyone, each once, of its current version; anything else is refused
  (`agreement_not_asked`). No Person is read for a guest, so the answer is the same whatever the
  address matches (a member who has agreed is asked again, as anyone). They are recorded through
  `accept.ts` (`by: "guest"`, the order or the checkout, the order's address, no Person) after the
  order or the checkout row in the same batch.

**Refusals.** Something due is `invalid_input` with `rule: "agreements_due"` and the documents by
id, title and version to read: a customer's own and their dependant's, each naming the Person;
staff's naming the Person; a guest's naming no Person. A batch whose counter moved before it
committed is `conflict` with `rule: "agreements_changed"` (passed through to customers and the
public too: the counter is one for the host and says nothing about anyone). An address several
People share is refused while anything is due, until staff merge them.

**No bypass for staff.** Only a guest carries acceptances in a buying call; a customer agrees
first (`me.agreements.accept`), and staff, the assistant and MCP are refused with the list
(send a link, sign at the desk, record paper). A pack tool's thrown refusal reaches its caller as
the tool's error with the host's code and details inside.

**Settlement and deletion are triggers** (migration 0853), so every writer and path does them in
the batch that makes them true, whatever order the host queues its statements in:
- an order with something paid and a Person (the verified payment's batch; `order.setPerson`
  when the address matched several People) gives its guest acceptances that Person;
- a subscription checkout the provider confirmed (`subscription_ref` set in the verified event's
  batch) gives them the holder (participant documents) or the payer (payer documents);
- an order that closes with nothing paid (expired, cancelled) deletes them, their signatures and
  answers. A subscription checkout never confirmed has no such moment: the minute cron's
  `agreement.takeEffect` deletes its guest acceptances three days on.

**Points declared** (one declaration each): `memberships.plan` and `memberships.passtype` share
`membership` ("Buying a membership or a pass"); `memberships.pass` declares the same point with
`enter: ["active"]`, so a pass staff give by hand (`givePass`) asks as buying one does (a granted
pass is the host's); `bookings.booking` has `booking` (`enter: ["booked", "waiting"]`);
`ticketing.tickettype` has `event`; `courses.course`, `courses.bundle` and `courses.plan` have
`course`. Nothing is attached by default.

**Audit.** `agreements` is redacted from the audit of `order.start`, `order.startHeld`,
`subscription.start` and every extension tool, so no name typed, signature or answer reaches it.

## What is not asked, and why
- **The host's own moves and writes**: promotion from a waitlist, a paid drop-in booked, timed
  moves, records a series makes, what a paid line or a subscription grants (a pass, a ticket, an
  enrolment, a membership), a subscription's renewals and its period orders. Asking them would make
  "agree again" retroactive.
- **What already exists**: paying an order already started (it expires in minutes) or a part-paid
  balance, cancelling, leaving a waitlist, a plan change or a pause of a running subscription. A
  plan change is an existing membership's, not a start (open to review).
- **Enrolments staff give, and the courses import**: Courses' points are on what is sold (the
  spec); giving access by hand is not buying, and imported students are moving over.
- **A ticket staff make by hand**: tickets are what a paid line grants; nobody sells one by hand.

## Consequences
- A booking or an order planned before any change to what is due (a publish, an attach, a detach,
  a retire, a version taking effect, a minor mark, a family link, the Trash, a merge, an erase)
  fails at commit and is retried against what is due now.
- A guest's acceptance becomes a Person's on the evidence of a verified payment with that
  address, as the order does (ADR 0428); someone paying with another's address makes that Person
  an acceptance they did not give, as they make them an order. The copy emailed to the address
  (step 4) is the person's notice.
- A visitor's health answers and signature pass through the Bookings, Memberships, Ticketing or
  Courses buying tool on their way to the host (the spec's choice): shipped, reviewed pack code;
  the tool's audit never holds them.
- A staff move of a booking to another class makes a new booking and is asked like one.
- Imports of bookings through the record CSV import are staff writes and are asked; the booking
  import still to come (stage 33) decides how moved bookings arrive.

## Proof
`packages/core/test/agreement-enforcement.test.ts` (a fixture pack with a plan, a pass, a ticket
and a visit with `enter`, the payments double): a customer refused a pass, a subscription and a
visit booked or waiting until they agree, and allowed after; a waiter taking a place asked, the
host's promotion not; a moved member's continuation offer refused until they agree; a guardian's
child needing the guardian's acceptance; staff, the assistant and MCP refused, acceptances in a
staff call refused, a visit given to another Person asked; a guest's order and subscription
needing their acceptances, recorded Person-less and settled at payment, at the provider's
confirmation and at `order.setPerson`, deleted at expiry, and the same answer for a member's
address and a stranger's; the race over an order, a visit and a subscription (an "agree again"
publish and an attach held across the batch), and a minor mark, a family link, the Trash, a
merge and an erase each failing a batch planned before; not retroactive (a visit kept, a running
subscription's event applied, a small change asking nobody); a ticket selling as before with
nothing attached and needing its waiver once attached; over HTTP. The shipped packs in
`apps/runner/test/agreements-enforcement.test.ts`: the points listed; Ticketing and Courses
selling as before; `x.memberships.buy`, `subscription.start`, `x.bookings.book` and
`x.bookings.buy` refused until agreed; a parent's drop-in for a child; `x.bookings.bookFor` and
`x.memberships.givePass` refused, then allowed after paper; a visitor's drop-in with its
acceptances settled at the verified payment; after "agree again" a coach unticking, a booking kept
and the cron promoting a waiter, and the waiter's next booking asked.

## Amended 2026-11-23: the review of PR #280

- **A minor never pays where the payer must agree** (the owner's decision of 2026-11-24). A Person who is a minor (marked, or a live
  dependant) and would be the payer at a point with a payer document is refused by
  `enforcePurchase` (`order.start`, `order.startHeld`, `subscription.start`, `order.honourLate`,
  `order.setPerson`): `agreements_due` with `reason: "minor_payer"` and "a parent or guardian needs
  to buy this for you". Nothing the child does satisfies it (`minorPayerDocuments` in
  `agreements/due.ts`, the one place to relax it if the owner decides a guardian's earlier
  agreement may let it through).
- **A guest's acceptance counts only for its own purchase** (the owner's decision of
  2026-11-24). It is checked in its buying call and settled to the matched Person as the evidence
  of that purchase, and it never counts for that Person at a later point
  (`guestAcceptanceCountsLater` in `agreements/due.ts`, one place). So a stranger's guest purchase
  with a member's address never stands in for the member's own agreement, a booking's waiver or a
  moved member's continuation offer.
- **A guest's purchase with a minor's address** (the owner's decision of 2026-11-24): it
  stands (refusing at checkout would say the address is a child's). The child stays due (reason
  `guardian`: a guest's never counts, nor a minor's own). In the batch that settles it (the
  verified payment, a guest's drop-in matched at payment, `order.setPerson`, a confirmed
  subscription checkout) staff with `agreements:manage` get a notice for the person only, naming the
  order or checkout and nothing of the documents or answers (`guestMinorNotice`). No hold and no
  refund are built.
- **`order.setPerson`** takes only a Person the order's address matches (or the survivor of a
  merge of one), refused otherwise (`order_person`), and a minor only once nothing is due for them.
- **`order.honourLate`** does not judge an order that moves a record (a drop-in): its move hook
  refuses honouring it (`held_gone`), and its participant is the booking's Person, not the payer.

## Amended 2026-11-24: the blocks (stage 44 step 5)

- **The inline step follows the refusal.** A block that buys or books makes the call; when the
  host refuses it with `agreements_due`, the block shows the documents it named, in turn, and makes
  the call again once they are agreed. No operation tells a block in advance what a purchase will
  need: the refusal, made before any batch is planned, is the one answer, so it cannot disagree with
  the check that holds. On `agreements_changed` the block asks again and tries once more
  (`withAgreements` in `@composable-os/client`); a visitor whose agreements are for an older version
  (`agreement_not_asked`) is asked again with none and shown what is due now.
- **A visitor reads the words through `agreement.guestVersions`** (customer and public,
  `hostInternal`, read): the versions a refusal named, as recorded. Only the version in effect of a
  live document attached somewhere and asked of everyone (what `guestDue` asks); anything else, a
  version scheduled for later included, is left out. It reads no Person, and the text is the business's. Opening it to the
  public is the reviewed change ADR 0402 asks for.
- **Bookings' tools pass the host's agreements refusal through** as it is (`agreements_due`, and
  `agreements_changed`, which before this was told as "it changed while you were booking"), so the
  block can tell a change of what is due from a change of the class.
- **What a visitor gives is held in the screen's memory only** until the buying call, which the
  packs' clients make with no cache kept after it (`gcTime: 0`), as `me.agreements.accept` and
  `me.agreements.get` are.

## Amended 2026-11-24: staff-given enrolments and hand-made tickets are asked (issue #281)

- **"Enrolments staff give" and "a ticket staff make by hand" move out of "What is not asked".**
  Giving access by hand starts it as buying it does, as a pass given by hand already did: anyone
  granted `courses:enrol` (the assistant included) or able to write a ticket could otherwise start
  one with everything due. `courses.enrolment` declares `course` (`enter: ["active"]`, for its
  `holder`) and `ticketing.ticket` declares `event` (`enter: ["valid"]`, for its `holder`), so the
  engine asks `x.courses.enrol`, a record made by hand, an ended enrolment made active again and a
  record given to another holder. What a paid line grants stays the host's (`by: "host"`), asked
  when its order started.
- **`keeps`** (new, optional, only with `enter`, not with `claims`): the states a record keeps its
  entry in, as `claims`' held and confirmed states do for a booking. A ticket is `valid` or `used`:
  made straight into "used" it is asked; undoing a check-in is the same ticket and is not.
- **`importMovesOver`** (new, optional, only with `enter`): a record `record.import` makes is
  someone moving over and is not asked. It is the courses import's door (`actors: ["human"]`, not
  on MCP), so imported students stay as decided above. Only the create: a later import that gives
  the record to another Person or makes it count again is asked, as any caller's write (the review
  of PR #357). The engine is told by the operation (`TransitionOptions.imported`), never by a field
  value, so `source: "import"` written through any other path is asked. The CSV record import
  stays asked: it is open to the assistant.
- **What this leaves open, on purpose or for later:** `record.import` needs only `records:write`,
  so any person on the staff (never an AI, MCP, an extension or an automation) can make an
  enrolment through it unasked, whatever its `source` says: the import is a person's door for
  moving over. A record restored from the Trash (`record.restore`) is not asked: it is the same
  entry, and "agree again" is not retroactive. Payer documents are not asked of a hand-made
  record (`payer: null`, as `givePass`). A ticket with no holder names no Person and is not asked
  until it is given one.

