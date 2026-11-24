# ADR 0630: CI's critical path on Namespace runners; forks, releases and deploys on GitHub's

Status: accepted, 2026-11-23 (`ci/namespace-runners`).

## Context
CI (`.github/workflows/ci.yml`) ran 19 jobs on GitHub's 4-vCPU runners, and a run took 10 to 11
minutes (589 to 644 s over three green runs on 2026-11-23). The slowest e2e shard set that time
(564 to 626 s of it). Typecheck took about 305 s and the slowest unit shards 330 to 400 s, all of
it CPU-bound work. Per-job setup (checkout, pnpm, Node, install, Playwright's browser) was only
25 to 45 s, and GitHub started each job within one or two seconds.

The owner connected the repository to Namespace (namespace.so) and made a runner profile,
`namespace-profile-composable-os`: Linux amd64, 8 vCPU, 16 GB, Ubuntu 24.04, a 50 GB cache volume
with caching of container images, git mirrors, toolchains and action downloads. The repository
is public. That raises the questions below.

- **Capacity.** A Namespace workspace runs a fixed amount of vCPU at once (64 vCPU on the Team
  plan, which is eight of these runners). Jobs over it wait in the queue. Our first run with all
  17 working jobs on the profile proved it: eight started, the others waited up to 315 s, and the
  run took 497 s although no job took more than 322 s.
- **Strangers.** Anyone can open a pull request from a fork. Its jobs must not spend the
  owner's Namespace minutes or read and write the cache volume that `main` uses.
- **Cache writes.** With a runner profile, Namespace sets which branches may write the cache
  volume on the profile itself (the cache volume's configuration, "Show Advanced features",
  the branch names). The `nscloud-cache-allow-commit-from-<branch>` runner labels belong to
  the other way of choosing a runner, by machine labels, and cannot be added to a profile.
  The workflow cannot enforce the rule itself.
- **Releases.** npm trusted publishing and provenance work only on cloud-hosted runners
  ("Self-hosted runners are not currently supported", docs.npmjs.com/trusted-publishers), and
  to GitHub a Namespace runner is self-hosted.

## Decision

### Two lanes, chosen in one place
`ci.yml`'s first job (`changes`, "What changed") picks two runners and every other job names one
of them:
- **fast**, the Namespace profile, takes the jobs on the critical path: the four app e2e shards,
  typecheck, and the unit shards marked `critical` in `scripts/ci-unit-shards.mjs` (core 2/3 and
  the runner). That is seven runners per run, so a run starts all of them at once, with one to
  spare.
- **standard**, `ubuntu-latest`, takes every job that finishes well before the e2e shards do on
  Namespace: lint, the npm packages, the landing page's and the control plane's Playwright, and
  the other six unit shards.
- `changes` itself, `docs` (the documents fast lane) and the two jobs that only gather results stay
  on `ubuntu-latest`. They take seconds. GitHub starts them in one or two, and a Namespace runner
  took about ten to start.

The repository variables `CI_FAST_RUNNER` and `CI_STANDARD_RUNNER` replace either lane without a
commit. Setting `CI_FAST_RUNNER=ubuntu-latest` puts CI back on GitHub's runners (if Namespace is
down, for example). Setting `CI_STANDARD_RUNNER=namespace-profile-composable-os` puts everything
on the profile, which is worth it only once the workspace can run about seventeen runners at once.

Required check names do not change: every job keeps its `name:`.

### The fork rule
A pull request whose head repository is not this repository runs both lanes on `ubuntu-latest`,
whatever the variables say:

```yaml
FORK: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}
```

A pull request whose head repository was deleted has no `full_name` and counts as a fork. Pushes
to `main` and pull requests from this repository's branches use the lanes. Those branches belong to
people who can already push here.

### The cache volume, and who may write it
The shared setup action (`.github/actions/setup`) puts only Playwright's browsers on the cache
volume (`namespacelabs/nscloud-cache-action@v1`, `cache: playwright`). Measured, that took the
browser install from 10-12 s to 5-7 s. The pnpm store is not on the volume: an install from a
warm store there took 12-14 s in all seven jobs measured, against 8-9 s downloading into an empty
local one. The git-mirror checkout action is not used, because `actions/checkout` took 1 to 3 s.
The setup action detects the runner by `runner.environment`. On GitHub's runners it does what CI
did before: setup-node caches the pnpm store in GitHub's cache, and the browsers download.

**Only `main` may write the volume.** This is set on the profile's cache volume (its advanced
settings, the branch allow-list `main`), which only the owner can change. Until it is set, every
branch's run writes the volume, and the runner's log says `Cache mode: write`. Fork pull requests
never reach the volume (the fork rule). A job that fails does not commit to the volume either
(Namespace commits a cache generation only when the job exits cleanly).

### No Turborepo remote cache for tests
Turborepo's remote cache (Namespace's `setup-turbocache`) stays off. CI deliberately caches
nothing between unit-test runs (`ci-unit-shards.mjs`), and a Turbo cache once hid a stale
golden file here. Caching `typecheck` or builds would be a separate proposal with its own
evidence.

### What stays on GitHub's runners
- `release.yml`, all of it: trusted publishing and provenance need GitHub's runners, and the build
  job's attestation and the smoke install stay alongside them (a comment in the file says so).
- `install-test.yml`: it holds the Cloudflare test account's token, runs nightly and from the
  release (where it must stay on GitHub's runners), and spends its time waiting on Cloudflare,
  not on CPU.
- `marketing.yml`: it deploys the public site with a Cloudflare token, runs only when the site
  changes on `main`, and its build takes about a minute. A Namespace runner is an ephemeral VM,
  and GitHub hands it the job's secrets as it would a GitHub runner. Even so, saving seconds on a
  rare deploy is not worth placing the token on a third party's machines. Editing the file would
  also redeploy the site, since it triggers on its own path.
- `upstream-check.yml`: weekly, informational, Node and git only, no install. There is nothing to
  speed up.
- `cla.yml`: `pull_request_target` on strangers' pull requests.

### The knobs left alone
The 8 vCPU are used where they matter without any setting changing. Vitest sizes its worker pool
to the machine, and the critical unit shards are each a single package. The app's e2e suite keeps
one Playwright worker per shard, because its specs share one database and the org-wide approval
policy, and four shards. A fifth shard would fill all eight Namespace runners with one run, and
add another cold dev-server start per run, which is where the known "fetch failed" flake happens
(being fixed separately). `--concurrency=2` on the gatekeepers and the rest stays, because those
shards still run on 4-vCPU GitHub runners.

## Consequences
- With the two lanes, a run on a branch of this repository took 383 s and 354 s, against 589
  to 644 s before (and 527 to 592 s for runs on GitHub's runners in the same hour). The
  required check "Lint, typecheck, unit tests" finished at +301 to +320 s (+343 to +408 s
  before), and "E2E smoke (Playwright)" at +354 to +383 s (+589 to +644 s). The PR that made
  this change has the table per job.
- The critical path is now the slowest app e2e shard on Namespace (300 to 357 s), then the
  GitHub-lane unit shards (core 3/3 and the app's, up to about 300 s, which vary by ±50 s from
  run to run on GitHub's runners).
- Runs from several branches at once share the workspace's eight runners. A second run that starts
  while one holds seven waits for runners, so in a busy hour a run can take longer than these
  numbers. The fix is on the account side: more concurrent vCPU (the Business plan has 160).
- Changing the shard layout or a job's lane means measuring again. The numbers behind the current
  split are in `scripts/ci-unit-shards.mjs` and here.

## Note (2026-11-24, ADR 0901)
- **A client repository's app workflow needs a macOS runner**, for the iPhone build (stage 63's
  template workflow, `templates/client/.github/workflows/app.yml`, the runner a repository
  variable, default the repository host's own). That is the client repository's CI, not this
  one's: the platform's own CI is unchanged and stays on Linux runners.
