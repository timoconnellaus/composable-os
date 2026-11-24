# ADR 0851: Differences from the roster and approval of time: the tolerance, approval on a match, approved changed, nobody their own

Status: accepted, 2026-11-24 (stage 58, build step 2: differences and approval). Builds on
[ADR 0850](0850-time-entries-the-hosts-clock-overlaps-refused-and-worked-on.md) (time entries),
[ADR 0625](0625-restricted-pack-permissions.md) (who rosters, the verified caller) and
[ADR 0627](0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md) (who is counted by
time, the lock). Pay from approved entries is step 3's (ADR 0852). Spec:
[stage 58](../stages/58-timesheets-leave.md), decisions 5, 6 and 12.

## Context

Pay is to count approved recorded hours (decision 1), so somebody approves each entry. Most
entries match the roster: a manager asked to approve each one stops reading them. What needs a
person is what differs: the late start, the early finish, the shift nobody recorded, the time
with no shift at all (decision 5). The difference must be the same answer on every screen, so the
host works it out, never a block. Approval feeds pay and is a person's act, audited, and nobody
approves their own time (decision 12).

## Decision

- **The difference** of an entry against a shift is, at each end, the minutes from the shift's
  own start and end (its claim less its margins, ADR 0760) to the entry's, any part of a minute
  counting as one (rounded away from zero): positive later, negative earlier. Worked on instants, so an entry across midnight and a
  clock change is compared as the time really worked. An entry **matches** when both ends are
  within the **tolerance**: Rostering's setting `matchMinutes` (5 by default, 0 to 30), read
  through `staffing.settings` beside the other recording settings. Exact seconds stay on the
  entry; the tolerance decides only what shows as a difference and what the host approves, to the
  second: five minutes and one second late shows as 6 and does not match (acceptance criterion 6,
  "within 5 minutes"; the review of PR #417), and with a tolerance of 0 only exact times match.
- **`staffing.time.differences { from, to, account? }`** (at most 62 local dates, the
  organisation's zone): each entry dated in the range beside its shift (its two differences,
  matches or not), **unrostered** for an entry against no live shift of the person's (a job, other
  work, or a shift cancelled or given to someone else since), **long** for one over 12 hours, and
  **not recorded** for each past live covered shift of someone counted **by time** on its local
  date, with no entry approved, waiting or open against it (whatever the entry's date) and not
  marked not worked. A by-class coach or someone not counted is never flagged. **Nothing about
  why**: an entry here carries no note and no approver's reason (`waiting`, what an approver
  decides, carries the note and why it was reopened). **Set-based**
  (`staffing/sets.ts`): the basis rows of everyone counted by time (one read), their claims (one
  read per hundred people), the range's entries (one read), the shifts' claims, what is recorded
  against the candidates, the not-worked marks and the titles (one read per object each), the
  names (one per hundred): 24 statements for 30 people over 62 days, exactly as many as over 7, and
  the rows read grow with the range, never the history (`staffing-time-approve-cost.test.ts`
  pins both). Nothing
  about why. **`staffing.time.waiting`** is the same read of the entries that wait (default the
  last 62 days), with no not-recorded lines.
- **Approval on a match** (decision 5): an entry the person finishes (`clockOut`), enters
  (`enter`) or corrects (`edit`) that is against one of their own live shifts and matches it is
  approved by the host in the same write (`approved_by = 'host'`, answered as
  `approval: { by: "host" }`, "approved: matched the roster"). Time with no shift (a job, other
  work) always waits for a person. So does an entry **held** (`core_time_entry.held`, migration
  1273, never cleared): `person` for an approver's entry for someone (and when its person rewrites
  its times: they become `entered` and the person's, `how_why` cleared, still held) and for a
  finish the host had marked missing that the person entered afterwards (nobody else saw it);
  `approver` once an approver has sent it back or reopened it, so neither a correction (even of the
  note alone) nor withdrawing it and entering the same times again gets it approved by the host:
  **a held `approver` entry is never withdrawn** by its person, only corrected (`time_held`). The
  claim matched is guarded in the write's batch (`core_staff_guard`): a shift moved or given to
  someone else after the read fails the write whole.
- **An approver decides** (`rostering:manage`: whoever rosters, decision 12):
  - **`staffing.time.approve { ids, changes? }`**: up to 100 waiting entries in one batch, each as
    it is or, when `changes` names it, changed (start, finish, break, and a zone for them; a zone
    alone is refused). **Approved changed keeps both**: the times as recorded go to
    `recorded_starts`, `recorded_ends` and `recorded_break_minutes` and stay there however often
    it is reopened and changed again by an approver; a correction its person makes after a reopen
    is what they recorded, so it clears them (the approved times would otherwise read as changed
    from times this approval never saw). A
    change is checked as entered time is (finished, at most 24 hours, the break shorter than the
    time, no overlap, not into a locked period) but not against the days-back setting. **All or
    none**: each update is guarded on the entry exactly as it was read (`core_staff_changed`), so
    one corrected, withdrawn or decided a moment before fails the whole call. An open entry, or
    one whose finish is missing, is refused until it is finished. A hundred changed entries of a
    hundred people is 614 statements, inside D1's 1,000, with at most 100 variables bound to any
    statement.
  - **`staffing.time.reject { id, why }`**: the entry `rejected` with why (the person and the
    approvers read it); the person corrects it with `edit`, and it waits again, or is approved by
    the host if it now matches.
  - **`staffing.time.reopen { id, why }`**: an approved entry (by an approver or the host) waits
    again, while no locked pay period holds it; the why is kept on the entry (`reopened_why`,
    migration 1273) until it is approved or rejected again, and while it is set the host does not
    approve it on a match: an approver asked to look at it.
  - **`staffing.time.enterFor { account, …, why }`**: time entered for someone (`how:
    by_approver`, with why; made by the approver), up to the days-back setting, never into a locked
    period. It always waits; its maker may approve it, since it is not their own time.
- **Nobody decides their own** entry, except an admin when nobody else may approve (then it is
  approved by themselves, and `approved_by` names them). An approver reads everyone's waiting
  entries and differences, or one person's; anyone else reads their own only (asking for someone
  else's is refused).
- **Who calls**: every operation here is tool-only, staff only, `mcp.expose: false`, and a
  person's at the screen (the calling tool `humanOnly`, the verified caller a person): an assistant
  or MCP is refused whatever is granted, reads included. Recording must be switched on
  (`recordsTime`).
- **What is kept out**: no note, why or changed time reaches the audit log (redacted; summaries
  name the entries and whose), and no why, time or approver's name reaches a notice. The person is
  told when their time is sent back ("See which, and why, and correct it in My time") or approved
  changed, and reads the rest in My time. Reads of waiting
  entries and differences are audited as reads.
- **The approver's answer says "host" or "approver"** for who approved, not a name: a person's own
  reads never name the colleague who approved them (as `myPay` hides who took the list). Step 3's
  export reads `approved_by` for its "approved by" column.

## Consequences

- Rostering's tools over these operations (`timeWaiting`, `differences`, `approveTime`,
  `rejectTime`, `reopenTime`, `enterTimeFor`), its `matchMinutes` setting and the words of its
  notices are step 5; the screens (Time to approve, Differences) are step 6. Until then nothing
  outside tests calls them.
- **Not recorded** is flagged from the first counted date in the range, not yet from the date pay
  starts counting recorded hours: `recordedFrom` is step 3's setting (ADR 0852), which narrows it.
- `approve`, `reject` and `reopen` read whether a pay period is locked before the write; nothing
  refuses an entry's change inside a lock committed meanwhile until step 3's triggers (migration
  1272), which pay must have before it counts entries.
- **The withdraw of a rejected entry differs from the spec's state table** (waiting or rejected
  may be withdrawn): a rejected entry is corrected, and an approver decides it; a rejected entry
  is never counted for pay and never blocks a lock.
- The daily summary of waiting entries to approvers at 07:00 is not built in this step; it is the
  host's notice, for step 5 beside the notification words or for the coordinator to place.
- An entry's shift proposal (`staffing.time.clockIn`, `mine`) now gives the shift's own time, not
  its claim widened by margins (ADR 0760): the same read serves the match.
- Migration 1273 is this step's: the spec numbered 1272 for step 3, which this step leaves to it.

## Considered and rejected

- **Approving every entry by a person**: most entries match; the manager's attention goes to what
  differs (decision 5).
- **Comparing rounded hours, or the minutes worked**: an entry can be the right length at the
  wrong time; both ends are compared, and nothing is rounded beyond showing whole minutes.
- **Approving on a match once an approver has sent it back or reopened it**: the approver said a
  person wants to look; the host approving it on the person's next correction, or on the same
  times entered again, would undo that.
- **Overwriting the recorded times when approved changed**: the person's record of what they
  worked would be lost; both are kept, and pay (step 3) counts the approved ones.
