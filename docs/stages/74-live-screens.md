# Stage 74: Live screens

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Packs
and blocks; "What is not decided", which lists realtime), [`CONTEXT.md`](../../CONTEXT.md)
(Screen, Block, Pack role), ADRs [0950](../adr/0950-two-targets-cloudflare-and-aws.md),
[0130](../adr/0130-automation-runtime.md), [0171](../adr/0171-automation-events-outbox.md),
[0611](../adr/0611-one-host-a-database-per-client.md) and
[0660](../adr/0660-pack-screens-in-the-admin.md); stages [47](47-pack-screens.md),
[66](66-one-host-many-clients.md) and [68](68-host-on-node.md); code:
`apps/app/src/lib/query.ts`, `apps/app/src/components/screens/screens.tsx`,
`apps/app/src/components/assistant/thread-provider.tsx`, `packages/client/src/hooks.ts`,
`packages/core/src/pipeline.ts` (the post-commit section), `packages/core/src/operation.ts`
(`afterCommit`, `recordChange`), `packages/sdk/src/contract.ts` (`ScreenSpec`),
`packs/bookings/index.ts` (`screens`).

Status: **spec proposed (2026-11-26)**. Not built until its interview settles the questions at its
end.

## Goal

A screen that several people watch at once shows a change within a couple of seconds of someone
else making it, without anyone pressing refresh. The front desk sees a booking the moment a
member makes it on their phone. It is built into the host, works the same on Cloudflare and on
AWS, and adds no sync product. Its first steps need no AWS stage.

## What exists today (from the code)

- **The host has no live reads.** The staff app reads through TanStack Query: `useOp` in
  `apps/app/src/lib/query.ts`, keyed `["op", name, input]`. The defaults are a stale time of 15
  seconds and no refetch on window focus. A screen shows what it loaded until the viewer
  navigates or writes.
- **A write refreshes only the browser that made it.** `useOpMutation` invalidates by operation
  name prefix (`invalidateOps(client, "person.")`). Another person's browser hears nothing.
- **A few places poll:** the desk signing session every 2 seconds
  (`components/agreements/sign-at-desk.tsx`), an agent's status every 10 seconds
  (`assistant/cards/agents.tsx`), approvals every 60 seconds (`approvals/hooks.ts`).
- **One live channel exists,** and it is the assistant's own: a WebSocket to the person's thread
  (`thread-provider.tsx`). It carries thread frames only.
- **`packages/client`** (the typed client for web and mobile apps) has no subscription. Its hook
  types carry an optional `refetch` and nothing else.
- **Pack screens** are declared in a shipped pack's manifest (`ScreenSpec`, stage 47, ADR 0660):
  a label, a block, the tools that gate it (`opens`). `screens.tsx` loads the block and gives it
  the pack's hooks over the app's `useQuery` and `useMutation`. Bookings declares Front desk
  and Class list; Rostering, Memberships, Programs, Courses and Daily checks declare others.
- **The pipeline knows what changed, after the commit.** It collects the record
  changes of a write (`changes`), puts automation events in the outbox in the same batch, and
  after the commit calls `deliverOutbox` (`packages/core/src/pipeline.ts`). That post-commit
  point is where a "this changed" notice belongs.
- **`afterCommit` is not a hook.** In `operation.ts` it wraps a handler's return value so the
  output is read after the commit. It does not run arbitrary work.
- **The outbox** (ADR 0171) exists only where an event sink is configured, skips test mode, and
  feeds automations at least once.
- `docs/architecture.md` lists realtime under "What is not decided".

## Decided by the owner (2026-11-26)

1. Live updates only on screens several people watch at once, such as a front desk's day view.
2. Built into the host, for both targets. No sync product.
3. Two targets: Cloudflare as it is, and AWS on Node with Postgres.

## The design in one page

```
 someone books ─► an operation ─► commit ─► publish "bookings.booking changed" (no record data)
                                                │
                    Cloudflare: LiveTopics, one Durable Object per client, WebSockets
                    AWS: NOTIFY in the write's transaction; each Node task LISTENs
                                                │
 front desk ◄── "changed: bookings.booking" ────┘
      └─► refetches through the ordinary operations ─► permission and visibility as always
```

- **A topic** is the name of a kind of record: `bookings.booking`, `person`. Nothing narrower
  in this stage.
- **A notice** says a topic changed. It carries the topic and nothing else: no id, no field, no
  actor.
- **The screen refetches.** Everything it shows still comes from the operations it already
  calls. A viewer who may not see a record learns only that something of that kind changed.

## The model

### Publishing

After a write commits, the pipeline publishes one notice per distinct object among the write's
record changes, through a new optional port on the operation context (`live`), beside `events`.
A read, a refusal, a simulation and test mode publish nothing. Writes made by the runner
(automations, schedules) publish the same way, since they pass through the same pipeline.

Publishing is best effort and never fails the write. It does not go through the outbox: the
outbox is built for automations that must run, and a lost notice here costs one stale screen
until the next notice or the safety refetch below.

### Subscribing

The browser opens one WebSocket per tab to `/api/live` and sends the topics it wants. The host
checks the staff session on upgrade and, for each subscription, that the viewer may open the
screen that asked (its `opens` and `writes` gate, the check `screens.tsx` already relies on).
Only staff may subscribe in this stage.

### What a pack declares

`ScreenSpec` gains `live`: the objects whose changes refresh the screen, each one of the pack's
own objects, `person` or `organisation`.

```ts
desk: { label: "Front desk", block: "bookings-desk", export: "FrontDesk",
        opens: ["findPeople", "bookFor"], live: ["bookings.booking", "bookings.class"] },
```

`cos ext check` refuses a `live` entry that is not an object the pack may read. The block needs
no change: the host subscribes while the screen is mounted and visible, and on a notice
invalidates that pack's queries, so the block's own hooks refetch. A host page uses the same
hook directly with a list of topics.

This is a change to the SDK contract, so `SDK_HASH` and the stable loader ids change once.

### In the browser

- **At most one refetch a second per screen,** with a short random delay, so twenty desks do not
  all ask in the same instant after a busy write.
- **Hidden tabs do not refetch.** They refetch once when shown again.
- **On reconnect, refetch once,** since notices sent while the socket was down are gone.
- **While the socket cannot connect,** a live screen polls every 30 seconds. It never shows an
  error for the live channel alone.
- **A safety refetch every 2 minutes** while visible covers a lost notice.

### The transport on Cloudflare

`LiveTopics`, a Durable Object class in the app Worker, one object per client (named for the
client under stage 66; one object in a single-client deployment). It accepts hibernatable
WebSockets tagged by topic, so an idle desk costs nothing. Publishing is one call from the app
or the runner to that object, which sends the notice to the sockets with the tag. It stores
nothing.

### The transport on AWS

The write's transaction issues `NOTIFY` with the client and the topic, which Postgres delivers
only if the transaction commits. Each Node task holds one listening connection and forwards
notices to the WebSockets it holds. No table, no queue. If stage 68's database access goes
through a pooler that cannot carry `LISTEN`, the listener uses a direct connection; step 4
checks.

### Server-sent events, considered

Simpler in the browser, but a Durable Object holding an open event stream cannot hibernate, so
every idle desk would be billed as running. WebSockets are used on both targets so that there
is one browser client.

### The first screens

Bookings' Front desk and Class list. They are the screens where a member's action elsewhere (a
booking, a cancellation, a check-in) changes what staff are looking at.

## Out of scope

- Customers' and the public's screens (a timetable's spots left). Question 2.
- `packages/client` and native apps. They follow when a customer screen needs it.
- Topics narrower than an object (one day, one location, one record).
- Sending record data, presence ("who else is looking") or edits in progress.
- Replacing the assistant's socket, or the polls listed above.
- Offline use.

## Acceptance criteria

1. With two staff browsers on Front desk, a booking made in one, or by a customer through the
   API, appears in the other within 2 seconds, with no reload.
2. A notice carries only a topic. A test reads every frame sent during a write and finds no id
   or field value.
3. A viewer without the screen's gate cannot subscribe to its topics; a customer session and an
   unsigned request are refused at upgrade.
4. With two clients on one host, a write for one client sends nothing to the other's sockets.
5. A refused write, a read, a simulated call and a test-mode call publish nothing.
6. With the socket blocked, the screen still loads and refreshes by polling.
7. After a dropped connection the screen reconnects and refetches once.
8. Fifty notices in a second cause at most one refetch per screen in that second.
9. A failing publish does not fail or slow the write beyond a set bound (measured in step 1).
10. On Cloudflare, an idle connected desk keeps no Durable Object awake.
11. On AWS, criteria 1 to 8 pass with two Node tasks, the writer and the viewer on different
    tasks.
12. `cos ext check` refuses a `live` entry naming an object outside the pack's reach.
13. `docs/architecture.md` no longer lists realtime as undecided, and the pack-writing skill
    says how to declare a live screen.

## Dependencies

Stage 47 (pack screens), as built. Stage 66 for the client in the object's name when it lands;
a single-client deployment needs nothing. Stage 68 for step 4 only.

## Migrations and numbers

No database migration is expected. The Durable Object class needs a Worker migration entry in
`apps/app/wrangler.jsonc`. The first build step claims an ADR number in
[`docs/parallel-work.md`](../parallel-work.md).

## Suggested build order

1. **Publishing.** The `live` port, the pipeline's post-commit publish, a test implementation,
   and the cost of a publish measured. Criteria 2, 5, 9.
2. **The Cloudflare transport:** `LiveTopics`, `/api/live`, the subscribe check. Criteria 3, 4,
   10.
3. **The browser and the contract:** the hook, `ScreenSpec.live`, the check, Front desk and
   Class list, one e2e test with two browsers. Criteria 1, 6, 7, 8, 12.
4. **The AWS transport:** `NOTIFY` and the Node server's sockets. Criterion 11.
5. **Docs, the skill and the ADR.** Criterion 13.

## Decided by this spec, open to override

- **Notices, not data.** The live channel says what kind of thing changed; reads stay
  operations.
- **A topic is an object.** Narrower topics wait for a screen that needs them.
- **Best effort after the commit, outside the outbox,** with a safety refetch.
- **WebSockets on both targets,** one per tab.
- **One Durable Object per client on Cloudflare; `LISTEN`/`NOTIFY` on AWS.**
- **A pack declares `live` on its screen;** blocks do not change.
- **Staff only.**
- **The numbers:** one refetch a second, 30-second polling when disconnected, a 2-minute safety
  refetch.

## Questions for the owner

1. **Which screens after Front desk and Class list?** Recommended: the appointments day view
   and the roster next, and the till and the door's check-in list when their stages are built.
   Every live screen costs refetches on every desk that has it open, so the list should stay
   short and be the owner's.
2. **Should customers ever get live updates** (spots left on a class, a queue position)?
   Recommended: not in this stage. It means sockets for the public, at a scale and cost staff
   screens never reach, and a second check of what a notice may reveal to someone outside the
   business.

## Status

Spec proposed (2026-11-26). No build step is built yet. Each build step changes its own line
here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — not built — Publishing: the `live` port and the pipeline's post-commit publish, measured

- **Step 2** — not built — needs: step 1 — The Cloudflare transport: `LiveTopics`, `/api/live`, the subscribe check

- **Step 3** — not built — needs: step 2 — The browser and the contract: the hook, `ScreenSpec.live`, Front desk and Class list

- **Step 4** — not built — needs: step 3, stage 68 — The AWS transport: `NOTIFY` and the Node server's sockets

- **Step 5** — not built — needs: step 3 — Docs, the skill and the ADR
