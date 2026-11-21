# ADR 0404: Behaviours are the vocabulary products are composed from

Status: proposed, 2026-11-20 (design conversation). Each behaviour is settled at its own stage.

## Context
ADR 0100 chose a declarative stage behaviour over a "before write" hook: the host enforces it
inside the record operations, for every actor, and the approval queue can simulate it. A hook would
have made every write a Dynamic Worker call whose result could not be dry-run.

Ticketing, bookings, a CMS and memberships each need rules of that kind, and they share them.
A class booking and an event ticket both draw on limited places. A blog post and an event page both
have a draft and a published state. One further fact forces the point: a tool's calls are separate
operations, not one transaction (stage 15). Taking the last place and creating the order cannot be
two calls.

## Decision
- **A behaviour is a declarative rule set an object opts into in its manifest, enforced by the host
  in the same batch as the write.** Extension code never hooks a write.
- **Behaviours stack on one object.** An event is publishable (it has a page), sellable (it has
  prices and places) and scheduled (it has a time).
- **A new behaviour is platform work.** It is added to the contract, with a contract version change
  where needed. A pack composes behaviours; it does not invent them.
- **The planned set**, each built by the stage that first needs it:

| Behaviour | What the host enforces | First needed by |
| --- | --- | --- |
| `stages` | Ordered stages, required fields, history (exists, ADR 0100) | Deals |
| `states` | A general state machine: allowed moves, who may make them, required fields, history | Orders |
| `capacity` | A count of places that can never go below zero; holds that expire | Ticketing, bookings |
| `sellable` | Prices and what a paid order grants | Ticketing |
| `publishable` | Draft, published, scheduled; revisions; public reads see published only | CMS, event pages |
| `recurring` | A schedule that generates dated records | Timetables |
| `allowance` | A pass or membership grants uses; a booking spends one | Bookings |

## Why
The same reasons as ADR 0100, now general: rules that hold for people, MCP clients, extensions and
imports alike, that can be simulated, and that cost no code execution per write. And because the
set is small and shared, a pack is mostly a manifest.

## Consequences
- The pace of new product kinds is set by the pace of new behaviours. That is deliberate.
- **`stages` and `states` share one engine** (decided 2026-11-20, stage 25 interview). `states` is
  declared in code with a fixed set; `stages` stays data an admin edits. Both run on one
  transition engine with one history table, and `stages` moves onto it in stage 25. Built in
  stage 25's first half: see ADR 0425. `states` now exists.
- "Entitlement" already means a hosted plan's limits (ADR 0211). The pass-and-uses behaviour is
  called `allowance` to keep the two apart.
