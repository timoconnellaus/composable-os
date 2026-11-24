# What a host costs on Cloudflare

<!-- Two parts, written by two sessions on 2026-11-24: the Durable Objects (its own section, from
     `chore/cloudflare-spend-durable-objects`) and everything else that is billed (this section,
     from `chore/cloudflare-spend-crons-d1`). Whichever merges second keeps both sides. -->

## Everything else that is billed: crons, D1, Queues, storage and AI calls

**Date:** 2026-11-24. **Code:** `main` at `d1478b6b` plus the fixes below. Both columns of the idle table are counted on `d1478b6b`: "before" as it is on `main`, "after" with the fixes. **Scope:** every
Worker's wrangler config (`apps/app`, `apps/runner`, `apps/marketing`,
`products/crm/apps/control`, `templates/client/apps/web`, our own gatekeepers) and what each
billed product does on an idle host and on a busy one. Durable Objects are in their own section.
The earlier audit, with the findings it fixed, is
[`research/cloudflare-cost-audit.md`](research/cloudflare-cost-audit.md).

Nothing was deployed and no Cloudflare API was called. The idle figures are counted in workerd by
the tests named below. The busy figures are estimates from those counts and from reading the
code; none is measured on a live host.

### Prices and limits

From Cloudflare's documentation, read on 2026-11-24
([Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[Queues](https://developers.cloudflare.com/queues/platform/pricing/),
[Observability](https://developers.cloudflare.com/observability/pricing/),
[Images](https://developers.cloudflare.com/images/pricing/),
[Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/)). Workers Paid:

| Product | Included a month | Then |
| --- | --- | --- |
| Workers requests (cron runs and queue batches count) | 10M | $0.30 per M |
| Workers CPU | 30M CPU-ms | $0.02 per M CPU-ms |
| D1 rows read (rows scanned, not rows returned) | 25 billion | $0.001 per M |
| D1 rows written (each index a write touches is another row) | 50M | $1.00 per M |
| D1 storage | 5 GB | $0.75 per GB-month; 10 GB per database, not raisable |
| Queues | 1M operations (a message is about 3: write, read, delete; a retry adds a read) | $0.40 per M |
| KV | 10M reads; 1M writes, deletes and lists | $0.50 per M reads; $5.00 per M writes |
| R2 | none for operations | Class A $4.50 per M, Class B $0.36 per M, $0.015 per GB-month |
| Images | 5,000 unique transformations (a repeat in the same month counts once) | $0.50 per 1,000 |
| Workers AI | 10,000 neurons a day | $0.011 per 1,000 neurons |
| Workers Logs, until 2026-11-30 | 20M events | $0.60 per M |
| Observability, from 2026-12-01 | 50 GB ingested, 10 GB-month stored | $0.25 per GB ingested, $0.10 per GB-month |

Limits that matter here: 1,000 D1 queries per Worker invocation (a batch is one), 100 bound
parameters per statement, 30 s per query. The local runtime enforces none of them, so a path that
could approach them has a statement-count test.

### What runs on a schedule

| Worker | Cron | What it does |
| --- | --- | --- |
| cos-runner | `* * * * *` | `minuteTick` (`apps/runner/src/index.ts:300`): about 20 steps, from automation schedules to agreement copies |
| cos-app | `*/10 * * * *` | the embedding catch-up, the adjudicator's sweep, blob deletions, the agents' sweep |
| cos-app | `17 3 * * *` | the daily maintenance: Trash purge, retention, storage measurement (`apps/app/src/server/purge.ts`) |
| crm-control | `30 2 * * *` | the control plane's daily jobs |
| dispatch Worker (hosted) | `* * * * *` | runs each running tenant's minute tick (`products/crm/apps/control/src/dispatch/handler.ts`), so the minute tick's cost is per tenant |

### What an idle host costs a day

Idle means the shipped packs installed and nobody doing anything. Counted by
`apps/runner/test/idle-minute-cost.test.ts` and `apps/app/test/ten-minute-cost.test.ts`.

| Product | Before this change | After |
| --- | --- | --- |
| Workers requests | 1,585 (1,440 minute ticks, 144 ten-minute runs, 1 daily) | same |
| D1 statements | about 82,000 (56 a minute, 7 every ten minutes) | about 60,000 (41 a minute; 43 in an hour's first minute) |
| D1 rows read | about 480,000 (336 a minute), and growing: the checklist step read every day run ever made, every minute | about 250,000 (176 a minute: 82 of its own, the rest the schema registry's stamp, which reads a row per extension field), flat as tables grow, plus, in an hour's first minute, one pass over subscriptions, open offers and acceptances with no person |
| D1 rows written | about 34,600 (24 a minute) | about 50 (the hourly and daily markers of the date-relative scan, and the nightly duplicate scan) |
| Audit rows added | 5,760 (4 a minute, about 2 GB a year of `core_audit` at its 6 rows written each) | 1 or 2 (the nightly duplicate scan and the daily Trash purge) |
| Queues, KV, R2, Images, Workers AI | 0 | 0 |
| Observability | about 1,600 invocation logs, a few MB | same |

Every included allowance above is far from reached: an idle host costs the $5 Workers Paid
minimum. What mattered was the audit log: four rows a minute of "nothing happened" filled
`core_audit` towards D1's 10 GB cap and made every audit read and the retention purge slower.

### What a busy host costs a day (estimate)

The scenario: 10 staff making 2,000 operations a day (500 of them writes), a public site with 5,000
page views a day, 200 orders, 50 assistant turns, 2,000 customer records and 5,000 subscriptions.

| Product | A day | Against the monthly allowance |
| --- | --- | --- |
| Workers requests | about 25,000 (pages, API, MCP, crons) | under 10% |
| D1 rows read | 2 to 3M: about 500 a staff operation (the stamp, the policy, a list page), a few per cached public read, 250,000 for the crons, and the daily storage measurement's counts over the big tables | under 1% |
| D1 rows written | 25,000 to 30,000: 10 to 30 per write (record, indexes, audit, changes, search), and a read counter row per public or customer read | about 2% |
| D1 storage | grows with the audit log, email bodies and payment events (below) | the 10 GB cap is the limit to watch, not the price |
| Queues | about 2,000 operations (automation events, routine deliveries) | under 10% |
| R2 | about 15,000 Class B reads (each picture view reads its object; nothing is cached at the edge) | about $0.16 a month |
| Images | a resize per picture view, billed once per unique size a month | small |
| Workers AI | about 70,000 neurons (50 assistant turns at about 700 each, plus summaries and embeddings) | about $0.66 a day past the 10,000 free |
| Observability | about 50 MB of logs | about 3% of the 50 GB from December |

At this size the bill is the $5 minimum plus Workers AI. The model calls are the only line that
grows faster than use, so they are where a host's spend shows first (Settings, AI, Usage).

### What was fixed in this change

| What | Where | Pinned by |
| --- | --- | --- |
| Four host steps called their operation every minute with nothing to do, and each wrote an audit row: `order.expireDue`, `record.publishDue`, `content.reindex`, `agreement.takeEffect`. Each now reads whether it has work first (one indexed row), outside the pipeline, as the roster step already did. A quiet minute writes no row (ADR 0130, amended) | `apps/runner/src/integrations/payments.ts` (`orderExpiryDue`, `packages/core/src/orders/late.ts:24`), `packages/core/src/content/schedule.ts:33` and `:72`, `packages/core/src/agreements/schedule.ts` (`agreementWorkDue`, `packages/core/src/operations/agreement.ts:957`) | `apps/runner/test/idle-minute-cost.test.ts`: no write; off the hour no full table scan and no statement reading more than 10 rows, with 500 checklist day runs on file; 60 statements and 120 rows of its own at most (41 and 82 today, room for a new step's reads); an order that is due is still expired and audited |
| The minute tick scanned `core_subscription` twice and `core_subscription_cool_off` twice, every minute. Partial indexes exist for them, but SQLite uses a partial index only when the query states its predicate literally, and these bound it as parameters | `packages/core/src/subscriptions/sweep.ts:36`, `packages/core/src/subscriptions/cooling-off.ts:1745` and `:1758` | the same test's query-plan check |
| The subscription sweep ran every minute and two of its reads (events not arriving, offers whose plan has gone) read every subscription and open offer: there is no index on `current_period_end` or `free_until`. Those two now run in an hour's first minute only; the past due read, indexed now, still runs every minute. Run hourly, a first page of 50 alone would return the same rows each hour and never reach the rest of a burst, so the events-not-arriving read pages through its whole one-day window (20 pages of 50 at most) | `apps/runner/src/integrations/payments.ts:61`, `packages/core/src/subscriptions/sweep.ts:27` | `packages/core/test/subscription-sweep-hourly.test.ts`: 100 periods ending within an hour, swept on each whole hour, tell staff about all 100 (51 with one page); `idle-minute-cost.test.ts` |
| Every staff request resolved its user with `id = ? OR lower(email) = ?`, which no index holds, so it read the whole `core_user` table (every staff account and every extension principal). It now reads by primary key first and falls back to the email only when the id is not a row | `packages/core/src/users.ts:27`, `apps/app/src/server/identity.ts:134` | `packages/core/test/acting-user-cost.test.ts`: 302 rows read before, 2 at most after |
| The checklist step's read of day runs past their close bound `state = ?`, so SQLite walked the `(object_type, record_id)` key instead of the partial index of open runs, and read every day run ever made, every minute (a run per checklist per day: 3,650 a year for ten). The predicate is written out, and `+object_type` keeps the planner off the type key | `packages/core/src/checklists/days.ts:416` | `idle-minute-cost.test.ts` with 500 day runs on file (501 rows read by that statement before, a few after) |
| The guest acceptance cleanup's check walks every acceptance with no person (guests' and erased ones), and no index holds it. Those acceptances wait three days, so the check now runs in an hour's first minute only | `packages/core/src/agreements/schedule.ts:18` | `packages/core/test/agreement-enforcement-review.test.ts` |
| The similar-records card asked again every 5 seconds for as long as a record was not indexed, which for a record that never is meant 720 requests an hour per open page, each reading D1 and Vectorize. It now stops a minute after the card first saw the record not indexed, and starts the minute again when the card is shown again | `apps/app/src/components/ai/similar-records.tsx:69` | `apps/app/test/similar-poll.test.ts` |
| The ten-minute cron was already quiet: 7 statements, about 5 rows read, none written | | `apps/app/test/ten-minute-cost.test.ts` pins it |

### What is left

None of these costs much at the sizes above. They are listed so they are fixed before a host
grows into them. Each needs a migration, a decision, or more than this change should carry.

| What | Where | Why it is left |
| --- | --- | --- |
| Every pipeline call reads the schema registry's stamp: `count(*)` and `max()` over the extension fields, objects and options, a row per field (47 with the default packs, a few hundred with all ten) | `packages/core/src/extensions/schema.ts:1328` | A stamp row bumped by triggers needs a migration (cost audit F13). An isolate-wide memo risks a stale registry right after an install |
| In an hour's first minute three reads walk a whole table: events not arriving (every subscription), offers whose plan has gone (every open offer) and the guest acceptance cleanup's check (every acceptance with no person) | `packages/core/src/subscriptions/sweep.ts:27`, `packages/core/src/subscriptions/offers.ts:1126`, `packages/core/src/operations/agreement.ts:957` | Each needs an index (a migration): `core_subscription (state, current_period_end)`, an offer index on `free_until`, and one on `core_agreement_acceptance (subscription_checkout)` |
| Each public or customer read writes a read counter row, even when the content cache answered it | `packages/core/src/pipeline.ts:2401` (`countOutsideRead`) | Changing what is counted changes ADR 0090's read accounting: a decision |
| A picture request runs `media.serve`, a full R2 read and a resize, with nothing in `caches.default`; HEAD does the same | `packages/core/src/http/media.ts:277` | Caching public pictures by id, width and content generation is a change to the media route worth its own review |
| Integration events whose dispatch throws are read and dispatched again every minute, with no attempt count or age limit | `apps/runner/src/automations/integration-events.ts:43` | Needs attempts or `next_at` columns (a migration), as the outbox has |
| A failure anywhere in an automation events batch retries all of it (`retryAll`), up to 6 times, then the dead-letter queue | `apps/runner/src/index.ts:272` | Bounded, and run creation is idempotent; dispatch is batch-shaped, so retrying one message at a time needs care |
| An extension's `ai.summarise`, `ai.extract` and `ai.classify` have no per-run cap, and each call reads the AI settings again | `apps/runner/src/executor/host.ts:263` | A cap is a contract change for extensions |
| One `run()` can send the same prompt up to 4 times (one retry, then the fallback model, which retries once), timeouts included | `packages/core/src/ai/client.ts:774` and `:885` | Needs a decision on which failures fall back |
| A routine's model turn runs before its post; a failed post makes the queue run the turn again, up to 4 times | `apps/app/src/server/assistant/routines.ts:93` | Keeping the generated message by run id first is a change to the routine delivery flow |
| `/api/v1/manifest` builds JSON Schema for every operation on every request | `packages/core/src/http/surface.ts:219` | Small; should be cached per extension version and audience |
| The control plane sends one job per instance where `sendBatch` would do, and retries permanent failures | `products/crm/apps/control/src/lifecycle.ts:230` | The control plane is not deployed yet |
| Per-row queries in a loop: the family card's shared email warning, which also reads every customer (`IN (SELECT ... FROM core_customer ...)`); the roster's offers; who still has to accept an agreement (up to 2,000 people) | `packages/core/src/operations/person-link.ts:293`, `packages/core/src/visibility/guardians.ts:207`, `packages/core/src/operations/staffing.ts:192`, `packages/core/src/operations/agreement-acceptance.ts:821` | Each is a rewrite of its query with its own tests |
| The daily storage measurement counts every row of the big tables | `packages/core/src/retention.ts:403` | Once a day; a few million rows read on a large host |
| Tables that grow and are never pruned: `core_payment_event` (each webhook's whole payload, the largest), expired sessions, verification codes and device sessions, expired preview links, `core_adjudication`, `core_import_key`, the daily usage rollups | `packages/core/src/orders/events.ts:184` and the daily maintenance in `apps/app/src/server/purge.ts` | Payment events may be needed as a record of what the provider said: how long to keep them is a decision. The rest are small additions to the daily maintenance |
| Observability is on with every invocation logged (`observability.enabled`, no `head_sampling_rate`) in every Worker | each `wrangler.jsonc` | Well inside the included 50 GB at these sizes. A large host can set `head_sampling_rate` |
| On the hosted platform every running tenant runs the minute tick | `products/crm/apps/control/src/dispatch/handler.ts:111` | Now about 41 reads and no write a tenant a minute (43 in an hour's first minute); idle Free tenants are paused |
