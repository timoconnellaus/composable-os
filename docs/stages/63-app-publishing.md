# Stage 63: App publishing

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Client
repos), [`CONTEXT.md`](../../CONTEXT.md) (Client app, Client repo, Environment, Client kit, Block,
Typed client, API contract, Device session, Pack role, Hosted client, Fleet),
[`docs/deploying.md`](../deploying.md) (a client repo, environments, staff in the company's mobile
app), ADRs [0166](../adr/0166-no-telemetry.md) (no telemetry),
[0402](../adr/0402-staff-and-customers.md) (audiences: opening an operation to the public is a
reviewed change), [0417](../adr/0417-the-api-contract-and-versions.md) (API versions),
[0419](../adr/0419-native-sessions-and-customer-sign-in.md),
[0422](../adr/0422-client-repos-and-one-command-as-built.md),
[0450](../adr/0450-client-environments.md),
[0451](../adr/0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md),
[0455](../adr/0455-staff-invites-and-native-sign-in-by-tokens.md),
[0456](../adr/0456-the-hosts-sign-in-mail.md),
[0478](../adr/0478-the-courses-pack.md) (the block lint's `noPurchase`),
[0490](../adr/0490-the-course-plan-self-service-and-the-staff-side.md) (billing kept off the app),
[0610](../adr/0610-three-homes-for-a-client-hosted-by-default.md),
[0629](../adr/0629-the-rosters-screens-role-clients-with-grants-and-the-roster-import.md) and
[0630](../adr/0630-ci-on-namespace-runners.md) (the platform's CI runners are Linux); stage
[46](46-hosted-clients.md) (decisions 19 and 20, "Who may deploy"), stage
[47](47-pack-screens.md) (staff screens in the admin), stage 48 (My account, PR #311: the
native account shell and its "Delete my account" section), and the stage 30 proposal
(Notifications: the push gatekeeper, issue #116); `templates/client/apps/mobile/` (`app.json`,
`App.tsx`, `src/host.ts`), `packages/product/src/index.ts` (`mobile`),
`packages/client/src/client.ts` (`onUpgradeRequired`), `packages/core/src/http/surface.ts` (the
`426 upgrade_required` answer), `packages/release/src/deploy.ts` and `operator.ts` (the deploy path
reading and writing a host's D1 with the deploy credential), `scripts/check-blocks.mjs`,
`blocks/native-base/theme.ts`.

Status: **spec agreed** (owner interviewed 2026-11-24: decision 1 answered by the owner, decisions
2 to 10 decided as best practice the same day and open to override). Build may start. Issues: #194
and #237 (buying in the app, deferred), #116 (push to client apps, stage 30), #121 (preview builds
per branch), #120 (a TV app).

## Status

Built (`feat/stage-63-app-cli`, ADRs 0900, 0901 and 0905; not yet tried on a real store account):

- **Step 1** — built — PR #369 — `mobile.app` and its checks; `app.config.ts`; `brand.ts`: `mobile.app` in the product definition, per environment, and its checks in
  `defineClientProduct`; `appBuild`; the template's `app.json` replaced by `app.config.ts` (name,
  ids, scheme, icon, splash, colours, host and build number from `product.ts` and `COS_ENV`);
  `brand.ts` written by `cos client generate` at `apps/mobile/src/blocks/brand.ts` (beside the
  copied blocks, not `src/brand.ts`: ADR 0900) and read by the native base theme.

- **Step 2** — built — PR #369 — `cos app check`, `credentials`, `build-info`; the purchase scan: `cos app check`, `cos app credentials` and `cos app build-info`; the purchase scan
  over the client's app code, its rules shared with the block lint
  (`packages/create-composable-os/src/purchase-rules.ts`).

- **Step 3** — built — PR #369 — The CI workflow; `cos app record`; the runbook: the template's workflow (`templates/client/.github/workflows/app.yml`), `cos app
  record` (writing `core_app_build` over the deploy path; the table is step 4's migration 1370),
  `cos app upload --platform android` (the internal testing track), and the runbook,
  [`docs/app-publishing.md`](../app-publishing.md). Deviations in ADR 0901: two small `cos` jobs
  hold the deploy credential (the number before, the record after); the iPhone listing is entered
  by the person who submits; the Android listing is sent only when asked.

- **Step 4** — not built — The build header, the minimum build and its warning, `app.status`,
  `core_app_build` (migration 1370), the settings operations, Settings → App.

- **Step 5** — not built — Review access (migration 1371).

- **Step 6** — not built — `native-update-required`; template wiring (`onUpgradeRequired`, the account
  shell).

- **Step 7** — not built — needs: stage 66 step 7 — The API version guard in `cos deploy` and the fleet
  update.

- **Step 8** — not built — needs: stage 30 step 4 — Push readiness.

- **Step 9** — not built — needs: stage 48, the first client's store accounts and real phones — The first
  client: accounts, keys, listing, review access, first release.

## Goal

Every client's app reaches the two phone app stores under the client's own name, icon and colours,
from the client's own store accounts, the same way every time. The name, the icon, the store
listing and the host each build talks to come from the client's product definition. The app is
built and signed in CI with keys a person set, sent to the stores' testing tracks, and released to
the public by a person once the client has said yes. A host update never silently breaks an app
already on people's phones, and an app too old to keep working tells its user to update. Store
reviewers can sign in without anyone's real data. Nothing in the app sells anything (ADR 0490).

## Who it is for

- **Gyms and studios first.** Members use the app every week: the timetable, booking, what they
  have left, their agreements, their courses. Coaches use the same app for the class list and the
  roster (ADRs 0451, 0629). The app is public in both stores under the gym's name, and must keep
  working through the platform's own updates of the gym's host.
- **Trades and services next.** Their customers rarely install an app; their workers live on their
  phones. Until such a client asks for an app, its workers use the product's admin on a phone
  (stage 47's fixed-role shell). No staff-only app is built in this stage (decision 7).

## What exists today (from the code, checked 2026-11-24)

- **The template's app** (`templates/client/apps/mobile`, copied by `cos create --with-mobile`): a
  plain sign-in, Home and Account tabs, `src/host.ts` (customer and staff sessions over device
  sessions, ADRs 0419, 0451, 0455), `secure-store.ts`, `secure-random.ts` and the generated
  customer client. Its `app.json` is static: `name: "Client"`, `slug: "client"`,
  `scheme: "client"`, `version: "1.0.0"`, the host's address hand-written in `extra.hostUrl`. No
  bundle identifier, no Android package name, no icon, splash or build number, no build
  configuration, and no CI workflow for the app (the template has no `.github` folder).
- **The product definition** (`packages/product/src/index.ts`): `mobile: { dir, clientDir, roles,
  scheme }`, and per environment `mobile: { scheme }`; `cos deploy` uses the scheme for
  `NATIVE_REDIRECT_URIS`. Nothing about the app's store identity, brand or listing, and the host's
  address is not passed to the app build.
- **Brand in the app** is `blocks/native-base/theme.ts`, a copied block's constants edited by hand.
- **Native blocks** (`blocks/native-*`, `packs/*/blocks/*-native-*`): sign-in, agreements, and the
  packs' screens. The block lint (`scripts/check-blocks.mjs`) refuses billing operations in every
  native block and buying in a `noPurchase` block (ADRs 0478, 0490). It runs on the platform's
  blocks only, not on a client's own app code.
- **API versions** (ADR 0417): the host serves `SERVED_API_VERSIONS` and answers an older version
  `426 upgrade_required` (`surface.ts`); the runtime client calls `onUpgradeRequired`. The
  template's app sets no `onUpgradeRequired` and has no update screen. The host does not know which
  app builds exist, and nothing stops a release from dropping a version an installed app uses.
- **Account deletion:** `me.deleteAccount` exists; no native block offers it today. Stage 48 adds
  the native account shell with a "Delete my account" section (with a preview and confirm).
- **Sign-in is by an emailed code** (ADRs 0455, 0456). A store reviewer cannot receive one.
- **The deploy path writes host records with the deploy credential**: `packages/release` reads and
  writes `core_install` and `core_update_runs` over the D1 API (`deploy.ts`, `operator.ts`). This
  is the precedent for recording builds.
- **Hosting:** a hosted bespoke client's repository is ours while hosted, and its CI deploys with a
  secret we add that reaches the whole fleet (stage 46, decisions 19 and 20). The platform's CI
  runs on Linux runners (ADR 0630); nothing builds for iOS, which needs a macOS machine.
- **No telemetry** (ADR 0166): the app carries no outside company's crash or analytics kit.

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | **The first client has no app in the stores today, and wants both iPhone and Android.** There is nothing to take over: its app gets a first listing in each store (owner's answer) |
| 2 | **Each client's app is published from the client's own store accounts,** with us invited as a member who may upload and release. The store shows the client's business as the seller, and a client who leaves keeps its app (decided as best practice) |
| 3 | **The client pays the stores' yearly account fees directly** (decided as best practice) |
| 4 | **A person on our side releases each version to the public, once the client has said yes.** Nothing goes out on its own when a store approves it (decided as best practice) |
| 5 | **Every change goes through the stores at first.** Sending fixes straight to phones (over-the-air updates) is added after the first client's app is live, as a later step (decided as best practice) |
| 6 | **Staff use the same app as members,** signing in as staff (ADR 0451, as built) (decided as best practice) |
| 7 | **A trades or services business's workers use the product's admin on their phones** until a client asks for an app (stage 47) (decided as best practice) |
| 8 | **Nothing is bought in the app.** All buying stays on the website; the app shows what people have (ADR 0490) (decided as best practice) |
| 9 | **An old version gets 14 days' warning in the app** before it stops working and asks to be updated. An admin may choose no warning in an emergency (decided as best practice) |
| 10 | **An admin can make a temporary test member for store reviewers,** with no real data and a fixed code, that ends on its own after 14 days (decided as best practice) |

Following from decisions 1 and 2 (decided by the coordinator, without asking): the first client
opens its own developer account in each store and pays for it; **the signing files and the store
accounts' passwords are held by the client, never by an AI and never in a repository.** We are
given only what the stores issue for uploading (an upload key or a store API key with a limited
role), which a person sets as CI secrets and the client can revoke in its store account at any
time.

## The design in one page

```
 product.ts ── mobile.app (name, version, store ids per environment, brand, listing folder)
     │
     ▼
 apps/mobile/app.config.ts  ◄── COS_ENV=staging|live      (replaces the static app.json)
     │   name, ids, scheme, icon, splash, colours, hostUrl, build number, API version
     ▼
 cos app check   ids, sizes, listing lengths, purchase scan, account deletion present, no key files
     │
     ▼
 CI (client repo): build ─► sign ─► upload to the stores' TESTING tracks ─► cos app record
     │             (behind a protected CI environment a person approves; keys are CI secrets
     │              a person set; never an AI, never in the repo)
     ▼
 a person on our side, after the client's yes: submit for review, release to the public
     │
     ▼
 host: knows each environment's builds and their API version; answers a build below the minimum
       "update"; cos deploy and the fleet update refuse a release that would drop an API version a
       supported build still uses
```

- **One source for the app's identity:** a new `mobile.app` block in `product.ts`, per environment
  where it differs (a staging app installs beside the live one, with its own name, ids and host).
  The template's static `app.json` becomes `app.config.ts`, which reads `product.ts` and the
  environment, so the host's address is never hand-written again.
- **Brand from the product, once:** icon, splash and three colours named in `product.ts` (the image
  files in the repo); `cos` writes `apps/mobile/src/brand.ts`, which the native base theme reads.
- **The store listing lives in the repository** (`apps/mobile/store/<locale>/`: name, subtitle,
  description, keywords, support and privacy addresses, release notes, screenshots), checked by
  `cos app check` and uploaded with the build. A person submits it.
- **Build and sign in the client repository's CI** (a workflow in the template): Android on a Linux
  runner, iOS on a macOS runner, using the app framework's own local build tools, so no outside
  build service holds the client's keys. Uploading runs only from `main`, behind a protected CI
  environment whose run a person approves.
- **Releases through the stores only** in this stage (decision 5).
- **Versions:** each build sends its platform and build number on every call. The host records
  each environment's builds (written by the deploy path, never by a caller), answers a build below
  the business's minimum with the update answer, and `cos deploy` and the fleet update refuse a
  release that stops serving an API version a supported build uses.
- **Store review sign-in:** a human admin starts a review access (decision 10).
- **Nothing is bought in the app** (decision 8): `cos app check` also scans the client's own app
  code for billing and buying operations.
- **Account deletion in the app is stage 48's** "Delete my account" section of the native account
  shell; this stage's check refuses a store build without it.

### What was weighed and rejected

| Option | Why not (or not now) |
| --- | --- |
| **One publisher account (ours) for every client's app** | Decision 2. The seller shown would be us; as we read the iPhone store's guidelines, apps made from a template are expected to come from the account of the business whose content they carry; a client leaving (ADR 0610) would need its app moved between accounts |
| **An outside hosted build and update service** | One more outside account per client holding signing keys, priced per build, and a second place secrets live. The framework's local build tools on CI runners do the same. Kept as the fallback if macOS runners prove impractical |
| **Building on a person's own machine** | Not repeatable, and the keys would sit on a laptop. Allowed once, for the first build of the first client, to learn; that build is still recorded with `cos app record` |
| **Over-the-air updates from day one** | Decision 5: a second release path with its own key, before the first app is in the stores |
| **A separate staff app per client, or a shared one for all** | Decision 6. A role client is generated per product (ADR 0451), so one generic binary cannot carry every product's staff operations; a separate app per client doubles the store work for a few users |
| **Brand edited by hand in `theme.ts`** | Today's way: it drifts from the listing and cannot be checked |
| **The minimum build as a `product.ts` field** | An urgent "update now" would need a deploy. It is a host setting a human admin changes |
| **Selling in the app, by the stores' payments or by linking to the website** | Decision 8. A second payment path and the stores' share; what an app may say about paying on the website differs by store and country. Deferred (#194, #237) |
| **The update notice as a My account attention kind** | It must show before sign-in and is about the app, not the customer's account. It is the app shell's own screen and banner (below) |

## What the stores require (as we read their public guidelines, for the owner to confirm)

These are the stores' rules, not law, and they change. Each is read again from the stores' own
pages before the first client's first submission. Anything legal (the privacy policy's wording,
what the business must tell its members) is for the business to confirm with its lawyer.

- **A developer account per publisher**, paid yearly. An organisation account shows the business's
  legal name and asks for proof the business exists (such as a company registration number). The
  client opens organisation accounts (decided below); a personal account would show a person's name
  and, on Android, may have to run a closed test before a public release.
- **Identifiers that never change:** a bundle identifier (iOS) and a package name (Android), one per
  app and per environment.
- **Signing:** iOS needs a distribution certificate and a provisioning profile from the account;
  Android needs an upload key, with the store holding the app's own signing key (so a lost upload
  key can be replaced without a new listing).
- **Review:** every build and listing change is reviewed; a reviewer needs a working sign-in;
  account deletion must be possible inside the app when an account can be made in it; the listing
  needs a privacy policy address and answers about what data the app collects.
- **Digital goods:** content used inside the app bought inside the app goes through the store's own
  payments; services used outside the app may be paid another way. The lines differ by store and
  country. Decision 8 keeps the app clear of all of it.
- **Push** needs a push key from the iOS account and a push project for Android, tied to the same
  identifiers (stage 30 holds and uses them).

## Platform work and pack work

| Piece | Kind | Where |
| --- | --- | --- |
| `mobile.app` in the product definition, per environment; its checks | Platform | `packages/product/src/index.ts` |
| `app.config.ts` from `product.ts` and `COS_ENV`; `brand.ts` written by `cos`; the base theme reading it | Platform (template, client kit) | `templates/client/apps/mobile`, `blocks/native-base/theme.ts` |
| `cos app check`, `cos app credentials`, `cos app build-info`; the purchase scan over a client's own app code | Platform (CLI) | `packages/create-composable-os`, rules shared with `scripts/check-blocks.mjs` |
| The CI workflow for builds and testing-track uploads, behind a person's approval | Platform (template) | `templates/client/.github/workflows/app.yml` (new) |
| `cos app record`: writes `core_app_build` with the deploy credential | Platform (release) | `packages/release` |
| The build header; the minimum build; the update answer; `app.status` | Platform, HTTP surface | `packages/client`, `packages/core/src/http/surface.ts` |
| `core_app_build`; `app.builds`, `app.settings`, `app.updateSettings`; Settings → App | Platform, new core table, operations and admin screen | `packages/core`, `packages/db`, `apps/app` |
| The API version guard in `cos deploy` and the fleet update | Platform | `packages/release`; stage 46's fleet update (`cos-fleet`) |
| Review access for store reviewers | Platform, sign-in | `packages/core/src/customers`, `apps/app/src/server/http/native.ts`, `packages/db` |
| `native-update-required` block; the template wires it, `onUpgradeRequired` and stage 48's account shell | Base layer block, template | `blocks/native-update-required`, `templates/client/apps/mobile` |
| Push readiness in the build | Platform, after stage 30 | template, `cos app check` |
| The first client's accounts, keys, listing, review access, first release | Runbook | `docs/app-publishing.md` (new) |

No pack changes. No pack hooks a write. Nothing new in any pack's manifest.

## The model

### The product definition

```ts
mobile: {
  dir: "apps/mobile",
  roles: ["bookings.coach"],
  app: {
    name: "Example Gym",               // the name under the icon (at most 30 characters)
    version: "1.0.0",                  // the version people see; bumped by a pull request
    ids: { ios: "com.example.gym", android: "com.example.gym" },  // never change once published
    icon: "apps/mobile/assets/icon.png",      // 1024 by 1024, no transparency
    splash: { image: "apps/mobile/assets/splash.png", background: "#101010" },
    colours: { primary: "#e11d48", background: "#ffffff", text: "#18181b" },
    listing: "apps/mobile/store",      // per locale: name, subtitle, description, keywords, notes
    purchases: "none",                 // the only value this stage accepts
  },
},
environments: {
  staging: { mobile: { scheme: "gym-staging", app: { name: "Gym (staging)",
    ids: { ios: "com.example.gym.staging", android: "com.example.gym.staging" } } } },
}
```

The names above are an example; the client's names are written once, in its `product.ts`.

Checks (`cos deploy` and `cos app check`, before any call): ids are reverse-domain and differ
between environments; the scheme is set and differs between environments; the icon exists at its
size; colours are valid and the text colour is readable on the background (a contrast check);
listing texts are within the stores' lengths; `purchases` is `"none"`; an id that differs from one
already recorded in `core_app_build` for that environment is refused.

The build number is not in `product.ts`: `cos app build-info` gives the next one (the highest
recorded for that environment, across both platforms, plus one) and the API version the app's
generated client was made against. One CI run uses one build number on both platforms.

### Records

- **`core_app_build`**: environment, platform (`ios`, `android`), app version, build number, API
  version, the bundle id or package name, the commit, when it was uploaded, and `supported` (true
  until the minimum build for its platform passes it). Written only by `cos app record` over the
  deploy path, as `packages/release` writes `core_install` today; no operation writes it. No
  personal data.
- **App settings** (in `core_settings`, no new table): per platform the minimum supported build and
  the date it takes effect (14 days after it is set by default; today for an emergency), the update
  message, the store links. Until that date a build below the new minimum is answered normally,
  with a warning the app shows as a banner (`app.status`, and a `Cos-App-Warning` header). Human
  admins only.
- **`core_review_access`**: the Person (a test member made for it, marked as a review member), who
  started it, the code's slow hash, created, ends (at most 14 days), uses, ended by whom.

### Operations

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `app.builds` (each environment's recorded builds, which are supported, their API version) | staff | `records:read` (as the host's other settings reads) | read |
| `app.settings` / `app.updateSettings` (minimum build per platform and its date, update message, store links) | staff | human admin, `settings:manage`, `actors: ["human"]`, not on MCP | write; raising the minimum is shown first as "these builds will be told to update on this date" |
| `app.status` (for the build named: supported, the warning or update message, the store link) | **public**, a reviewed opening (ADR 0402) | anyone; answers only for the build named | read |
| `reviewAccess.start` (makes a test member and a code, shown once) | staff | human admin, `actors: ["human"]`, not on MCP | write; a new way in, so admins are told |
| `reviewAccess.end`, `reviewAccess.list` | staff | human admin | write / read |

`app.status` is public on purpose: the update screen must work before sign-in. It says nothing but
whether that build works and where to update.

**The build header.** The runtime client sends `Cos-App: <platform>/<build>` on every call when the
app passes its build (the template does). The surface answers `426 upgrade_required` with the
update message when the build is below the minimum in effect for its platform, exactly as it
answers an API version no longer served. A call without the header (the web app) is unchanged.
The header goes only to the client's own host; nothing is sent to us (ADR 0166).

### Review access

A human admin starts it from Settings → App, for the live environment: the host makes a Person and
a customer account marked as a review member, with no membership, pass or other records, and shows
a code once. Signing in with that address and code works (ADR 0455's routes; no mail is sent for a
review member), only for that address, until the end date. The reviewer sees what any new member
sees and can book only what a new member could; whatever it makes is erased with it. Every sign-in
is audited, and admins are told when it starts, the first time it is used and when it ends (as the
host tells admins today, `packages/core/src/customers/subscriber-signup.ts`). Ending it, by hand or
at its date, ends the account's sessions and erases the test Person. It never applies to a staff
account; a reviewer who must see the staff side is given a staff invite by a person.

### CI, keys and who does what

- **The store accounts are the client's** (decision 2). The client opens an organisation account in
  each store, pays for it (decision 3), keeps its passwords, and invites our person as a member with
  the role that may upload and release. The client can remove us at any time.
- **The workflow** (`app.yml` in the client template): on a person's manual run or a version tag on
  `main`: `cos app check`; build Android on Linux and iOS on macOS (the macOS runner is a repository
  setting, default the repository host's own); sign; upload to the testing tracks with the listing;
  then one small Linux job runs `cos app record`. Every job that holds a secret uses a protected CI
  environment whose run a person approves; a pull request from a fork gets no secret.
- **Keys** (each a CI secret, set by a person; `cos app credentials` names each and the command to
  set it, never a value): the iOS store API key and its ids, the distribution certificate and its
  password, the Android upload key and its password, the Android store's upload account key. They
  are made in the client's own store accounts. Never in `product.ts` or the repository: `cos app
  check` refuses a file that looks like one. The build jobs hold only the store keys; only the
  record job holds the deploy secret, because for a hosted client that secret reaches the whole
  fleet (stage 46, "Who may deploy").
- **Hosted clients:** the repository is ours while hosted (stage 46, decision 20), so the CI secrets
  sit in our organisation; they are revocable upload keys, never the client's passwords or the
  store's own signing key. A client moving to its own account sets them again in its own repository
  (secrets do not move).
- **Release to the public** is a person's action on our side, in each store's console, after the
  client's yes (decision 4), recorded on the release's pull request or tag. No command releases to
  the public. A staging app goes to testing tracks only and is never listed publicly.

### Push (with stage 30)

This stage makes the build ready for push: the push entitlement and identifiers in
`app.config.ts`, the key names in `cos app credentials`, and the registration call in the template
after the person allows notifications. Stage 30's push gatekeeper holds the push keys (set by a
human admin, never readable back) and sends. Staging and live are separate apps with separate push
keys.

### Over-the-air updates (a later step, after the first client's app is live)

Not built in this stage (decision 5). When it comes it gets its own spec section and ADR, along
these lines: the host serves updates of its own app's code from its bucket; each update is signed
in CI with a key a person holds and the app trusts only that key; an update names the build it fits
and the API version it calls; a person approves each; one step back republishes the previous one.

### Buying in the app: the constraint

The app shows what a person holds and lets them book with it; it never sells (decision 8, ADR
0490). The block lint holds it for the platform's blocks, and `cos app check` now holds it for the
client's own app code too (a billing or buying operation named anywhere in `apps/mobile` fails).
It is a product rule, not a security boundary: the host still decides every call. Stage 48's
native shell sends a member to the website for their card and plan, which stays as stage 48 says.

### Screens

- **Web admin:** Settings → App (a host settings screen, not a pack screen): the builds per
  environment and platform with their API version and whether they are supported; the minimum
  build, its date and the update message; review access (start, list, end). Human admins change;
  other staff see.
- **Native:** `native-update-required` (shown on the update answer or from `app.status`, with the
  store link) and the warning banner during the 14 days; the template wires both, sets
  `onUpgradeRequired`, and includes stage 48's `native-account` with its "Delete my account"
  section. Nothing about the app's version is a My account section or attention kind.
- **Customer web:** nothing new.

### Notifications

Admins are told when review access starts, is first used and ends, and when a raised minimum build
takes effect. We (the fleet operator) are told by the fleet update when a release is held back
because a supported build still uses an API version it would stop serving.

### What an AI may do

May: write listing drafts, release notes and a draft of the privacy answers (from the operations
the app calls), suggest brand colours, run `cos app check`, open a pull request with a version bump.
May not: create, see, hold or set any signing key, store key or push key; hold a store account's
password; approve a CI run; submit for review or release to the public; start review access; change
the minimum build (human admin, not on MCP).

### Privacy and erase

The app holds tokens only in the device's secure store (ADR 0419) and no outside company's data kit
(ADR 0166); crash reports are the stores' own consoles. `core_app_build` holds no personal data. The
review member is a test Person erased when access ends; its sign-ins are audited. The privacy
answers in the listing are drafted from the operations the app calls, and a person confirms them;
the privacy policy itself is the business's, for it to confirm with its lawyer. Erasing a member is
unchanged.

## Out of scope

- Selling in the app (store purchases or linking out): #194, #237.
- Over-the-air updates (decision 5: a later step).
- A staff-only app, and a privately distributed app (decision 7: when a client asks).
- The standard tier's app (no repository, ADR 0610).
- Preview builds per branch (#121), a tablet or TV app (#120), screenshots made automatically.
- Sending push, device registration, quiet hours: stage 30.
- Store analytics or ratings in the admin.
- Moving an app that is already listed under someone else's account (decision 1: the first client
  has none; added when a client needs it).

## Acceptance criteria

1. With `mobile.app` set, `app.config.ts` gives the staging and live builds their own name, ids,
   scheme and host address from `product.ts`; no host address is written in the app's files.
2. `cos app check` refuses: ids or schemes the same in two environments, an id that differs from a
   recorded build's, a missing or wrong-sized icon, an unreadable text colour, a listing text over
   a store's length, `purchases` other than `"none"`, a billing or buying operation named anywhere
   in the app's code, an app without the account shell's "Delete my account", and a key file in the
   repository.
3. `cos app credentials` names every secret the workflow needs and the command to set it, and prints
   no value; the workflow fails with that list when one is missing.
4. The template's workflow builds and signs both platforms from `main` and uploads to the testing
   tracks only after a person approves the run; a pull request from a fork gets no secret; only the
   record job holds the deploy secret.
5. `cos app record` writes `core_app_build`; no operation writes it. `cos app build-info` gives the
   next build number and the generated client's API version.
6. A call with `Cos-App: ios/41` when the minimum in effect is 42 is answered `426` with the update
   message; the template shows `native-update-required`; `app.status` answers the same before
   sign-in. Before the minimum's date the call is answered normally with `Cos-App-Warning`, and the
   app shows the banner.
7. `app.updateSettings` is refused for an AI, an MCP client and a non-admin; raising the minimum is
   shown first with the builds it will stop and the date (14 days by default, today if chosen).
8. `cos deploy` and the fleet update refuse a release whose served API versions leave out one a
   supported build uses, naming the build; with that build no longer supported they go on.
9. Review access: a code works for its address only, until its end; a wrong code is the usual
   refusal; no mail is sent; each use is audited; admins are told; ending it ends the sessions and
   erases the test Person; it cannot be started by an AI, on MCP, or for a staff account.
10. `brand.ts` is written from `product.ts`, and the native base theme reads it.
11. One e2e journey (on the host): an old build is told to update; an admin raises the minimum.
12. The first client's app is in both stores' testing tracks from CI, under the client's own
    accounts, and a person on our side has released it after the client's yes (runbook, real
    accounts).
13. The site: `SITE.md` and the "a mobile app when needed" line say what is true when this merges.

## Dependencies

- Built: stage 23 (API versions, device sessions), stage 24 (template, `cos`), ADRs 0451 and 0629.
- Stage 46 (hosted clients, in build): the fleet update's guard, and who holds a hosted repo's
  secrets. The guard in `cos deploy` does not wait for it.
- Stage 48 (My account, spec on PR #311): the native account shell with "Delete my account". Steps
  1 to 4 do not wait for it; the check in criterion 2 and the first store submission do.
- Stage 30 (Notifications, proposal): push readiness (step 8) waits for its push gatekeeper.
- Stage 47 (pack screens): the admin on a phone for trades' workers; no code dependency.

## Migrations and numbers

Block **BY** (claimed in `parallel-work.md` by the coordinator): migrations 1370 to 1389, ADRs 0900
to 0909. Expected:

- Migration 1370 `core_app_build`; 1371 `core_review_access`. App settings use `core_settings`.
- ADR 0900: the app's identity, brand and listing from `product.ts` (`mobile.app`, `app.config.ts`,
  `brand.ts`).
- ADR 0901: publishing from the client's own store accounts; building and signing in the client
  repository's CI; keys held by people, never an AI or the repository; a person on our side releases
  after the client's yes. Notes ADR 0630 (the client repository's workflow needs a macOS runner; the
  platform's CI is unchanged).
- ADR 0902: the build header, the minimum build with its warning period, and `app.status` opened to
  the public (amends ADR 0417 with a dated note; the public opening per ADR 0402).
- ADR 0903: the API version guard on `cos deploy` and the fleet update (amends ADR 0417).
- ADR 0904: review access for store reviewers (amends ADR 0455 with a dated note).
- ADR 0905: the purchase scan over a client's own app code (amends ADR 0490 with a dated note).

## Suggested build order

| Step | What | Files or areas | Can run beside | Collides with |
| --- | --- | --- | --- | --- |
| 1 | `mobile.app` and its checks; `app.config.ts`; `brand.ts`; base theme reads it | `packages/product`, `templates/client/apps/mobile`, `blocks/native-base` | 3, 4, 5, 6 | Stage 46 (also adds to `packages/product`); stage 48 (template's `App.tsx`) |
| 2 | `cos app check`, `credentials`, `build-info`; the purchase scan | `packages/create-composable-os`, `scripts/check-blocks.mjs` (shared rules) | 4, 5, 6 | Any change to the block lint; stage 48's `cos add` section wiring in the same package |
| 3 | The CI workflow; `cos app record`; the runbook | `templates/client/.github`, `packages/release`, `docs/app-publishing.md` | 4, 5, 6 | Stage 46 (`packages/release`) |
| 4 | The build header, the minimum build and its warning, `app.status`, `core_app_build`, the settings operations, Settings → App | `packages/client`, `packages/core/src/http/surface.ts`, `packages/core`, migration 1370, `apps/app` settings | 1, 2, 3, 5, 6 | Anything in `http/surface.ts`; the Settings index and route tree |
| 5 | Review access | `packages/core/src/customers`, `apps/app/src/server/http/native.ts`, migration 1371 | 1, 2, 3, 6 | Sign-in work (stage 48's change of address, stage 30's text sign-in if any) |
| 6 | `native-update-required`; template wiring (`onUpgradeRequired`, the account shell) | `blocks/`, `templates/client/apps/mobile` | 1 to 5 | Stage 48's native shell in the template |
| 7 | The API version guard in `cos deploy` and the fleet update | `packages/release`, stage 46's fleet update | 5, 6 | Stage 46's fleet update step: build after it or in it |
| 8 | Push readiness | template, `cos app check` | 5, 6, 7 | Stage 30's gatekeeper |
| 9 | The first client: accounts, keys, listing, review access, first release | runbook, the client's repo | — | Needs real accounts, a macOS runner and real phones; stage 48 merged |

Size: **medium**. Mostly tooling and the template; two small host pieces and two tables. Three
build sessions at once: steps 1 to 3 (CLI and template), step 4 with 6 (host and blocks), step 5
alone; then 7 with stage 46 and 8 with stage 30.

## Decided by this spec, open to override

- Decisions 2 to 10 above were decided as best practice without asking, and are open to override.
- The client opens **organisation** developer accounts in both stores (the business's legal name
  as seller; avoids the personal-account testing rule).
- We hold only revocable upload keys, as CI secrets; never the client's passwords, never the
  store's own app signing key (the Android store keeps it).
- The framework's local build tools on CI runners, not an outside build service.
- The macOS runner is a repository setting, default the repository host's own.
- The build jobs hold no deploy secret; one small record job does.
- The build number is the highest recorded plus one, the same on both platforms in a run; the app's
  version is `mobile.app.version`, bumped by pull request.
- The API version a build uses comes from its generated client, not a `product.ts` field.
- The minimum build is a host setting, not a `product.ts` field, so an urgent "update now" needs no
  deploy.
- The API version guard stops the release, not the app: we keep the old version served longer.
- `purchases` has one value, `"none"`. No `audience` field until a client asks for a staff-only app.
- A staging app goes to testing tracks only.
- The update notice is the app shell's own, not a My account section or attention kind.
- The client's yes to a release is recorded on the release's pull request or tag.
- Review access is for the live environment, a test member with no records, at most 14 days.

## Questions for the owner

None. The owner's one answer (no app in the stores today; both iPhone and Android) settled the
only question that was not best practice.

## Risks

- **Signing and upload keys.** A leaked store key or upload key lets someone upload as the client.
  Held only as CI secrets, behind a person's approval, forks given none, the Android store keeping
  the app's signing key, and revocable by the client. A hosted client's keys sit in our
  organisation: one breach there reaches every hosted client (stage 46's same note).
- **Review access is a way in** with a known code: test member only, one address, 14 days, audited,
  admins told, human admin only.
- **`app.status` is public.** It answers only about the build named and reveals only store links,
  which are public anyway.
- **Store rejection** for reasons we cannot test here (template-made apps, sign-in, privacy answers,
  digital goods). Needs the first client's real submission.
- **Needs real things:** the client's developer accounts (and the business proof they ask for), a
  macOS runner, a real iPhone and Android phone, and the stores' current guidelines read again.
- **The guard depends on records.** A build uploaded by hand is not recorded unless `cos app record`
  is run; the runbook says every build goes through CI (or is recorded by hand, once, for the first).
