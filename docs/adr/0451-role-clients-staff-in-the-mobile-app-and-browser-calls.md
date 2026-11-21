# ADR 0451: A pack role's own client, staff in the company's mobile app, and browser calls

Status: accepted, 2026-11-21 (client releases and environments fix, second part). Builds on
[ADR 0418](0418-the-typed-client-as-built.md), [ADR 0421](0421-the-client-app-binding-and-customer-sign-in.md),
[ADR 0436](0436-pack-roles-and-the-door-role.md) and ADR 0455 (native sign-in by tokens, on the
identity branch `fix/staff-invites-and-native-sign-in`, not merged when this was written).

## Context
The first client's door scanner is part of the gym's own app, used by coaches who hold Ticketing's
door role. `cos client generate` wrote only `customer.ts` into a client repo, and the template's
mobile host module signed in customers only, so `x.ticketing.checkIn` (staff only) could be neither
typed nor called from it. Writing the whole staff client into a customer-facing app would put every
staff operation's name and shape in a public bundle. Separately, a web block running in a browser
(an Astro site's React island) had no sanctioned way to call the host: the template's host module
served sign-in only. And the mobile host module made no write on React Native (no `crypto`).

## Decision
- **The release says what each pack role may call.** `packages/core/api/v1/roles.json`, generated
  with the contract and carried in the client kit (`contract/roles.json`): for every carried pack's
  role, its objects and the staff operations a holder may call (its tools whose permission it holds,
  and `record.get` and `record.list`), computed with the pipeline's own `packRoleReaches`.
- **A client per role, opted into per app.** `product.ts`'s `mobile.roles: ["ticketing.door"]`
  (the role's pack must be in `packs`). `cos client generate` writes `roles/<pack>.<role>.ts`
  beside the app's customer client: only those operations, `record.get` and `record.list` typed to
  take only the role's objects, factory `create<Pack><Role>Client`. The whole staff client is never
  written into a client repo. The web app gets none: its binding never serves staff (ADR 0421).
- **Staff sign in in the template's mobile app** (`staffSession` in its host module), against the
  identity branch's token routes: by an emailed code (`/api/v1/auth/staff/code`, `/staff/sign-in`)
  or, where staff sign in with Google or Cloudflare Access, in the system browser
  (`/native/staff-sign-in` with a PKCE challenge, then `/api/v1/auth/staff/exchange`). The staff
  session has its own slot in the secure store (`staffSecureStore`): a device holds at most one
  staff session and one customer session, apart, and signing in again ends the previous staff one.
  Staff calls go only to the host's address, through a role client; a staff token is never sent to
  the company's own server. `cos deploy` sets `NATIVE_REDIRECT_URIS` to the app's redirect,
  `<scheme>://staff-sign-in`, from `product.ts` (`mobile.scheme`, per environment, default the
  product's id), and the template declares that scheme in `app.json`.
- **Signing out needs no operation.** A pack role may call nothing but its own operations, and must
  still be able to end its session: the staff session signs out with the runtime's
  `tokenSession(...).signOut()`, which the identity branch makes call its
  `POST /api/v1/auth/sign-out { refreshToken }` (ADR 0455) and clear the store even if the call
  fails. Until that merges, signing out forgets the tokens on the phone only.
- **Customer sign-in in the mobile host module answers with tokens**, never a cookie
  (`/api/v1/auth/customer/code` and `/customer/sign-in`, ADR 0455). The cookie exchange
  (`/api/v1/auth/token`) is no longer used by the template.
- **`cos init` in an Expo app** shows, as a diff like its others, the tsconfig change the host
  module's and native blocks' `.ts` imports need on `expo/tsconfig.base`
  (`allowImportingTsExtensions`, `noEmit`), and copies `secure-random.ts` with `expo-crypto`.
  **`cos add`** prints the platform's packages at the release's version (never `*`) and the install
  command the app takes: `npx expo install` in an Expo app, else its lockfile's package manager.
- **The mobile host module takes the app's secure random source** (`random`: expo-crypto's
  `getRandomBytes` and `digest`) for idempotency keys and PKCE, and refuses to start without it, so
  a missing one is said at start-up and not at the first write.
- **`operationRoute(request, env, { allow, path })`** in the template's web host module: a
  same-origin route for browser calls. `POST <path><operation>` (default `/api/v1/op/`, so the
  typed client works with `baseUrl: location.origin`) is forwarded over `HOST` with the customer's
  cookie and the `Idempotency-Key` and nothing else, only for operations in `allow`; another
  site's `Origin` is refused, a write without `Origin` is refused, a body that is not JSON is
  refused, an `Authorization` header is never forwarded, and the host's answer is passed back
  without its headers. Astro with React islands is a supported way to host web blocks, with it.
- **The printed edge rule names only the routes that reach the host** (the sign-in route and the
  operation route, `web.routes` in `product.ts`), so on an adopted site with its own API it does not
  throttle the site's own routes for everyone behind one address.

## Consequences
- Until the identity branch merges, a host does not serve the token sign-in routes the mobile host
  module uses; its tests run against a stand-in host that answers as ADR 0455 fixes them.
- The door role's client is four operations. A role that later gains a tool gets it in its client
  when the repo regenerates against the new release.

## Tests
`packages/client-gen/test/generate.test.ts` (an app with the door role's client names no other
staff operation; `record.list` of `person` and `person.list` are type errors);
`packages/create-composable-os/test/client-repo.test.ts` (`cos client generate` writes the role
client; `cos deploy` sets `NATIVE_REDIRECT_URIS` per environment; a role of an unlisted pack is
refused; the tsconfig diff; the `cos add` command); `apps/app/test/staff-app.test.ts` (staff sign
in by code and in the browser against a stand-in of ADR 0455's routes built from the host's real
parts; a door-role device session reaches only the role's operations over the real surface; one
staff session per device, apart from the customer's; "signing out ends it on the host" is a todo
until the identity branch merges); `apps/app/test/mobile-app.test.ts` (customer sign-in by tokens
against the same kind of stand-in); `packages/client-gen/test/targets.test.ts` (the template's
mobile host module in a context with no `crypto`: refused at start-up without `random`, a write
with it); `apps/app/test/company-web.test.ts` (the operation route: allowed calls, a write with no
`Origin`, another site, an operation not allowed, not JSON, an `Authorization` header not
forwarded).
