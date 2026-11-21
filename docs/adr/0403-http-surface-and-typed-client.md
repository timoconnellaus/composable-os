# ADR 0403: An HTTP surface and a typed client

Status: accepted, 2026-11-20 (design conversation and stage 23 interview).

## Context
An operation is exposed three ways from one definition: a TanStack Start server function for the
UI, an MCP tool, and a host module for extension code (ADR 0003). A phone app, a TV app and a
client's own web Worker can use none of these well. Ghetto shows what happens without a fourth:
its site, its Expo app, its TV app and its Claude connector each have their own path to the data.

## Decision
- **A fourth surface: HTTP,** one route per operation (`POST /api/v1/op/<name>`). Every operation
  whose audience allows the caller is reachable there, with the same validation, gate, role and
  scope checks, audit and field diffs as any other call. There is one pipeline (`invoke()`, ADR
  0018) and no second path to the database.
- **It ships for staff, customers and the public together,** after stage 22.
- **A typed client generated per product.** A small runtime package holds the transport, errors,
  idempotency and TanStack Query helpers, with no DOM or Node dependency, so it serves TanStack
  Start and React Native alike. A generator writes each product's typed operations from that
  product's own registry, in the client repo, so pack tools and the org's own tools are typed.
- **The generated client is split by audience.** A customer app's bundle holds no staff operation
  name.
- **Pack hooks build on it.** A pack's headless part is functions and hooks over the client, with
  no markup.
- **Every write carries an idempotency key,** and a write without one is refused on this surface.
  A phone on a bad connection retries; a retry must not buy a second ticket.
- **Phones hold a short-lived access token and a rotating refresh token.** A reused refresh token
  ends the session. A session unused for a set time (90 days by default) ends.
- **The host serves the current and the previous API version.** An older app is told to update.
- **The client's web Worker calls the host over a service binding;** phones and TVs call it over
  the public hostname.
- **The staff admin keeps its server functions.**

## Why
One definition, every surface, is the rule that keeps a platform from growing a second API. Types
generated from the registry mean a client app fails to compile when an operation changes, before it
fails for a user.

## Consequences
- The HTTP surface is a contract. It is versioned with the platform and keeps the previous version
  working.
- Realtime (a coach and a client seeing the same live workout, a door scan updating a count) is not
  covered by request and response. It is a later primitive; this ADR does not decide it.
- Caching public reads at the edge is decided with the first public operations (stages 27 and
  28). One route per operation keeps that possible without changing the surface.
- Push notifications, uploads from client apps and offline writes queued on a device are also
  left for later.

## As built (stage 23, steps 1 and 2, 2026-11-21)
- The route, the callers, the envelope, the manifest and cross-origin calls:
  [ADR 0415](0415-the-http-surface-as-built.md). The surface lives in `packages/core/src/http/`;
  cos-app's adapter finds the caller from the request's session.
- Idempotency keys: [ADR 0416](0416-idempotency-keys-as-built.md). The key commits in the
  write's own batch, through a new pipeline hook (`inBatch`).

## As built (stage 23, steps 3 to 7, 2026-11-21)
- The contract per audience, its golden files, the served versions and `upgrade_required`:
  [ADR 0417](0417-the-api-contract-and-versions.md).
- `@composable-os/client`, `cos client generate`, the customer and staff entry points, and pack
  hooks with Deals as the example: [ADR 0418](0418-the-typed-client-as-built.md).
- Native apps' tokens, the idle setting, and customer sign-in served by the host, with codes
  sent by the host itself: [ADR 0419](0419-native-sessions-and-customer-sign-in.md).
- Changed from the decision above: "the host serves the current and the previous version" is
  built as a list of served versions with only v1 in it; serving a previous version needs an
  adapter that does not exist until there is a v2.
