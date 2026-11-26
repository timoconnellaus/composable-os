# ADR 0882: The accounting outbox: references, once only, uncertain outcomes, holds and dependencies, the lock and start dates, approval

Status: accepted, 2026-11-26 (stage 61 build, step 4; revised the same day after the review of PR
#504). Builds on ADRs [0880](0880-the-accounting-contract.md) (the contract: references,
`applyWrite` writes nothing for a reference the books hold; read after write, as amended) and
[0881](0881-the-accounting-connection-is-the-hosts-alone.md) (`callAsHost` purpose `accounting`);
follows [0645](0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md) (host code
claiming a row before it sends) and [0793](0793-payout-reads-through-the-payments-gatekeeper.md)
(a daily read bounded per run). Spec: [stage 61](../stages/61-accounting-sync.md), decisions 4, 6
and 7.

## Context

Money leaves the business's own records for its books. An entry posted twice counts the money
twice; an entry silently dropped leaves the books short; an entry dated inside a period the
accountant locked changes a period already reported. The classic failures of a sync are the ones in
between: an answer lost on the way back, a Worker that stops after the books wrote and before the
host recorded it, a call that hangs, two cron runs at once, books whose search for a reference lags
behind their writes, books that refuse for a while or are down for a fortnight, and a business that
changes its accounting system. For the first two weeks a person approves each day before it goes
(decision 4).

## Decision

**An entry is a row with a reference unique per books, built with the mapping's keys.** Host code
(steps 5 and 6) queues an entry with `queuePost` (`packages/core/src/accounting/outbox.ts`): one row
of `core_accounting_post`, reference `cos:<kind>:<source id>:<n>`, inserted only when that
reference is not queued for the same books, so queuing it again is a no-op (`UNIQUE (connection_id,
reference)`, migration 1332, which remakes migration 1330's table). Where a books account or tax
rate goes it holds `{ map: <kind>, key? }`, and where a payment names its invoice
`{ dep: "books_ref" }`; the runner resolves them when it sends, so a mapping changed before then
applies, and an entry nobody mapped is held with what to map.

**A person's details apart.** A contact's name, email, address and tax number, and a document's
bill-to, are kept only in `detail`; `body`, `lines` and the call kept (`request`) name them by key
(`{ detail: "name" }`). The runner fills them in only in the call it sends; what it keeps is the
call with the keys. The sent-entry trigger lets `detail` alone be cleared, so step 9's erase clears
`detail` and the figures sent stay as they were; the log then shows the keys, not the person.

**Claimed before it is sent, recorded onto that claim only.** The runner (`runner.ts`,
`runAccounting`) claims an entry by moving it to `sending` with its call and the next attempt
number, in one conditional statement only one run can win, then calls the books as the host, then
records the outcome with `attempts = <its claim>`, so an outcome that arrives late never lands on a
later run's claim. Every call has a deadline of 5 minutes (`CALL_DEADLINE_MS`); a claim is taken for
a stopped run only after 30 minutes (`STALE_MS`), longer than a scheduled invocation can run (15
minutes).

**A write the host knows was applied is never sent again.** The facet keeps the books' ref of each
write it applies and the integration host gives it with the applied action (ADR 0880, as amended),
so an ordinary send needs no second call. When the ref does not come with it, the entry is
`unknown` with `applied_at` set and is looked up by its reference after 1, 5, 30, 120 and 720 minutes
(`APPLIED_LOOKUP_MINUTES`), then held: "in the books, but its reference was not found: check
<reference>". A trigger (`core_accounting_post_applied`) refuses ever moving such an entry to
queued, sending, retrying, skipped or waiting for approval; a person's retry only looks it up again.

**An uncertain outcome is looked up before anything is sent again, a bounded number of times.** An
answer lost (`[apply-outcome:unknown]`), a call past its deadline, or a claim left by a stopped run
makes the entry `unknown`. It is looked up after 1, 5 and 30 minutes (`UNCERTAIN_LOOKUP_MINUTES`,
36 minutes in all) under a lease so one run looks it up; found, it is `sent`; when all three miss it
is queued again, at most three times (`MAX_UNKNOWNS`), then held ("the books' answer was lost three
times"). The contract promises read after write, and the 36 minutes cover books that lag a little;
the gatekeeper's own rule (a reference the books hold writes nothing) is the second guard.

**An error with no refusal code holds the entry.** A failure that carries no `[accounting:<code>]`
at the start of its message (a configuration error, a bug, an RPC failure) may have been written: it
is looked up on the same schedule and then held, never queued again by itself.

**A refusal holds only what it touches, and the bookkeepers hear of it.** A refusal a person must
fix (`unmapped`, `invalid`, `duplicate_number`, `contact_archived`; the deploy floor denying
`accounting.post`) holds the entry with its reason, and the rest carry on. A transient one
(`rate_limited`, `unavailable`, an action the gatekeeper may try again, and `locked_period`, which
means the lock moved since the run read it) retries after 1, 5 and 30 minutes, 2 and 12 hours, then
holds. **For its first two tries (`PAUSE_TRIES`, six minutes) nothing else is sent**: the books are
struggling. After that the rest go past it, but its own day's later entries keep their order behind
it; dependencies wait as below. So one entry pauses everything for six minutes at most, never for
its whole schedule. The bookkeepers (admins and accounts granted `accounting:manage`) are told once
a day when entries are held, and once per entry when one has been refused four times (over half an
hour); the screens and the digest are step 7.

**An outage touches nothing.** Every run reads the books first (`describeBooks`: the currency and
the lock date). If they cannot be reached, the run stops before it claims anything: an outage of any
length leaves every entry `queued` with no attempt counted, and when the books are back the backlog
goes in order, a run's worth a minute.

**Dependencies.** An entry may depend on one other (a payment on its invoice, an invoice on its
contact). It is sent only once that one is sent, with that one's books ref; it waits (re-checked
every ten minutes) while that one is queued or waits for approval, and is held ("waits for …")
while that one is held or was skipped. Sending one releases what waited for it, in the same run
when there is room.

**Order.** Entries go by the day they belong to, then as queued (index
`core_accounting_post_order`, which carries `next_attempt_at` so entries waiting on a dependency are
passed over from the index).

**The lock date (decision 7) and the start date (decision 6).** An entry whose day is on or before
the books' lock date, read at the start of the run, carries the first open day, and its text (a
document's first line) says "dated 12 November 2026, the books are locked to 30 November 2026"; a
document falls due no earlier than it is dated. The date is worked out from the entry's own day each
try. A lock date that is not a date blocks every send (an entry could land inside a lock) and the
bookkeepers are told once. Nothing before the start date is queued, and an entry whose day is before
it is held and never sent; it is retryable once a human admin moves the start date earlier than its
day (possible only before anything was sent to these books).

**A change of books.** Books change only while the sync is off (step 2), and now not while an entry
is on its way to the old books (being sent, or of unknown outcome). The old books' entries not sent
are skipped by the admin making the change, with "the books were changed: not sent to the old
books"; an entry the host knows is in the old books stays as it is. **Nothing already sent is posted
again to the new books**: the spec asks for nothing of the kind, and the bookkeeper moves history
between systems as their accountant says. The new books start from their own start date (the
daily pass starts again from it), with their own mapping and their own references. Other books on
the same connection are refused once that connection has entries, since references are unique per
connection: connect them as their own connection. Only the chosen books' entries are due or sent.

**An entry left waiting in Approvals** (the host's message reviewed after all, which the
provisional-id rule can do) is held with its pending action's id. Once a person approves and applies
it there, the next run looks it up and records it `sent`; turned down, it is held saying so, for a
retry or a skip. A retry while it still waits there is refused, and a skip turns the pending action
down with it.

**A person's retry and skip.** Both write only on the state they read and fail whole, their audit
row with them, when the runner moved the entry meanwhile (a statement in the same batch that the
outbox's insert trigger refuses when the move did not land).

**Approval is the outbox's, one day at a time.** An entry queued while fewer than `approve_until`
days are approved waits (`awaiting_approval`); the state is decided in the insert from the settings
row. `accounting.approveDay` (a person with `accounting:manage`) queues the day's waiting entries and
counts the day the first time it is approved, in the same batch. A day nobody approved does not
count. After the fourteenth approved day entries are queued at once and the bookkeepers are told
once; an entry put for approval before then still waits for a person. A human admin putting
approval back on starts the count again.

**Blocked, said once.** A connection that is not active, books in another currency, or a lock date
that is not a date block every send; nothing is claimed, and the bookkeepers are told once when it
starts (`blocked` on the settings row).

**The run is host code on the minute cron, not an operation.** A run must commit each claim before
the books are called and each outcome after, which one operation's batch cannot; it is the host's
own bookkeeping, as an agreement's copy is (ADR 0645). The spec's `accounting.run` is this function
(`runAccountingDue`); the operations are the people's: `approveDay`, `post.retry`, `post.skip`, all
`actors: ["human"]`. The integration host audits each write as the system's (origin
`system.accounting`, the gatekeeper's words cut to 300 characters); the runner audits what it
decides alone (operation `accounting.run`): an entry found by its reference, held, or whose outcome
is not known.

**The gatekeeper's words.** Refusal and failure messages reach the outbox and the audit. A
gatekeeper never echoes a request's or response's headers or body, or any credential, in them;
step 8's Xero gatekeeper writes its own words and the books' error code at most.

**Bounded.** A run claims at most 25 entries (`SENDS_PER_RUN`) and looks up at most 25 of unknown
outcome (`LOOKUPS_PER_RUN`), three to four statements each and about a dozen for the run: 86
statements for 25 sends with no dependencies, 99 with half of them waiting on the one before, the
same whatever the backlog. The sends go before the daily pass, which builds at most seven settled
days a run (`DAYS_PER_RUN`) from 02:00 in the organisation's zone and marks each only once built; a
builder that fails is caught, its day built again next run, and the bookkeepers told once a day.
A quiet minute is one indexed read.

## Consequences

- Steps 5 and 6 only build entries (`queuePost`, a `DayBuilder` for the daily pass), keeping a
  person's details in `detail`; sending, holds, retries, the lock and start dates and approval are
  this step's for every kind. Step 9's erase clears `detail` (and links and matches); it needs no
  change to the triggers.
- A partial outage, where the books answer reads but refuse every write `unavailable` past the
  retry schedule, holds entries one at a time; they wait for a person's retry, and the bookkeepers
  are told. Nothing is lost or doubled. A full outage is automatic.
- A void is not sent by the runner: it is a person's request (step 6) and always reviewed (ADR 0881).
