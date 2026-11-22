# ADR 0552: A tool a person approves (`personApproves` on a tool)

Status: accepted, 2026-11-23 (stage 31a, build step 7). Extends
[ADR 0512](0512-one-per-person-and-tools-only-a-person-may-call.md) and
[ADR 0513](0513-a-granted-holder-keeps-what-it-was-granted.md) (moves only named tools make), and
the two notions of "a person's own" in [ADR 0507](0507-what-the-bookings-review-needed-of-the-platform.md).

## Context
Spec 31: cancelling a class is destructive; "an AI asks, a person approves" (acceptance criterion
6: refused to an AI without a person's approval). A `humanOnly` tool refuses the assistant outright,
so it cannot even ask. A tool's `destructive` risk is queued for the assistant under the default
`balanced` preset, but not under every preset, and the class's move into `cancelled` must not be
open to every staff write either (`record.update` would bypass the tool).

## Decision
- **A tool may declare `personApproves: true`** (with a risk other than `read`, staff only). Its
  operation always waits in the approval queue for any actor but a person (`alwaysReview` for the
  assistant, MCP clients, automations and extensions), whatever the policy, preset or deploy floor
  says; a `deny` still applies; the adjudicator never approves it (a forced review). A person's own
  call runs as any tool's.
- **Such a tool may be named in a move's `tools`** (ADR 0513), with a `permission`, as a `humanOnly`
  one may: the move is a person's act, called by one or approved by one. No other staff write makes
  it.
- Bookings: `cancelClass` (`destructive`, `personApproves`, `bookings:cancelClasses`) is the only
  staff way into a class's `cancelled`; the class's move is `by: ["host"], tools: ["cancelClass"]`.

## Consequences
- So there are three: `humanOnly` (a tool only a person calls: refused to anyone else),
  `personApproves` on a tool (anyone may ask; a person decides), and `personApproves` on a field or
  setting (ADR 0507: anyone else's write of it is queued).
- An approved call runs with the asking actor and the approval; the queue's dry run of a tool runs
  nothing (ADR 0507).

## Proof
`apps/runner/test/bookings-attendance.test.ts`: under the `autonomous` preset the assistant's and an
MCP client's `cancelClass` are queued and change nothing; a person's `record.update` to cancelled is
refused; a person approves the assistant's request and the class and its bookings are cancelled.
With the flag taken out, the assistant's call is applied at once and the test fails.

## Amended 2026-11-23, after the review of PR #253
- A `personApproves` tool counts as a person's act wherever `personsTool` asks (ADR 0513): the
  moves it names, and also the holder-term fields extension code may set and a hand grant's dates
  and once-per-person (`operations/record.ts`). This is deliberate: its write is a person's, made
  by them or approved by them.
- The person who approves need not hold the tool's pack permission: approving follows the
  existing approval model (a person who may approve the action), not the tool's permission.
- A hand grant records who gave it (`given_by`): for an approved call by another actor, the
  approving person (the run's `startedBy` is the approver), not the extension principal. No
  shipped `personApproves` tool makes a hand grant today (`cancelClass` grants nothing), so the
  path is not reachable yet; it is set so that it is right when one does.
