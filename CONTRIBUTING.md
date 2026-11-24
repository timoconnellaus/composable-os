# Contributing to Composable OS

Thanks for helping. This page is for people; coding agents also follow [`AGENTS.md`](AGENTS.md).

## Before you start

- Read [`docs/architecture.md`](docs/architecture.md) and use the words in
  [`CONTEXT.md`](CONTEXT.md). Significant decisions are recorded in [`docs/adr/`](docs/adr/).
- For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Licence and the CLA

Composable OS is licensed under FSL-1.1-ALv2 (see [`LICENSE`](LICENSE) and the licence section of
the [`README`](README.md)). Every contributor signs the [Contributor License Agreement](CLA.md) once.
On your first pull request the CLA bot posts a comment; reply with the sentence it gives you, and
the check turns green. You keep the copyright in your work; the CLA lets the project use it under
the FSL and also under commercial and enterprise terms.

Vendored code (the packages listed in [`UPSTREAMS.md`](UPSTREAMS.md)) keeps its own licence.
Changes to it go upstream where possible, and local changes are recorded in `UPSTREAMS.md`.

## Working on the code

You need Node 24 (`.nvmrc`) and pnpm 10.

```sh
pnpm install
pnpm dev                    # the app on http://localhost:5173, with the runner and a local D1
pnpm lint && pnpm typecheck && pnpm test
```

- Every user action is an **operation** in `packages/core` with zod schemas, a description, a
  permission and a risk class. UI, MCP and extension code call operations, never D1 directly.
- Tests run in workerd. Prefer integration tests against real bindings over mocks.
- Biome formats and lints (`pnpm format`). TypeScript is strict.
- Never commit secrets, account IDs or `.dev.vars`.

## End-to-end tests

The app's Playwright suite (`apps/app/e2e/`) is slow to run whole, so locally you run only the
specs for the area you changed; CI runs everything, split across four runners.

```sh
pnpm --filter @composable-os/app exec playwright test people.spec.ts       # one spec, both sizes
pnpm --filter @composable-os/app exec playwright test deals --project=desktop
```

- **The run starts its own dev server** (`e2e/dev-server.mjs`, on `E2E_PORT`, 5179 by default) and
  refuses to start if that port is taken, so two checkouts never share a database. Set
  `E2E_REUSE_SERVER=1` to run against your own `pnpm dev` instead. The shipped packs the specs use
  are installed once in global setup. If workerd crashes under the run, the output says
  `THE DEV SERVER BROKE`, and a failure at that moment is named as the dev server's, not the
  product's.
- **Desktop runs every spec; the phone project runs only tests tagged `@phone`**:
  `test("…", { tag: "@phone" }, async ({ page }) => …)`, on each test (Biome's Playwright rule
  refuses the option on a `test.describe`). Tag a test when its layout really differs at phone width: the nav drawer, a sheet in place of
  a panel, a table or grid that reflows, touch in place of drag or hover, or a phone-only
  assertion. Most tests are not tagged.
- **One e2e test per user journey, not one per screen.** A new stage adds an e2e test for each
  journey a person takes through it. Rules, edge cases and anything that waits on time (cron
  ticks, delivery lags) belong in integration tests (vitest in workerd), which are fast.

## How CI is laid out

`.github/workflows/ci.yml` runs on every pull request and every push to `main`. A change that
touches only documents (`docs/` or a Markdown file at the root) skips everything but the document
checks. Otherwise these jobs run in parallel, each on its own runner (some on Namespace, see
below):

- **Lint** and **Typecheck** (the typecheck job also builds the landing page).
- **Unit tests**, in eight shards: core in three (vitest `--shard`), the runner, the app in two,
  the gatekeepers, and every other package together. `scripts/ci-unit-shards.mjs` holds the
  layout, balanced by measured time; CI's matrix is generated from it. The last shard takes every
  package the others don't name, so a new package is tested without touching the layout, and
  `pnpm lint` fails if a package with a `test` script would run in no shard or in two.
- **npm packages**: what the release's build job does for npm, on every change: the release
  bundle, every package's tarball (`scripts/release/npm-packages.ts`, where a pack's type
  declarations are emitted, which `pnpm typecheck` does not do), a fresh client repo made and
  built from them (`check-npm-packages.ts`), and `npm publish --dry-run` on each tarball.
- **E2E**: the app's Playwright suite in four shards, the control plane's, and the landing page's.

Two jobs only gather results, and they are the names to require: **Lint, typecheck, unit tests**
(lint, typecheck, every unit shard and the npm packages) and **E2E smoke (Playwright)** (the e2e shards and the
control plane).

### Where the jobs run

CI uses two lanes ([ADR 0630](docs/adr/0630-ci-on-namespace-runners.md)), chosen in one place:
the first step of the `changes` job ("What changed") in `ci.yml`.

- **The fast lane** is the Namespace runner profile `namespace-profile-composable-os`
  (8 vCPU, a cache volume that holds Playwright's browsers). It runs the jobs on the critical
  path: the four e2e shards, typecheck, and the unit shards marked `critical` in
  `scripts/ci-unit-shards.mjs`. The profile runs only eight runners at once across all runs,
  so nothing else goes there.
- **The standard lane** is GitHub's `ubuntu-latest`. It runs every other job (lint, the npm
  packages, the landing page, the control plane, the other unit shards), plus the small jobs
  that only pick lanes, check documents or gather results.
- **Pull requests from forks run everything on `ubuntu-latest`**, always. A stranger's change
  never spends the project's Namespace minutes and never reaches its cache volume. Pull requests
  from this repository's branches and pushes to `main` use both lanes.
- **Only `main` writes the cache volume.** That is set on the runner profile in the Namespace
  account, not in the workflow. Other branches read it.
- Turborepo's remote cache stays off: unit tests cache nothing between runs.
- `release.yml`, `install-test.yml`, `marketing.yml`, `upstream-check.yml` and `cla.yml` run on
  GitHub's runners. npm trusted publishing and provenance need them, and the deploy and test-account
  tokens stay there.

**If Namespace is down** (fast-lane jobs sit queued with no runner, or fail before their first
step), set the repository variable `CI_FAST_RUNNER` to `ubuntu-latest` (Settings → Secrets and
variables → Actions → Variables) and re-run. Every job then runs on GitHub's runners, with no
commit. Delete the variable to go back. `CI_STANDARD_RUNNER` does the same for the standard lane.
A shard that moves lanes, or a new shard on the critical path, is a change to
`scripts/ci-unit-shards.mjs`: measure it first.

To run one unit shard locally, exactly as CI does (`turbo run test` with its filters, so its
packages' dependencies are type-checked first):

```sh
node scripts/ci-unit-shards.mjs --list               # the shards' names
node scripts/ci-unit-shards.mjs --run "core 2/3"
node scripts/ci-unit-shards.mjs --check              # every package's tests in exactly one shard
```

If one shard grows much slower than the others, move packages or change a split count in that
file, using the times in the CI logs (each package's vitest `Duration`).

## Working in parallel

Many pull requests are open at once, so a pull request must not edit a line every other one
edits. Do not edit:

- `CORE_SCHEMA_VERSION`. It is generated from the migration files
  (`packages/db/scripts/schema-version.mjs`, run on install and before `@composable-os/db`'s
  typecheck, test and build). Adding a migration is adding its file (and `src/schema.ts`).
- The migrations in the release golden manifest. The golden leaves them out and the test checks
  them against `packages/db/migrations`. Regenerate the golden only when a Worker's config changes.
- A stage's row in `docs/roadmap.md`, or a block's row in `docs/parallel-work.md`, per build
  step. A roadmap row gives the stage's state when its spec was agreed; a block's row is written
  once, when the block is claimed.
- A rows-read budget, to make room for a migration's tables. A cold call scans `sqlite_master`
  once (the schema cache; query.sql's guard and erase read it too). It has no index, so the scan
  reads a row for every table, index and trigger in the database, and every migration makes it
  longer. Budgets leave that scan out: measure with `packages/core/test/rows-read-meter.ts`
  (`rows` is the path's own rows, `schemaScans` counts the scans apart, and a test bounds it),
  warm the cache unmetered first (`refreshSchemaRegistry`), or derive the bound from
  `SELECT count(*) FROM sqlite_master` (`deals.test.ts`, the runner's `stage6b-rows-read.test.ts`).
  A budget that fails after you add a migration is measuring the schema: fix the test, don't
  raise the number.

Progress is recorded in the stage spec (`docs/stages/NN-*.md`), in its Status section: each build
step adds a bullet of its own under it, saying what it built (the branch or PR, the migrations and
ADRs it used, what is left), and does not rewrite another step's. A spec without a Status section
gets one at its first build step.

## The docs site

The technical docs (`apps/docs`, docs.composableos.dev, [ADR 0930](docs/adr/0930-the-docs-site-generated-from-the-code.md))
are generated from the code, with overviews and guides written beside it.

- **A pull request that adds or changes a pack, a block or an operation updates its overview in the
  same pull request**: `packs/<id>/docs/overview.md`, a capability's `docs/overview.md`
  (Agreements: `packages/core/src/agreements/docs/overview.md`), or the guide in `docs/guides/`.
- **Reference pages are never edited by hand.** Run the generator and commit what it writes:

  ```sh
  pnpm --filter @composable-os/docs generate   # write the pages, the sidebar and llms.txt
  pnpm --filter @composable-os/docs check      # what CI's lint job runs
  pnpm --filter @composable-os/docs dev        # http://localhost:4322
  ```

- CI's lint job fails when a generated page is stale, when a pack, block, core operation or
  gatekeeper has no reference page, when a pack has no overview (nine packs are on the pending list
  in `apps/docs/docs.config.mjs` until theirs are written), when an overview lacks a section, or
  when an internal link is broken; the typecheck job builds the site and checks its links again.
  A change to documents only runs `--check --markdown-only`, which needs no install.
- On a conflict in `apps/docs/src/content/docs/`, `src/sidebar.json` or `public/llms.txt`, take
  either side and run the generator again.

## Pull requests

- Branch from `main`, keep commits focused, and open a pull request against `main`.
- CI (lint, typecheck, tests, build and the end-to-end suite) and the CLA check must be green.
- Describe what changed and why, and anything you deliberately left out.
