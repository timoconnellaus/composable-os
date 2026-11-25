# Stage 73: Connections on AWS

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Integrations), [`CONTEXT.md`](../../CONTEXT.md) (Gatekeeper, Connection, Integration host,
Outbound action, Connection binding), [`UPSTREAMS.md`](../../UPSTREAMS.md) (Vendored from
cloudflare-os; Our own gatekeepers), ADRs
[0950](../adr/0950-two-targets-cloudflare-and-aws.md),
[0007](../adr/0007-integrations-are-gatekeepers.md),
[0050](../adr/0050-integration-host-and-connections.md),
[0110](../adr/0110-integration-host-per-connection.md),
[0111](../adr/0111-outbound-actions-in-the-approval-queue.md),
[0112](../adr/0112-email-calendar-sync-service.md),
[0113](../adr/0113-inbound-webhooks-and-integration-events.md),
[0114](../adr/0114-own-gatekeepers-pickers-and-host-modules.md),
[0429](../adr/0429-payments-gatekeeper-verified-events-and-refunds.md) and
[0456](../adr/0456-the-hosts-sign-in-mail.md); stages [68](68-host-on-node.md),
[69](69-lambda-sandbox.md) and [71](71-models-vectors-mail-on-aws.md); code:
`apps/runner/src/integrations/` (`host.ts`, `queue.ts`, `sync.ts`),
`packages/core/src/integrations/runtime.ts`, `packages/gatekeeper-interface/src/gatekeeper.ts`,
`packages/gatekeeper-kit/src/`, `packages/gatekeeper-payments/src/` (`stripe.ts`, `events.ts`),
`packages/gatekeeper-text/src/events.ts`, `packages/gatekeeper-email-send/src/worker.ts`.

Status: **spec proposed (2026-11-26)**. Not built until its interview settles the questions at its
end.

## Goal

A host on AWS can take payments, send text messages, send and receive mail and read a calendar,
with everything a connection stores kept in the deployment's region. The rule that external
access goes only through gatekeepers holds on both targets. Which gatekeepers move, and how, is
the choice this spec puts to the owner.

## What exists today (from the code)

- **Core sees a port.** `IntegrationRuntime` (`packages/core/src/integrations/runtime.ts`) is
  what operations call: `startConnect`, `provision`, `redeem`, `reconnect`, `disconnect`, binding
  a resource, calling a gatekeeper, applying an outbound action. Core imports nothing from
  Cloudflare. The database holds a mirror for the UI only (`core_integration_connection`, ADR
  0110).
- **The port's only implementation is a Durable Object.** `IntegrationHost`
  (`apps/runner/src/integrations/host.ts`, 1,532 lines), one object per connection. In its own
  storage it keeps the connected account, a staged account during a connect, one gatekeeper
  facet per bound resource (`ctx.facets.get`), hook controllers, and sync state driven by its
  alarm.
- **What it stores are RPC stubs.** The account is a `Fetcher<GatekeeperUser>`; a facet is made
  from a stored Durable Object class stub; a hook controller is a stored stub. The runner sets
  the compatibility flag `allow_irrevocable_stub_storage` for this. ADR 0110 says why: only
  Durable Object storage can hold them.
- **The interface is vendored.** `packages/gatekeeper-interface/src/gatekeeper.ts` (2,033 lines,
  unchanged from upstream) types everything as `WorkerEntrypoint`, `DurableObject`, `RpcTarget`
  and `RpcStub` from `cloudflare:workers`. Methods return `DurableObjectClass` values
  (`getGatekeeperClassFor`), take stubs (`startSession(approvalQueue: RpcStub<ApprovalQueue>)`,
  `bindHook`), and pass `ReadableStream`s (`GitCache`).
- **`packages/gatekeeper-kit`** (vendored) is written over Durable Object key-value storage:
  the action journal, the hook delivery queue, credentials, cursors, observers.
- **The gatekeepers.** Twelve packages have a Worker configuration: `email`, `email-send`,
  `google`, `mcp`, `microsoft`, `payments`, `slack`, `slack-post`, `text`, `webhook`,
  `websearch`, `zoominfo`. Two more (`accounting`, `booking-system`) have only a fake provider's
  configuration. A search for `extends DurableObject` finds 26 classes in them (fakes included),
  and 45 `WorkerEntrypoint` classes. Seven are vendored (UPSTREAMS.md); `email-send`, `slack-post`,
  `webhook`, `payments`, `text`, `accounting` and `booking-system` are ours.
- **What a gatekeeper keeps at rest,** as far as this survey read:

  | Gatekeeper | Kept in its Durable Objects |
  | --- | --- |
  | `payments` | `PaymentsEvents`: each verified provider event as JSON until delivered, and seen ids; provider references in key-value storage |
  | `text` | `TextEvents`: seen ids, provider references, hashes of numbers that said stop or help, and events waiting for delivery, which name a member's number |
  | `webhook` | `WebhookEndpoint`: each received event with its payload until delivered |
  | `email-send` | A send history (recipients and subject, later scrubbed) and the journal of messages waiting for approval |
  | `email` | The owner, the hook and a nonce. It parses each message and hands it on; the host keeps bodies in its own bucket (`email-bodies/`, `packages/core/src/sync/ingest.ts`) |
  | `google`, `microsoft`, `slack` | OAuth tokens, watch and cursor state, and per-resource state. Not read in full for this spec |

- **Extension code reaches a gatekeeper** only through a `codemode:<gatekeeper>` host module,
  which calls the integration host as the caller (ADR 0114).
- **Mail on Cloudflare** is sent through the `send_email` binding and received by the `email()`
  handler of `packages/gatekeeper-email`.
- **The text gatekeeper** ships with a fake provider only; a real provider is one more
  implementation of `TextProvider`.

## Decided by the owner (2026-11-26)

1. Two targets. AWS is Node 22 in containers. Not workerd on AWS, and not a third-party
   Workers-compatible runtime.
2. The reason for AWS is a health product that must keep its data at rest in Australia.
3. Queues and schedules on AWS are stored in Postgres behind the platform's own interfaces.
4. Mail on AWS is SES. Files are S3.
5. Pack and extension code on AWS runs in a Lambda function with no network access.
6. The whole host is wanted on AWS, in stages: email and calendar connections, payments and
   text messages among them.

## Why this is the hardest part to move

Everything else in the host has a seam with plain data on both sides. This one does not. The
gatekeeper interface is an object-capability protocol: a gatekeeper hands the host live objects
(an account, a class to instantiate, a controller), the host stores those objects and hands
its own back (an approval queue, a hook callback). Node has no stored stubs, no facets and no
Durable Object classes to pass. A gatekeeper cannot be moved by swapping a binding; its shape
has to change.

## The options

**(a) Everything on Node.** Write our own gatekeeper interface in plain async TypeScript, a Node
connection host behind `IntegrationRuntime`, and port every gatekeeper to it.

- For: one way of working on AWS; all data in the region.
- Against: the seven vendored gatekeepers are large and built on the kit's Durable Object
  storage and on RPC decorators. Porting them is a rewrite of code we do not own, and it ends
  our ability to pull upstream changes for the Node copies. Most of them (Slack, ZoomInfo,
  SharePoint, the MCP gatekeeper) are not needed by the product AWS is for.

**(b) Gatekeepers stay on Cloudflare.** The AWS host calls the existing Workers over HTTPS.

- For: least code. Nothing is rewritten.
- Against: it does not meet the reason for the target. Credentials, payment events, events
  naming members' phone numbers, webhook payloads and mail waiting for approval would be at
  rest in Cloudflare Durable Objects (the table above). Durable Objects cannot be pinned to
  Australia, as far as we know (to be confirmed in step 1). The stub protocol also does not
  cross plain HTTPS, so `IntegrationHost` would have to stay on Cloudflare too, with a new
  HTTP front. That is a second deployment to run for every AWS client.

**(c) The Node connection host, and only the gatekeepers a health product needs.** Build the
host half of (a). Port payments, text messages, outbound mail, inbound mail and inbound
webhooks first, then calendar. Every other gatekeeper is Cloudflare-only for now, and the
catalogue on AWS does not list it.

- For: the first five are our own code or small. Their provider logic is already separate
  from the Worker shell in places (`stripe.ts` takes its store as an option; `TextProvider` is
  an interface). All of it stays in the region.
- Against: two implementations of each ported gatekeeper to keep in step. Calendar is the
  costly one, because Google and Microsoft are vendored (see The model).

**Recommended: (c).** It is the only option that meets the region rule without rewriting code
nobody on AWS will use.

## The design in one page (for option c)

```
 operation ─► IntegrationRuntime (core's port, unchanged)
                 ├─ Cloudflare: IntegrationHost, a Durable Object per connection (as today)
                 └─ AWS: the Node connection host
                        │ one lock per connection
                        ├─ connection, resources, credentials (encrypted), journal, events:
                        │  tables in the client's schema
                        ├─ gatekeepers: modules behind our own interface (payments, text, …)
                        ├─ wake-ups: stage 68's schedules      inbound: POST /gatekeeper/*
                        └─ the only code with outbound network access
 extension code (Lambda, no network) ─► codemode:<gatekeeper> ─► the host, as the caller
```

## The model

### Our own gatekeeper interface

A small TypeScript interface for Node, written by us, covering what core's port needs and no
more: describe the vendor, connect or provision an account, list and bind resources, start a
session and call a method, submit, simulate, apply and reject an outbound action, receive an
inbound request, run a sync step. Arguments and results are plain data. Where the vendored
interface passes a stub, ours passes an id the host looks up. The vendored interface and kit
are not edited and stay the Cloudflare target's.

### The Node connection host

- **State** is rows in the client's schema: the connection, its bound resources, the action
  journal, inbound events and sync cursors. The existing mirror table stays what the UI reads.
- **Credentials** (OAuth tokens, a client's provider keys) are encrypted with a key from AWS
  KMS before they are stored, and decrypted only inside the connection host. No operation,
  extension or assistant tool can read them.
- **One connection at a time:** a Postgres advisory lock per connection, taken for each call,
  gives what one Durable Object per connection gives today.
- **Alarms** (staged-connect expiry, sync passes, catch-up) are one-off wake-ups in stage 68's
  schedules.
- **Inbound** provider calls arrive at the Node server on the same `/gatekeeper/*` paths. The
  handler verifies the signature, stores the event and its id in one transaction, and a queue
  consumer delivers it to the operation that applies it. Delivery is at least once and the
  seen-id table makes it apply once, as `PaymentsEvents` and `TextEvents` do.
- **Outbound actions** go through core's `submitOutbound` and the approval queue exactly as
  ADR 0111 says. The journal is a table.
- **Gatekeepers run in the runner's Node process,** not as services of their own. Host code is
  trusted; the rule protects against extension code, which is in the sandbox.

### The first gatekeepers

| Gatekeeper | On AWS | Note |
| --- | --- | --- |
| Payments | The provider code of `gatekeeper-payments`, shared | ADR 0429's verified events and refunds through approval hold |
| Text messages | `TextProvider` and the stop and help rules, shared | Needs a real provider chosen (question 3) |
| Outbound mail | SES through stage 71's transport | The host's sign-in mail included |
| Inbound webhooks | The verify-and-store path above | ADR 0113 |
| Inbound mail | SES receiving into S3, then the host's existing ingest | Whether SES receives mail in the chosen region is to be checked in step 1 |
| Calendar | New, small Google and Microsoft calendar gatekeepers written for our interface, reusing the vendored API clients where they do not depend on the kit | The vendored gatekeepers are not ported |

Shared provider code moves into files with no Worker imports, used by both targets' shells.

### What extension code sees

Nothing changes in the contract. `codemode:<gatekeeper>` and `ctx.gatekeeper("<name>")` reach
the connection host through the sandbox's host proxy (stage 69). A gatekeeper that is not on
this target is not offered: `availableVendors` leaves it out, and an extension that declares
its module fails install with a clear message.

## Out of scope

- Porting Slack, Slack posting, ZoomInfo, web search, the MCP gatekeeper, SharePoint, Gmail and
  Outlook mail sync, accounting and the booking-system connection. Each is a later step when a
  product on AWS needs it.
- Any change to connections on Cloudflare.
- Video (Stream), which is not a gatekeeper.
- A client's own gatekeeper (stage 66 leaves room for it on Cloudflare).

## Acceptance criteria

1. The audit of step 1 is recorded: per gatekeeper, what it stores and where each target keeps
   it.
2. Core's integration tests pass against the Node connection host with the fake provider.
3. On AWS a test payment is taken, the provider's webhook is verified and applied once when
   delivered twice, and a refund goes through approval.
4. A text message is sent through approval rules as on Cloudflare; a "stop" reply stops further
   texts to that number.
5. Mail is sent through SES, including sign-in mail; a received message reaches the host's
   ingest with its body in the client's part of S3.
6. A staff calendar is connected by OAuth and its events sync; a reconnect after expiry works.
7. Stored credentials are unreadable without the KMS key, and no operation returns them.
8. An extension tool in the sandbox calls a ported gatekeeper through its host module and is
   refused one that is not on the target.
9. Two calls on one connection never interleave, with two Node tasks running.
10. Nothing a ported gatekeeper stores leaves the deployment's region: checked by listing every
    store it writes.
11. The Cloudflare gatekeepers' suites pass unchanged.

## Dependencies

Stage 68 (Node server, queue, schedules), stage 69 (the sandbox's host proxy), stage 71 (SES).
Stage 70 for the KMS key and the public route in the OpenTofu module.

## Migrations and numbers

No numbers are picked here. The first build step claims a block for its ADR and Postgres
migrations in [`docs/parallel-work.md`](../parallel-work.md).

## Suggested build order

1. **Audit and spike.** Read every gatekeeper's storage and record it; confirm what Cloudflare
   can pin to a region; draft our interface; run payments' provider code on Node against the
   fake provider; check SES receiving in the region.
2. **Our interface and the Node connection host** with the fake provider. Criteria 2, 7, 9.
3. **Inbound webhooks.** The verify, store and deliver path.
4. **Payments.** Criterion 3.
5. **Text messages.** Criterion 4.
6. **Outbound mail, then inbound mail.** Criterion 5.
7. **Host modules from the sandbox,** and the catalogue per target. Criterion 8.
8. **Calendar:** Google, then Microsoft. Criterion 6.
9. **The region check, docs and the ADR.** Criteria 1, 10, 11.

Steps 4, 5 and 6 can run side by side after step 3.

## Decided by this spec, open to override

- **Core's port does not change.** The work is a second implementation of `IntegrationRuntime`.
- **Our own interface for Node, plain data only.** The vendored interface stays as it is.
- **Gatekeepers run inside the runner's process on AWS.**
- **Credentials are encrypted with KMS and stored in the client's schema.**
- **A lock per connection** stands in for an object per connection.
- **A gatekeeper not ported is not offered on AWS,** and says so at install.
- **Calendar gets new small gatekeepers** in place of ports of the vendored ones.
- **The same public paths** for provider callbacks on both targets.

## Questions for the owner

1. **Which option: (a), (b) or (c)?** This is the main question. Recommended: (c). Option (b)
   leaves payment events, members' numbers and credentials at rest outside Australia, and
   option (a) rewrites vendored gatekeepers no AWS product has asked for.
2. **Does the rule about data in Australia cover what the providers themselves hold?** A
   payments provider, a text provider and a calendar provider each store what passes through
   them, where they choose. Recommended: the rule covers what our host stores; each provider is
   named to the client, and a provider with an Australian region is preferred where one exists.
   Only the owner knows what the health product has promised.
3. **Which text provider, and which calendars first?** No real text provider is built yet.
   Recommended: decide the text provider with the health product in mind before step 5, and
   build Google calendar before Microsoft unless that product uses Microsoft.

## Status

Spec proposed (2026-11-26). No build step is built yet. Each build step changes its own line
here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — not built — needs: stage 68 — Audit and spike: what each gatekeeper stores, our interface drafted, payments' provider code on Node

- **Step 2** — not built — needs: step 1 — Our interface and the Node connection host, with the fake provider

- **Step 3** — not built — needs: step 2 — Inbound webhooks: verify, store, deliver

- **Step 4** — not built — needs: step 3 — Payments

- **Step 5** — not built — needs: step 3 — Text messages

- **Step 6** — not built — needs: step 3, stage 71 — Outbound mail, then inbound mail

- **Step 7** — not built — needs: step 2, stage 69 — Host modules from the sandbox, and the catalogue per target

- **Step 8** — not built — needs: step 2 — Calendar: Google, then Microsoft

- **Step 9** — not built — needs: step 4, step 5, step 6, step 7, step 8 — The region check, docs and the ADR
