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

- **Desktop runs every spec; the phone project runs only tests tagged `@phone`**:
  `test("…", { tag: "@phone" }, async ({ page }) => …)`, on each test (Biome's Playwright rule
  refuses the option on a `test.describe`). Tag a test when its layout really differs at phone width: the nav drawer, a sheet in place of
  a panel, a table or grid that reflows, touch in place of drag or hover, or a phone-only
  assertion. Most tests are not tagged.
- **One e2e test per user journey, not one per screen.** A new stage adds an e2e test for each
  journey a person takes through it. Rules, edge cases and anything that waits on time (cron
  ticks, delivery lags) belong in integration tests (vitest in workerd), which are fast.

## Pull requests

- Branch from `main`, keep commits focused, and open a pull request against `main`.
- CI (lint, typecheck, tests, build and the end-to-end suite) and the CLA check must be green.
- Describe what changed and why, and anything you deliberately left out.
