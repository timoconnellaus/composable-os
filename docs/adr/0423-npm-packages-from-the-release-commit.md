# ADR 0423: The npm packages, built from the release commit

Status: accepted, 2026-11-21 (stage 24 build, step 4). Builds part of
[ADR 0401](0401-platform-packs-screens.md).

## Context
The stage 24 spec decided that the platform's packages a client repo needs are public npm packages
under `@composable-os` (the runtime client, the SDK, the `cos` command and each pack), published by
the release workflow from the same commit as the release bundle, with provenance, and that the host
is still deployed only from the verified bundle. Nothing is on npm today, and the packages export
TypeScript source.

## Decision
- **The packages:** `@composable-os/client`, `@composable-os/sdk`, `@composable-os/product`
  (`defineClientProduct`, which `product.ts` imports), `@composable-os/pack-<id>` for each pack,
  `@composable-os/cli` (the bundled `cos`, with the SDK source and migrations its `cos ext check`
  needs) and `create-composable-os` (one bin that runs `cos create`). Licence FSL-1.1-ALv2, as the
  source they come from; blocks are not on npm, they ship inside the release (ADR 0424).
- **Built, not copied:** `scripts/release/npm-packages.ts` compiles each package's TypeScript to
  `dist/` (JavaScript and declarations, `exports` pointing at them), keeps the SDK's `src/` too,
  pins `workspace:` dependencies to the release version, and packs each with `npm pack`.
- **Checked from a fresh folder:** `scripts/release/check-npm-packages.ts` installs the CLI from
  its tarball in a temporary folder outside the repository, runs `cos create --with-mobile`
  against the release built in the same run, installs the new repo with every `@composable-os`
  package from the tarballs (third-party packages from the registry), runs `cos ext check` on an
  extension there, type-checks the web and mobile apps and builds the web app.
- **In the release workflow:** the `build` job does both and runs `npm publish --dry-run` on every
  tarball, then uploads them. The `npm` job publishes those tarballs, with `--provenance`, only
  when the repository variable `NPM_PUBLISH` is `true`, using npm's trusted publishing (GitHub
  OIDC). No npm token is created, stored or referenced. The old job that published the CLI with
  an `NPM_TOKEN` secret is replaced.

## Checked
Run locally for 0.0.2 from this branch, after the merge of stage 25: eight tarballs built; the
fresh-folder check installed them, created a client repo (with the mobile app) from the locally
built release, passed `cos ext check` on an extension there, type-checked both apps and built the
web app, with no file from this checkout; `npm publish --dry-run` accepted a tarball. The first
run found that `cos ext check` could not type-check against the SDK source inside node_modules;
it now works from a copy outside it, with `zod` (a dependency of the CLI) beside it.

## Consequences
- Before the first publish, a person claims the `@composable-os` organisation and the
  `create-composable-os` name on npm, adds `release.yml` as each package's trusted publisher, and
  sets `NPM_PUBLISH` (`docs/deploying.md`, "Publishing to npm").
- Every release now carries a semver promise for these packages (ADR 0401's consequence).
- The check needs the npm registry for third-party packages; it is a release-time check, not part
  of `pnpm test`.

## Amended 2026-11-21 (client releases and environments)
A release now carries every pack in the repository (ADR 0420 as amended), so the
`@composable-os/pack-<id>` packages published from a release commit and the packs its host can
install are the same set: every `packs/<id>/`. `npm-packages.ts` already packed every pack folder;
what changed is that each of them is now also in the release's runner and `packs.json`.
