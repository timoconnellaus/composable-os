# ADR 0405: Skills ship with the platform

Status: accepted, 2026-11-20 (design conversation and stage 21 interview).

## Context
Products are composed by an agent working with a person. What the agent needs to know (how to
write an extension, what it may not do, how to check the result) is today spread over
`AGENTS.md`, the SDK's types and the Deals extension. It is relearned in each session and is not
available in a client's repo at all.

## Decision
- **The platform repo holds installable skills** in a plain `skills/` folder, linked into
  `.claude/skills/`. They are plain Markdown that Codex and other agents can read too.
- **The first set is two skills for extension authoring:** `write-extension` (objects, fields,
  views, behaviours) and `add-automations-tools-dashboards`. Their first reader is an agent in the
  platform repository writing shipped extensions. Skills for starting a client app, adding a pack,
  building screens and migrating from other systems come when those things exist.
- **A skill is versioned with the contract it describes.** CI fails when the contract version
  changes and `skills/` does not.
- **A skill is thin.** It gives the order of work, the rules and what to check. Schemas and
  model-facing descriptions on operations stay the source of truth, and Deals is the worked
  example.
- **Every skill ends in a checker.** `cos ext check` validates what was written with the same code
  the host runs, and the skill requires tests for every tool and automation.
- **Gaps are closed, not worked around.** When the work needs something the platform, the contract
  or the skill does not have, changing them properly is part of the work. A shortcut that fakes it
  in extension code (a direct database write, an outside call past a gatekeeper, a rule enforced in
  a tool) is never acceptable.
- **The skills are not evaluated by an agent harness.** Deterministic code is tested: the checker
  against the host's check, and the version guard. The skills are improved when something goes
  wrong in real use.

## Why
A skill without a checker is advice. A skill out of step with the contract writes broken
manifests. And an agent told to stop at every gap produces half-finished work, while one allowed
to work around gaps produces unsafe work; closing the gap properly is the only good outcome, and
the person doing the work is best placed to decide it.

An eval of fifteen agent runs costs more than fixing a skill when it fails once in use, and the
first real use (Ticketing) comes soon.

## Consequences
- Skills for working on the platform itself stay in the repo's own `.claude/` and are not
  installed into client repos.
- A local check command is needed that shares its code with `extension.check`.
- In a client repo (stage 24) "closing the gap" means something different, because the client's
  agent cannot change the platform. The client-repo skills will have to say what to do there.
