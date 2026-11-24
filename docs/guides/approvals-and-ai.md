---
title: Approvals and AI
description: The approval pipeline, the policy adjudicator, model roles, and what an AI may and may not do.
order: 3
---

An outline; the full description is in [docs/architecture.md](../architecture.md#6-approval-pipeline)
(the approval pipeline) and [its AI section](../architecture.md#8-ai).

## Every call is gated

Each operation call passes through the approval pipeline
([ADR 0011](../adr/0011-approval-pipeline.md), [ADR 0018](../adr/0018-invocation-pipeline-and-gate.md)):

1. a **deterministic gate**: the actor and the operation's risk class give `auto`, `deny` or
   `review`, never below the deployment's floor;
2. an optional **policy adjudicator**, which judges the simulated change against the
   organisation's written policy ([ADR 0204](../adr/0204-policy-adjudicator.md));
3. a **human queue** for what is left, in the Approvals inbox.

A `review` decision dry-runs the operation, which causes no real effect, and records a pending
action with its diff; a person approves or rejects it
([ADR 0022](../adr/0022-approval-queue-and-simulation.md)). Every decision is audited.

## What only a person does

- **Loosening approval policy is a human admin's only**, and auth secrets are env-only: identity
  and policy are not AI-configurable.
- An operation may allow only human actors (`actors: ["human"]`), and a pack's tool may be
  `humanOnly` ([ADR 0512](../adr/0512-one-per-person-and-tools-only-a-person-may-call.md)).
- A tool or a field may be **a person's to approve** (`personApproves`): anyone else's call waits
  for a person whatever the policy says ([ADR 0552](../adr/0552-a-tool-a-person-approves.md)).
- **A change to how the system is set up** (an extension, a schema change) is never approved from
  a device session, such as the company's app on a phone: the host refuses it there, and a person
  reviews it in the web admin ([ADR 0872](../adr/0872-the-owners-client.md)).

Each operation's actors and each tool's flags are on their reference pages.

## Model roles

Code asks for a model **role** (such as `review`), never a model id. A deployment maps roles to
models in Settings → AI; calls go through AI Gateway.

## MCP and the assistant

An MCP client and the in-app assistant call the same operations as the UI, through the same
pipeline, with the same descriptions the reference pages show.
