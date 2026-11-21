# ADR 0417: The API contract, its golden files and versions

Status: accepted, 2026-11-21 (stage 23 build, step 6). Builds part of
[ADR 0403](0403-http-surface-and-typed-client.md).

## Context
ADR 0403 decided that `/api/v1` is a contract: a change that would break a client compiled
against it is a new version, the host serves the current and the previous version, an older app
is told to update, and a golden file of the manifest per audience is committed so CI sees a
breaking change. It did not say what the manifest holds, how a breaking change is told from an
addition, or what "no longer served" answers.

## Decision
- **One description of the API, the contract** (`packages/core/src/http/contract.ts`): for each
  operation a client may call, its name, description, risk, audiences, kind (`query` for a read,
  `mutation` for anything else), JSON Schema for input and output, and for a mutation the queries
  it makes stale. Tool-only operations are left out: no client calls them.
- **What a mutation makes stale is derived by namespace, not declared.** Operations declare
  nothing about what they write. The contract infers it from the operation's name instead:
  `person.update` stales the `person.*` reads, `x.deals.<tool>` the Deals reads, and a customer's
  own records are one namespace (`me.*` and `my.*`), which a pack's tools write too. This departs
  from the spec's wording ("taken from what the operation declares it writes") on purpose, and is
  open to revisiting: when a write needs to stale reads outside its namespace (an order that
  changes a capacity, say), give operations a declaration then, and the contract reads it.
- **The same contract is served, committed and generated from.** `GET /api/v<n>/manifest` is the
  caller's audience's contract. `packages/core/api/v1/{staff,customer,public}.json` are
  committed. `cos client generate` writes the typed client from it (ADR 0418).
- **The contract guard:** `test/api-contract.test.ts` fails while the registry (core operations
  and the shipped extensions' tools) and the committed files differ, so CI does. Its message names
  what in the change would break a client compiled against the files: an operation removed, a
  mutation that became a query or the reverse, an input newly required or no longer taken, an
  output property gone. `pnpm --filter @composable-os/core api-contract` rewrites the files. A
  change it calls breaking is a new API version.
- **Versions:** `SERVED_API_VERSIONS` lists the versions the host serves, the current one and the
  previous one; today only `v1`. A call to a version below the oldest served is answered
  `upgrade_required` with status 426 and a message an app can show ("This version of the app is no
  longer supported. Update the app to keep using it."). A version above the current is
  `not_found`. The runtime client raises `UpgradeRequiredError` for 426 and calls the app's
  `onUpgradeRequired`.
- **Every `/api/v<n>` path is the surface's,** served or not, so an old app gets the update
  answer rather than a staff sign-in redirect.

## Why
- A contract that is the served manifest, the committed file and the generator's input cannot
  drift between the three.
- Deriving what is stale from the namespace keeps query invalidation right for every operation
  now without a new key on 300 definitions.

## Consequences
- `staff.json` is large (about 1.6 MB): it holds the schema of every staff operation. It changes
  whenever a staff operation does, which is the point.
- When v2 ships, v1 needs an adapter that answers v1 calls in v1's shapes, and the v1 golden
  files stay committed. That adapter is not built: there is no v2 yet.
- While stage 23 is being built and no client depends on v1, its golden files may change
  incompatibly (`me.sessions.list` gained device sessions and a nullable `expiresAt`).
