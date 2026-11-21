# Coordinator handoff

For a fresh session taking over the coordinating role: interviewing the owner, writing and amending
specs and ADRs, starting build sessions, reviewing what they produce. Written 2026-11-21 with
nothing in progress: every build session has finished its turn and is idle.

Read this, then [`handoff.md`](handoff.md) for the standing build rules (some of it predates the
platform and is stale; where the two disagree, this file is newer), then
[`roadmap.md`](roadmap.md), then [`../AGENTS.md`](../AGENTS.md) and [`../CONTEXT.md`](../CONTEXT.md).

## What this is

Composable OS (composableos.dev) is a platform for composing software products for companies. A
trusted host owns identity, one operations registry, approvals, audit and gatekeepers. Products are
built from extensions on a typed contract. The CRM is the first product. Ghetto Movement, a gym, is
the first client product: it wants to sell event tickets, and later to leave Mindbody.

The direction is in ADRs 0400 to 0405. The plan is stages 20 to 40 in the roadmap. Nothing is
installed anywhere except the site, so renames and schema changes are cheap now and the owner has
chosen, each time, to do them now.

## How the owner works

- **One stage at a time: interview → spec → build → review → PR → merge.** Interviews run ahead of
  builds so an agreed spec is always waiting.
- **Interviews use the `interviewer` skill and its `kim` CLI.** Give each question a recommended
  default and the short reason. The owner accepts most defaults in one click and pushes back in the
  interview's chat when something is overthought. Answers arrive through the skill's hooks.
- **Simple beats thorough.** The owner removed an eval harness ("test the deterministic code, fix
  the skill when it goes wrong") and a gap-logging scheme ("don't take shortcuts" was enough).
  When asked to choose, they have said "whatever is best long term": decide, say what you decided
  and why, and say it can be overridden.
- **Who builds what.** The coordinating model writes specs and ADRs, builds or reviews each
  stage's spine, and reviews everything. Opus subagents build the rest. Each spec's "Suggested
  build order" ends by naming its spine.
- **Ask before committing, pushing or opening a PR,** unless the request itself can only be met by
  one (a CI change). The owner answers quickly. Never merge a PR yourself.
- **Never handle credentials.** When a token was needed, the owner created it and piped it from
  the clipboard into `gh secret set` themselves.
- **Report plainly.** Say what you checked yourself, what you are taking from a build's report, and
  what you did not check. Builds report in a confident register whether or not they are right.

## How a build session is run

- Start it in its own worktree of this repository, with a brief that names the spec, the binding
  "Decided at the interview" table, the spine it must do itself, where it must stop, and the
  other sessions working at the same time.
- Tell it not to push or open a PR until the owner says, and to stop for review after the spine.
- When it reports, read the diff and the tests it names before repeating anything it says. Ask for
  a proof that does not depend on its word: stage 22 ran an isolation test that fails when the
  filter is removed; stage 25 hashed stage history before and after.
- A review can change the design. Stage 22's review added the rule that a customer's call gets no
  raw database and no write queue, which made a list of 180 unmoved reads harmless by construction.
- Use Node 24 for checks.

## Where every stage stands

| Stage | State |
| --- | --- |
| 20 Move in | Merged (#76). The repository and local folder are renamed. The site is live |
| 21 Extension skills | Merged (#78) |
| 22 Customers and audiences | Built. **PR #80 open, all checks green, ready for the owner to merge.** Reviewed in part: the open-operations list and the outside path in `pipeline.ts`, not all 116 files |
| 23 HTTP surface and typed client | Spec agreed (in PR #77). Not started. Needs 22 merged |
| 24 Client apps | Spec agreed (in PR #77). Not started. Needs 23, and the owner to claim the `@composable-os` organisation on npm |
| 25 States, orders and payments | Spec agreed (in PR #77). **First half built and reviewed** on branch `claude/stage-25-transition-engine-f54037`, 8 commits, not pushed, no PR. Second half not started; it needs 22 merged |
| 26 Capacity and holds | **Interview open, one of eight questions answered.** Spec still "proposed". Needs only stage 20, so it can build as soon as it is agreed |
| 27 Ticketing, and Ghetto | Spec proposed. Not interviewed |
| 28 Content | Spec proposed. Not interviewed |
| 29 to 40 | One line each in the roadmap. Not specced, on purpose, until ticketing has shown what the primitives look like |

## Open pull requests

| PR | What | State |
| --- | --- | --- |
| #80 | Stage 22 | Green. The stage 22 session has Auto-fix on it. One phone-width Approvals e2e test failed once and passed on a re-run |
| #79 | CI: a fast lane for documents-only changes | Open. Its fast path has not yet run for real |
| #77 | Docs: specs for stages 23, 24 and 25, and this file | Open, on branch `docs/stage-23-interview`. Until it merges, the agreed specs exist only on that branch: `git show origin/docs/stage-23-interview:docs/stages/NN-….md` |

`main` does not yet say stage 21 or 22 is built in every place, and PRs #77 and #80 both edit
`docs/roadmap.md`, so expect a small conflict in whichever merges second. Keep both sides.

## What to do next, in order

1. **Ask the owner to merge #80, then #79 and #77.** After #80, update #77 from `main` and check the
   roadmap rows.
2. **Stage 25's first half:** ask whether to push the branch and open a PR. After #80 merges it
   needs `main` merged in; the overlap is in `packages/core/src/pipeline.ts` and
   `packages/core/src/records/`. The spec's section "What the second half needs from the engine"
   lists what that merge and the second half must deal with.
3. **Finish the stage 26 interview.** It is still open in Keep it moving under the title "Stage
   26: Capacity and holds"; resume watching it with the `kim` CLI. Then amend the spec and ADR 0404
   on the docs branch, as was done for stages 20 to 25, and start the build. It adds a behaviour to
   the same SDK files as stage 25, so the second to merge has a small merge to do.
4. **Once #80 is merged, start stage 23 and the second half of stage 25,** side by side. For 25,
   the coordinating model builds orders priced by the host, the rule that only a verified payment
   marks an order paid, and guest checkout; Opus builds the gatekeeper against a fake provider,
   expiry and late payment, refunds, the admin screens and the Stripe runbook.
5. **Interview stage 27.** It needs answers only the owner and the gym can give: which event is
   sold first and when it must be on sale; how the gym's existing app accounts meet the platform's
   customers; whether coaches get staff accounts for door scanning. Then stage 28.
6. **Stage 24** when 23 is merged and the npm organisation is claimed.

## Decisions the coordinator made that the owner may still override

- **A pack tool runs as the customer who called it.** The host always decides rows; a tool
  declares any extra fields it may set (ADR 0414).
- **An admin's "send writes to review" floor does not apply to customers,** who are never queued.
  A floor that denies still denies.
- **`stages` and `states` share one engine and one history table,** now `core_transition_history`
  (ADR 0425). Stage moves are for staff and the platform only.
- **Three names from stage 20:** the `cos` command, the `COS_` variable prefix, release files named
  `composable-os-<product>-X.Y.Z`.

## Waiting on the owner

- **The testing proposal.** The e2e job takes 26 to 35 minutes on CI: 118 tests run twice (desktop
  and phone) on one worker. Proposed, not yet answered: run the phone size only where layout
  matters; move the one 96-second test (`notification-preferences`) to an integration test;
  split the suite across four runners; split lint, typecheck and unit tests into parallel jobs;
  have build sessions run only the specs for their area; one e2e test per user journey in new
  stages. Expected result: about 6 minutes per pull request.
- **The site.** composableos.dev is live and redeploys on every change to `apps/marketing` on
  `main`. The owner has not read its copy. The footer's contact address may not exist as a
  mailbox. `www` does not respond.
- **The real-account fresh install** (stage 20, acceptance criterion 3) has not been confirmed.
- **The npm organisation** for stage 24.
- **Stripe's fees and the app stores' rules on outside payment** were not checked for stage 25.

## Known rough edges

- **A flaky e2e test:** a phone-width Approvals test, unrelated to the change it failed on.
- **Test order in a worktree:** `pnpm test:e2e` writes `apps/app/.dev.vars` with sign-up open, and
  `apps/app/test/identity.test.ts` then fails because it asserts sign-up is closed. Run unit tests
  first, or move the file aside.
- **The seam's ratchet:** 180 record reads are still outside the visibility seam, listed in
  `packages/core/test/visibility-one-seam.test.ts`, and are for the old stage 14a to move. They
  are unreachable by customers by construction, not by the list.
- **Stage 14a** (staff roles, teams, the rest of the seam) is specced and not built. Stages 27 and
  28 each have a question that leans on it: who may check in tickets, and who may publish.
- **The old roadmap section** ordering stages 12 to 16 still says "14a first".

## Housekeeping

- **Worktrees** under `.claude/worktrees/`: `stage-20-…` and `stage-21-…` are merged and can be
  removed. `stage-22-…`, `stage-25-…`, `docs-stage-23` and `ci-docs-fast-lane` are live.
- **An old design folder,** `~/repos/composable`, holds the first drafts of these documents.
  Everything in it is in this repository. Delete it only on the owner's word.
- **Build reports** written by the build sessions (stage 20, stage 22 steps 1 to 3, stage 25's
  first half) are in the desktop app's shared notes folder for the previous coordinating session,
  not in the repository. What mattered from them is in the specs, the ADRs and this file.
- **The owner's own clone** of `main` may be behind `origin/main`; fetch before reading from it.
