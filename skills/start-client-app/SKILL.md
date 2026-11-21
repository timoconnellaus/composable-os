---
name: start-client-app
description: Start a company's own product on Composable OS - create a client repo from the template (cos create) or adopt an existing repository in place (cos init), choose the packs, wire the web app's service binding and the mobile app's typed client, and deploy the host and the web app (cos deploy). Use when asked to start a new product, a website or app for a company on Composable OS, to connect an existing site or app to a Composable OS host, or for the first deploy of a client repo.
---

# Start a client app

Describes extension contract version 1. For the platform version a repo is on, read
`platform.version` in its `product.ts`.

## When to use it

A company wants its own product on Composable OS: a website where its customers sign in, a mobile
app, the staff admin and MCP that come with the host. Either there is no repository yet (create
one), or the company already has a site or an app (adopt it, moving nothing).

The host (records, rules, sign-in, the staff admin) is deployed from a verified platform release.
The client repo holds only the company's apps, its own extensions (`extensions/`), copied blocks
and `product.ts`. It never holds platform code and never opens a database. One host serves one
company: every client repo deployed to one Cloudflare account shares that account's host, which
is named for the company's product at its first install (`<id>-app`, `<id>-runner`, the `<id>`
database; `names` in `product.ts` overrides them) and shows the product's `label`. A host that
exists keeps its names: nothing deployed is renamed.

## The steps

1. **New or existing?**
   - **New:** `npm create composable-os <dir> -- --label "<Name>"` (that is `cos create <dir>`;
     add `--with-mobile` for the Expo app). The id comes from `<dir>`. It writes the repo, runs
     `git init`, and generates each app's typed client.
   - **Existing:** at its root, `pnpm dlx @composable-os/cli init --id <id> --label "<Name>"
     --web <dir> --mobile <dir>` (leave out an app it does not have). Without `--id` and `--label`
     both come from the folder's name. It adds `product.ts`, `skills/`, each app's typed client and
     host module (`<app>/src/composable-os/customer.ts` and `host.ts`; the mobile app also
     `secure-store.ts`), a `pnpm-workspace.yaml` when the apps are in folders of their own, and the
     client-repo rules in `AGENTS.md`. It changes no file that exists without showing the diff
     first and applies the diffs only with `--yes`: read them, then run it again with `--yes`. An
     adopted web app keeps its Worker (`web.worker` is its name) and its own deploy
     (`web.deploy: "own"` in `product.ts`).
2. **Read `AGENTS.md`.** Its rules hold for everything after this.
3. **Choose the packs.** `product.ts` lists the release's packs that are on (`packs: ["deals"]`).
   List only what the request needs; an empty list is base records only (people, organisations,
   activities, tasks), and each signed-in customer can always read their own Person (`me.get`).
   `cos deploy` refuses a pack the release does not have.
4. **Install:** `pnpm install` at the root.
5. **The web app** reaches the host only through `HOST`, a service binding to the host's
   `ClientApp` entrypoint: already in the template's `apps/web/wrangler.jsonc`, shown as a diff by
   `cos init` for an existing Worker. Its host module (`apps/web/src/host.ts` in the template,
   `src/composable-os/host.ts` when adopted) has what a page needs: `customerApi(env, request)`
   (the typed client for the customer the request comes from), `signedInCustomer`, the sign-in
   routes `authRoute` serves (`POST /auth/code`, `/auth/sign-in`, `/auth/sign-out`), and
   `withSessionKept`, which keeps customers signed in. **The template already has a public page,
   a sign-in page, an account page from `me.get` and sign-out**: for a request like "members sign
   in and see their account" there is nothing to add, unless the platform's sign-in block is
   wanted (the `add-block` skill).
   - **An adopted site with data of its own** (its own D1, KV or R2): it keeps them and keeps
     deploying itself. Customers' records live in the host. What moves into the host, and when, is
     the company's decision: say so and do not move data or remove a binding yourself.
   - **A framework other than React** (an Astro site): call the host from its server code with the
     host module; the web blocks are React and do not fit it.
6. **The mobile app** (Expo) calls the host's public address over HTTPS with the same typed
   client. Its host module (`apps/mobile/src/host.ts`, or `src/composable-os/host.ts` when adopted)
   has `hostSession({ hostUrl, store, deviceName })` with `requestCode`, `signIn` (the emailed code
   is exchanged at once for a device session in the secure store), `api` and `signOut`. The host's
   address is `expo.extra.hostUrl` in `app.json`.
7. **Regenerate the clients** after changing `packs` or `extensions/`: `pnpm cos client generate`.
   `cos deploy` and `cos upgrade` do it too.
8. **Deploy:** `CLOUDFLARE_API_TOKEN=... pnpm cos deploy`. Before anything in the account changes
   it runs `cos ext check` on every extension, type-checks every app that has a `tsconfig.json`
   (an app without one is not checked), and builds and checks the web app (a template web app
   must build to `dist/server/`; an adopted one with `web.deploy: "own"` is left to its own
   deploy). It prints `Checked: ...`, then deploys the host with the product's packs and the
   org's extensions, then the web app with its binding, and prints the web app's address.
9. **A person then does, by hand:**
   - open the host's address `/setup` to create the first staff admin;
   - connect an email-send connection and choose it for customer sign-in codes with the
     `customer.settings.update` operation (`emailConnectionId`; over MCP, as a human admin; the
     admin has no picker yet). Until then code requests answer that sign-in is not set up;
   - for a custom hostname, `web.hostname` in `product.ts` and its DNS;
   - before opening the web app to the public, the rate limiting rule `cos` prints, on the web
     app's zone.

## The rules

- Call operations through the typed client only. Never give a web app the template deploys a D1,
  R2 or KV binding or a secret of its own; `cos deploy` refuses a build that has one.
- Rules live in the host: a screen never calculates a price, checks a capacity or decides what a
  customer may see.
- Customers sign in on the company's own hostname through the web app; staff use the admin on
  the host's address. Do not put the two on one hostname.
- **When the platform lacks something:** stop that part, say exactly what the platform needs (a
  behaviour, an operation, a gatekeeper, a pack in a release), and build the rest. Never work
  around it in client code.

## The check

`pnpm cos deploy` is the check: it ends with the web app's address after `Checked: ...`. Then a
person opens the web app, signs in with an emailed code and sees the account page.
