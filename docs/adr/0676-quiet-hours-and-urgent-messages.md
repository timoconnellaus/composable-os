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
  (local `HH:MM`, default `21:00` to `07:00`), in the time zone of the same setting,
  `quietZone`. The same start and end means none. A human admin's only, as every routine setting:
  the zone is not the organisation's general one (Settings → General), which `settings.update`
  lets others change, an AI's change applied at once under Balanced. No text or push is switched
  on until `quietZone` is set; a row prepared without one is `failed` with the reason.
  Per-member quiet hours are out of scope; staff get their own for staff notices (step 4).
- **Only texts and pushes wait.** An email is never held by quiet hours.
- **Decided when a row is prepared** (`quietDecision`, `packages/core/src/routine-mail/quiet.ts`):
  a text or push prepared inside the window is `waiting` with `wait_until`, the window's end,
  unless its kind is **urgent** and its moment (`until`) comes before the window ends: then it goes
  now (a 6am class cancelled at 5am). An urgent message whose moment is after the window waits like
  any other (a cancellation of a class days away). A night the clocks change ends on the local
  `end` time of that morning; an `end` the clocks skip that night (01:30 when they go from 01:00
  to 02:00) ends at the jump, never an hour early. A row held for a person is `held`, not
  `waiting`: the clock never releases it.
- **Released by the runner's minute cron** (`releaseWaitingRoutineMessages`): a waiting row whose
  `wait_until` has come is decided again, as an email is when it is claimed (ADR 0590's F2): its
  kind turned off, its pack's routine messages or its channel switched off since, `off`; not
  routine, `held`; its moment (`until_at`) passed while it waited, `expired` (words and number
  cleared); else `ready` for its gatekeeper, whose claim must decide it again too. The email went
  when it was prepared. Batches of 500 until none is left (at most ten a minute), in chunks well
  under D1's 100 bound values a statement; a row waiting for a person's approval (a pending action)
  is never released by the clock.
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
| A held row never released; a kind or channel switched off since: `off`; more than one batch a minute | `packages/core/test/routine-messages.test.ts` |
| An end the clocks skip ends at the jump | `packages/core/test/routine-messages.test.ts` |
| The zone a human admin's: an MCP client changing the organisation's zone moves nothing; the assistant and MCP cannot set `quietZone` | `apps/runner/test/routine-messages.test.ts`, `packages/core/test/routine-messages.test.ts` |
