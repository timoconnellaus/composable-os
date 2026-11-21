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

## As built (stage 21, 2026-11-20)

- **Where the shared check is.** The checks on source (allowed imports and transpile, the type
  check against the SDK) moved out of cos-runner into `@composable-os/extension-check`; the runner
  imports them. The checks on the manifest (contract, formulas, automations, dry-run reconcile)
  are `checkEvaluated` in `packages/core`, which `extension.check` and `cos ext check` both call.
  The declarations for the type check and the SDK bundle are built by one function
  (`sdk-artifacts.ts`), at the runner's build time and when the command runs.
- **What the command does differently, and why.** It evaluates the extension in Node, not in a
  Dynamic Worker: the code is the caller's own and runs with the caller's authority, as its tests
  do. Its database is Node's built-in SQLite with `packages/db/migrations` applied, behind the D1
  methods the Kysely dialect uses. An extension that names another's objects (Leads names
  `deals.deal`) has that extension read from the directory beside it and reconciled first, as it
  would already be installed in a deployment.
- **The same issues are held by a test, not by hope.** Five broken fixture extensions and one list
  of expected issues; `packages/extension-check/test/check.test.ts` holds the command to the list
  and `apps/runner/test/same-issues.test.ts` holds `extension.check` to it.
- **`cos ext test` also checks that tests exist.** Before running Vitest it fails when a tool or an
  automation of the extension is named in no test file. The interview required a test for each;
  this is the deterministic part of that rule.
- **`cos` in the repository is `pnpm cos`.** It builds the CLI and runs it. `cos ext` is a separate
  chunk of the CLI's bundle that needs `typescript` and `esbuild` at run time, so
  `npx create-composable-os` stays dependency-free and says where `cos ext` runs. How a client
  repo gets the command is decided in stage 24.
- **The version guard is part of `pnpm lint`** (`scripts/check-skills-version.mjs`):
  `skills/CONTRACT_VERSION` and a "contract version N" line in each `SKILL.md` must equal the
  SDK's `CONTRACT_VERSION`.
- **There is no `dependsOn` key.** The stage spec listed it among what `write-extension` covers;
  the contract has none and this stage does not change the contract. The skill says what is true:
  naming another extension's object is the dependency, and that extension is installed first.
- **Used once.** An agent given only a plain request (renewals on organisations, a task for the
  owner a month before) and the skills wrote an extension that passed `cos ext check` and
  `cos ext test` first time. Nothing failed; what it had to guess was fixed in the skills: look
  for an existing extension that already models the request, the sign of `offsetDays`, whether an
  automation ships on or off, reading an operation's input schema before calling it, and what the
  test host does not evaluate. The trial extension was not kept.
