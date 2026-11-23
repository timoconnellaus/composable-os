# ADR 0590: Routine mail, a shipped pack's declared email sent without approval

Status: accepted, 2026-11-23 (`feat/routine-mail`, block AS: migration 0750). The owner's
decisions of 2026-11-23. Builds on ADRs [0051](0051-outbound-approvals.md) (outbound approvals),
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md) (the host's own message),
[0456](0456-the-hosts-sign-in-mail.md) (sign-in mail, the shape this
follows), [0540](0540-the-family-link.md) (guardians), [0560](0560-a-paid-line-moves-a-record-that-exists.md)
(a paid visitor's order address), [0571](0571-a-calendar-file-made-by-the-email-gatekeeper.md),
[0573](0573-runs-over-the-rate-rail-wait-their-turn.md) and
[0574](0574-an-idempotency-key-on-an-email-send.md). Amends [0572](0572-bookings-messages-the-dashboard-and-the-coachs-app-screen.md).

## Context
Under the default (Balanced) preset every email an automation sends is an outbound action a
person approves. A gym sending hundreds of booking confirmations a day cannot work that way
(ADR 0572's consequence). The owner decided:

1. A pack's own routine emails send without approval: only fixed emails the pack declares
   (confirmation, reminder, change, cancellation), only to the member the record belongs to and
   their linked parent, never anything an AI wrote. Everything else still waits for a person.
2. An admin can switch any one kind of routine email off.

Loosening approval is the owner's decision; this builds exactly that, and the guarantee is the
host's, not a pack's good behaviour (ADR 0405).

## Decision

**A routine email is declared, fixed and shipped.** An extension declares `routineMail` in its
manifest (`packages/sdk/src/routine-mail.ts`): kinds, each about one of its own objects (or a core
order), each with messages of a subject and a body with named slots, a guardian's version, and
optional calendar events. The words are the declaration's. A slot holds:

- a field the host reads itself from the record, or along relations to the extension's own
  objects only (`class.room.name`), written as text, a time in a zone, a date, money or a count;
  never an email, URL, phone or user field;
- one line per record of an own object pointing at it (`each`: a buyer's tickets);
- a link to one of the extension's text settings, used only when it is on the business's own site;
- from the pack, only a key of declared words (`choice`), a moment, a whole number up to a bound,
  or a flag that keeps or drops an optional part `[...]`.

The contract check refuses words holding a link, an address or markup, a slot not declared, a slot
that may be empty outside an optional part, a path leaving the extension, a `{member}` outside a
guardian's email, and the `routine-mail` module without a declaration. A **runtime** extension (the
assistant's or anyone's in the workspace) may not declare `routineMail` or the module at all
(`outsideDeclarations`, `packages/core/src/extensions/install.ts`), as with roles and `sellable`.

**Sending is a host module, in an automation run of a shipped extension only.**
`ctx.routineMail.send({ kind, record, message?, values? })` reaches `codemode:routine-mail`
(`RunHost.#routineMail`, `apps/runner/src/executor/host.ts`), which answers only an automation run:
not a tool (whoever called it), not Code Mode, not a customer's call, not a test run. It calls
`prepareRoutineMail` (`packages/core/src/routine-mail/index.ts`), which decides from the database,
never from the code's claims: the extension is `shipped` and `active` in `core_extensions` (an
ejected pack is `runtime` and refused); the automation is that extension's and the run is its
recorded run; the kind is in the installed manifest; the record exists, is of the kind's object,
and is the run's record, points at it, or shares a relation to an own object with it (another
booking of the same class); the values fit their slots (an address, free text for a host's slot,
or a choice not declared is refused). There is no operation: the assistant and MCP have nothing to
call.

**The recipient is the host's.** From the record: its declared customer Person's primary address,
each guardian with a live link where the object opens to guardians (ADR 0540), or, for a core order
or a visitor's held drop-in with no Person, the order's own address once a payment was applied
(ADR 0560). One email per recipient. A send names a record, never an address.

**What is routine, and what is held for a person.** Each recipient's email is a row of
`core_routine_mail` (migration 0750). It is `routine` only if all hold; otherwise it is held, and
the row says why:

- every value the host put in passes `unroutineText`: one line, short (120 characters by default,
  a cancellation's reason 200, a member's name 80), no hidden or control characters, nothing that
  is or becomes a link (`://`, `www.`, `example.com`, IDN), no `@`, no markup or brackets. A class
  title or a child's name holding a link is held, not sent;
- no required slot is empty;
- the run started from a record change, a moment or a schedule: not a manual trigger, and not a
  replay (`automation.replay`, which an AI may call, would send the email again; a retry resends
  nothing, its sends being keyed);
- the change that started it was not an AI's (assistant or MCP) that no person approved: the root
  audit row of the cascade is read. A tool an AI calls now carries its own call as the root of the
  tool's writes (`packages/core/src/extensions/tools.ts`), so a booking an AI makes through a tool
  is held too;
- the recipient has had fewer than 20 routine emails in the last 24 hours (`ROUTINE_DAILY_CAP`): a
  loop cannot mail-bomb a member; over the cap it is held, never dropped.

**The switch per kind** is in `core_settings` (`routine_mail`), changed only by a human admin
(`routineMail.settings.update`: `actors: ["human"]`, `settings:manage`, not on MCP), from Settings
→ Routine email. Off writes an `off` row and sends nothing and queues nothing. A kind is on unless
its pack declares `on: false` or an admin turned it off. The same setting holds the business's own
site, an https origin; with none set, routine email carries no link.

**The send, the gatekeeper and the gate.** The runner asks the integration host's
`sendRoutineMail(rowId)` (`apps/runner/src/integrations/host.ts`) to send each row from the org
email-send connection a person bound to the automation (that binding is their consent to the pack's
mail going out from that address). It is not on the cos-app runtime port. It claims the row and
sends the row's own words; the caller passes nothing else. Its queue (`HostQueue`, purpose
`routine-mail`) answers `hostRoutineMail()` with the site only for a row decided routine, and puts
the send in the automation run's change set. Email-send gives the send its own kind,
`email.routine` (not auto-approvable), only when that queue answers and the message has routine
shape: one recipient, plain text, no cc, bcc, reply-to or HTML, every link in the body and a
calendar file's link on that site, no calendar description
(`packages/gatekeeper-email-send/src/routine.ts`; the fake outbox uses the same module, as
`fake.routine`). `submitOutbound` (`packages/core/src/integrations/outbound.ts`) treats it as
routine only with both the host's flag and that kind; the gate (`evaluateGate`) then lets it apply
under Balanced and Autonomous. Anything else from that queue (a held row, a send the gatekeeper did
not confirm) is reviewed whatever the preset. A held email's approval is the ordinary one: an
`email.send` the approver reads in full.

**The policy and the floor.** Cautious reviews routine mail as every outbound action: an org that
chose it chose to approve what leaves. The deploy floor (`APPROVAL_FLOOR`) still applies after the
preset: `deny` on outbound refuses every routine email (the row says `denied`), and `review` on
outbound (for `*` or `automation`) holds each one for a person. An operator's explicit floor wins
over the owner's default. Settings → Routine email says which is in force (`sendsOnItsOwn`).

**Rails stay.** The automation's runs-per-minute and writes rails (ADR 0573), the gatekeeper's caps
and its full queue as back-pressure (a routine send waits like any other), and idempotency: each
row is keyed by the run its chain of retries began with, the kind, the message, the record and the
recipient, and its send by `routine:<row id>` (ADR 0574), so a retried step sends nothing twice.

**Audit.** Every row records the kind, the message, the record, the recipient and the rule that
chose them, the automation and run, what started it and who made that change, whether it was
routine or why it was held, and what became of it (`sent`, `waiting` with its pending action,
`off`, `denied`, `failed`). The words are cleared once decided. `routineMail.log` and
`routineMail.get` (admins: `audit:read`) show the log and each kind's last week; a sent one is also
audited as an applied outbound action. A person's erase deletes their rows.

## The packs
- **Bookings** (`packs/bookings/routine-mail.ts`): Booking confirmations (booked, booked and
  paid, moved in from the waiting list, moved by staff, with calendar files), Waiting list news
  (passed over and why, a place free after the cut-off), Class changes (with an updated file for
  the booked), Class cancellations (the reason; nothing used, nothing charged, or the money goes
  back once approved), Class reminders, Drop-in payments and refunds. All of the pack's member
  email fits. Wording changed only where a slot could not carry it: a guardian's email always reads
  "Sam is booked into" (not "You booked Sam"), and the link line reads "You can see your bookings
  when you sign in[: link]."
- **Ticketing** (`packs/ticketing/routine-mail.ts`): Tickets by email (about the order, to its own
  address, one line per ticket and per event), Event reminders (about the holder's first ticket,
  with how many they hold), Balance reminders (about the order; "Reply to this email to pay it" is
  gone: the email says to pay when signed in).
- **Courses** sends no member email today, so nothing moves.
- **Not routine, still approved**: the staff notice of classes with no attendance taken is in the
  app, not email. Any email an automation sends through `ctx.gatekeeper("email-send")` itself, any
  email the assistant, MCP, Code Mode or a person's `integration.call` sends, the host's sign-in
  and order mail (ADRs 0456 and 0429) are unchanged.

## Why
- Rules live in the host: the pack names a kind and a record; the host owns who, what and whether.
- Two keys, as ADR 0456: the host decides routine, and the gatekeeper confirms the shape at the
  edge where mail leaves; neither alone sends it on its own.
- When in doubt, held: a held email still reaches the member once a person approves it, so the
  checks can be strict.

## Consequences
- Under Balanced a gym's confirmations, changes, cancellations and reminders go out on their own;
  admins see each kind's count and can turn any off.
- Links in routine email need the site set (Settings → Routine email) and the pack's page on it.
- A booking staff make with the assistant waits for a person's approval of its email.
- More than 20 routine emails to one address in a day wait for a person.

## Proof
Each rule and the test that fails without it:

| Check | Test |
| --- | --- |
| Words with a link or address; undeclared slots; empty slots outside `[...]`; paths leaving the extension | `packages/sdk/test/routine-mail.test.ts` |
| A value with a link, an address, markup or a hidden character | `packages/sdk/test/routine-mail.test.ts` ("what a value may hold") |
| A runtime extension declaring routine mail or the module | `packages/core/test/routine-mail.test.ts` ("who may declare it") |
| The gate: Balanced and Autonomous apply, Cautious reviews, a floor's review holds and deny stops | `packages/core/test/routine-mail.test.ts` ("the gate", "submitOutbound") |
| A held send, or one the gatekeeper did not confirm, waits even under Autonomous | `packages/core/test/routine-mail.test.ts` |
| The settings only a human admin's; an https origin only; links only to the site | `packages/core/test/routine-mail.test.ts` |
| The routine kind only from the host's queue, only of routine shape | `packages/gatekeeper-email-send/test/routine.test.ts` |
| Sent on its own under Balanced, logged, counted; a retried step sends nothing twice | `apps/runner/test/routine-mail.test.ts` |
| The switch off: nothing sent, nothing queued | `apps/runner/test/routine-mail.test.ts` |
| The assistant's tool call, an MCP change, a replay the assistant asked for: held | `apps/runner/test/routine-mail.test.ts` |
| Code Mode, a tool, a customer's call: no module | `apps/runner/test/routine-mail.test.ts` |
| Not shipped (ejected), another extension, another automation, not a run, an undeclared kind | `apps/runner/test/routine-mail.test.ts` |
| An address, free text for a host's slot, an undeclared choice; someone else's record | `apps/runner/test/routine-mail.test.ts` |
| A link in a child's name or a class title: held | `apps/runner/test/routine-mail.test.ts` |
| Cautious, and over the daily cap: held | `apps/runner/test/routine-mail.test.ts` |
| Bookings' and Ticketing's emails on the shipped packs | `apps/runner/test/bookings-messages.test.ts`, `bookings-held.test.ts`, `ticketing.test.ts`; the packs' own tests |

## Amended 2026-11-23, after the security review of PR #267
The review found the exemption wider than the owner's sentence. Built, each with a test that fails
without it:

- **Never on an AI's say-so, for the record's life (B1).** Reading only the run's root change let a
  booking an AI made get its later reminder (a clock run), change and cancellation unreviewed. A
  send is now held when anything about it was written by an AI (the assistant or an MCP client, or
  a tool or automation whose cascade began with one) that no person approved, read from the audit
  trail by the host (`aiWritten`): the record the email is about (its creation or any write), the
  Persons it goes to and the one it is about (their creation or any write: an address, a name),
  and the order whose address it uses.
- **Never words an AI wrote (B2).** Each field that fed a slot (a class's title, a room's name, a
  cancellation's reason, an event's name or venue, a ticket's name, the calendar's title and place,
  a time) holds the send when its latest write was an AI's that no person approved; a person's
  later write of the field clears it. `unroutineText` also holds phone numbers and "call/ring/text"
  followed by digits, spaced, spelled-out or bracketed dots (`example . com`, `(dot)`, `[.]`,
  `dot com`), look-alike dots (U+2024, U+2027, U+00B7, U+2219, U+22C5, fullwidth and ideographic),
  `hxxp`, IP addresses, scheme prefixes (`mailto:`, `tel:`, `javascript:`, `data:`), U+2028 and
  U+2029, blank-looking characters (U+3164, U+115F, U+1160, U+FFA0, variation selectors) and every
  bidirectional control. A legitimate title with a phone number in it is held for a person: that is
  the intended outcome. Making the room's or class type's name `personApproves` was considered and
  not done: it would make every AI edit of a name wait, where the per-field check holds only the
  email.
- **What a person's approval clears.** A person approving one held email about a record (its
  outbound action applied by a human account) clears everything written about that record, its
  Persons and the fields that fed it **up to that approval**: later routine mail about the record
  flows. A write after the approval holds again. An approval is a person's only when a human
  account decided it: **the adjudicator's approval is not a person's (F1)**, for the change that
  started a run and for every write above.
- **The switch is read again when a row is sent (F2).** A kind turned off after its email was
  prepared (a retry of a failed send) settles the row `off` and sends nothing.

The coordinator's decisions, built:

- **D1, nothing starts flowing on deploy.** Each pack's routine email is off until a human admin
  turns it on once (Settings → Routine email, which says what will then be sent without approval and
  to whom). Until then its emails are prepared and are ordinary sends, decided by the policy exactly
  as before this ADR (under Balanced each waits for approval; nothing is dropped). Installing or
  upgrading a pack that declares routine mail while it is off tells the admins once, in the app.
  The kind switches then work as above.
- **D2, an unpaid order's address is not routine.** A visitor types any address: when nothing was
  paid, the email to the order's address is held for a person. A signed-in customer's free order
  goes, as routine, to their own verified sign-in address (`routineOrderRecipient`).
- **D3, a refund notice goes to the address that paid.** Bookings' drop-in kind is about the order:
  its payment-held and refund emails go to the order's own address, never the booking's Person or
  guardians.
- **D4, caps counted where a row is claimed.** Beside the 20 a day per address, now keyed on the
  mailbox (plus-tags and case folded, as the sign-in code limit), an organisation-wide limit
  (`orgDailyCap`, default 2,000 a rolling day; over it, held and the admins told once a day). Both
  are counted in the single statement that claims a routine row (`claimRoutineMail`), so runs
  claiming at once cannot race past either.
- **D5, the log.** Rows about a record are deleted when the record's Person is erased
  (`about_person_id`), rows sent to a guardian about an erased child included; the log is kept for
  `retentionMonths` (default 12), purged by the daily housekeeping, and the settings page says so.

Proof, added: `apps/runner/test/routine-mail.test.ts` (an MCP booking's later reminder held; an
AI-made Person booked by a person held; an AI-changed address held; an AI booking a person approved,
then a change that flows; an AI-written class title, phone number or plain, held until a person
writes it; a kind turned off before a retry sends nothing; a pack not turned on: an ordinary send,
the admins told; plus-tagged addresses against the cap), `packages/core/test/routine-mail-review.test.ts`
(concurrent claims racing the cap, the organisation's limit, the switch at claim, an order's
address, the adjudicator's approval, retention, erase), `packages/sdk/test/routine-mail.test.ts`
(the stronger value checks).
