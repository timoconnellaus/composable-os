# Stage 23: HTTP surface and typed client

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (The HTTP
surface and the typed client), [`CONTEXT.md`](../../CONTEXT.md), ADRs
[0402](../adr/0402-staff-and-customers.md) and
[0403](../adr/0403-http-surface-and-typed-client.md), [stage 22](22-customers-and-audiences.md),
and ADRs 0003, 0016, 0018, 0021, `packages/core/src/invoke.ts`,
`registry.ts`, `operation.ts`, `client.ts`, `packages/mcp-shared`.

Status: spec proposed. Builds on stages 20 and 22.

## Goal

A phone app, a TV app and a company's own web Worker call operations on the host the same way,
with types. A developer changes an operation's input and every client app that calls it fails to
compile. A phone that retries a purchase on a bad connection buys once.

## What exists today (from the code)

- An operation is exposed as a TanStack Start server function, an MCP tool and a host module, from
  one definition with zod input and output.
- MCP tools are generated from the registry (ADR 0021). There is no generic HTTP route for
  operations; the app's own UI uses server functions.
- `@composable-os/core/client` (after stage 20) is a browser-safe subset of core (field registry, filter JSON) for
  the staff UI. It is not a client for calling operations.
- Ghetto's Expo app calls hand-written `/api/app/<path>` routes with a token kept in
  `expo-secure-store`. Its TV app and its Claude connector have their own paths.

## Scope

### The surface
- `POST /api/v1/op/<operation name>` on the app Worker, with the input as JSON and the output as
  JSON. Every call goes through `invoke()` with a principal built from the request: a staff
  session, a customer session, or public.
- Errors use one envelope with the existing error codes (`invalid_input`, `forbidden`, …) and the
  `details` operations already return, such as a stage rule's missing field.
- An operation not open to the caller's audience, and an operation that does not exist, give the
  same answer.
- `GET /api/v1/manifest` returns, for the caller's audience only, the operations they may call
  with JSON Schema for input and output. A customer never learns a staff operation's name from it.
- Cross-origin calls are allowed only from origins listed in the deployment's settings. Phones
  send no origin and authenticate by token.

### Idempotency
- Every write call carries an `Idempotency-Key`. The host stores the key with the principal, the
  operation, a hash of the input and the response, in the same batch as the write.
- The same key and input returns the stored response without running the handler. The same key
  with a different input is refused. Keys are kept for 24 hours and then purged by the daily cron.
- A write without a key is refused on this surface. Other surfaces are unchanged.

### Sessions for native apps
- A native app exchanges its sign-in for a short-lived access token and a refresh token. Refresh
  tokens rotate on use; a reused one revokes the whole session.
- Tokens are for one audience. A customer token is never accepted where a staff session is
  needed, as in stage 22.
- A staff member or a customer can list and revoke their own sessions, by device name.

### The typed client, `@composable-os/client`
- Generated from the registry at build time: for each operation, its input and output types, and a
  TanStack Query `queryOptions` or `mutationOptions` factory with a stable key.
- No DOM, Node or Workers dependency. The transport is passed in: `fetch` to a hostname, or a
  service binding.
- Two entry points, split by audience, so a customer app's bundle holds no staff operation names:
  `@composable-os/client/customer` (customer and public operations) and `@composable-os/client/staff`.
- Mutations create their own idempotency key and keep it across retries.
- Query keys follow one rule (`[operation, input]`) and each mutation lists the keys it makes
  stale, taken from what the operation declares it writes.
- A client app that includes extensions generates its own client the same way from its product's
  registry, so pack tools and the org's own tools are typed too.

### Pack hooks
- A pack may ship a headless entry (`@composable-os/pack-deals/client`): functions and hooks over the
  typed client, no markup. This stage adds the convention and one example for Deals; packs with
  customer-facing hooks arrive with stage 27.

### Versioning
- `/api/v1` is a contract. A change that would break a client compiled against it is a new
  version; the host serves the current and the previous version, as it does for the extension
  contract.
- A golden file of the manifest for each audience is committed. CI fails when it changes without
  the file changing, so a breaking change is seen.

## Out of scope
- Realtime: subscriptions, live queries, presence.
- Push notifications.
- File upload from client apps (it arrives with media in stage 28).
- Offline writes that queue on the device. Retries with the same key are covered; a queue is not.
- Replacing the staff UI's server functions with this surface.

## Acceptance criteria
1. **One pipeline:** a call over HTTP and the same call as a server function produce the same
   audit row, field diffs and timeline posts. A test compares them for a write of each risk class
   allowed on the surface.
2. **Audiences:** the stage 22 isolation test runs again over HTTP and passes. The manifest for a
   customer lists exactly the generated list's customer operations.
3. **Idempotency:** the same key and input sent twice, and sent twice at once, runs the handler
   once and returns the same response; a different input with the same key is refused; a write
   with no key is refused.
4. **Tokens:** a reused refresh token revokes the session; a customer token is refused on a staff
   operation with the same answer as no token.
5. **Types:** changing an operation's input in a fixture makes a fixture client app fail
   `tsc`. The client builds and its tests run under both a Workers and a React Native (Hermes)
   test target.
6. **Bundle split:** the customer entry point contains no staff operation name, checked by a test
   that reads the built file.
7. **Contract guard:** a breaking change to the manifest without a golden file change fails CI.
8. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Surface, Typed client) and
   `docs/architecture.md` are updated.

## Dependencies
- Stage 22 for customer and public callers. With stage 20 alone, the surface could ship for staff
  callers first; that split is offered at the interview.

## Migrations and numbers
Migrations 0410 to 0419 (idempotency keys, native sessions). ADRs 0415 to 0419, and ADR 0403
amended as built.

## Suggested build order
1. The route, the principal from a staff session, the error envelope; the one-pipeline test.
2. Idempotency.
3. The generator and `@composable-os/client/staff`; the type-break test.
4. Customer and public principals; the customer entry point; the isolation test over HTTP.
5. Native tokens.
6. The Deals hooks as the example.

## To settle at the interview
- **One route per operation, or a single route** taking the operation name in the body. Per
  operation reads better in logs and rate limits; a single route is simpler to proxy.
- **Staff surface first?** It would let Ghetto's staff and coach screens move early.
- **How the client is delivered to a client repo:** generated there from the product's registry,
  published as a package, or both.
- **What the client does when the host is a version ahead or behind.**
- **Whether reads may be cached at the edge** for public operations, and who decides how long.
