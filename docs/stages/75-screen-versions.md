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

Status: **spec proposed (2026-11-27)**. Not built until its interview settles the questions at its
end.

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
- **Serving on the web** is step 1's finding: `cos-front` loads the published version under
  Worker Loader (id from the client and the version) and serves its files from the store, or
  uploads it to the client's namespace Worker at publish.

## Out of scope

- The desktop app (stage 76).
- An editor for screens inside the product, or an assistant that writes them.
- Versions of extensions, fields or operations: those change through the client's staging
  environment.
- The admin's own screens (`apps/app`), unless the interview says otherwise (question 1).
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

## Decided by this spec, open to override

- **A preview runs on live data** (ADR 0960).
- **The pointer is in the client's database,** so a client's export carries it.
- **The last ten versions are kept,** and any version published in the last 90 days.
- **Versions are built outside the host** (the client's repository and CI). The host stores and
  checks; it does not build.
- **The store does not depend on Cloudflare's loader,** so a second target can serve the same
  versions.

## Questions for the owner

1. **Whose screens are these first?** A client's own web app (its website and account area), the
   staff screens of the admin, or both. Recommended: the client's own web app first. The admin is
   ours, is the same for every client and is released with the host; making it a published
   version per client is a much larger change.
2. **Who may publish for a hosted client?** Recommended: a person at the client who holds the
   publish permission, since a published version needs no account token. The other answer is
   that only we publish, as with deploys today.
3. **Where do changes come from at first?** Recommended: the client's repository, built in CI
   and uploaded as a version. An editor or an assistant inside the product would be a later
   stage on top of the same store.

## Status

Spec proposed (2026-11-27). No build step is built yet. Each build step changes its own line
here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — not built — needs: stage 66 — The serving spike: the first client's built web app under Worker Loader, measured

- **Step 2** — not built — The browser-only build

- **Step 3** — not built — The version store

- **Step 4** — not built — needs: step 3 — The pointer and `screens.publish`

- **Step 5** — not built — needs: step 1, step 4 — Serving the published version on the web

- **Step 6** — not built — needs: step 5 — Preview

- **Step 7** — not built — needs: step 6 — Docs, the skill and `cos`
