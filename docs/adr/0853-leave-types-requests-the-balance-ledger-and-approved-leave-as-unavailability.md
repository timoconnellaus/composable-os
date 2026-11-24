# ADR 0853: Leave: types, requests, days and the balance ledger; approved leave as unavailability, taking the person off shifts

Status: accepted, 2026-11-24 (stage 58, build step 4). Builds on
[ADR 0621](0621-the-staffed-behaviour-and-the-time-claim.md) (`staffed`),
[ADR 0622](0622-warnings-in-a-writes-answer.md) (unavailability),
[ADR 0623](0623-offers-and-takes-the-race-and-the-cut-off.md) (offers),
[ADR 0624](0624-the-rosters-notices-uncovered-shifts-and-leaving.md) (leaving) and
[ADR 0627](0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md) (pay periods).
Amends ADRs 0622, 0624 and 0629 (dated notes in each). Spec:
[stage 58](../stages/58-timesheets-leave.md).

## Context

Stage 45 let a person say when they cannot work, and nobody approved it. Staff also ask for time
off that is paid or counted against a balance (annual, personal), and the manager decides it
(stage 58, decisions 7 to 10 and 12). A sick day is health information, so leave is personal: a
record in a `rec_*` view would be read by every member with `records:read`, by SQL, exports and
the assistant. Stage 45's roster already knows "away" (the `unavailable` warning, who is eligible
for an offer, the notice to rosterers); a second "approved away" would drift from it. What leave a
business must give and how it accrues are rules that differ by agreement and place, for the
business to confirm with its accountant.

## Decision

- **Four core tables** (migration 1271), in no `rec_*` view, amounts as integers in the type's unit
  (minutes for an hours type, hundredths of a day for a days type), no money:
  - `core_leave_type`: name (unique, any case), unit, keeps a balance, below zero (`warn` or
    `refuse`, decision 9), paid (a label for the export only), active, order. **None ship**, and no
    screen suggests any. Its unit never changes once a request or a balance entry is in it, and a
    type in use is never removed (made inactive instead).
  - `core_leave_request`: the person, the type, whole local days (start and end date) or one date
    with a local start and end time, the organisation's zone, and the range as instants worked out
    once when asked; a state; a note; who asked (the person, or an approver for them), who decided
    and when, why declined or cancelled.
  - `core_leave_day`: each date of a request, the amount asked and the amount approved.
  - `core_leave_balance_entry`: the ledger, **insert only** (`set` and `adjust` by a pay holder;
    `approved` and `cancelled` by the host, one each per request at most). **The balance is the
    sum.** The host never accrues. A set is written as the difference from the sum, in the
    statement, so two sets at once land on the second's amount.
- **The database keeps the rules** (triggers, for every statement shape, D1's recursive triggers
  being off): a request is never replaced (an id that exists is refused before a REPLACE could
  delete it); `requested` moves once to `approved`, `declined` or `cancelled`, and `approved` only
  to `cancelled`, so of **two approvals at once one applies** and the other fails whole; approved
  leave moves to `cancelled` only once its away row is gone and its ledger entry reversed, earlier
  in the same batch, so a cancel planned while it waited that lands after the approval fails whole
  (`core_leave_request_held`) instead of leaving the person away for good; what it
  asked never changes (its note may only be cleared); an approved request is never deleted; its days
  change only while it waits. The ledger is never updated, deleted or replaced. An `approved` entry
  of a type that refuses a balance below zero is refused when it would take the sum below zero,
  so two approvals at once that together would are decided by the database too.
- **Asking** (`staffing.leave.request`, the person's own; `staffing.leave.requestFor`, an approver
  for someone else, optionally approving it in the same batch: a sick day phoned in). The host
  **proposes** each date's amount: for an hours type, the minutes of the person's shifts starting
  that local date (for part of a day, the rostered minutes inside it); for a days type, one day.
  A hint the person and the approver may change, never a pay rule. The answer gives the balance
  now and after, and the shifts it covers; `preview` writes nothing. Refused into a locked pay
  period, over the person's own other leave (asked or approved), beyond 62 dates, and below zero
  for a type that refuses it (warned for one that warns).
- **Approving** (`staffing.leave.approve { id, amounts? }`) is one batch: the days' approved
  amounts, the request (guarded as above), the balance entry when the type keeps one and the
  amount is not zero, **stage 45's `core_staff_away` row** (kind `leave`, its new `leave_request`
  column naming the request, no note), and, for each covered shift that has not started, **the
  person taken off it** (the record write `staffing.assign` makes, so its claim, its open offer and
  its notices follow) and **an offer to everyone eligible** (the statement `staffing.offer` makes
  for an uncovered shift; none past the cut-off, none when nobody could take it). Each take-off is
  guarded on the person still holding the shift at commit (`core_staff_guard`): a shift given to
  someone else after the approval read it fails the approval whole (`roster_changed`), never
  taking the new person off. Eligibility is read once for every shift, whatever their kinds
  (`eligibleForShifts`, over stage 45's set-based reads); each person offered is told once, every
  such notice written by one statement. The rosterers get stage 45's notice with which shifts were
  offered and which nobody could be. At most **40 shifts** an approval: 670 queries at that size
  with four kinds of 100 qualified people each (400 told), inside D1's 1,000 an invocation; more
  is refused whole, with what to do.
- **Declining** (with why) and **cancelling**: the person cancels their own waiting request, or an
  approved one before it starts; an approver cancels approved leave (with why) while no locked pay
  period holds it. Cancelling approved leave removes its away row and writes the reversing ledger
  entry, and **puts nobody back** on a shift (the rosterers are told, and reassign).
- **Who.** Approvers are the rosterers (`rostering:manage`, decision 12), **never for their own
  request**, except an admin when nobody else may approve. Types and balances are a pay holder's
  (`rostering:pay`). A person reads their own requests and balances; approvers and pay holders
  read everyone's balances; approvers read what waits; other staff read nothing, not even that
  someone is on leave (someone else's request answers as not found). Every leave operation is
  tool-only and staff only, and is a **person's at the screen**: the calling tool `humanOnly` and
  the verified caller a person, never an assistant or MCP, whatever is granted; saving a type is
  applied by a pay holder (an AI may draft its name); reading the types is anyone's.
- **What is kept out.** No note, reason, amount or balance in the audit log (redacted; summaries
  name the request and whose), a notice or an error. Reads of balances and of what waits are
  audited as reads.
- **Unavailability, amended (ADR 0622).** `staffing.back` refuses a request's row (cancel the
  request). Once the business has a leave type, `staffing.away` makes no new kind `leave` row (a
  person says `other` or `regular`; leave is asked for); rows already made stay. `staffing.awayList`
  answers which rows came from a request, and leaves them out for an assistant acting for its own
  person (reading leave is a person's).
- **Leaving, amended (ADR 0624).** `user.deactivate` cancels the leaver's waiting requests in its
  batch; approved leave and balances stay, as payroll records.

## Consequences

- A business that sets no leave type sees nothing change: `staffing.away` behaves as before.
- Every stage 45 rule about being away holds for approved leave without a line of new roster code.
- A pay period's lock refusing changes to leave dated in it, leave lines in its totals and
  export, are stage 58 step 3's (migration 1272); until then, the operations refuse leave into a
  locked period, and raw writes are not refused by a lock trigger.
- Two overlapping requests asked at the same instant are not refused by the database (the overlap
  is read first); an approver sees both waiting.
- Rostering's tools and screens over these operations are steps 5 and 6.
- **Open: a weekly pattern can put the person back on a shift inside approved leave.** Approval
  takes them off the shifts that exist when it runs; a series' generation later (its horizon is
  eight weeks, leave up to 62 days) names the pattern's person, made with the `unavailable`
  warning as stage 45 makes any shift over unavailability, and does not consult leave. Making the
  generation leave such a date uncovered is recurring work outside this step, for the
  coordinator to place (the review of PR #374).

## Considered and rejected

- **A second, approved "away" table for leave**: stage 45's warning, eligibility and notice would
  each need to read it; writing the existing row once leave is approved reuses all of them.
- **Making every unavailability a request**: a regular afternoon off is not leave (decision 8).
- **Accruing balances, or working out a leave day's hours**: entitlement and pay rules that differ
  by agreement and place; the host keeps the numbers it is given and proposes a hint.
- **A balance column updated in place**: a ledger keeps who changed it and why, and cannot lose an
  update under a race.
- **Putting the person back on their shifts when approved leave is cancelled**: the shifts may have
  been taken by someone else meanwhile; the rosterers decide.
