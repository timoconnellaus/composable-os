# ADR 0901: Publishing from the client's own store accounts, built and signed in its CI

Status: accepted, 2026-11-24 (stage 63 steps 1 to 3, `feat/stage-63-app-cli`). Notes
[ADR 0630](0630-ci-on-namespace-runners.md); builds on [ADR 0166](0166-no-telemetry.md),
[ADR 0610](0610-three-homes-for-a-client-hosted-by-default.md) and
[ADR 0900](0900-the-apps-identity-brand-and-listing-from-product-ts.md).

## Context
Stage 63's interview decided that each client's app is published from the client's own store
accounts, with us invited as a member who may upload and release (decision 2); that a person on
our side releases each version to the public once the client has said yes (decision 4); and that
the signing files and the store accounts' passwords are the client's, never an AI's and never in a
repository. The builds must be repeatable and signed with keys a person set, and a host must know
which builds exist (so a later step can keep serving the API version they use).

## Decision
- **The client's own accounts.** The client opens an organisation account in each store, pays for
  it, keeps its passwords and invites our person with a role that may upload and release. We hold
  only what the stores issue for uploading (the iPhone store's API key, the distribution
  certificate made with it, the Android upload key, the Android store's upload account key), as
  CI secrets a person sets and the client can revoke.
- **Built and signed in the client repository's CI**, with the app framework's own local build
  tools (`expo prebuild`, then the platforms' own: Gradle on a Linux runner, Xcode on a macOS
  runner), never an outside build service. The template carries the workflow,
  `.github/workflows/app.yml`:
  - It runs on a person's manual run (choosing the environment and the stores) or a tag
    `app-v<version>` on `main`, never on a pull request, so a fork's pull request gets no secret.
    The first job refuses a commit that is not on `main` and a tag that is not
    `app-v<mobile.app.version>`.
  - Every job that holds a secret uses a protected CI environment whose run a person approves:
    **`app-upload`** for the two build jobs (the store keys only) and **`app-record`** for the two
    small Linux jobs that run only `cos` (the deploy credential): `check` (`cos app check`, then
    `cos app build-info` for the build number) and `record` (`cos app record`).
  - Each job checks its own secrets first with `cos app credentials --check --for <job>`, which
    fails with the names that are missing and the command that sets each, and never a value.
  - The macOS runner is a repository variable (`APP_MACOS_RUNNER`), default the repository host's
    own. **ADR 0630's note:** the platform's own CI is unchanged (Linux runners); only a client
    repository's app workflow needs a macOS runner.
- **Uploads go to the testing tracks only.** The iPhone build is exported with
  `destination: upload` (the platform's own upload, with the API key). The Android build goes to
  the `internal` track with `cos app upload --platform android`, one edit of the store's
  publishing API: the bundle, the release notes from the listing, optionally the listing's text
  (`--listing`), then commit. No command can name another track, and none releases to the public.
- **A person releases**, in each store's console, after the client's yes, recorded on the
  release's pull request or tag. A staging app goes to testing tracks only.
- **The host records each build**: `cos app record` writes `core_app_build` (environment,
  platform, version, build number, API version, store id, commit, when, supported) with the deploy
  credential, as the deploy path writes `core_install`. No operation writes it. Re-recording a
  build is a no-op; a build number already used, one lower than the platform's highest, or a store
  id other than the recorded one is refused. `cos app build-info` gives the next build number (the
  highest recorded in that environment, across both platforms, plus one; one CI run uses one number
  on both) and the API version the app's generated client was made against (its `API_VERSION`).
- **`cos app check` refuses a key in the repository**: a file named like one (`.p8`, `.p12`,
  `.jks`, `.keystore`, provisioning profiles) or holding a private key or a store account key.

## Deviations from the spec
- **Two jobs hold the deploy credential, not one.** The build number is read from the host's
  records before the builds, and recorded after them, and a job cannot pause between the two. Both
  are small Linux jobs that run only `cos` from a commit on `main`; the build jobs, which run the
  build tools and their plugins, never hold it. A person approves `app-record` twice per run.
- **`cos app upload`** is a command the spec does not name: the Android store has no upload tool of
  its own on a runner, and an outside one would be a product the repository does not name.
- **The iPhone store's listing text is not uploaded by the workflow.** Its listing belongs to a
  version and is entered by the person who submits it for review, from the files `cos app check`
  checked. Its upload by API is left for a later step.
- **The Android listing is sent only with `--listing`** (the workflow's `listing` input, off by
  default): that store's listing is not per track, so a listing sent with a testing build could
  reach the public listing once reviewed. The runbook asks for the store's managed publishing to be
  on, so nothing goes out until a person publishes it.

## Consequences
- `core_app_build` itself is core migration 1370 (stage 63 step 4). Until a host has it,
  `cos app build-info` starts at build 1 and `cos app record` refuses, saying the host must be
  upgraded first. The columns this step writes are the ones `packages/release/src/app-builds.ts`
  lists; step 4's migration must match them.
- For a hosted client the repository and its CI secrets are ours while hosted (stage 46): revocable
  upload keys, never the client's passwords or the store's own signing key. A client moving to its
  own account sets them again in its own repository.
- Not yet tried against the real stores: no store account, signing key or upload existed when this
  was built. The first client's first build (stage 63 step 9) is the first real run.

## Tests
`packages/release/test/app-builds.test.ts` (core_app_build over the D1 API on the fake Cloudflare
API), `packages/create-composable-os/test/app.test.ts` (`credentials` names every secret the
workflow reads and prints no value; `--check` fails with the missing ones; the workflow's triggers,
environments and which job holds which secret; `build-info` and `record` against a host; the
Android upload's calls against a fake store, with a real key's signature checked).
