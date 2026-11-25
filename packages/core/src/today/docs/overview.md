---
id: today
title: Today
summary: The day at a glance for one person, in the business's own time zone. The host's numbers (takings, changes waiting, shifts with nobody on them, checklists missed, unread notices) and the numbers installed packs declare, each shown only to someone who could already read it, with the rows behind each.
stage: 60
spec: docs/stages/60-owners-today.md
adrs: [0870, 0871, 0872, 0874]
operations: [today.]
---

## What it is for

The owner, a manager or a coach opens Today and sees the business's day: what is happening, what
needs a decision and what went wrong. Each number comes from the host for the person asking, and
each opens the rows behind it. The answer names no pack: an installed pack adds its own numbers.
The phone's owner's client and the web admin both read it.

## Concepts

- **Today**: the business's current local day, from its local midnight to the next, in the
  organisation's time zone. A day across a clock change is 23 or 25 hours long.
- **Item**: one number, with a key (`host.takings`, `bookings.cameToday`), a label, a value (a
  count, a percent, or money in the currency's minor unit for the host's own), a comparison with
  the same local time yesterday or a week ago, `ok` or `attention`, and what a tap opens.
- **Host item**: worked out by the host from data no `rec_*` view shows: `host.takings`,
  `host.approvals` ("Waiting for you"), `host.uncovered` (shifts with nobody on them),
  `host.checklists` (checklists missed) and `host.notices` (unread notices).
- **Pack item**: declared by a shipped pack in its manifest (`todayItems`): read-only SQL over
  `rec_*` views, a count or a percent, gated by the pack's own tools.
- **Rows**: at most 50 behind an item, each a name, a second line and the record it opens.

## How the pieces fit

- **Platform code** in `packages/core/src/today/`: `items.ts` (the business's windows, who is
  asking, the gate), `host.ts` (the host's items), `pack.ts` (a pack's items), `declaration.ts`
  (the install's check of a pack's SQL), reached through the
  [operations](/capabilities/today/operations/) `today.get` and `today.rows`. Both are staff reads.
- **The gate**: an item is shown only to someone who could already call what reads it, judged by
  the pipeline's own rule. A pack item needs every tool its pack names for it. Takings needs
  `finance.report` (`finance:read`); changes waiting need `approval.approve`, and only the actions
  this person may approve are counted; shifts with nobody on them and checklists need someone who
  rosters; notices need the inbox.
- **Reads**: takings is Finance reports' Sales net (sold less refunded) for the local day, with the
  number of payments, against the same time last week; changes waiting are the pending actions the
  approver rules let this person approve; shifts with nobody on them are the roster's window, with
  how many start within 24 hours; checklists are runs missed today and runs still open past their
  end; notices are the unread count.
- **An AI actor** (the assistant, an MCP client) gets the pack items and the money its user may
  see, never the changes waiting, checklists, shifts or the inbox.
- **A pack role's account** (a coach, the door, a cleaner) reaches Today too, and sees no host item
  and only the pack items its role's tools open; a row opens a record only where the role reads
  that object.
- **Cost**: a few statements whatever the data. The pack items are read as columns of one
  statement, and kept 60 seconds with the takings; the person's own items are read on every call.

## Main flows

1. **Look.** A person (or the assistant) calls `today.get` and gets the day's date, the zone and
   the items they may see, attention first.
2. **Open.** A tap calls `today.rows` with the item's key; changes waiting open the approvals and
   notices the inbox. Looking at the money's rows is audited, naming the item, never a figure.

## What is built

Stage 60's step 3, as the code has them: `today.get` and `today.rows`, the host's takings, changes
waiting, shifts with nobody on them, checklists and notices, the running of a pack's declared items,
and a pack role's own Today. Payments failing waits for Finance reports' money owed. Not in the
code yet: the packs' own items, alerts, the web Today and the native blocks (steps 4, 5, 7 and 8).
