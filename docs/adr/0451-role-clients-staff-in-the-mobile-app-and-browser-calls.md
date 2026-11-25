# ADR 0451: A pack role's own client, staff in the company's mobile app, and browser calls

Status: accepted, 2026-11-21 (client releases and environments fix, second part). Builds on
[ADR 0418](0418-the-typed-client-as-built.md), [ADR 0421](0421-the-client-app-binding-and-customer-sign-in.md),
[ADR 0436](0436-pack-roles-and-the-door-role.md) and
[ADR 0455](0455-staff-invites-and-native-sign-in-by-tokens.md) (native sign-in by tokens).

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
- **Staff sign in in the template's mobile app** (`staffSession` in its host module, on the
  runtime's `tokenSession` and `startBrowserSignIn`), against ADR 0455's routes: an invited staff
  member by an emailed code (`/api/v1/auth/staff/code`, `/staff/sign-in`)
  or, where staff sign in with Google or Cloudflare Access, in the system browser
  (`/native/staff-sign-in` with a PKCE challenge, then `/api/v1/auth/staff/exchange`). The staff
  session has its own slot in the secure store (`staffSecureStore`): a device holds at most one
  staff session and one customer session, apart, and signing in again ends the previous staff one.
  Staff calls go only to the host's address, through a role client; a staff token is never sent to
  the company's own server. `cos deploy` sets `NATIVE_REDIRECT_URIS` to the app's redirect,
  `<scheme>://staff-sign-in`, from `product.ts` (`mobile.scheme`, per environment, default the
  product's id), and the template declares that scheme in `app.json`.
- **Signing out needs no operation.** A pack role may call nothing but its own operations, and must
  still be able to end its session: both sessions sign out with the runtime's
  `tokenSession(...).signOut()`, which calls `POST /api/v1/auth/sign-out { refreshToken }`
  (ADR 0455) and clears the store even if the call fails.
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
- Sign-in by code works only once a human admin has chosen the host's mail connection and allowed
  it to send sign-in codes (Settings → Users); `cos deploy` does not do it.
- The door role's client is four operations. A role that later gains a tool gets it in its client
  when the repo regenerates against the new release.

## Tests
`packages/client-gen/test/generate.test.ts` (an app with the door role's client names no other
staff operation; `record.list` of `person` and `person.list` are type errors);
`packages/create-composable-os/test/client-repo.test.ts` (`cos client generate` writes the role
client; `cos deploy` sets `NATIVE_REDIRECT_URIS` per environment; a role of an unlisted pack is
refused; the tsconfig diff; the `cos add` command); `apps/app/test/staff-app.test.ts` (on the
host's real native sign-in routes: an invited door-role coach signs in by code and a staff member
in the system browser; the door session reaches only the role's operations; signing out, and
signing in again, end the session on the host; no cookie is sent); `apps/app/test/mobile-app.test.ts`
(customer sign-in by tokens on the real routes, no cookie sent or set, sign-out ends the session);
`packages/client-gen/test/targets.test.ts` (the template's
mobile host module in a context with no `crypto`: refused at start-up without `random`, a write
with it); `apps/app/test/company-web.test.ts` (the operation route: allowed calls, a write with no
`Origin`, another site, an operation not allowed, not JSON, an `Authorization` header not
forwarded).

## Amended 2026-11-21 (`fix/role-hooks-and-host-module-upgrade`): host modules follow upgrades
`cos init` wrote the host modules (`host.ts`; the mobile app's `secure-store.ts` and
`secure-random.ts`) as new files only, and `cos upgrade` never touched them, so an adopted repo
could not take a newer template's.
- **What cos wrote is recorded:** a sha256 per host module in `composable-os.lock.json` at the
  repo's root, by `cos create` and `cos init` (a module that was there already and differs is the
  company's and is not recorded).
- **`cos upgrade` replaces a module the company has not edited** (its file still has the recorded
  hash) with the new template's, writes one the new template adds, and for an edited one writes
  nothing and shows its diff against the new template, with what to do (merge by hand; once the
  file equals the template it is recorded again). A module with no recorded hash (a repo adopted
  before this) counts as edited unless it already equals the new template.
- **By content, not version:** `cos upgrade` on the version the repo is already on still checks
  the host modules against the kit, and `cos diff <block>` at the copied version compares the
  kit's files with the hashes recorded at copy time, so a kit rebuilt at the same version (local
  tarballs) still shows what changed.
- Found on the way: `cos upgrade` could not move `platform.version` in a `product.ts` written by
  `cos init`, whose keys are quoted; it can now.
- Tests in `packages/create-composable-os/test/client-repo.test.ts`: unedited (replaced, recorded),
  edited (left, diff shown), no recorded hash (left, diff shown), a module new in the template
  added to an adopted repo, and a same-version rebuilt kit (host module replaced, block diff shown).

## Amended 2026-11-21 (issue #177): `cos upgrade` moves the platform's packages
`cos upgrade` moved `platform.version` but not the `@composable-os/*` dependencies, so its type
check ran against the old installed packages and passed while copied blocks no longer compiled.
It now moves every `@composable-os/*` dependency in the root's and each app's `package.json` to
the target version, keeping the range style, and names any it cannot safely rewrite (a tarball, a
path, a workspace, a tag, an override). It never installs (as `cos create` and `cos init` do not);
it type-checks only when every moved package is installed at the target version, and otherwise
says the check was skipped and prints the repo's install command, to run before `cos upgrade`
again. Tests in `packages/create-composable-os/test/client-repo.test.ts`.

## Amended 2026-11-24 (stage 45 step 7, ADR 0629): a role's client may carry grants
`roles.json` lists each carried pack's grantable permissions (`grants`: the permission, whether it
is restricted, and the staff tools a grant of it opens). `product.ts`'s `mobile.roles` takes `{ role,
grants }` beside a bare role name, and `cos client generate` writes that role's client with the
granted tools too, naming the grants in its header; a restricted grant prints a note that the host
still decides every call. A grant of a pack the product does not list, a grant the release does not
have, and a role listed twice are refused. The generated client also carries the host it talks to
(`baseUrl`), which a screen uses to show an address on that host (the calendar feed's), never one
from the page.

## Amended 2026-11-24 (stage 60 step 6, ADR 0872): the owner's client
"The whole staff client is never written into a client repo" stands; a second short list is added
beside the role clients. `product.ts`'s `mobile.owner: true` makes `cos client generate` write
`roles/owner.ts` (`createOwnerClient`) with only the operations the owner's Today needs, from
`roles.json`'s `owner` (Today, the four approval operations, the notice inbox's three, `user.me`).
It is not a pack role: any staff account may sign in with it, on the device's one staff session,
and the host decides every call.
