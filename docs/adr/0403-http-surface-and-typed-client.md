# ADR 0403: An HTTP surface and a typed client

Status: proposed, 2026-11-20 (design conversation). To be settled at the stage 23 interview.

## Context
An operation is exposed three ways from one definition: a TanStack Start server function for the
UI, an MCP tool, and a host module for extension code (ADR 0003). A phone app, a TV app and a
client's own web Worker can use none of these well. Ghetto shows what happens without a fourth:
its site, its Expo app, its TV app and its Claude connector each have their own path to the data.

## Decision
- **A fourth surface: HTTP.** Every operation whose audience allows the caller is reachable at a
  versioned HTTP route on the host, with the same validation, gate, role and scope checks, audit
  and field diffs as any other call. There is one pipeline (`invoke()`, ADR 0018) and no second
  path to the database.
- **A typed client generated from the registry.** One package exports each operation's input and
  output types and TanStack Query option factories. It has no DOM or Node dependency, so the same
  package serves TanStack Start and React Native.
- **Pack hooks build on it.** A pack's headless part is functions and hooks over the client, with
  no markup.
- **Writes carry an idempotency key.** A phone on a bad connection retries; a retry must not buy a
  second ticket.
- **The client's web Worker calls the host over a service binding;** phones and TVs call it over
  the public hostname.

## Why
One definition, every surface, is the rule that keeps a platform from growing a second API. Types
generated from the registry mean a client app fails to compile when an operation changes, before it
fails for a user.

## Consequences
- The HTTP surface is a contract. It is versioned with the platform and keeps the previous version
  working.
- Realtime (a coach and a client seeing the same live workout, a door scan updating a count) is not
  covered by request and response. It is a later primitive; this ADR does not decide it.
- Open: session tokens for native apps (storage, refresh, revocation) and whether staff apps on
  phones use the same surface with staff sessions. They should.
