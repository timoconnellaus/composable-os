# Stage 75: Screen versions

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Client
repos, Deployment), [`CONTEXT.md`](../../CONTEXT.md) (Client, Client app, Block, Typed client,
Environment, Registry), ADRs
[0960](../adr/0960-screens-as-published-versions-and-one-desktop-app.md),
[0403](../adr/0403-http-surface-and-typed-client.md),
[0417](../adr/0417-the-api-contract-and-versions.md),
[0421](../adr/0421-the-client-app-binding-and-customer-sign-in.md),
[0450](../adr/0450-client-environments.md),
[0451](../adr/0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md),
[0610](../adr/0610-three-homes-for-a-client-hosted-by-default.md) and
[0611](../adr/0611-one-host-a-database-per-client.md); stage
[66](66-one-host-many-clients.md) ("A client's own code"); code: `templates/client/apps/web/`,
`apps/app/src/server/http/bound.ts`, `packages/client/src/client.ts`,
`packages/release/src/deploy.ts`.

Status: **spec agreed (owner interviewed 2026-11-27)**.

## Goal

A change to a client's screens reaches its users without a deploy. The screens are built into a
version, someone looks at that version on the real product, and publishing it is one audited
step that can be undone. The same published version is what the web serves and what the desktop
app (stage 76) downloads.

## What exists today (from the code)

- **A client's web app is a server-rendered Worker.** It calls the host over its `HOST` binding
  (`ClientApp`, the client fixed on the binding) with the customer's cookie (ADR 0421). Stage 66
  puts one such Worker per bespoke client in the `cos-clients` namespace, behind `cos-front`.
- **A browser can already call the host:** `/api/v1` with the typed client (ADRs 0403, 0418), and
  `operationRoute` for same-origin calls from a page (ADR 0451).
- **A change to a web app is a deploy** from the client's repository with our account token
  (ADR 0610). There is one live version, no draft and no way back but another deploy.
- **Nothing stores a built app.** Worker Loader runs extensions only (ADR 0043).

## Decided by the owner (2026-11-27)

| # | Decision |
| --- | --- |
| 1 | No client's host moves off the shared host to gain this (ADR 0960) |
| 2 | Screens are stored as versions per client; one is published; a draft can be used before it is published |
| 3 | The desktop app loads the same published version (stage 76) |
| 4 | Both a client's own web app and the admin's staff screens become published versions (interview, 2026-11-27) |
| 5 | A person at the client who holds the publish permission may publish for a hosted client |
| 6 | Changes come from the client's repository and from inside the product (an editor or the assistant), both from the start |
| 7 | An organisation can have its own admin screens. A screen is a saved record of which block fills each **region**, not code. A block can fill a region, and a block has regions of its own: something added to an appointment card, or another card in place of the default (the owner, 2026-11-27, reversing the same day's first answer, "a screen is code") |
| 8 | What fills a region is a standard block or a custom one. A standard block is ours and is named, never copied, so it is updated by a release. A custom block is the organisation's own code |
| 9 | A custom block written inside the product is built by a build service of ours, in a sandbox. Arranging blocks needs no build |
| 10 | The admin has an **edit mode** beside the assistant: a person turns it on, selects something on the screen (an appointment card, say) and asks for a change to it or an addition (the owner, 2026-11-27) |

## The design in one page

```
 change ─► build ─► version v7 (files by hash, a manifest, the contract it was built for)
                        │
        preview address ┤  a signed-in person allowed to preview: served v7
                        │
   screens.publish ─────┘  the pointer moves: v6 ─► v7      (screens.publish again: back to v6)

 web:      hostname ─► cos-front ─► the published version
 desktop:  the wrapper asks the host for the published version, downloads and checks it
```

## The model

- **A version** is the built output of a client's screens: its files, each named by its hash, and
  a manifest (the files, the entry, the API contract version it was built against, who built it
  and from what). A version is never changed after it is stored.
- **The browser-only build.** The client template's screens build as an app that needs no server:
  it calls `/api/v1` through the typed client, signs in with tokens and routes by hash. The
  server-rendered site stays as a second build for the public pages that need it.
- **The pointer** says which version is published for a client and an environment. It is in the
  client's database, moved only by `screens.publish`, with its history kept.
- **`screens.publish`** takes a version and moves the pointer. It refuses a version built for a
  contract the host does not serve, and one whose manifest or files do not check. It has its own
  permission and is high risk: an assistant may only ask, and a person approves.
- **Preview.** A draft is served only at a preview address of the client's (never the live
  address or the fleet's staff domain), only to someone signed in there who holds the preview
  permission. It runs on the client's live data: what is done in a preview is real.
- **Old versions are kept** so a page open at the moment of publishing still loads its files, and
  so the pointer can move back. How many is in "Decided by this spec".
- **A screen** of the admin is a record in the organisation's database, as a saved view or a
  dashboard is: its name, where it sits in the navigation, and which block fills each of its
  regions, with each block's settings. Saving one is an operation; nothing is built or deployed.
- **A region** is a named place a block or a screen offers, with a contract: what it hands to
  whatever fills it (one appointment, the record being shown, nothing). A fill either **adds**
  to a region (a line under an appointment card) or **replaces** its default (another card). A
  block's regions are declared with the block, and the contract is what a release may not break.
- **Standard and custom blocks.** A standard block comes from the release and is named, never
  copied, so every screen uses the release's current one. A custom block is the organisation's
  own code, in its version, written for one region's contract. (A block copied into a client's
  website with `cos add` stays the client's, as today.)
- **Edit mode.** With it on, the admin outlines what can be selected: each block and each
  region, which the page already knows by name (the screen, the region's path, what fills it).
  Selecting one hands that name to the assistant with the request. The assistant answers with
  the smallest change that does it: a setting of the block, a fill added to a region, or the
  default replaced by a custom block it writes and the build service builds. The change is made
  on a draft of the screen, shown at once, and published by someone who may. A part of a
  standard block that is no region cannot be changed: the assistant says so and offers to replace
  the block around it, and the request is recorded, since it tells us which region is missing.
- **The build service** takes a custom block's source, written in the product by the assistant
  or an editor, or pushed from a repository, and makes a version from it: it bundles in a
  sandbox with no network and no secrets, against the release's region contracts and typed
  client, and stores the result as a draft. It never publishes.
- **Serving on the web** is step 1's finding: `cos-front` loads the published version under
  Worker Loader (id from the client and the version) and serves its files from the store, or
  uploads it to the client's namespace Worker at publish.

## Out of scope

- The desktop app (stage 76).
- Versions of extensions, fields or operations: those change through the client's staging
  environment.
- The mobile app, whose screens go through the stores.

## Acceptance criteria

1. A client's screens build with no server code and run from static files against `/api/v1`.
2. A build is stored as a version that cannot be changed; a changed file is refused.
3. `screens.publish` moves the pointer; the next request for the client's address gets the new
   version, and a page already open keeps working.
4. Publishing the earlier version again restores it.
5. A version built for a contract the host does not serve is refused.
6. A draft is reachable only at the preview address by someone allowed; a customer and another
   client's staff are refused; the live address never serves it.
7. One client's versions and pointer are out of reach of another client (two-client test).
8. Without the permission nothing is published, and an assistant's publish waits for approval.

## Dependencies

Stage 66 (the shared host, `cos-front`, the namespace). Nothing else.

## Migrations and numbers

Block CE: migrations 1490–1509, ADRs 0960–0969 (ADR 0960 written).

## Suggested build order

1. **The serving spike:** the first client's real built web app under Worker Loader behind
   `cos-front`, measured (size accepted, cold start, cost, logs through a tail Worker), against
   the namespace upload. Its result is recorded here and decides step 5.
2. **The browser-only build** in the client template and the first client's repository.
3. **The version store:** versions, manifests, the check, kept apart per client.
4. **The pointer and `screens.publish`,** with its permission, history and contract check.
5. **Serving the published version** on the web, by the mechanism step 1 chose.
6. **Preview:** the preview address, its sign-in and permission.
7. **Docs, the skill and `cos`:** building and uploading a version from a client's repository.
8. **The admin's screens as a version:** `apps/app`'s staff screens build as a browser-only app
   over `/api/v1`, stored and published like any other version. What stage 76 loads.
9. **The build service:** a spike first (bundling an organisation's screen in a sandbox, its
   time and its limits; Cloudflare's runtime bundler is marked experimental), then the service.
10. **An organisation's own admin screens:** the screen record and its operations, regions
    declared on the first standard blocks, add and replace, the check of saved screens at a
    release, custom blocks from the build service.
11. **Edit mode:** selecting a block or a region in the admin and asking the assistant for a
    change to it, on a draft; the record of requests no region could meet.

## Decided by this spec, open to override

- **A preview runs on live data** (ADR 0960).
- **The pointer is in the client's database,** so a client's export carries it.
- **The last ten versions are kept,** and any version published in the last 90 days.
- **Versions are built outside the host** (the client's repository and CI). The host stores and
  checks; it does not build.
- **A release checks every saved screen** against the blocks' declared regions, on staging first:
  a data check, with no rebuild. A custom block is rebuilt only when the contract of the region it
  fills changes. A screen or block that no longer fits stops the update before live, as a
  client's extension that fails the release's checks does (stage 66, decision 7).
- **Few regions at first.** Every region is a promise a release must keep. A block starts with the
  regions a real need asked for, and gains more the same way.
- **Layout is what the record can say:** which regions a screen has and their order. Anything else is a custom block
  that fills the whole screen.
- **Blocks on one screen share a selection** (the class picked in a timetable is what a class
  list shows). Its shape is designed in step 10.
- **A screen made only of standard blocks is shown in the desktop app** from the start: it
  holds none of the organisation's code. A custom block is not, until Electrobun's internal
  bridge can be closed for a view (ADR 0960).
- **Edit mode selects blocks and regions, not any pixel,** and needs its own permission, apart
  from the permission to publish. A change is for everyone who uses the screen, not one person.
- **A request that is about the data, not the screen** (a new field on the appointment) is an
  extension change and goes the way those go today: written by the assistant, approved as a
  diff. Edit mode may start it, and the screen change that shows the field follows it.
- **The word is "region"** (the owner, 2026-11-27, over "slot", which this vocabulary avoids
  and Radix uses for something else, and over "part" and "area"). Where a database is placed
  is its location, never its region, so the two do not meet.
- **The store does not depend on Cloudflare's loader,** so a second target can serve the same
  versions.

## Questions for the owner

None open. Decisions 4 to 9 answer them (the interview of 2026-11-27 and its chat).

## Status

Spec agreed (owner interviewed 2026-11-27). No build step is built yet. Each build step changes its own line
here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — not built — needs: stage 66 — The serving spike: the first client's built web app under Worker Loader, measured

- **Step 2** — not built — The browser-only build

- **Step 3** — in progress — branch `feat/stage-75-version-store` — The version store: versions
  (kind `web`), manifests (`@composable-os/sdk/screen-version`), the checks, kept apart per client;
  `screens.versionBegin`/`versionPut`/`versionSeal`/`versionList`/`versionGet`, the upload route,
  the retention sweep and the hold step 4 fills; migration 1490, ADR 0961

- **Step 4** — not built — needs: step 3 — The pointer and `screens.publish`

- **Step 5** — not built — needs: step 1, step 4 — Serving the published version on the web

- **Step 6** — not built — needs: step 5 — Preview

- **Step 7** — not built — needs: step 6 — Docs, the skill and `cos`

- **Step 8** — not built — needs: step 4 — The admin's screens as a version

- **Step 9** — not built — needs: step 3 — The build service

- **Step 10** — not built — needs: step 6, step 8, step 9 — An organisation's own admin screens

- **Step 11** — not built — needs: step 10 — Edit mode
