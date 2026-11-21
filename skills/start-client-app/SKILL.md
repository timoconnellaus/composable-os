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

The host (records, rules, sign-in, the admin) is deployed from a verified platform release. The
client repo holds only the company's apps, its own extensions (`extensions/`), copied blocks and
`product.ts`. It never holds platform code and never opens a database.

## The steps

1. **New or existing?** In an empty folder, `npm create composable-os <dir>` (or
   `cos create <dir> --label "<Name>"`). In an existing repository, run `pnpm dlx
   @composable-os/cli init` at its root, saying where the apps are (`--web <dir>`,
   `--mobile <dir>`). `cos init` adds `product.ts`, `skills/`, each app's typed client
   (`<app>/src/composable-os/customer.ts`) and the client-repo rules in `AGENTS.md`. It changes no
   existing file without showing the diff first, and applies the diffs only with `--yes`: read
   them, then run it again with `--yes`.
2. **Read `AGENTS.md`.** Its rules hold for everything after this.
3. **Choose the packs.** `product.ts` lists the release's packs that are on (`packs: ["deals"]`).
   Only list what the request needs; an empty list is base records (people, organisations,
   activities, tasks) only. The packs a release has are in its notes; `cos deploy` refuses one it
   does not have.
4. **Install.** `pnpm install` at the root.
5. **The web app** talks to the host only through `HOST`, a service binding to the host's
   `ClientApp` entrypoint, already in the template's `apps/web/wrangler.jsonc`; `cos init` shows it
   as a diff for an existing Worker. Call operations with the generated client:
   `createCustomerClient({ baseUrl: "https://host", fetch: (url, init) => env.HOST.fetch(url, init),
   headers: () => customerSession(request.headers.get("cookie")) })`. The template's
   `apps/web/src/host.ts` does this, and the sign-in routes, and keeps customers signed in.
6. **The mobile app** (Expo) calls the host's public address over HTTPS with the same generated
   client, signed in with a device token (`tokenSession` in `@composable-os/client`).
7. **Regenerate the client** after adding a pack or an extension: `pnpm cos client generate`
   is run by `cos deploy` and `cos upgrade`; run it yourself when you change `extensions/`.
8. **Deploy.** `CLOUDFLARE_API_TOKEN=... pnpm cos deploy`. It checks `extensions/` with
   `cos ext check` and the apps' types first, and stops with nothing changed if either fails. Then
   it deploys the host from the release with the product's packs and the org's extensions, and
   the web app with its binding. It prints the web app's address.
9. **Before opening to the public,** do the step `cos create`/`cos init`/`cos deploy` print: a
   rate limiting rule on the web app's zone. A person does this in the Cloudflare dashboard.

## The rules

- Call operations through the typed client only. Never give the web app a D1, R2 or KV binding
  or a secret of its own; `cos deploy` refuses a build that has one.
- Rules live in the host: a screen never calculates a price, checks a capacity or decides what a
  customer may see.
- Customers sign in on the company's own hostname through the web app; staff use the admin on
  the host's address. Do not put the two on one hostname.
- **When the platform lacks something:** stop that part, say exactly what the platform needs (a
  behaviour, an operation, a gatekeeper, a pack in a release), and build the rest. Never work
  around it in client code.

## The check

`pnpm cos deploy` is the check: it runs `cos ext check` on every extension and type-checks the
apps before anything is deployed. Then open the web app's address, sign in with an emailed code
and see the account page.
