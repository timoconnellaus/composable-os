# ADR 0755: The "mine" reach for pack roles

Status: accepted, 2026-11-24 (stage 39, build step 3). Amends
[ADR 0436](0436-pack-roles-and-the-door-role.md) (pack roles),
[ADR 0553](0553-attendance-the-coach-role-moves-and-cancelling-a-class.md) (a role limited to
today) and [ADR 0600](0600-a-pack-role-and-its-grants-add-up.md) (a role and its grants add up).
Builds beside [ADR 0889](0889-a-pack-role-limited-to-the-people-its-holder-looks-after.md) (a role
limited to the People its holder looks after), whose shape it follows. The stage 39 spec planned
this as ADR 0752; this build session was given the upper half of block BJ (0755 to 0759), so it is
0755, and the spec's later ADRs take the next free numbers when written.

## Context
A crew member in the Jobs pack (stage 39) works from a phone in customers' homes. Their account
must reach the jobs they work on: the visit, the site, the tasks, the checklist. It must not read
every customer's job, address and access notes. A crew account is a pack role (`jobs.crew`), and
pack roles could reach every record of the objects they list (ADR 0436), only today's (ADR 0553),
or only those about the People the holder looks after (ADR 0889). None says "the records I am
on": a crew member does not look after the customer, and a job is not on one day.

What makes a job a crew member's is a record of the pack that names them: their crew place (a
`staffed` record, one person on one visit). From it a relation leads to the visit, and from the
visit to the job. And a crew member's reach should not last forever: the spec settles a week
before the visit to a week after.

## Decision

**A role may reach an object only through records naming its holder** (`mine` on `RoleSpec`, the
SDK's `MineSpec`, `packages/sdk/src/mine.ts`), by object:
`{ through, who, path?, live?, within? }`.
- `through`: an object of the role's own pack whose records name the holder;
- `who`: its `user` field (one account) naming them;
- `path`: the relations (one record each, at most three) from `through` to the object reached,
  `"visit.job"`; left out, the object reached is `through` itself;
- `live`: the states of `through`'s `states` in which its record counts (left out: every record
  not in the Trash);
- `within: { from, to?, days }`: `through`'s own datetimes; its record counts from `days` days
  before `from` to `days` days after `to` (`from` when left out).

Jobs' crew (step 5) will declare, on jobs, visits, crew places and sites, `through:
"jobs.assignment"`, `who: "staff"`, `live: ["booked", "on_the_way", "on_site"]`, `within: { from:
"starts", to: "ends", days: 7 }`, with the path from the crew place to each.

**The contract check** refuses an object of another extension (reached or `through`), a `who`
that is not a one-account user field, a path that is not one-record relations between the pack's
own objects ending at the object reached, more than three steps, a state `through` does not have,
a `within` field that is not a datetime of `through`, and an object already limited by `today` or
`looksAfter` (one limit an object). **`who`, every relation of the path, the states field `live`
reads and the `within` datetimes must be `personApproves`**: each decides whom the role reaches
(a crew place moved from twenty days out to tomorrow, or a cancelled one booked again, brings a
job into reach), so changing it is a person's choice, never
the assistant's, an MCP client's, an automation's or code's on its own (ADR 0889 closed the same
gap on a team's staff fields at review; the states field and the datetimes were added at this
PR's review, which reproduced an assistant's, an MCP client's and an automation's move of a place's
times and state being applied without a person). `cos ext check` says which objects a role reaches only
through which records.

**The host holds it, as it holds the other limits** (`packages/core/src/pack-role-mine.ts`). The
pipeline reads the role with its pack's manifest in the statement it already makes
(`loadStaffRights`, which resolves `through`'s states field). While a call carries the limit (the
account's own call the role allows, or a tool run it started and the runs that run starts,
through `roleMine` beside `roleToday` and `roleLooksAfter`), before the operation runs:
- `record.list` of a limited object holds a predicate in its own query (`mineWhere`):
  `id IN (SELECT <last relation> FROM <through> JOIN <each object on the path> … WHERE <who> = ?
  AND <state> IN (…) AND <from> <= now + days AND <to or from> >= now − days)`. Each object on the
  path is read through its view, so a visit in the Trash leads nowhere. Its bound values are the
  account, one for each live state (at most twenty) and the window's two ends (Jobs' three states:
  six), however many records name the account; a
  filter, sort, cursor or projection cannot reach past it;
- `record.get` and `record.update` of a limited object: the stored record must be reached, else
  not found;
- `record.create` of a limited object or of a `through` object: refused. A new record of the
  object is reached by nobody yet, and a new crew place naming the account would widen the reach;
- `record.update` writing a field that decides the reach (a `through`'s `who`, its states field
  or its window's datetimes, or a relation on a path), on any object: refused, whether or not
  the role reaches that record;
- `record.create` and `record.update` of any object whose relation values name a record of a
  limited object the account does not reach (a note put on another customer's job): not found,
  exactly as for a record that does not exist, so a write attaches nothing to another's job and
  learns nothing of which ids exist. One statement for each fifty ids of an object named (added at
  this PR's review, which reproduced both);
- a tool runs (its own calls are held in turn), and so do the account's own core operations
  (`screens.mine`, `ack.mine`, `ack.confirm`); **every other operation is refused**, whatever key
  its input names records by, so the limit fails closed for an operation it does not understand.

As for ADR 0889, the limit is the role's own pack's: another pack's tool the role reaches
(`anyStaff`, ADR 0652) runs without it. It is held before the gate, the agent's grant and the
queue. Nothing is cached: when the crew place is cancelled, moved to another person, or its visit
put in the Trash, the reach changes on the next call. A grant that opens a tool (ADR 0600) lifts
it on that call, as it lifts the others.

## Why
- The reach is the record that makes the work someone's: the crew place, which the roster, the
  warnings and the time claim already treat as one person's place on one visit. Nothing new says
  who is on a job, and nothing is copied.
- A path of relations, not a join the host infers, so the pack says how a crew place leads to a
  job and a site, and the check can prove each step. Three steps is a crew place to its site.
- One subquery with a constant number of bound values (at most twenty-three) keeps a busy crew member inside D1's 100 bound values a
  statement; ADR 0553's list of ids would grow with the jobs.
- A window on `through`'s own datetimes: step 2's `staffed.timesFrom` copies the visit's times onto
  each crew place, so the window moves with the visit and reads no other record.
- Not found, not forbidden, for a record the role does not reach: the crew member learns nothing
  of what else there is. Refusing creates of the limited and naming objects, changes to what
  decides the reach, and every other operation keeps the rule checkable with four operations.

## Consequences
- A crew account with no live crew place in the window reaches nothing. An office member gives a
  crew member a place; the role never gives itself one.
- The fields deciding the reach are `personApproves`, so Jobs' `assignCrew` writes the crew place
  from a tool a person calls or approves (step 5), and an assistant's assignment waits for a
  person, as the spec's AI table already says.
- Under the limit, a Jobs tool's other core calls (a job's tasks, stage 58's clocking, a
  checklist's ticks) are refused until a step opens each with its own check against the reach.
  Step 5 must open, each with that check, the ones its crew tools need; failing closed until then
  is the point.
- The check and the write are two statements (as for ADRs 0553 and 0889): a crew place cancelled
  between them lets one write already checked land.
- One more statement on each role call that gets or updates a limited record; none on a list
  (its predicate rides in its own query) and none on anyone else's calls.
- **A host copy or follow onto `through` changes its deciding fields without the write naming
  them.** Step 2's `staffed.timesFrom` copies a visit's times onto each crew place, so a write of
  the visit's times moves the window; `states.follows` moves a crew place when its visit moves, so
  a visit move whose follow leads into a live state widens the reach. The hold here sees only the
  values a call writes. Step 2 merged first, so step 5, which declares the `jobs.crew` role, must
  treat the sources of such a copy or follow as deciding: the visit's times `personApproves` and
  refused under the limit, and no follow from a state outside `live` into one in it (Jobs' visits
  end in `cancelled`, final). Found at this PR's review; not reproducible here, where no pack
  declares a copy or follow onto a `through` object a role's `mine` names.
- An object that relates to a limited object but is not limited itself (a note on a job) lists
  every such record under the limit: the pack declares `mine` on it, or keeps it out of the role.
  The check does not flag it.
- Field-level rules on what a reached record shows (prices without `jobs:prices`, access notes on
  the visit's day only) are not this reach's: step 5 holds them on the pack's fields.

## Proof
`packages/core/test/pack-role-mine.test.ts`, on a fixture pack with jobs, visits and crew places:
the crew account lists and opens only the jobs, visits and places of its own booked places within
the window (six days before and after count, ten and twenty do not, another account's do not); a
filter naming another job, a page of one and a projection hold it; a get of anything else is not
found; the reach follows a place cancelled and booked again, a visit put in the Trash and
restored, and a place moved to another account and back; the role itself is refused other
operations. A member's call carrying the limit (as a tool run does) changes a job it reaches and
not another, writes no field deciding the reach (who, the place's visit, its times, its state, the
visit's job), creates no job, visit or crew place but other records, and is refused
`record.count`, `task.list`, `person.list` and `record.createMany`; a create or update naming
another's job, a job out of the window or a missing id in a relation (one or many) is not found
alike, and clearing one passes. The assistant's, an MCP client's or an automation's move of a
place's times or state waits for a person and changes no reach. The list's predicate binds four
values with one live state and six with three; a reach naming what the registry cannot read
matches nothing. The declaration's checks
refuse each bad declaration above. Removing the list's predicate fails eight of its tests;
dropping the deciding-field check fails two; without the relation hold, or without the check on
the states field and the datetimes, a test fails for each.
`apps/runner/test/pack-role-mine.test.ts`, in the real sandbox: a tool run carrying the limit
lists and opens only the reached job, follows into another pack's tool it calls (an extension
cannot call its own), renames only the reached job, cannot repoint a crew place, and is refused
`record.count`. An account that holds the role (the pack shipped in place) lists and gets only its
job directly, through its pack's tools, and through another pack's tool one of them calls, and is
refused a tool its role does not hold. Without the carry in the executor, or in the tool call, all
four of its tests fail.
`packages/extension-check/test/check.test.ts`: `cos ext check` names the reach.
