# ADR 0624: The roster's notices, uncovered shifts and leaving

Status: accepted, 2026-11-23 (stage 45, build step 3). Builds on ADRs
[0621](0621-the-staffed-behaviour-and-the-time-claim.md), [0622](0622-warnings-in-a-writes-answer.md)
and [0623](0623-offers-and-takes-the-race-and-the-cut-off.md); amends the deactivation of
`user.deactivate` ([ADR 0170](0170-automation-run-as-bindings.md)).

## Context
Stage 45's notifications table: a person is told when they are put on or taken off a shift, when
theirs changes time or is cancelled; rosterers are told of takes, lapses, leave over rostered
shifts, a pattern that could not be applied, and uncovered shifts (daily, and at once). A shift's
person may be written by many paths (a person editing a class's coach, a rosterer's assign, the
assistant once approved, an import), so a notice sent by one tool would miss the others. A staff
member leaving must not leave their future classes pointing at an account that cannot work them.

## Decision
- **The notices are the host's**, written in the batch of the write that causes them
  (`packages/core/src/staffing/changes.ts`, called for every write of a staffed record): its open
  offer is cancelled when the shift goes to someone else, is cancelled or removed (the offerer
  told); the person put on or taken off it by someone else is told, and the person whose shift
  changed time or was cancelled; a live shift inside the uncovered window (14 days) left with
  nobody on it is told to the rosterers at once. Nobody is told what they did themselves.
- **The host's own writes tell nobody per shift**: a series' generation and its changes write many
  records as the host. A date the generation leaves uncovered because its pattern person is already
  on another shift tells the rosterers the date and why. A pattern change tells the people on it
  nothing per shift in this step (decided conservatively: one notice per future class would be
  many; the roster's patterns screen, step 7, is where a rosterer sees it).
- **They are in-app notices** (`system.message`, delivered by email as each person's preferences
  say). A notice about someone's availability (leave added over rostered shifts) is `humanOnly`
  ([ADR 0643](0643-health-answers-read-by-a-person-with-the-permission-every-read-audited.md)): no AI acting for a rosterer lists it, and it never carries the note.
- **Uncovered shifts**: `staffing.uncovered` (a rosterer's read) and the minute cron's
  `staffing.due`, which once a local day from 07:00 (guess) tells the rosterers every live shift
  with nobody on it in the window. It runs once a day by a row in `core_staff_run` (migration
  0812), and reads through each staffed object's index on its person field, so a long covered
  history is never read.
- **Who may roster** is one function (`staffing/rosterers.ts`: `mayRoster`, `rosterers`): admins
  until stage 45 step 4 gives it to `rostering:manage`.
- **Leaving**: `user.deactivate` now answers with the person's future shifts (from their claims,
  read by account and end, never their past) and the series whose pattern names them, and is
  refused (`deactivate_confirm`, with the count and the list) until confirmed with that count, as
  `recurring.change` is. Confirmed, in the same batch: every pattern naming them names nobody (its
  version bumped, so a generation planned before fails), every shift of theirs that has not started
  names nobody (the ids taken again from their claims at commit, so a class made meanwhile is
  cleared too), their claims are released by the triggers, their open offers and those named to
  them are cancelled (whoever offered one to them is told), and the rosterers are told with the
  list. Past shifts and shifts under way keep them. Reactivating puts nothing back. The changes are
  audited as the host's (their marks, ADR 0590, are `host`).

## Consequences
- A notice reaches the same people whatever wrote the shift; a new write path that goes through
  the record operations tells them without more code.
- Stage 33's import writes as staff or the host; an import that should not notify writes as the
  host.
- The feed's revocation on leaving and `staffing.forget` are later steps (5 and 4).
