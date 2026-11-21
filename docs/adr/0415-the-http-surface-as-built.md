# ADR 0415: The HTTP surface, as built

Status: accepted, 2026-11-21 (stage 23 build, step 1). Builds part of
[ADR 0403](0403-http-surface-and-typed-client.md) on [ADR 0411](0411-audiences-on-operations-as-built.md)
and [ADR 0412](0412-customer-scope-and-principals-as-built.md).

## Context
ADR 0403 decided a fourth surface, `POST /api/v1/op/<name>`, for staff, customers and the public
together, with one pipeline and no second path to the database. The stage 23 spec named the
envelope, the manifest and cross-origin calls. It did not say where the surface lives, how the
caller is found from a request, what a request carrying two sessions is, or what statuses the
envelope uses.

## Decision
- **The surface is core's and framework-free** (`packages/core/src/http/`): `createHttpSurface`
  takes an invoker and a function that builds the call's context from the request. cos-app's
  adapter (`apps/app/src/server/http/api.ts`) supplies that function and is served in
  `src/server.ts` before TanStack Start, so the staff-only identity middleware does not stand in
  front of it. Tests run the same surface over a fixture registry.
- **Every call is `invokeByName`**, which is `invoke()`. The surface's own statements are an
  idempotency key's ([ADR 0416](0416-idempotency-keys-as-built.md)), committed in the write's
  batch through the pipeline. It hands the pipeline the same contexts any adapter does: a staff
  context, or an outside one with a principal and no staff user. A customer's or the public's
  handler therefore has no raw database and no write queue, as ADR 0413 says.
- **The caller comes from the session the request carries, and from nothing in the body.**
  - A staff session (Better Auth's cookie, Cloudflare Access's JWT, or hosted support access) is
    staff, with the context the UI's server functions build (`staffContext`), actor `human`.
  - A customer session (stage 22's cookie, secret and tables) is that customer.
  - No session, or a customer session that resolves to no linked, active account, is the public.
  - **A request with a staff session and a customer cookie is refused** (`forbidden`, 403): the
    two are separate accounts and never one caller.
  - Without `CUSTOMER_AUTH_SECRET` no customer session exists, and every non-staff caller is the
    public.
- **Origin `client`** for every call over HTTP, staff ones included. The audit row of a staff
  call over HTTP differs from the same call as a server function only there.
- **The operation is looked up for the caller before the body is read**
  (`resolveFor`, the pipeline's own audience rule): a name not registered, one not open to the
  caller, and a tool-only operation called directly all get `unknown_operation` (404) with the
  same words. So a customer's session on a staff operation gets exactly what no session gets.
  The pipeline checks the audience again.
- **The envelope:** success is `{ "data": <output> }` with 200. Failure is
  `{ "error": { "code", "message", "details"? } }` with the existing codes and details, and a
  status from the code: `invalid_input` 400 (415 for a body that is not JSON, 413 for one over
  1 MB, 422 for a reused idempotency key), `unknown_operation` and `not_found` 404, `forbidden`
  and `denied` 403, `conflict` 409, `rate_limited` 429 with `Retry-After`, `plan_limit` 402,
  `internal` 500. A staff write the gate queued is `pending_approval` with 202. An outside
  caller's internal errors are its code and "Internal error" only.
- **`GET /api/v1/manifest`** lists what the caller may call directly (`listFor`), with JSON
  Schema for input and output: for a customer, the generated list's customer operations without
  the tool-only ones; for the public, the public ones; for staff, the staff ones.
- **Cross-origin calls** are allowed from the origins in `API_ALLOWED_ORIGINS` (a var, set at
  deploy time, comma separated) and the API's own; a preflight from any other origin, or a call
  carrying one, is refused with 403. A request with no `Origin` (a phone, a server) is let through
  to authenticate. A body must be `application/json`, which a cross-site form cannot send.
- **Customers are rate limited per account and operation** by a new `CUSTOMER_RATE_LIMIT`
  binding (60 per 60 s), passed to the pipeline's existing check (stage 22).

## Why
- A surface in core with the context injected is the only way the stage 22 isolation suite can
  run over HTTP on the same fixture registry, and the only place the caller is decided is the
  adapter, which reads sessions and nothing else.
- Looking the operation up before reading the body means nothing a closed caller sends changes
  the answer, so the surface cannot be used to map the registry.

## Consequences
- The customer sign-in routes (`/api/customer-auth/*`) are not served yet: sending a code needs a
  decided sender for the email-send gatekeeper call. Until they are, a customer session exists
  only where something else signed the customer in.
- Public calls are limited per client address only by Cloudflare rate limiting rules at the
  edge, which this build does not configure.
- Native tokens (stage 23 step 5) will be a third credential the adapter reads; the surface does
  not change.
