<!-- composable-os: client repo rules -->
## Composable OS: rules for agents in this client repo

This repository is a company's own product on Composable OS. The host (records, rules, sign-in,
the staff admin, MCP) is deployed from a verified platform release named in `product.ts`; this
repository holds only the company's own apps, its own extensions and copied blocks. The steps for
common work are in `skills/` (start with `start-client-app` and `add-block`).

- **Call operations through the typed client only.** Apps reach the host through
  `@composable-os/client` and the generated client (`cos client generate`): the web app over its
  `HOST` service binding, the mobile app over HTTPS. Never open a database, and never give the web
  app a D1, R2 or KV binding or a secret of its own.
- **One set of screens, two builds.** `apps/web` builds as the Worker (`pnpm build`) and as static
  files (`pnpm build:browser`, over `/api/v1` with tokens). A screen reaches the host only through
  `useScreenHost()` (`src/screen-host/`), never `fetch("/auth/...")`, the binding or a server
  function, so both builds keep working; `pnpm --dir apps/web test` checks the static build.
- **Rules live in the host.** A screen never calculates a price, checks a capacity or decides what
  a customer may see. It calls an operation and shows the answer.
- **Copy blocks, do not import them.** `cos add <block>` copies a block into an app; the copy is
  yours to restyle. `cos diff <block>` shows what changed upstream, to apply by hand.
- **When the platform lacks something:** stop that part, say exactly what the platform needs (a
  behaviour, an operation, a gatekeeper), and build the rest. Never work around it in client code:
  no direct database access, no outside calls past a gatekeeper, no rule enforced in a screen.
- **The org's own extensions** live in `extensions/` and are checked with `cos ext check` and
  tested with `cos ext test`. `cos deploy` installs them.
- **The mobile app's identity is product.ts's** (`mobile.app`, stage 63): its name, store ids,
  icon, colours and listing. `apps/mobile/app.config.ts` and `src/blocks/brand.ts` are made from
  it; never write a host address or a store id in the app. Run `cos app check` before a store
  build. Nothing is bought in the app: buying and billing stay on the website.
- **Signing and store keys are a person's.** Never create, see, hold or set a signing key, a store
  key or the deploy credential, never approve the app workflow's run, submit for review or release
  to the public. `cos app credentials` names what a person sets.
- **Before opening the web app to the public,** add the rate limiting rule for public calls on the
  web app's zone (`cos create` and `cos init` print it).
<!-- /composable-os: client repo rules -->
