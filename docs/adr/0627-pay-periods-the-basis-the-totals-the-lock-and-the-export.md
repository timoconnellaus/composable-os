# ADR 0627: Pay periods: the basis, the totals, the lock and the export

Status: accepted, 2026-11-23 (stage 45, build step 6). Builds on ADRs
[0621](0621-the-staffed-behaviour-and-the-time-claim.md) (the `staffed` behaviour),
[0624](0624-the-rosters-notices-uncovered-shifts-and-leaving.md),
[0625](0625-restricted-pack-permissions.md) (restricted pack permissions, the caller of a pack's
tool) and [0626](0626-the-rostering-pack-and-bookings-additions.md) (the Rostering pack). Migration
0813.

## Context
Stage 45's decisions 10, 14, 18, 19 and 20: some staff are paid by the hour or by the class, so the
roster feeds a pay period for them; the host holds **no rates and calculates no pay**; what counts
as worked is the roster as it stands when the period is closed, after corrections, with the class
list's ticks beside it as evidence; set-up and pack-down minutes count for pay only; the period is
fortnightly by default. Pay is sensitive: no member, no AI and no audit row may see what someone is
totalled, and a period handed to payroll must never change underneath it.

## Decision

**Who is counted** (`core_staff_pay_basis`): `by_time`, `by_class` or `not_counted` per staff
account **from a local date** (no row: not counted). A period totalled again later uses the basis in
force on each shift's own date, never today's, so a reopened period re-locks to the same lines
unless the roster itself was corrected.

**The period** is the declaring pack's setting (`staffing.settings.payPeriod`, `payPeriodStart`,
`payPeriodDay`; Rostering's: fortnightly by default): weekly or fortnightly from the date one period
starts (until it is set nothing is totalled), or monthly from a day of the month (1 to 28), in the
organisation's zone. A shift belongs to the period of its local start date, so a class from 23:30
on the period's last day to 00:30 is wholly in it.

**The lines and totals** (`packages/core/src/staffing/pay.ts`): one line per live shift (in a live
state, out of the Trash, with a person who has an account) of a counted person in the period,
across every staffed object, read set-based in pages through each object's start index. Its own
minutes are its end minus its start **as instants**, so a shift across a clock change counts the
time really worked (01:30 to 03:30 on the night clocks go back is three hours); a shift across
midnight is one line. A kind's set-up and pack-down minutes (`staffed.payBefore`, `payAfter`:
Bookings' class type `rosterBeforeMinutes`, `rosterAfterMinutes`, a person's to change) are added;
they never enter the time claim. A shift **marked not worked** (`core_staff_not_worked`, a
rosterer's, with why, only once it has started) is a line counting nothing. A cancelled shift is no
line. Totals are per person, basis and kind: shifts and **whole minutes** (both, whatever the basis:
payroll reads the one it pays on). **Hours** are shown as minutes ÷ 60 rounded half up to two
places, from the summed minutes (never a sum of rounded hours); integers only, no floats.

**Evidence** (`staffed.evidence`, new): an object of the same extension whose records name the
shift and the staff account that marked each (Bookings: a booking's `class` and `markedBy`). Beside
each line: whether its list was taken, by whom, and a flag when someone other than its person took
it. Evidence informs the rosterer's corrections before the lock; it never changes a total.

**The lock** (`staffing.payPeriod.lock`): a period that has ended is locked by someone who handles
pay. One batch writes the period `locking`, its lines (a hundred to a statement, one JSON
parameter each), then `locked`. Before it, the lock reads a fingerprint of what the lines came from
(the period's shifts: how many and their latest change; their profiles'; the kinds'; the marks in
the period; who is counted) and guards each in the batch (`core_staff_guard`): a write in between
fails the lock whole (`roster_changed`), so the locked lines are exactly the roster locked. A
period of more than 10,000 shifts is refused, never cut short.

**A locked period never changes, for every writer** (migration 0813 and reconciler-built
triggers):
- On each staffed object's table (`<table>__paylock_*`, built and dropped with the time claim's
  triggers): a shift whose start is in a locked period keeps its person, start, end, kind and
  liveness; a new live shift is not dated into one; a live one is not deleted. A note, or a move
  between two live states (`scheduled` to `done`), is not refused. D1 runs with recursive triggers
  off, so the `BEFORE INSERT` also refuses a REPLACE or upsert of a locked shift's id, and the
  `BEFORE UPDATE` an `UPDATE OR REPLACE` onto one. On the account holder's table (a coach profile),
  the account of a profile on a locked shift does not change (nor by a REPLACE), and a profile not
  in the Trash is not deleted; one in the Trash may still be purged.
- The not-worked mark (a shift's start is kept on it), and who is counted for a date on or before
  a locked period's last day, are refused the same way, including REPLACE.
- `core_pay_period` moves only `locking` to `locked` to `reopened`; `core_pay_line` is written only
  into a version being locked and never changed or deleted; neither is replaced.
- Refused as `conflict`, `rule: "pay_period_locked"`, naming no figure.

**Reopening** (`staffing.payPeriod.reopen`) is a person's, with why; the version is kept as it was
(`reopened`, who, when, why). Locking again writes the next version; every version's lines stay
readable.

**The export** (`staffing.payPeriod.export`): a plain CSV: a summary row per person, basis and kind
(period start, end, name, staff email, basis, kind, shifts, hours as a decimal, minutes), a blank
row, then a row per shift (name, email, date, local start, local end, kind, title, place, minutes
counted, why not worked, list taken, taken by, for review). From the locked version, or a preview
of an open period whose first row says so. Text that a spreadsheet would run (starting `=`, `+`,
`-`, `@`, a tab or a carriage return) is prefixed with an apostrophe. No rates, no money, and no
product it is for.

**Who** (the spec's "What an AI may do"): every pay operation is tool-only and refuses a caller who
is not a person (`humanOnly` on the calling tool **and** the verified caller a person) or who does
not handle pay: an admin, or an account a human admin granted the pack's `staffing.pays`
permission (Rostering's `rostering:pay`, restricted and grantable, ADR 0625). Rostering's tools
`payBasis`, `payBases`, `periods`, `periodTotals`, `lock`, `reopen`, `export` are `rostering:pay`
and `humanOnly`: never an assistant or MCP client, whatever is granted; never an automation or
another pack's code. `markNotWorked` is a rosterer's (`rostering:manage`, `personApproves`). A
person does not read their own totals through these tools (their shifts are the same data
unsummed).

**What is kept from the record of it**: who is counted how, a reopening's and a mark's reason are
redacted from the audit log; reading totals or the export is audited (`auditReads`) as which
period, version and who, never its figures; the lock's audit row names the period. Errors name no
figure. Tool runs store no output. The pay tables are core tables in no `rec_*` view: no dashboard,
`query.sql`, `export.csv` or assistant record read reaches them.

## Why
- Hours and counts, not money, is decision 14; minutes are exact integers, hours are a view.
- A basis by date and locked lines make a period reproducible; triggers make the lock hold for
  paths nobody has written yet, as the time claim does.
- Evidence is shown, not applied: decision 18 makes the corrected roster the truth.

## Proof
- `packages/core/test/staffing-pay.test.ts`: criterion 10's fixture by hand (a fortnight across the
  clock change; hourly, per-class and salaried staff; a cancelled class, a class not worked, a take
  mid-period, set-up and pack-down minutes, a duty across midnight, a class across the clock
  change, a list taken by someone else); the CSV line by line with a formula cell neutralised; the
  lock against record writes, a coach profile's account, the mark, the basis, and raw REPLACE,
  upsert, `UPDATE OR REPLACE` and delete statements on every table; reopening and versions; the
  lock's guard; an AI refused every pay operation whatever is granted; nothing in `rec_*` views,
  `query.sql` or the audit log.
- `packages/core/test/staffing-pay-cost.test.ts`: a period's totals and lock with 3,000 shifts of
  history read the period's rows only.
- `apps/runner/test/rostering.test.ts`: the shipped tools in the real runtime: a member, viewer
  and rosterer refused every pay tool until granted, an admin and a granted member hold them, an
  assistant and MCP refused every one; `markNotWorked` asked by an assistant waits for a person; a
  class with set-up minutes totalled, locked, exported and then kept.

## Consequences
- A class type's set-up minutes changed after a lock change nothing locked; a period reopened and
  locked again uses them as they are then.
- A coach profile purged from the Trash leaves its classes with no account: a later re-lock of a
  reopened period would not count them. Its locked lines keep them.
- An uncovered shift or one with a visiting coach is no line, so changing it inside a locked period
  is refused only when it would gain or lose a person, a time or its liveness.
- `staffing.forget` (not built) must keep locked lines, as the spec says.
- Overtime, penalty rates and minimum engagements are payroll's (out of scope); the export is the
  input it needs.
