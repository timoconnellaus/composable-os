# ADR 0882: The accounting outbox: references, once only, uncertain outcomes, holds and dependencies, the lock and start dates, approval

Status: accepted, 2026-11-26 (stage 61 build, step 4). Builds on ADRs
[0880](0880-the-accounting-contract.md) (the contract: references, `applyWrite` writes nothing for a
reference the books hold) and [0881](0881-the-accounting-connection-is-the-hosts-alone.md)
(`callAsHost` purpose `accounting`); follows [0645](0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md)
(host code claiming a row before it sends) and [0793](0793-payout-reads-through-the-payments-gatekeeper.md) where the daily read of
payouts is bounded per run. Spec: [stage 61](../stages/61-accounting-sync.md), decisions 4, 6 and 7.

## Context

Money leaves the business's own records for its books. An entry posted twice counts the money
twice; an entry silently dropped leaves the books short; an entry dated inside a period the
accountant locked changes a period already reported. The classic failures of a sync are the ones in
between: an answer lost on the way back, a Worker that stops after the books wrote and before the
host recorded it, two cron runs at once, a books system that refuses for a while or is down for a
fortnight. And for the first two weeks a person approves each day before it goes (decision 4).

## Decision

**An entry is a row with a fixed reference, built with the mapping's keys.** Host code (steps 5
and 6) queues an entry with `queuePost` (`packages/core/src/accounting/outbox.ts`): one row of
`core_accounting_post`, reference `cos:<kind>:<source id>:<n>`, inserted only when that reference is
not queued yet, so queuing it again is a no-op. Where a books account or tax rate goes it holds
`{ map: <kind>, key? }`, and where a payment names its invoice `{ dep: "books_ref" }`; the runner
resolves them when it sends, so a mapping changed before then applies, and an entry nobody mapped
is held with what to map. The exact call sent is kept (`request`, migration 1332) and, once sent,
never changes: it is what the log shows.

**Claimed before it is sent, recorded after.** The runner (`runner.ts`, `runAccounting`) claims an
entry by moving it to `sending` with its call in one conditional statement only one run can win,
then calls the books as the host, then records the outcome. Two runs at once each claim different
entries.

**An uncertain outcome is looked up, never resent blind.** An answer lost (`[apply-outcome:unknown]`),
an error that carries no refusal code, an action applied whose ref the books do not return, or a
claim left `sending` past ten minutes (a run that stopped between the books' answer and the record)
makes the entry `unknown`. The next run calls `findByReference` first, under a lease so one run
looks it up: found, it is `sent` with the books' ref; not found, it is `queued` again, and only then
sent. The gatekeeper's own rule (ADR 0880) is a second guard: a reference the books hold writes
nothing.

**A refusal holds only what it touches.** A refusal a person must fix (`unmapped`, `invalid`,
`duplicate_number`, `contact_archived`; the deploy floor denying `accounting.post`; an entry that
waits in Approvals instead of going) holds the entry with its reason, and the rest carry on. A
transient one (`rate_limited`, `unavailable`, an action the gatekeeper may try again, and
`locked_period`, which means the lock moved since the run read it) retries after 1, 5 and 30
minutes, 2 and 12 hours, then holds. **While an entry waits to retry, nothing else is sent**: the
books are refusing for a while, so the runner stays inside their limits and the entries keep their
order. A person's `accounting.post.retry` starts its count again.

**An outage touches nothing.** Every run reads the books first (`describeBooks`: the currency and the
lock date). If they cannot be reached, the run stops before it claims anything: an outage of any
length leaves every entry `queued` with no attempt counted, and when the books are back the backlog
goes in order, a run's worth a minute.

**Dependencies.** An entry may depend on one other (a payment on its invoice, an invoice on its
contact). It is sent only once that one is sent, with that one's books ref; it waits (re-checked
every ten minutes) while that one is queued or waits for approval, and is held ("waits for …")
while that one is held or was skipped. Sending one releases what waited for it, in the same run
when there is room.

**Order.** Entries go by the day they belong to, then as queued (index
`core_accounting_post_order`).

**The lock date (decision 7) and the start date (decision 6).** An entry whose day is on or before
the books' lock date, read at the start of the run, carries the first open day, and its text (a
document's first line) says "dated 12 November 2026, the books are locked to 30 November 2026"; a
document falls due no earlier than it is dated. The date is worked out from the entry's own day each
try, so a lock moved or lifted since is read as it is. Nothing before the start date is queued, and
an entry whose day is before it is held and never sent, nor retried.

**Approval is the outbox's, one day at a time.** An entry queued while fewer than `approve_until`
days are approved waits (`awaiting_approval`); the state is decided in the insert from the settings
row, so an approval counted meanwhile is read as it is. `accounting.approveDay` (a person with
`accounting:manage`) queues the day's waiting entries and counts the day the first time it is
approved, in the same batch, so two people approving it count it once; a day nobody approved does
not count. `accounting.post.skip` (a person, with why) leaves an entry out, before or after its
day is approved, never one being sent, sent or of unknown outcome. After the fourteenth approved
day entries are queued at once and the admins (and accounts granted `accounting:manage`) are told
once; an entry that was put for approval before then still waits for a person, so nothing goes
unchecked. A human admin putting approval back on starts the count again.

**Blocked, said once.** A connection that is not active, or books in another currency than the
deployment's, block every send; nothing is claimed, and the bookkeepers are told once when it
starts (`blocked` on the settings row), not every minute.

**The run is host code on the minute cron, not an operation.** A run must commit each claim before
the books are called and each outcome after, which one operation's batch cannot; it is the host's
own bookkeeping, as an agreement's copy is (ADR 0645). The spec's `accounting.run` is this function
(`runAccountingDue`); the operations are the people's: `approveDay`, `post.retry`, `post.skip`, all
`actors: ["human"]`. Each send is audited as the system's by the integration host (origin
`system.accounting`), with the entry's reference in its description.

**Bounded.** A run claims at most 25 entries (`SENDS_PER_RUN`) and looks up at most 25 of unknown
outcome (`LOOKUPS_PER_RUN`), with three to four statements each and about a dozen for the run, so
its statements do not grow with the backlog; the next minute carries on. The daily pass, from 02:00
in the organisation's zone, builds at most seven settled days a run (`DAYS_PER_RUN`) and marks each
only once built, so a run that stops builds it again, which queues nothing twice. A quiet minute is
one indexed read.

## Consequences

- Steps 5 and 6 only build entries (`queuePost`, a `DayBuilder` for the daily pass); sending, holds,
  retries, the lock and start dates and approval are this step's for every kind.
- A partial outage, where the books answer reads but refuse every write `unavailable` for longer than
  the retry schedule, holds one entry at a time (each after about fifteen hours); they wait for a
  person's retry. Nothing is lost or doubled, but it is not automatic; a full outage is.
- A void is not sent by the runner: it is a person's request (step 6) and always reviewed (ADR 0881).
- The daily digest of what is held, and the screens, are step 7.
