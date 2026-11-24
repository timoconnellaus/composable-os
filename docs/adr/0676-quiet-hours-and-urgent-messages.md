# ADR 0676: Quiet hours and urgent messages

Status: accepted, 2026-11-24 (stage 30, build step 1: `feat/stage-30-routine-messages`, block BB:
migration 0910). The stage's decisions 4 and 5 (`docs/stages/30-notifications.md`). Builds on ADR
[0670](0670-routine-messages-text-and-push-on-the-routine-mail-path.md) (routine messages).

## Context
Texts and pushes buzz a phone; email does not on its own. Decision 4: quiet hours from 9pm to 7am
in the business's time zone, when texts and pushes wait and emails go at once. Decision 5: a class
cancelled at short notice still texts and pushes during quiet hours, because it is urgent. Trades
start early, so the window is the business's to set. Journeys will use the same setting.

## Decision

- **One business-wide window** in the `routine_mail` setting, `quietHours: { start, end }`
  (local `HH:MM`, default `21:00` to `07:00`), in the organisation's time zone (Settings →
  General). The same start and end means none. A human admin's only, as every routine setting.
  Per-member quiet hours are out of scope; staff get their own for staff notices (step 4).
- **Only texts and pushes wait.** An email is never held by quiet hours.
- **Decided when a row is prepared** (`quietDecision`, `packages/core/src/routine-mail/quiet.ts`):
  a text or push prepared inside the window is `waiting` with `wait_until`, the window's end,
  unless its kind is **urgent** and its moment (`until`) comes before the window ends: then it goes
  now (a 6am class cancelled at 5am). An urgent message whose moment is after the window waits like
  any other (a cancellation of a class days away). A night the clocks change ends on the local
  `end` time of that morning.
- **Released by the runner's minute cron** (`releaseWaitingRoutineMessages`): a waiting row whose
  `wait_until` has come is `ready` for its gatekeeper to send, or `expired` when its moment
  (`until_at`) passed while it waited; its words and number are cleared then. The email went when it
  was prepared. A bounded batch a minute, in chunks well under D1's 100 bound values a statement; a
  row waiting for a person's approval (a pending action) is never released by the clock.
- A row whose moment had already passed when it was prepared is `expired` at once.

## Why
- Holding at preparation and releasing by the clock keeps the decision with the row, visible in
  the log (`waiting` until a time), and needs no timer per message.
- "Urgent" lets a message through only when waiting would make it late: an urgent kind cannot use
  quiet hours as a loophole for messages that could have waited.

## Consequences
- A reminder due at 11pm for a 6:30am class goes by email only; its text or push is `expired` at
  7am. Gyms that want late reminders by phone set a shorter window.
- Until the text and push gatekeepers are built (steps 3 and 4), no row reaches `waiting`, and the
  minute step is one read.

## Proof

| Check | Test |
| --- | --- |
| 11pm waits until 7am; noon goes; midnight; the edges; a window inside a day; none; a night the clocks change | `packages/core/test/routine-messages.test.ts` ("quiet hours") |
| An urgent cancellation of a 6am class at 5am goes at once; of a class days away waits; not urgent waits | `packages/core/test/routine-messages.test.ts`, `apps/runner/test/routine-messages.test.ts` |
| At 7am a 9am class's reminder goes and a 6:30am class's is `expired`, its email ready at 11pm | `apps/runner/test/routine-messages.test.ts` |
| Released once; words and device cleared on expiry | `packages/core/test/routine-messages.test.ts` ("the end of quiet hours") |
