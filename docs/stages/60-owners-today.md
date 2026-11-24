# Stage 60: Owner's Today

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Approval
pipeline, Dashboards and views, Packs and blocks), [`CONTEXT.md`](../../CONTEXT.md) (Dashboard,
Widget, Click-through, Pending action, Change set, Notification, Notification preference, Daily
digest, Pack role, Permission grant, Restricted permission, Shift, Checklist), ADRs
[0010](../adr/0010-dashboards-sql-views.md),
[0057](../adr/0057-dashboards-params-cache-and-click-through.md),
[0167](../adr/0167-first-run-setup-wizard.md) (the organisation's time zone),
[0172](../adr/0172-notification-delivery.md), [0206](../adr/0206-daily-digest.md),
[0345](../adr/0345-approvals-by-tap-typing-or-voice.md),
[0436](../adr/0436-pack-roles-and-the-door-role.md),
[0449](../adr/0449-permissions-granted-one-by-one.md),
[0451](../adr/0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md),
[0453](../adr/0453-pack-hooks-over-the-clients-operations.md),
[0455](../adr/0455-staff-invites-and-native-sign-in-by-tokens.md),
[0553](../adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md) (a pack role's
`today` limit), [0600](../adr/0600-a-pack-role-and-its-grants-add-up.md),
[0624](../adr/0624-the-rosters-notices-uncovered-shifts-and-leaving.md),
[0625](../adr/0625-restricted-pack-permissions.md),
[0629](../adr/0629-the-rosters-screens-role-clients-with-grants-and-the-roster-import.md),
[0650](../adr/0650-checklists-templates-runs-ticks-and-a-done-run-kept-unchanged.md); stage 47
([spec](47-pack-screens.md), staff screens declared by the pack); stage 48 (My account, the
customer-side counterpart: `me.attention`); stage 52 (Finance reports, which owns every money
figure); stage 30 (Notifications, which owns push and staff quiet hours); GitHub issues
[#306](https://github.com/timoconnellaus/composable-os/issues/306) (dashboards compute "today" in
UTC), [#116](https://github.com/timoconnellaus/composable-os/issues/116) (push to client apps) and
[#215](https://github.com/timoconnellaus/composable-os/issues/215) (failed-payment emails to the
member).

Status: **spec agreed** (2026-11-24: decisions 1 to 10 decided by the coordinator under the owner's
standing rule that best-practice answers are decided, not asked; the interview was stopped with
nothing kept for the owner. Decisions 11 and 12 are the coordinator's notes on how this stage fits
others). Build may start in the order below; step 3's money items wait for stage 52, step 1 for
nothing.

## Goal

The owner opens the business's app on their phone and sees today, in the business's own time zone,
on one screen: classes and who came, money taken, members who joined and who cancelled, payments
that failed, shifts with nobody on them, checklists that were missed, and the changes waiting for
their approval, which they approve or reject right there. The few things that cannot wait reach
them as an alert without the app open. Every number comes from the host, as the signed-in person
may see it; each tap opens the rows behind it. A pack that is installed adds its own numbers to the
screen, and the app never names a pack. The same screen is in the web admin for the laptop.

## Who it is for

- **Gyms and studios first.** An owner who coaches, is rarely at a desk, and wants to know before
  the 6 am class whether the opener is on and before lunch whether yesterday's renewals went
  through. A studio manager who runs the day while the owner is away (by a grant, below).
- **Trades and services next.** The same screen with other packs installed: jobs today and who is
  on each (an unassigned job is an uncovered shift: `staffed` works the same), quotes waiting and
  invoices overdue (stages 35 and 39 declare those items when they are built), a van check not
  done (a checklist), money taken. What differs: the day is spread across places, so an item's rows
  may be grouped by place or crew; an uncovered job matters hours ahead rather than days; and money
  owed to the business matters more than to a gym. Nothing on the screen is gym-shaped: it lists
  the items the installed packs declare.

## What exists today (from the code, checked 2026-11-24)

- **Dashboards and widgets** (`packages/core/src/dashboards/`, ADRs 0010 and 0057): read-only SQL
  over `rec_*` views, named parameters, a 60-second cache (`cache.ts`), KPIs with the previous
  period, click-through to a filtered list (`click-through.ts`). Packs ship dashboards in their
  manifest (`dashboards` in `packages/sdk/src/manifest.ts`): Bookings' attendance, no-shows, late
  cancels and how full (`packs/bookings/dashboards.ts`); Memberships' active, on trial, paused,
  "Payments failing" and revenue net of tax (`packs/memberships/dashboards.ts`); others too.
  `widget.run` is a staff read (`packages/core/src/operations/dashboard.ts`). Home is the user's
  chosen dashboard (`dashboard.home`, `apps/app/src/routes/_app/index.tsx`).
- **Date windows are in UTC.** `resolveDateWindow` in `packages/core/src/dashboards/params.ts`
  ("in UTC") starts every day, week, month, quarter and year at UTC midnight, so "today" for a
  business far from UTC is wrong for part of every day. This is issue #306. The organisation's time
  zone exists (`org_timezone`, `loadGeneralSettings` in `packages/core/src/settings.ts`, ADR 0167)
  and the local-time helpers too (`packages/core/src/time/local.ts`: `localParts`,
  `wallClockToInstant`, `addLocalDays`), used by rostering, pay periods, agreements and a pack
  role's `today` limit (`packages/core/src/pack-role-today.ts`, ADR 0553).
- **Subscriptions** (`packages/core/src/subscriptions/events.ts`): a subscription in `past_due` or
  `unpaid` is failing (`FAILING`) with `failing_since`. Staff are told of a mismatch or a change made
  at the provider (`tellStaff`), but **not when a renewal fails**; the member is not told either
  (issue #215, now stage 30's).
- **The approval queue** (`packages/core/src/operations/approval.ts`, `approvals/`):
  `approval.list`, `approval.get`, `approval.approve`, `approval.reject`; the host's plain
  description of each action (`approvals/describe.ts`); approval by tap with a second step for
  destructive and outbound actions (ADR 0345). How a decision was made is stored as
  `decided_via` (`tap`, `typed`, `spoken`: `ApprovalVia` in `packages/db/src/schema.ts`). The
  approver's rules are the host's: a refund needs `orders:refund`, a publish `records:publish`, a
  roster change someone who rosters (`assertRosterApprover`, `staffing/approvals.ts`), an extension
  or schema change `extensions:manage`.
- **Staff notices** (`packages/core/src/notifications/`): a fixed list of types
  (`NOTIFICATION_TYPES` in `types.ts`), routed to email or Slack per a person's preferences
  (`preferences.ts`, `core_notification_preference`) by cos-runner's minute cron (ADR 0172); the
  "Approvals waiting" notice (`approval.pending`) and its escalation; the daily digest (ADR 0206).
  The roster's notices (ADR 0624, `staffing/changes.ts`, `staffing/due.ts`) are `system.message`:
  uncovered shifts in a 14-day window (`DEFAULT_UNCOVERED_DAYS`), daily and at once. A missed
  checklist run is told to the rosterers (ADR 0650).
- **Rostering and checklists**: `staffing.uncovered` (a rosterer's read, `mayRoster` in
  `staffing/rosterers.ts`); checklist runs are read only by the run's person and people who roster,
  never by other staff or an AI, and are **in no `rec_*` view** (`checklists/index.ts`).
- **Native staff** (ADRs 0451, 0455, 0629): staff sign in in the company's app with a **role
  client** per pack role (`mobile.roles` in `packages/product/src/index.ts`, generated by
  `packages/client-gen` from `packages/core/api/v1/roles.json`). "The whole staff client is never
  written into a client repo." An admin holds no pack role, so **an admin has nothing typed to call
  in the app**.
- **Pack screens** (stage 47, agreed, build in PR #303): a shipped pack declares staff screens;
  `screens.mine` lists what the viewer may open; the web admin builds them in.
- **Push**: nothing. No device token, no push channel (issue #116; stage 30).

## Decided by the coordinator (2026-11-24)

The draft's questions, each decided at its recommendation under the owner's standing rule. The
owner may override any of them.

| # | Decision |
| --- | --- |
| 1 | **The draft's picture of the owner's morning stands** (what they look at first, which numbers matter): to be checked with the business during setup, not asked now |
| 2 | **Both**: the business's own app on the phone and the web admin in a browser, sharing logic, not screens |
| 3 | **Money on this screen** (takings and failed payments) is for **owners and admins, plus people chosen one by one** (a manager). Everyone else sees the numbers their own work allows, such as classes and who came |
| 4 | **Four kinds alert straight away**: a member's payment failed; a shift or class with nobody on it, starting soon; a checklist was missed; something is waiting for your approval. A cancelled membership or class is shown on the screen, not alerted |
| 5 | **An empty shift alerts 24 hours before it starts.** The screen still lists every empty shift in the roster's window (14 days) |
| 6 | **Alerts wait overnight, except an empty shift starting before the morning** |
| 7 | **"Takings today" is money received today, including tax, less refunds made today** (closest to what the payment provider shows and what lands in the bank) |
| 8 | **From the phone the owner may approve everything except changes to how the system is set up** (an extension, new fields): those are listed and say "review on a computer" |
| 9 | **An alert never names a member or an amount** (a lock screen is not private); names and amounts show after sign-in |
| 10 | **Nothing beyond the listed items for now**; anything else the business wants is checked during setup and added as a pack item later |

### Coordinator's notes (2026-11-24)

| # | Decision | Why |
| --- | --- | --- |
| 11 | **Every money figure comes from Finance reports (stage 52), never a second calculation.** Takings is stage 52's Sales "net" (gross received less refunded) over today's range; the gate is stage 52's `finance:read`, not a permission of this stage's | Two calculations of "sales" drift apart; one permission for "may see the business's money" is what decision 3 and stage 52's own decision both describe |
| 12 | **A day is the business's day. Issue #306 is fixed by or before this stage**: step 1 below fixes it, unless another stage has closed it first, and this stage is not done while #306 is open | "Today" at 07:30 in a zone ten hours ahead of UTC is otherwise yesterday's numbers |

## The design in one page

- **One host operation answers "today" for the caller.** `today.get` returns the items the caller
  may see, each a number with its label, a comparison (the same time yesterday or last week),
  whether it needs attention, and what tapping it opens. The app renders the answer as cards and
  names no pack, no object and no rule.
- **Items come from two places, both in the host.**
  - **Host items**, computed by the host for any product: takings and payments failing (through
    stage 52's figures), changes waiting for you (the approval queue, only what this person may
    approve), unread notices, and, where an installed pack declares the behaviours, shifts with
    nobody on them (`staffed`) and checklists missed or still open (`checklists`). These read host
    data no `rec_*` view shows (or must not show), so they are platform code, not pack SQL.
  - **Pack items**, declared by a shipped pack in a new manifest key `todayItems`: a label,
    read-only SQL over `rec_*` views (the widget rules), a format, when it needs attention, an
    optional drill-in list, the order it sits in, and the tools a viewer must be able to call to
    see it (as stage 47's `opens`). Bookings declares classes today, booked, came so far,
    no-shows; Memberships new, cancelled and trials started today; Ticketing tickets sold and
    checked in today; Courses enrolments today.
- **"Today" is the business's day.** The host resolves today, yesterday and the same day last week
  in the organisation's time zone and binds them as parameters (`:today_from`, `:today_to`,
  `:now`). The same function fixes every dashboard's presets (#306) and is the one stage 52 uses
  for its days.
- **Approve where you look.** The screen lists what is waiting for this person, each with the
  host's description and preview; approve or reject one at a time, with the second step where the
  host asks for it. Setup changes are listed and say "review on a computer".
- **Alerts** are host notices of one new type, `today.alert`, keyed per item: a failed payment, an
  empty shift starting within 24 hours, a missed checklist; changes waiting keep the existing
  `approval.pending` notice. Each is told **once per item per person per local day** (a ledger),
  never carries a name or an amount, waits overnight (except an empty shift before morning) and
  routes by the person's preferences: in-app, email or Slack now, **push when stage 30 is built**.
- **A new native surface: the owner's client.** `product.ts` gains `mobile.owner: true`; `cos client
  generate` writes `roles/owner.ts` holding only the operations this screen needs. Any staff account
  may sign in with it; the host decides every call, so a coach who signs in with it sees only what
  their rights allow.
- **Web too.** Headless hooks in `@composable-os/client` drive a native block (`owner-today`) and a
  web Today in the admin, which a person may choose as Home.

### What was weighed and rejected

- **A "Today" dashboard of widgets.** Approvals, checklists and uncovered shifts are not in `rec_*`
  views, checklists must never be read by an AI, and widget SQL can be run by an MCP client. A
  dashboard also has no "needs attention", no per-viewer gate and no alerts.
- **Computing takings here from `rec_order`.** A second definition of sales beside stage 52's
  (decision 11).
- **The app naming each pack's numbers** (a gym app calling Bookings' and Memberships' tools).
  Every client app would hard-code its packs, a new pack would need an app release, and who may see
  revenue would be decided in a client (ADR 0401).
- **Packs declaring their own alerts** (thresholds on a number). Decision 4 names four alerts, all
  host events; a threshold rule per pack is a second alert system to tune. Later, if asked.
- **The full staff client in the company's app.** ADR 0451 refuses it (every staff operation's
  name in a public bundle). The owner's client is a short, named list.
- **Only the web admin on a phone.** Phone web push needs the page added to the home screen, staff
  already sign in in the company's app, and decision 2 says both.
- **A platform-made staff app in the app stores.** A product of its own (store accounts, review,
  one brand for all businesses).
- **Growing the daily digest into this.** The digest is a once-a-day email; this is a live screen.
  The digest may later link to it.

## Platform work and pack work

| Piece | Kind | Notes |
| --- | --- | --- |
| Day windows in the business's zone (`:today_from`, `:today_to`, presets) | **Platform** | `dashboards/params.ts`, on `time/local.ts`; fixes #306 for every dashboard; ADR 0871 |
| `todayItems` manifest key, contract checks, `cos ext check` | **Platform** (SDK) | shipped packs only; a runtime extension declaring it is refused, as `screens` is |
| `today.get`, `today.rows`; host items | **Platform** (core) | new `packages/core/src/today/`; reads approvals, staffing, checklists, notifications, and stage 52's figures |
| `today.alert` type, the ledger, quiet hours, per-item preferences | **Platform** (core, runner) | one migration; `notifications/types.ts`, `preferences.ts` |
| A host event when a renewal starts failing | **Platform** | `subscriptions/events.ts`; the member's message is stage 30's |
| The owner's client (`mobile.owner`) | **Platform** (product, client-gen) | amends ADR 0451 |
| Headless `today` and approvals hooks | **Platform** (`packages/client`) | shared by web and native |
| Web Today in the admin; Today as a Home choice | **Platform** (`apps/app`) | beside stage 47's navigation |
| Native blocks `owner-today` and `owner-approvals` | **Base-layer blocks** | native skin, copied with `cos add` |
| Bookings, Memberships, Ticketing, Courses items | **Pack** | `todayItems` in each `packs/<id>/index.ts`, SQL over their own views |
| Rostering's and checklists' items | **Platform** (host items) | the behaviours are the host's; Rostering declares nothing new |
| Push delivery to phones | **Stage 30** | device registration, the push gatekeeper, staff quiet hours |

## The model

### Words

- **Today** (the screen and `today.get`): the items one person may see for the business's current
  local day.
- **Item**: one number on it, with a key (`host.takings`, `bookings.cameToday`), a label, a value,
  a comparison, a state (`ok` or `attention`) and a target.
- **Target**: what a tap opens: a drill-in list (`today.rows`), the approvals list, the notice
  inbox, or on the web a pack screen (stage 47).
- **Alert**: a `today.alert` notice for one item, told once per item per person per local day.

### The business's day (step 1, fixes #306)

- One function, `localDay(now, zone, offsetDays)`, returns `[from, to)` as instants for a local
  date, built on `time/local.ts` (so a 23- or 25-hour day at a clock change is right).
- `resolveDateWindow` takes the organisation's zone and resolves every preset (today, yesterday,
  this week, this month, this quarter, this year, a `{ from, to }` day range) in it. Weeks start on
  Monday, as `isoWeekday` does.
- Dashboards' cache keys include the zone, so a change of zone is never served from cache.
- Every dashboard's figures shift on the day this ships: the release notes say so.
- Stage 52 uses the same function for its periods and its "by day" rows.

### The `todayItems` declaration (shipped packs)

Not `today`: that key already names a pack role's limit to today (ADR 0553), and Programs has a
`today` tool.

```ts
todayItems: {
  cameToday: {
    label: "Came today",
    order: 20,
    format: "count",                      // count | percent (money is the host's: decision 11)
    sql: "SELECT count(*) AS value FROM rec_x_bookings_booking b JOIN rec_x_bookings_class c ON c.id = b.class WHERE c.starts_at >= :today_from AND c.starts_at < :today_to AND b.state = 'attended'",
    compare: "yesterday",                 // yesterday | lastWeek | none
    attention: undefined,                 // or { above: 0 } / { below: 5 }
    rows: { sql: "...", label: "member", record: { object: "person", id: "person_id" } },
    opens: ["roster"],                    // this pack's tools: all callable by the viewer
    web: { screen: "desk" },              // optional: a stage 47 screen of this pack
  },
}
```

- The SQL follows the widget rules (one `SELECT`/`WITH`, `rec_*` only, bound parameters, row and
  time limits, `validateReadOnlySql`) and returns one `value`.
- **No money format for packs.** Money on this screen is the host's, through stage 52. A pack that
  wants a money number on Today asks for it to become a stage 52 figure (a later change), not SQL.
- `rows` returns at most 50 rows with a display column and a record to open; nothing private (no
  notes, health answers, pay or leave). The contract refuses a `rows` SQL over a view the pack marks
  private.
- `opens` is required and names the pack's own staff tools; a tool open to customers or the public
  cannot be the only gate.
- At most 8 items per pack; keys camelCase; a runtime extension declaring `todayItems` is refused
  by `cos ext check` and at install, and the key is ignored at run time.

### Host items

| Key | Value | Who sees it | Attention |
| --- | --- | --- | --- |
| `host.takings` | stage 52's Sales net for today (received less refunded), with the number of payments; compared with the same time last week | `finance:read` (stage 52: admins, and others by grant) | never |
| `host.paymentsFailing` | subscriptions failing now, and how many began failing today (stage 52's Money owed rule for failing renewals) | `finance:read` | above 0 newly failed |
| `host.approvals` | pending actions this person may approve | the approver rules, per action | above 0 |
| `host.uncovered` | live shifts with nobody on them, in the next 24 hours and in the roster's window | someone who rosters (`mayRoster`) | above 0 within 24 hours |
| `host.checklists` | runs missed today, and runs open past their end | someone who rosters | above 0 missed |
| `host.notices` | unread notices | everyone | never |

- `host.uncovered` and `host.checklists` appear only when an installed pack declares `staffed` or
  `checklists`; they read through the same functions as `staffing.uncovered` and `checklist.runs`,
  never through a `rec_*` view.
- The card shows a count for payments failing, never a sum; the rows (names and the amount due)
  come from stage 52's Money owed for those subscriptions.
- `finance:read` guards this screen's money. Any staff member with `records:read` can still read
  orders and the Memberships dashboard's revenue today: closing that wider read is stage 52's and
  stage 14's question, not this stage's.

### Operations

| Operation | Audience | Who may | Risk | What |
| --- | --- | --- | --- | --- |
| `today.get` | staff | any signed-in staff account (pack roles too: the reach rule gains it) | read | `{ day, zone, items[] }`, each item gated, in order, attention first |
| `today.rows` | staff | as the item's gate | read | one item's drill-in rows, at most 50 |
| `today.alerts` | staff | the person themselves | read | which alerts they receive, on which channels, and their overnight hours |
| `today.setAlerts` | staff | the person themselves, `actors: ["human"]` | write | turn an alert on or off and set overnight hours for themselves; never someone else's |
| `approval.list/get/approve/reject` | staff | unchanged | unchanged | reached from the screen |
| `notification.list/unreadCount/markRead` | staff | unchanged | unchanged | the inbox |

- Nothing is opened to `customer` or `public`.
- A non-human caller of `today.get` gets the pack items and the money items its user's rights
  allow (stage 52 decided the assistant may read figures), never checklists or approvals.
- Cost: `today.get` runs each visible item's query once, in parallel, cached 60 seconds per
  business, item, parameters and the viewer's gate set (so a manager never gets the owner's cached
  money), with a bounded statement count (a test). No query per row.

### Approving from the phone

- Each waiting action shows the host's description and preview (`approvals/describe.ts`), Approve
  and Reject, and the second step's confirm where the host asks for it (ADR 0345).
- An action that needs `extensions:manage` (an extension, a schema change) is listed with "review
  on a computer"; `approval.approve` refuses it from the owner's client (the device session's
  client is known to the host), so the rule holds in the host, not only in the block.
- The decision is stored as today (`decided_via: "tap"`); the audit entry also records the client
  it came from (the owner's client), from the device session. No new `ApprovalVia` value.

### Alerts

- **The four** (decision 4), each a host event, told as it happens and then never again that day
  for that item and person:
  - **A payment failed**: the subscription's webhook sets `failing_since` (a new host event in
    `subscriptions/events.ts`). To `finance:read` holders. "2 payments failed today".
  - **An empty shift soon**: a live shift with nobody on it that starts within 24 hours, from the
    staffing changes and the minute cron. To the rosterers. For such a shift this alert takes the
    place of the roster's existing at-once `system.message`, so nobody is told twice; the daily
    14-day list is unchanged.
  - **A checklist missed**: the existing notice of ADR 0650, re-typed as `today.alert`.
  - **Changes waiting**: the existing `approval.pending`, unchanged, with its escalation.
- **The ledger**: `core_today_alert (user_id, item_key, local_day)`, a primary key that makes
  "once" hold under retries. Erased with the user.
- **Wording**: the item's label and a count. No member's name, amount, note or health detail (a
  test over every alert kind). The app shows the rest after sign-in.
- **Overnight** (decision 6): each person's overnight hours, default 21:00 to 07:00 in the
  business's zone. An alert in those hours is written in-app at once (the inbox does not buzz) and
  held on every other channel until they end; an empty shift starting before they end is sent at
  once. When stage 30 is built, these hours are stage 30's staff quiet hours (it owns the setting),
  and the empty-shift alert is its urgent kind.
- **Channels**: in-app always; email or Slack per preference now; push once stage 30 adds it.
  `today.alert` is one notification type whose preference is kept per item key (on by default for
  the four, for the people who receive them).

### Screens

- **Native (the company's app, base-layer block `owner-today`)**: the day's date and zone; cards
  in the host's order, attention first; pull to refresh; a card opens its rows (label, a secondary
  line, tap to open the record's native screen if the app has one); "Waiting for you" opens
  `owner-approvals`. Signed in through the staff session (ADR 0455). Query data for money and rows
  `gcTime: 0`, cleared when the app goes to the background (ADR 0629's pattern).
- **Web (the admin)**: the same cards as a page, `/today`, which a person may choose as Home beside
  the dashboards; a card opens its pack screen (stage 47) when it declares one, else its rows.
  Works at phone width.
- **Customer side**: nothing. What a customer needs to act on is stage 48's `me.attention`.

### The owner's client

- `mobile.owner: true` in `product.ts`; `cos client generate` writes `roles/owner.ts` holding only
  `today.get`, `today.rows`, `today.alerts`, `today.setAlerts`, the four approval operations, the
  notification inbox's three, `user.me`, and (once stage 30 exists) its device registration. Any
  other staff operation is a type error.
- Any staff account may sign in with it; the host decides every call. A coach sees the items their
  role reaches and nothing else.
- This amends ADR 0451 ("the whole staff client is never written into a client repo" stands; a
  second short list is added).

### What an AI may do

- Read pack items and money items through `today.get` as its user, within that user's rights, so
  "how did today go?" can be answered. Nothing of checklists or approvals through this operation.
- Never approve or reject (`approval.approve` is `actors: ["human"]`, unchanged), change anyone's
  alerts, declare items or send an alert.

### Privacy, audit and erase

- Every number is computed for the viewer by the host; the client keeps nothing longer than shown.
- Drill-in rows carry names and record ids only, never notes, health answers, pay or leave.
- `today.get` reads by a person are not audited one by one; `today.rows` for money items is audited
  (who looked at whose failed payment), naming the item, never a figure.
- Erase: a person's ledger rows and alert preferences go with them; records erased elsewhere drop
  out of every item.
- What the business tells its staff about who sees their shifts and checklists is for the business
  to confirm with its accountant or lawyer.

## Out of scope

- Push delivery itself (stage 30), and any alert by text message.
- Acting on an item other than approving: offering an empty shift, refunding, retrying a payment
  (pack screens and existing tools).
- Charts, trends and date ranges on the phone: the dashboards and stage 52's reports.
- Alerts declared by packs (thresholds), and items for runtime extensions.
- Money figures other than stage 52's.
- A platform-made staff app in the stores.
- The member's failed-payment message (stage 30, issue #215).
- Customising the order of cards or hiding items per business.
- Stock running low (stage 37) and the till's takings by till (the point of sale): later items;
  the till's sales are already in takings through stage 52 once ADR 0694's step is built.

## Acceptance criteria

1. With Bookings, Memberships and Rostering installed and the business in a zone ten hours ahead
   of UTC, at 07:30 local an admin's `today.get` counts the classes starting since local midnight;
   a dashboard widget with the `today` preset counts the same; a day across a clock change is 23 or
   25 hours. Issue #306 is closed.
2. An admin signed in to the company's app with the owner's client sees takings, payments failing,
   classes today, came so far, new and cancelled members, uncovered shifts, missed checklists and
   changes waiting; the app's source names no pack and no object.
3. `host.takings` equals stage 52's Sales net for the same local day, to the minor unit, with a
   refund today of an older sale subtracted; no code in `packages/core/src/today/` sums orders or
   payments itself.
4. A pack not installed or disabled contributes no item, by `today.get` or `today.rows`.
5. A coach (`bookings.coach`) signed in with the owner's client gets only the items their role's
   tools allow and no money, approvals or checklists; a member granted `finance:read` sees money;
   with the grant removed, the next `today.get` has no money item (and the cache does not serve
   it).
6. Approving a refund from the phone works only for a person with `orders:refund` and asks for the
   second step; an extension or schema action shows "review on a computer" and is refused by the
   host when approved through the owner's client.
7. A renewal that fails sends one `today.alert` to each `finance:read` holder who has it on, once
   per local day however many fail; the next day's failure sends again.
8. A shift left with nobody on it starting within 24 hours alerts the rosterers once, and they get
   no second `system.message` for it; one further out alerts nobody.
9. At 23:00 local a failed payment is in the inbox and held from email and Slack until 07:00; an
   empty shift starting at 06:00 is sent at 23:00.
10. No alert's title or body contains a person's name, an amount or a note (a test over every alert
    kind).
11. An assistant's `today.get` has no checklist or approval items; it can never approve.
12. A runtime extension declaring `todayItems` fails `cos ext check` and install; a pack item whose
    SQL reads a non-`rec_*` table, writes, or returns no `value` fails the contract, and so does a
    pack item with a money format.
13. `today.get` makes a bounded number of statements whatever the data (a statement-count test), and
    a second call within 60 seconds hits the cache for the same viewer and not for another.
14. `cos client generate` with `mobile.owner: true` writes `roles/owner.ts` holding only the listed
    operations; `record.list` is a type error.
15. E2E: one journey on the web Today (an admin opens Today, approves a waiting change, sees the
    count drop). The native block is checked on a real phone before the site claims it.
16. The site: `SITE.md` and the gym page say what is built (and that push waits for stage 30).

## Dependencies

- **Built**: dashboards (stage 4), approvals (stage 2), notifications and the digest, orders and
  subscriptions (stages 25 and 32), Bookings, Memberships, Rostering and checklists (stage 45),
  role clients with grants (ADR 0629), native staff sign-in (ADR 0455).
- **Agreed, not built**: stage 47, pack screens (only for the web Today's links to pack screens;
  without it a web card opens its rows). Stage 52, Finance reports: `host.takings`,
  `host.paymentsFailing` and `finance:read` need its Sales and Money owed functions; until it
  merges, step 3 ships the other host items and the money items follow.
- **Stage 30, Notifications**: push and staff quiet hours. This stage ships without it; push for
  these alerts is stage 30's acceptance.
- **Later**: stages 35 (Invoices) and 39 (Jobs) declare the trades' items.

## Migrations and numbers

Block **BV** in [`parallel-work.md`](../parallel-work.md): migrations 1310–1329, ADRs 0870–0879.

- Migration **1310**: `core_today_alert` (the ledger) and the per-item alert preferences and
  overnight hours (a column on `core_notification_preference` or a small table, as the build
  finds cleanest). No `x_*` table is touched.
- No new permission: money uses stage 52's `finance:read`.

ADRs the build writes:

1. **0870**: Today's items, the `todayItems` declaration and `today.get` (amends ADRs 0010 and
   0057 for shipped packs).
2. **0871**: Day windows in the business's zone (amends ADR 0057; closes #306). Left free if
   another stage fixes #306 first and writes its own ADR.
3. **0872**: The owner's client (amends ADRs 0451 and 0455).
4. **0873**: Today's alerts: the type keyed per item, the ledger, overnight hours, the failed
   renewal event (amends ADRs 0172, 0624 and 0650).

## Suggested build order

| Step | What | Files or areas | Beside |
| --- | --- | --- | --- |
| 1 | Day windows in the business's zone (#306) | `packages/core/src/dashboards/params.ts`, `cache.ts`, `time/local.ts`, dashboard tests | anything outside `dashboards/`; stage 52 should use it, so land it first or coordinate |
| 2 | `todayItems` declaration and contract checks | `packages/sdk/src/manifest.ts`, the contract, `packages/extension-check` | collides with stage 47 step 1 (same files, PR #303): after it merges |
| 3 | `today.get`, `today.rows`, host items; the pack-role reach | new `packages/core/src/today/`, `operations/today.ts`, the registry, `pack-roles.ts` | collides on `pack-roles.ts` with stage 47 and stage 38 step 2; money items after stage 52 merges |
| 4 | Packs declare items | `packs/bookings`, `memberships`, `ticketing`, `courses` `index.ts` and tests | collides with stage 47 step 4 (`packs/*/index.ts`) |
| 5 | Alerts: type, ledger migration, host events, overnight hours, preferences | `notifications/types.ts`, `preferences.ts`, `subscriptions/events.ts`, `staffing/changes.ts`, `checklists/`, cos-runner's cron, `packages/db/migrations` | collides with stage 30 (notifications) and anything in `subscriptions/` or `staffing/` |
| 6 | The owner's client and the headless hooks | `packages/product`, `packages/client-gen`, `packages/core/api/v1/roles.json`, `packages/client`, `packages/create-composable-os` | collides with any role-client or client-gen work (stage 48's customer client changes, stage 30's device registration) |
| 7 | Web Today and the Home choice | `apps/app` (a route, `dashboard.home`, components) | after stage 47 steps 2 and 3 (`_app.tsx`, sidebar) |
| 8 | Native blocks `owner-today`, `owner-approvals` | base-layer native blocks, `scripts/check-blocks.mjs` | beside 7; needs 6 |

Steps 1, 2 (after PR #303) and 6 can start at once in three sessions; 3 needs 2; 4 and 5 need 3;
7 and 8 need 3 and 6.

## Size

**Medium to large.** Eight build steps of platform work, none very deep, plus four small pack
declarations. Up to three sessions at once.

## Decided by this spec, open to override

| Choice | Decision |
| --- | --- |
| Where it lives | The company's app (the owner's client) and the web admin, sharing hooks |
| Who declares items | Shipped packs only, by `todayItems`; the app names no pack |
| The manifest key's name | `todayItems`, because `today` already names a pack role's limit (ADR 0553) |
| Rostering's and checklists' numbers | The host's, not Rostering's SQL |
| Money | Only the host's items, from stage 52, gated by `finance:read`; packs declare no money items |
| Payments failing on the card | A count, never a sum; amounts only in the rows after sign-in |
| Alerts | The four of decision 4, all host events; packs declare none in this stage |
| Once | Once per item, per person, per local day |
| An empty shift's alert | Takes the place of the roster's at-once notice for that shift; the daily list is unchanged |
| Overnight hours | Per person, default 21:00 to 07:00 in the business's zone; in-app at once, other channels held; stage 30's setting once built |
| Who gets which alert | Failed payments: `finance:read` holders; empty shifts and missed checklists: the rosterers; approvals: as today |
| Setup changes from the phone | Refused by the host through the owner's client, not only hidden |
| How a phone approval is recorded | `decided_via: "tap"` as today, the client in the audit entry |
| The owner's client | A fixed, short list of operations, not a pack role |
| Comparison | Takings against the same time last week; counts against yesterday unless the pack says otherwise |

## Questions for the owner

None open. All ten of the draft's questions were decided by the coordinator at their
recommendation (decisions 1 to 10); the owner may override any of them. Decisions 1 and 10 are to
be checked with the business during setup.

## Risks

- **Security**: the owner's client puts a few staff operation names in a public app bundle (ADR
  0451's concern); the list is short and the host decides every call. A stolen unlocked phone can
  approve: approvals stay behind the staff session's rotation and the second step.
- **Privacy**: drill-in rows name members; the cache is keyed by the viewer's gates; lock-screen
  wording is the main leak and is tested.
- **Money**: takings must match what the owner sees from the payment provider closely enough to be
  trusted; taking stage 52's figure keeps one definition. Nothing on this screen charges, refunds or
  retries a card.
- **Time zones**: fixing #306 changes every dashboard's numbers on the day it ships; say so in the
  release notes.
- **Needs a real device and a real account**: the native screen on phones, the staff sign-in
  there, failed renewals from the payment provider's test mode, and (with stage 30) push on both
  phone platforms.

## Built

- **Step 2** (branch `feat/stage-60-today-items`): `todayItems` in the manifest (`TodayItemSpec`,
  `TODAY_ITEM_FORMATS`, `TODAY_ITEM_COMPARES`, `TODAY_ITEM_PARAMS` in `packages/sdk/src/contract.ts`;
  `todayItemManifestSchema`, `todayItemIssues` and `toManifest` in `manifest.ts`): at most 8, keys
  camelCase, `count` or `percent` (a money format refused with the reason), the gate of the pack's
  own tools as a screen's, rows opening its own object or a base one, `web.screen` one of its
  screens. The SQL check is the host's, in `checkManifest` (`todayItemSqlIssues` in
  `packages/core/src/today/declaration.ts`): the widget guards with only `:today_from`, `:today_to`
  and `:now`, the pack's own views counted as present, and exactly `value` (or the rows' declared
  columns) returned. A runtime extension declaring items is refused (`outside_audience`) by its check
  and at install. [ADR 0870](../adr/0870-todays-items-and-the-today-items-declaration.md) (amends
  0010 and 0057). No migration. Criterion 12 is met; nothing yet reads the items (step 3), and no
  pack declares any (step 4).
