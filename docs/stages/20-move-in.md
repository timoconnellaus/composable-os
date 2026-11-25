# Stage 20: Move in

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), ADR [0400](../adr/0400-a-general-host-and-products.md), and in
`~/repos/relationship-os`: `docs/architecture.md`, `docs/parallel-work.md`, `docs/handoff.md`,
`docs/stages/09-rename-licence-landing.md` (the last rename, and how it was done), ADRs 0001,
0012, 0023, 0160 to 0165, 0190, `packages/release/src/legacy.ts`, `packages/sdk/src/contract.ts`.

Status: **spec agreed** (interview 2026-11-20). Nothing else is built beside this stage: it
renames across every file.

## Goal

The Relationship OS repository becomes the Composable OS repository. The platform has its name and
package scope, the Relationship OS brand is gone, and the CRM is the first **product** on the
platform, defined in `products/crm`. The extension contract no longer says `crm`. Nothing is
installed anywhere, so every name changes once, now, with no upgrade path to keep.

## What exists today (from the code)

- `~/repos/relationship-os`, GitHub `timoconnellaus/relationship-os`: `apps/app` (`ros-app`),
  `apps/runner` (`ros-runner`), `apps/control`, `apps/marketing`; 27 packages under
  `@relationship-os/*`, including `create-relationship-os`; `extensions/deals`,
  `extensions/leads`, `extensions/lifecycle`; `evals/`; `scripts/release`.
- 134 ADRs, the highest 0352. Stage specs 00 to 17. Migrations up to 0371. Number blocks are
  claimed in `docs/parallel-work.md`.
- **Nothing is installed and nothing is published.** The GitHub repository has no releases, no
  forks and no stars (checked 2026-11-20). Packages are not on npm.
- The product's name is in code: `DEFAULT_REPOSITORY = "timoconnellaus/relationship-os"`
  (`packages/release/src/github.ts`), the same string in `packages/core/src/operations/update.ts`,
  `BILLING_URL` in `packages/core/src/entitlements.ts`, `REPO_URL` in
  `apps/marketing/src/links.ts`, the `ros-updater` user agent, `ROS_*` variables.
- `packages/release/src/legacy.ts` exists only to upgrade installs made before the last rename:
  it maps `ros-*` names onto `crm-*` ones, knows the old release file names and holds
  `PREVIOUS_REPOSITORIES`.
- The extension contract says `crm`: the host module `codemode:crm` (imported in about 17 files),
  `ctx.crm`, and the `crm_*` SQL views that `query.sql`, dashboards and shipped extensions read.
- The design for the platform is in a separate local repository, `~/repos/composable`: ADRs 0400
  to 0405, stage specs 20 to 28, a glossary, an architecture document and a roadmap.

## Decided at the interview (2026-11-20)

| Question | Decision |
| --- | --- |
| The platform's name | **Composable OS**, at composableos.dev |
| Package scope and repository | `@composable-os/*`, repository `composable-os` |
| How the code gets there | The `relationship-os` GitHub repository is **renamed**. No new repository |
| Cut-over | Now, from `main` as it stands. Nothing else is open |
| The Relationship OS brand | **Retired everywhere**: UI strings, Workers, CLI, release files, docs |
| The CRM product's name | Plain **CRM**. Composable OS is the only brand |
| Worker and resource names | **By product**: `crm-app`, `crm-runner`, and later `ghetto-app` |
| The product's apps | `products/crm/apps/`. The hosted control plane moves there |
| The marketing site | Becomes the **Composable OS site**, in this stage |
| The product definition | **Names only.** No switches for core features yet |
| Licence | Stays **FSL-1.1-ALv2** with the CLA |
| `crm` in the extension contract | **Renamed now**: `codemode:ops`, `ctx.ops`, views `rec_*` |
| Legacy-install code | **Deleted** |
| A bridge release | Not needed: nothing is installed |

## Scope

### The repository
- Rename the GitHub repository `timoconnellaus/relationship-os` to `timoconnellaus/composable-os`.
  History, PRs and CLA signatures stay; GitHub redirects old links.
- Bring the design documents in from `~/repos/composable` as one PR: ADRs 0400 to 0405, stage
  specs 20 to 28, and the new glossary terms.
- Merge the documents. The existing architecture document becomes the body of
  `docs/architecture.md`, with the platform's "What is added" sections after it. The two
  `CONTEXT.md` files become one. The two roadmaps become one table, stages 0 to 28. `AGENTS.md`
  keeps both sets of rules.
- ADRs 0001 to 0352 and stage specs 00 to 17 are history and are left as written, old names
  included. `docs/adr/README.md` says so in one paragraph. ADR 0190 (the last rename) gets a dated
  note pointing at ADR 0400.
- `docs/parallel-work.md` gains the blocks the stage specs here claim.

### Names
| Was | Becomes |
| --- | --- |
| `@relationship-os/*` | `@composable-os/*` |
| `create-relationship-os` | `create-composable-os`, which installs a product (`--product`, default `crm`) |
| The `ros` command | `cos` |
| Workers `ros-app`, `ros-runner`, `ros-gatekeeper-*` | `<product>-app`, `<product>-runner`, `<product>-gatekeeper-*` |
| D1 database and other resources named `ros…` | Named for the product |
| `ROS_*` variables, the `ros-updater` user agent | `COS_*`, `cos-updater` |
| Release files `relationship-os-X.Y.Z.*` | `composable-os-<product>-X.Y.Z.*` |
| "Relationship OS" in UI copy, emails, model instructions | "CRM" where it names the product, "Composable OS" where it names the platform |

A name that depends on the product is never written in a package. It comes from the product
definition.

### The extension contract
- The host module `codemode:crm` becomes `codemode:ops`, and `ctx.crm` becomes `ctx.ops`.
- The SQL views `crm_*` become `rec_*`: `rec_person`, `rec_organisation`, `rec_activity`,
  `rec_task`, `rec_x_deals_deal`, `rec_stage_history` and the rest. One migration drops the old
  views and creates the new ones; the reconciler names extension views the new way.
- Everything that names them follows: the `query.sql` validator's table list, shipped dashboards
  and widgets, Deals' `stageMetrics`, the SDK's in-memory test host, the SDK README, the MCP
  server's instructions, the assistant's prompts, the eval prompts and their recordings.
- `contractVersion` stays 1. There is no earlier version in use to keep working.

### The product definition
- `products/crm/product.ts` exports one typed object: id (`crm`) and label ("CRM"); Worker and
  resource names; the shipped extensions it includes (Deals, Leads, lifecycle); the update
  repository; the billing URL; the strings the UI shows as the product's name.
- The release build, the deploy engine, the installer and the self-updater read names and the
  repository from it. `scripts/release/build-release.ts` takes `--product`.
- A lint script fails when a package outside `products/` contains `relationship-os`,
  `Relationship OS`, `relationshiposcrm`, `ros-`, `ROS_`, `codemode:crm`, `ctx.crm` or a `crm_`
  view name. Its allow list is the historical ADRs and stage specs.

### The product's apps and the site
- `apps/control` moves to `products/crm/apps/control`. It is the hosted CRM's control plane and
  nothing else changes in it but names.
- `apps/marketing` stays where it is and becomes the Composable OS site, deployed at
  composableos.dev: what the platform is, the products built on it (the CRM first), and how to
  install. Its copy is rewritten and read by a person before it is deployed.

### Removed
- `packages/release/src/legacy.ts` and every use of it: the name mapping, the old release file
  names, `PREVIOUS_REPOSITORIES`, `isLegacyState`, and their tests and fixtures.
- Anything else that exists only for installs from before a rename.

### Local folders
- `~/repos/relationship-os` becomes `~/repos/composable-os`. `~/repos/composable` is deleted once
  its documents are merged.

## Out of scope
- Any new feature or operation.
- Splitting core, or moving duplicates, assignment rules or email sync out of it.
- Switches for core features in the product definition.
- Packs as packages, the block registry, the client template (stage 24). Shipped extensions stay
  in `extensions/` until then.
- Publishing to npm.
- Where the hosted CRM is served from once it is live, and what happens to the
  relationshiposcrm.com domain. The billing URL moves into the product definition with its value
  unchanged.

## Acceptance criteria
1. **Repository:** the GitHub repository is `composable-os`; the old address redirects; history
   and PRs are intact; the design documents are merged.
2. **No stray names:** the lint script passes, with only the historical documents allowed.
3. **Fresh install:** the real-account install test (ADR 0168) installs product `crm` with
   `create-composable-os`. The account holds `crm-app`, `crm-runner` and `crm-gatekeeper-*`
   Workers and resources named for the product, and the deployment smoke test passes.
4. **Product names come from one place:** building with a fixture product definition (`demo`)
   yields `demo-app` and `demo-runner` and a UI that says "Demo", with no code change.
5. **Contract:** Deals, Leads and lifecycle use `codemode:ops` and `rec_*` and pass their tests. A
   fixture extension importing `codemode:crm`, and a `query.sql` call naming a `crm_` view, are
   refused with a message that names the new form.
6. **Views:** after migrations, the database has every `rec_*` view and no `crm_*` view. Shipped
   dashboards render the same numbers as before on the seeded data.
7. **Legacy gone:** `legacy.ts` and its uses are deleted and nothing imports them.
8. **Evals:** the scripted authoring, automations and dashboards eval tests pass with the new
   names in prompts and instructions.
9. **Site:** the Composable OS site builds and is deployed at composableos.dev, with copy a person
   has approved.
10. `pnpm lint typecheck test` and e2e pass in CI. `docs/architecture.md`, `CONTEXT.md` and
    `docs/roadmap.md` are the merged documents. `NOTICE` and the CLA name Composable OS.

## Dependencies
- None on other stages. `main` of Relationship OS as it stands.

## Migrations and numbers
Migrations 0380 to 0389 (the view rename). ADRs 0400 to 0409 are this design's block (0400 to
0405 used).

## Suggested build order
1. In the existing repository, before any rename: the product definition and the lint script with
   an empty rule list, names unchanged. Everything still passes.
2. Delete the legacy-install code.
3. The contract rename: module, context and views, then everything that names them.
4. The scope, CLI, Worker, variable and release file names, read from the product definition.
5. "Relationship OS" out of every string. Turn the lint rules on.
6. `apps/control` to `products/crm/apps/control`.
7. Rename the GitHub repository and the local folder. Merge the design documents.
8. The Composable OS site, and its deploy to composableos.dev.
9. The real-account fresh install.

Steps 2 to 6 are separate commits so each can be reviewed alone. Step 7 changes something outside
the repository and is done by a person, or with their go-ahead at that moment.

## Notes from the build session's point of view
- Three names were chosen by this spec, not at the interview, and can change without another
  interview: the `cos` command, the `COS_` variable prefix, and the release file pattern.
- If one install of the old kind turns up, it is reinstalled fresh. That was agreed.

## Status

- **All steps** — built — PR #76 — Move in (still needs a human: the repository rename, the site's deploy and the real-account install).
