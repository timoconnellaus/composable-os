# Stage 21: Extension skills

Read first: [`AGENTS.md`](../../AGENTS.md), [`CONTEXT.md`](../../CONTEXT.md), ADRs
[0404](../adr/0404-behaviours-are-the-vocabulary.md) and
[0405](../adr/0405-skills-ship-with-the-platform.md), and in the code after stage 20:
`packages/sdk/README.md`, `packages/sdk/src/` (`contract.ts`, `manifest.ts`, `behaviour.ts`,
`automation.ts`, `automation-check.ts`, `testing.ts`), `extensions/deals/`, `extensions/leads/`,
`docs/stages/03-extensions.md`, ADRs 0023, 0024, 0025, 0100, 0130.

Status: **built** (2026-11-20; spec agreed at the interview the same day). Builds on stage 20. What
the build decided is in ADR 0405, "As built".

## Goal

An agent in a checkout of the Composable OS repository is asked for a new shipped extension. It
loads a skill, writes the extension the way Deals is written, runs one command that tells it what
is wrong, fixes that, and finishes with an extension that passes the same checks the host runs,
with tests. When the work needs something the platform does not have, the agent changes the
platform properly as part of the work. It never takes a shortcut.

## What exists today (from the code)

- **The contract:** `defineExtension` in `@composable-os/sdk`, with the host module
  `codemode:ops` (after stage 20). `extensions/deals/index.ts` is the fullest example, with
  `automations.ts`, `tools.ts`, `dashboards.ts` and tests beside it.
- **Checks in the host:** `extension.check` runs typecheck, contract validation, formula checks and
  a dry-run reconcile (stage 3). It runs inside a deployment, on the extension workspace.
- **Checks in the SDK:** `automation-check.ts` (static checks on automations) and `testing.ts`
  (`createTestHost`: in-memory host modules that enforce the declared permissions, run tools and
  run automations start to finish).
- **Skills:** the repository's `.claude/skills/` holds one unrelated skill (`animate`). What an
  agent needs for extensions is spread over `AGENTS.md`, the SDK README and Deals.
- **Limits already written down:** extensions cannot ship UI, run background code only through
  automations, and a tool's calls are separate operations, not one transaction (stage 15).

## Decided at the interview (2026-11-20)

| Question | Decision |
| --- | --- |
| Who the skills are for, first | An agent in the Composable OS repository writing shipped extensions (Ticketing, Content) |
| How many | **Two**: `write-extension` and `add-automations-tools-dashboards` |
| Packaging | A plain `skills/` folder, linked into `.claude/skills/` |
| Other agents | The skills work for Codex and others, not only Claude |
| The check command | `cos ext check <dir>` and `cos ext test <dir>` |
| An eval of the skills | **None.** Deterministic code is tested; the skills are improved when something goes wrong in use |
| When the platform lacks something | Changing the platform, the contract or the skill is fine and is part of the work. Shortcuts and workarounds are not |
| Tests | Required: at least one per tool and per automation |

## Scope

### Two skills, in `skills/`
- **`write-extension`**: a new extension from a request. Choosing an id; objects, fields and
  formulas; relations to base records and other extensions' objects; `permissions`; indexes; seeds;
  views, record tabs and panels; navigation; settings; `dependsOn`; adding fields to another
  extension's objects without changing it; and **behaviours** (`stages` today), in a section each
  later behaviour adds to.
- **`add-automations-tools-dashboards`**: `defineTool` and its risk classes; triggers, steps and
  what an automation must declare; dashboards and widgets over `rec_*` views; click-through.

Each skill has the same parts, in this order: when to use it; the steps; the rules; the check
command and how to read its output.

### How a skill is written
- It points at code, it does not copy it. Field types come from `field-types.ts`; the worked
  example is Deals, by file and section.
- It states the rules with the reason for each: no writes to D1; no outside access except through
  a gatekeeper; no change to identity or approval policy by an extension; no hook on a write; no
  UI in an extension; several writes in a tool are not one transaction, so a tool must be safe to
  run again (as `leads.convert` is).
- **It says one thing about gaps.** If the work needs something the platform, the contract or the
  skill does not have, changing them is fine and is part of the work, done properly: a behaviour
  in the host, a gatekeeper, a core operation, an ADR where `AGENTS.md` asks for one, and the
  skill updated to match. What is never acceptable is a shortcut or workaround that fakes it in
  extension code.
- It requires tests: at least one per tool and per automation, written with `createTestHost`.
- It is short enough to read in full each time.
- It is plain Markdown with the standard skill frontmatter and nothing Claude-specific in its
  steps. `AGENTS.md` points at `skills/` so other agents find it.

### The check command
- `cos ext check <dir>` runs outside a deployment what `extension.check` runs inside one:
  contract validation, typecheck, formula checks, automation checks, and a dry-run reconcile
  against an empty local database with the core schema applied.
- The checking code is shared with the host operation, not copied. The same manifest gives the
  same issues from both.
- Output is a list of issues with a file, a path into the manifest, a message and, where there is
  one, the fix. Exit code 0 only when there are none.
- `cos ext test <dir>` runs the extension's Vitest tests.

### Versioning
- `skills/` carries the contract version it describes. CI fails when the SDK's `contractVersion`
  changes and `skills/` does not.
- The layout is chosen so installing the skills into a client repo (stage 24) needs no rewrite.

## Out of scope
- An eval of the skills. The existing authoring eval in `evals/extensions` is left as it is.
- Skills for client apps, packs, blocks, screens or migrations (later stages).
- The runtime authoring path over MCP. It uses the same contract and the server's own
  instructions; the skills say so in one line.
- A Claude Code plugin package (stage 24, read from current documentation then).
- New behaviours. The behaviours section covers `stages` only until stage 25.
- Any change to the contract.

## Acceptance criteria
1. **Two skills** exist in `skills/` with the four parts each, load as skills in a checkout, and
   are pointed at from `AGENTS.md`.
2. **Same issues:** for a set of broken fixture extensions (a bad formula, an undeclared
   permission, a relation to a missing object, an automation step that writes what it did not
   declare, a stage rule naming a missing field), `cos ext check` and the host's
   `extension.check` report the same issues.
3. **Deals, Leads and lifecycle pass** `cos ext check` and `cos ext test` unchanged.
4. **Version guard:** changing `contractVersion` without touching `skills/` fails CI.
5. **Used once:** one small extension is written from a plain request with the skills, by an agent
   that has not seen this spec, and passes the check and its tests. What it got wrong on the way is
   fixed in the skill before the stage is done.
6. `pnpm lint typecheck test` pass in CI. `CONTEXT.md` (Skill) and `docs/architecture.md`
   (Skills) are true. ADR 0405 is amended as built.

## Dependencies
- Stage 20: the skills are written against the renamed contract (`codemode:ops`, `rec_*`) and the
  `cos` command.

## Migrations and numbers
No migrations. ADR 0405.

## Suggested build order
1. Factor the checks out of the host operation and add `cos ext check` and `cos ext test`, with
   the same-issues test.
2. `write-extension`.
3. `add-automations-tools-dashboards`.
4. The version guard.
5. The one trial extension, and the fixes it leads to.

## Status

- **All steps** — built — PR #78 — Extension skills, cos ext check and cos ext test.
