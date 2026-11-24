# ADR 0626: The Rostering pack, the roster's rules from its settings, and Bookings' additions

Status: accepted, 2026-11-23 (stage 45, build step 4). Builds on ADRs
[0500](0500-recurring-a-weekly-rule-in-local-time.md),
[0590](0590-routine-mail.md), [0600](0600-a-pack-role-and-its-grants-add-up.md),
[0620](0620-field-level-exceptions-in-recurring.md) to
[0624](0624-the-rosters-notices-uncovered-shifts-and-leaving.md) and
[0625](0625-restricted-pack-permissions.md). Amends ADR
[0553](0553-attendance-the-coach-role-moves-and-cancelling-a-class.md) (what a coach reaches).

## Context
Steps 1 to 3 built the host's side of the roster: field exceptions, the `staffed` behaviour and its
time claim, warnings, qualifications, unavailability, offers and takes, the notices and leaving, all
behind tool-only operations nobody called yet. Step 4 is the pack people use: duties that are not
classes, their weekly pattern and dated shifts, the team role, the tools, the settings. Three things
were missing on the host's side: a roster read across every staffed object (`staffing.week`, named
in the spec, not built in step 3), a way for the host's rules to read a pack's numbers (the cut-off
and the uncovered window were constants "until Rostering's setting"), and a horizon a setting sets.

## Decision

**The pack** (`packs/rostering`, requires nothing):
- `rostering.duty` (name, colour, usual length, place, what to do, active), set-up records.
- `rostering.dutyseries` (duty, weekdays, a local time, length, first and last date, zone, the
  regular person `staff`, `active` or `ended`) declares `recurring`, generating `rostering.shift`:
  title, duty and person copied, `cancelled` on a closure of the series, ended with `ended`.
- `rostering.shift` (duty, series, starts, ends, zone, person `staff`, notes, `scheduled` or
  `cancelled`, `changed`) declares `staffed` (`who: { field: "staff" }`, `kind: "duty"`, live in
  `scheduled`, the place its duty's, the pattern its series' `staff`). Indexed by start, person,
  state and start, and series.
- **Who is on a duty shift, and a series' regular person, are `personApproves`**: an assistant's
  change waits for a person.
- **The role** `rostering.team`: `permissions: ["rostering:team"]`, `read: []`. A cleaner holds it:
  the team's tools and nothing else, no record read.
- **The permissions**: `rostering:team` (the role's) and `rostering:roster` (grantable, held by no
  role) name the same team tools, so a coach is granted the roster beside `bookings.coach` (ADR
  0600: the tools set `grantLiftsRoleLimits`; the team role has no limits to lift). Ordinary staff
  hold them as any tool. `rostering:manage` is grantable and **restricted** (ADR 0625): admins, and
  whoever an admin grants it (nobody at first, decision 16).
- **The tools** each call one tool-only `staffing.*` operation, which acts for the tool's verified
  caller, and pass on its answer: the team's `week`, `mine`, `offers`, `offer`, `withdraw`, `take`,
  `away`, `back`, `myAway`; the rosterers' `assign`, `check`, `qualify`, `qualifications`,
  `awayFor`, `awayList`, `uncovered`. As the spec's table: reads are applied for an assistant;
  `assign` and `qualify` are `personApproves`; `offer`, `withdraw`, `take`, `away`, `back`,
  `awayFor` and `awayList` are `humanOnly`. `away` and `awayFor` keep the note out of the audit log
  (a tool's `redact`, new). `awayList` is not in the spec's list: the unavailability screen reads
  everyone's through it.
- **Settings**, each `personApproves`: the offer cut-off (60 minutes), the uncovered window (14
  days), the duty horizon (56 days). The pay period is step 6's.

**The roster's rules from the pack's settings.** A shipped pack declares `staffing: { rosters,
settings? }`: the restricted permission whose holders roster (with admins), and which number
settings are the offer cut-off and the uncovered window, each a setting a person approves (the
contract refuses one that is not: the roster's numbers are never an AI's to change). The host reads
them
(`rosterNumbers`, `isRosterer`, `rosterers` in `packages/core/src/staffing/rosterers.ts`): the
setting's stored value, else its default, within bounds (0 to 10,080 minutes; 1 to 62 days); the
host's defaults (60 minutes, 14 days) with no such pack. Only a shipped pack or the org's own may
declare it (`outside_audience`). Who rosters is now `rostering:manage` everywhere step 3 asked
"admin": the `unavailable` warning's reader, offers, the notices' recipients, every `staffing.*`
operation, the `user.deactivate` notice. Nothing hard-codes admin but `isRosterer` itself (admins
always may, decision 16).

**Who says who works a shift: a rosterer, by every path** (added in the review of PR #284; the
owner's decision of 2026-11-24, a class's coach included). Restricting the rosterers' tools alone was
cosmetic: a member could write a duty shift's person, a class's coach or a duty series' regular
person with `record.update`, putting themselves on any shift past the take's qualification check
and cut-off. So, wherever an installed shipped pack declares who rosters (`staffing.rosters`), the
host refuses (`forbidden`, `rule: "rostering"`) a caller's write that sets or changes:
- a staffed object's person (`who`), on create (a shift made with someone on it) and update;
- a pattern's person (a series field that is some staffed object's `pattern.who`), on create and
  update, and so `recurring.change` of it;
- a holder's account (a coach profile's `user`) once the profile exists (it puts that account on
  every shift naming the profile; a new profile is nobody's shift yet);

unless the caller (the account a tool was called for, or the calling account) rosters. Every path
that writes a record reaches the check (`assertRosterWrite`, `staffing/index.ts`, called by
`createRecord` and `updateRecord`): `record.create`, `record.update`, `record.createMany`,
`record.import`, `recurring.change`, `record.restoreVersion` (no staffed object is publishable
today). `recurring.follow` back to the pattern's person and `record.restore` of a shift or series
with someone on it are refused the same way. There is no merge of extension records. Taking
yourself off a shift this way is refused too: you offer it. Creating a shift or a pattern with
nobody on it, and every other field, stay open to whoever may write the object. The host's own
writes are not the caller's: a take (the batch notes the offer it takes), a series' generation and
a change it carries to its records (`by: "host"`), `staffing.assign` (whose caller is a rosterer),
and `user.deactivate` (the host's statements). **Where no installed pack declares who rosters (a
product with Bookings alone), nothing changes**: whoever may write a class sets its coach, as
before this step.

For a product with Bookings and Rostering this changes Bookings' staff flows: a member can still
make, move and edit a class and its series, but naming, changing or removing a coach (a class's, a
series', or a coach profile's account) needs a rosterer (an admin, or a member granted
`rostering:manage`). Bookings' tools write no coach, and its existing tests install no Rostering,
so they are unchanged.

**An AI's roster change is approved only by someone who could make it** (the review of PR #284,
ADR 0480's rule): approving a pending call of a restricted tool (`assign`, `qualify`) needs a
person who holds that tool themselves (`staffAuthority`, their role or a grant); approving a
pending record write of who works a shift needs a person who rosters (`staffing/approvals.ts`).
The requester's authority still holds at apply too: a proposer whose grant was taken away fails.
*Amended 2026-11-24 (issue #285):* an AI's restore is a roster change too. Approving a pending
`record.restore` of a shift or series that names someone (read against the record in the Trash,
as the restore's own check reads it) needs a person who rosters; one with nobody on it does not.
Approving a pending `record.restoreVersion` of an object whose versioned content carries who works
it needs one as well. The approval queue's redaction (ADR 0627) reads the same rule
(`rosterChangeCall`).

**`recurring.horizonSetting`**: a number setting of the extension (days) that sets a series' horizon
when it holds a value; `horizonDays` stays the default. The duty series' is the duty horizon.

**The roster read**, `staffing.week { from, to, mine?, account? }` (tool-only, read; `truncated`
when more than 1,000 shifts of one object fall in the range, so a reader is never shown a silently
shortened roster): every live
shift of every staffed object in a range of local dates (at most 62 days), set-based: the shift's
object and id, title, kind and its name, times, zone, place, whether it has nobody on it or a person
with no account, the person's account and name, whether it is the reader's, its open offer, and,
for a rosterer only, its warnings (worked out in bulk, as a write would be made with them). Nothing
of a class's bookings, places or list, nor any Person.

**A leave note never reaches an AI**: `staffing.awayList` answers the notes only when the tool's
caller is a person (step 3 let an assistant read its own person's notes); the times still reach it.

**Bookings' additions.** `bookings.class.coach` and `bookings.series.coach` are `personApproves`:
the assistant, MCP and code may ask to change a coach, a person applies it. The host's own writes
(a take, `staffing.assign`, the series' generation, `user.deactivate`) are not gated by it, as for
every `personApproves` field. Routine mail is unchanged: no routine email shows a coach, and
`personApproves` on a field changes which writes wait for a person, not the marks ADR 0590 reads
(only a `defaultSetting` a person approves changes a mark). Bookings' tool `roster` keeps its name
and meaning. The class type's preparation and pack-down minutes and the dashboard's uncovered
classes are steps 6 and 7's.

## Why
- One read across every staffed object is the host's: no pack may read another it does not
  require, and a coach's role reaches class lists only today, which the roster must not widen.
- The numbers are the business's (decisions 17, 20, 21): a setting a person changes, read by the
  host's rules for every path, not a constant and not a copy in each pack.
- A note about someone's leave is theirs; an assistant summarising a person's own week does not
  need it, and the step 3 review already kept other people's notes from any assistant.

## Proof
- `packs/rostering/test/rostering.test.ts` (`cos ext test`): the contract, every tool's permission
  and AI limits, and each tool asking the host what it should.
- `apps/runner/test/rostering.test.ts`: a duty series fills its horizon with its person, which the
  setting moves; a class and a duty of one person refused; criterion 6 (a coach granted the roster
  reads every future shift and their own, offers and takes, and still reaches lists only today; the
  roster holds no booking, place or Person; a registry walk before and after the grant differs by
  exactly the team's tools); criterion 7 (the team role's walk: only its tools); criterion 8
  (ADR 0625); leave told to rosterers only, never in another's roster or the audit log, and an
  assistant reading its person's time off gets no note; an assistant's swap of a class's coach waits
  for a person.
- `packages/core/test/restricted-permissions.test.ts`: the rosterers by grant, and the numbers from
  the settings.
- The review of PR #284 (`apps/runner/test/rostering.test.ts`): a duty shift's person by
  `record.update` and `record.create` refused to a member, a viewer and a coach and made by a
  granted rosterer and an admin; a member taking themselves or someone off refused; `createMany`
  and `import` refused to a member; a series' person by create, update and `recurring.change`;
  `recurring.follow`; a restore from the Trash; a class's coach and a coach profile's account; a
  leaver still taken off; an AI's `assign` and an AI's coach swap refused to a member approver and
  applied by a rosterer, and failing at apply once the proposer's grant is gone; a team tool called
  from another pack's code or an automation answered `staff_caller`; the roster cut short says so
  (`packages/core/test/staffing-offers.test.ts`).

## Consequences
- The feed (step 5), pay (step 6) and the screens (step 7) are still to come; until step 7 the
  pack's tools are reached from the admin's tool calls, the assistant and MCP, not from screens.
- `staffName` on a shift (with `staffing.forget`) is not built yet: the roster names people by
  their accounts' current names.
- The notices' words are still the host's own; the spec's "notification words are the pack's" is
  left for later (they say nothing pack-specific today).

## Amended 2026-11-24 (stage 49 step 1, ADR 0761)
The roster shows a shift whose title may name a client (`staffed.private`, an appointment) as its
kind's name to anyone but its own person and those who roster. See
[ADR 0761](0761-a-shift-that-names-a-client-kept-off-the-roster-and-the-feed.md).
