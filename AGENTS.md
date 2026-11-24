# AGENTS.md

Composable OS: a platform for composing products on a trusted host on Cloudflare. The first product
is the CRM (`products/crm`). Start with [`docs/architecture.md`](docs/architecture.md), use the
vocabulary in [`CONTEXT.md`](CONTEXT.md), and respect the decisions in [`docs/adr/`](docs/adr/).

## Working in a stage

- Each stage runs as: **interview** (agree how it works) → **spec** in `docs/stages/NN-name.md` → a
  **build session** in its own worktree → review → merge.
- The specs of stages 21 to 28 are proposals. A stage is not built until its interview has settled
  the questions listed at the end of its spec and its status in `docs/roadmap.md` says "spec agreed".
- You will be pointed at a stage spec in `docs/stages/`. Build what it says. Its acceptance criteria
  are the definition of done.
- Record what a build step built in the spec's Status section, not in `docs/roadmap.md` or
  `docs/parallel-work.md` (CONTRIBUTING.md, Working in parallel).
- If the spec turns out to be wrong or ambiguous, don't silently diverge. Stop and ask, or record the
  deviation and why in the PR description.
- A new significant decision gets an ADR (`docs/adr/NNNN-title.md`, next free number). If a decision
  changes, amend the old ADR with a dated note rather than deleting it.
- Keep `docs/architecture.md` and `CONTEXT.md` true when you change what they describe.

## Skills

Step-by-step instructions for common work are in [`skills/`](skills/), one folder each with a
`SKILL.md` (plain Markdown, for any agent; linked into `.claude/skills/`). Skills taken from other
projects are not in `skills/`: they are copied unchanged into `.claude/skills/` (`UPSTREAMS.md`).
Read the skill in full before starting the work it names.

- Writing a new extension, a new kind of record, or fields on other objects:
  [`skills/write-extension/SKILL.md`](skills/write-extension/SKILL.md).
- Adding tools, automations or dashboards to an extension:
  [`skills/add-automations-tools-dashboards/SKILL.md`](skills/add-automations-tools-dashboards/SKILL.md).
- Loading a company's existing posts into its host: [`skills/import-content/SKILL.md`](skills/import-content/SKILL.md).
- Moving a studio's courses, videos and students from a course platform:
  [`skills/import-courses/SKILL.md`](skills/import-courses/SKILL.md).
- Moving a gym's exercise bank, programs and past training:
  [`skills/import-programs/SKILL.md`](skills/import-programs/SKILL.md).

- Any work on the site (`apps/marketing`): the `landing-page-generator` skill
  ([`.claude/skills/landing-page-generator/SKILL.md`](.claude/skills/landing-page-generator/SKILL.md),
  vendored, see `UPSTREAMS.md`). It ends in its three checks on the built page.

The first two end in `pnpm cos ext check packs/<id>` and `pnpm cos ext test packs/<id>`: the
checks the host runs on an extension, and its tests. When the platform, the contract or a skill
lacks what the work needs, changing it properly is part of the work; a shortcut or workaround in
extension code is never acceptable (ADR 0405).

## Rules that hold everywhere

- **Operations first.** Anything a user can do is an operation in the registry (`packages/core`) with
  zod schemas, a model-facing description, a permission and a risk class. UI, MCP and extension code
  call operations. They never write to D1 directly.
- **Core vs extension schema.** Core tables are `core_*` and change only via migrations in
  `packages/db`. Never touch `x_*` tables from migrations.
- **No ambient authority for extension code.** Dynamic workers run with `globalOutbound: null` and
  get only host modules. External access goes only through gatekeepers.
- **Identity and policy are not AI-configurable.** Auth secrets are env-only. Loosening approval
  policy is human-admin-only.
- **Code asks for a model role, never a model id.**
- **A name that depends on the product is written once,** in `products/<id>/product.ts` (for a
  client product, its repository's `product.ts`: `cos deploy` names its host from it at the first
  install and sets its label, issue #155). Packages
  name Workers and resources `cos-*`; a release, the installer and the UI read the product's names
  from its definition. `pnpm lint` fails on a retired name (`scripts/check-stray-names.mjs`).
- **Every operation declares its audiences.** `staff` is the default. Opening an operation to
  `customer` or `public` is a reviewed change (ADR 0402).
- **Rules live in the host.** Prices, places and what a customer may see are enforced by
  behaviours and the visibility seam, never by a block or a client app (ADRs 0401, 0404).
- **Client code never opens the database.** A client app reaches the host through the typed client
  only (ADR 0403).
- **A new behaviour is platform work.** A pack composes behaviours and does not hook writes.
- **Web and native share logic, not screens.**
- Vendored code (see `UPSTREAMS.md`) is edited deliberately. Note local changes in `UPSTREAMS.md`.

## The site

- **Keep the site current.** [`apps/marketing/SITE.md`](apps/marketing/SITE.md) says what
  composableos.dev claims, section by section; read it, not the page's source, to see whether
  your change touches the site. When a change adds or alters something the site describes (a pack
  or piece it lists, something marked "in design" that is now built, a connection, the commands in
  the developer section, what the offer covers), update the site and `SITE.md` in the same PR.
- **Use the skill.** Site work follows `landing-page-generator`: one goal and one call to action,
  only proof that can be sourced, and its three checks on the built page
  (`apps/marketing/README.md`). The angle and the look are in ADR 0465.

## Tooling

- pnpm + Turborepo. Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before pushing.
- Biome formats and lints. Don't add ESLint or Prettier.
- Tests run in workerd via `@cloudflare/vitest-pool-workers`. Prefer integration tests against real
  bindings over mocks.
- TypeScript strict. No `any` without a comment saying why.
- Generate Worker `Env` types with `wrangler types`. Don't hand-write them.
- E2E: locally run only the specs for the area you changed
  (`pnpm --filter @composable-os/app exec playwright test <spec>`); CI runs them all. A new stage
  adds one e2e test per user journey, not one per screen; tag a test `@phone` only when its phone
  layout differs (see `CONTRIBUTING.md`, End-to-end tests).

## Git

- Work on a branch, open a PR against `main`, and keep commits focused.
- Don't commit account IDs, secrets or `.dev.vars`.
