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
- **Rules live in the host.** A screen never calculates a price, checks a capacity or decides what
  a customer may see. It calls an operation and shows the answer.
- **Copy blocks, do not import them.** `cos add <block>` copies a block into an app; the copy is
  yours to restyle. `cos diff <block>` shows what changed upstream, to apply by hand.
- **When the platform lacks something:** stop that part, say exactly what the platform needs (a
  behaviour, an operation, a gatekeeper), and build the rest. Never work around it in client code:
  no direct database access, no outside calls past a gatekeeper, no rule enforced in a screen.
- **The org's own extensions** live in `extensions/` and are checked with `cos ext check` and
  tested with `cos ext test`. `cos deploy` installs them.
- **Before opening the web app to the public,** add the rate limiting rule for public calls on the
  web app's zone (`cos create` and `cos init` print it).
<!-- /composable-os: client repo rules -->
