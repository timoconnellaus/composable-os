# ADR 0573: Runs over the rate rail wait their turn; a full approval queue is back-pressure

Status: accepted, 2026-11-23 (stage 31a step 9, the review of PR #256). Amends
[ADR 0130](0130-automation-runtime.md) (rails) and [ADR 0170](0170-automation-run-as-bindings.md)
(gatekeeper calls from a run).

## Context
An automation's runs-per-minute rail (the Rate Limiting binding, 60 a minute) auto-paused the
automation and dropped every run over it: no run row, never replayed. A closure cancelling 70
classes, a series change moving 70, or a popular booking window opening started more than 60 runs
of one Bookings automation in a minute; members of the rest were never told, and every later
cancel went unsent until an admin resumed it. A member-facing message caused by a host change must
not be dropped.

Building the test for it found a second loss: the email-send gatekeeper refused a send once 50
were waiting (its journal's default), with an error extension code reported as its own failure;
three in a row quarantined the whole Bookings pack, its tools included.

## Decision
- **The runs-per-minute rail shapes, it does not lose.** A run over it is recorded `queued` with
  `status_reason` "deferred: over the runs-per-minute rail" and `wait_until` the next minute, and
  no Workflow instance. The minute cron's `runDeferredDue` starts them, oldest first, as the rail
  allows again (each start counts against it), with the trigger and cascade tags they were
  recorded with, at most 500 a tick. An automation disabled or paused keeps its backlog until it
  runs again. Only a backlog past 5,000 (a runaway) pauses the automation, its backlog kept, and
  the admins are told.
- **Writes per hour still pause** (a runaway's real cost), and the runs held back by it are
  recorded the same way, starting after the automation is resumed. Events that arrive while an
  automation is paused are not matched (as before): the pause is reported to the admins.
- **A gatekeeper's queue full is back-pressure**: its refusal ("Too many pending actions") reaches
  extension code as `rate_limited`, which the step retries and which never counts towards the
  extension's quarantine. Email-send holds up to 500 sends waiting for approval per sender (was
  50), a day of member emails under Balanced.

## Consequences
- A burst is told within a few minutes rather than lost; the run history shows each deferred run
  as queued until it starts.
- A run deferred longer than its moment (a reminder) still runs: what it does is its own (Bookings'
  reminder sends nothing once the class has started).

## Proof
`apps/runner/test/automations.test.ts` (three runs over a rail of one: one now, two recorded and
started on the next two ticks, each once, nothing paused), `apps/runner/test/bookings-messages.test.ts`
(a closure of 70 classes under a rail of 60: every member told exactly once, nothing paused),
`apps/runner/test/gatekeeper-backpressure.test.ts`, and email-send holding 60 pending sends
(`packages/gatekeeper-email-send/test/calendar.test.ts`).

## Amended 2026-11-23, after the second review of PR #256
- **The drain applies the same rails as the start** (one function, `railVerdict`): an
  automation's writes this hour (over them it is paused, its backlog kept), the binding, and its
  own stricter runs-per-minute rail (a routine's 6 a minute drains at 6, counting runs started in
  the last minute, not those waiting).
- **Every automation gets its share of a tick**: the drain reads which automations have runs due,
  then up to `500 / n` of each one's oldest, so a backlog of thousands of confirmations never holds
  another automation's cancellations back.
- **A retry, a replay or a manual run over the rail** is answered as waiting its turn, with its run
  id (`automation.retry` → `{ runId, deferred: true }`, `automation.run` → `deferredRunIds`), and a
  second click while it waits answers with the same run. Its stored trigger keeps the retry's
  journal (completed steps replay, nothing is written twice) and the run its chain began with
  (ADR 0574).
- **A step a gatekeeper holds back waits, it does not fail.** A step whose gatekeeper refused it
  as back-pressure (`rate_limited`: its approval queue full) is tried again after 30 seconds, 1, 2,
  5, 10, 15 and 15 minutes (about 48 in all), the run shown waiting ("Held: the approval queue is
  full") and the admins told once that it is holding what it sends. If the queue is still full
  after that, the run fails saying so (`held_back`), and the admins are told; its retry sends
  nothing it already sent (ADR 0574).
- A deferred run whose record is erased is cancelled rather than started with no record.

Proof, added: `apps/runner/test/deferred-runs.test.ts` (a rail of 6 drains 6 of 10; two
automations, one with a backlog, both drained in a small tick; a retry over the rail answered as
deferred with its journal and first run, asked twice the same run; a manual run's deferred ids),
`apps/runner/test/bookings-held.test.ts` (500 sends waiting: a cancelled class's run waits, held,
the admins told; once the queue has room each member's email is queued once).
