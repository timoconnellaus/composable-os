# ADR 0660: Pack screens in the admin

Status: accepted, 2026-11-24 (stage 47, [spec](../stages/47-pack-screens.md); owner interviewed
2026-11-24). Builds on ADRs [0401](0401-platform-packs-screens.md),
[0421](0421-the-client-app-binding-and-customer-sign-in.md),
[0424](0424-blocks-as-built.md), [0436](0436-pack-roles-and-the-door-role.md),
[0449](0449-permissions-granted-one-by-one.md), [0453](0453-pack-hooks-over-the-clients-operations.md),
[0600](0600-a-pack-role-and-its-grants-add-up.md), [0625](0625-restricted-pack-permissions.md) and
[0629](0629-the-rosters-screens-role-clients-with-grants-and-the-roster-import.md). Amends ADRs
[0005](0005-extensions.md), [0010](0010-dashboards-sql-views.md), 0401 and 0436, and closes the open
item of 0629 and of the stage 45 spec ("Not shown in the product's admin yet").

## Context
Packs ship web blocks for staff (Bookings' desk and class list, Memberships' staff view of a
person, the Programs and Courses builders, all of Rostering's screens), but the product's admin
mounted none of them: they ran only on the development page (`/blocks`), and a company's web app
never serves staff (ADR 0421). A fixed-role account (a coach, the door, a rostered cleaner) could
sign in to the admin and was refused every call its shell made.

## Decision
- **A shipped pack declares its staff screens** in its manifest (`screens`, `ScreenSpec` in
  `@composable-os/sdk`): a label, a web block of the same pack and the component it exports, where
  it sits in the navigation (`nav: { group, order }`), what gates it (`opens`, the pack's own tools
  that decide who may open it; `writes`, objects of the pack it writes through the host's record
  operations), and optionally `record: { object, as }` for a tab on that object's record page (one of the pack's
  objects, Person or Organisation) given the record's id as the prop `as`. A record screen with
  `nav` too is also listed in the navigation, opened without a record; its block chooses one
  (Bookings' class list: today's classes, for a coach). The contract refuses an empty gate, a tool
  of another pack or one it does not have, a tool staff cannot call, a gate of only tools open to
  customers or the public (except on a record screen, a tab on a staff record page about one
  record, where tools staff share with customers are staff's: a coach logging a client's sets), a
  `writes` object not the pack's own, a native block or another pack's, and a record on any other
  object.
- **A gate names the tools that decide who may open the screen, not every tool it calls**: its
  main read and the write its main action makes. The host refuses every other call the viewer may
  not make, and the block shows its own state for that (Rostering's "not yours" states, a refusal
  message). A screen that saves through the host's record writes rather than a tool (Courses'
  builder, Programs' bank and builder) is gated by `writes`: the viewer must pass `record.update`
  on that object, so no viewer or pack role gets it.
- **Only shipped packs.** A runtime extension declaring `screens` fails `cos ext check` and install
  (as `restricted` and `staffing` do), and the key is ignored at run time: `screens.mine` reads
  only installed, active, shipped rows. Nothing is loaded at run time from an extension's files and
  there is no frame: the admin's build holds this repository's packs' blocks, reviewed with the
  code. **The host lists only what the build holds**: the build hands the host each repository
  pack's gate fingerprint (`screenGateFingerprint`: its screens and everything their gates are
  judged by), and `screens.mine` lists a pack's screens only when the installed row's manifest
  gives the same one. A row holding a pack's id with another manifest lists nothing; a host with no
  admin build lists nothing. And an org's own extension (ADR 0422) may not take the id of any pack
  the release carries, listed or not (`shipped-list.ts`); only local development, which delivers
  some packs as org extensions, says otherwise (`COS_DEV_ORG_PACKS`, never set by a deploy, and
  ignored outside a Vite development build, so a var set by hand on a deployed Worker does
  nothing).
- **The host decides who sees a screen: `screens.mine`.** A staff core read (staff audience only;
  a customer or the public is told no such operation exists) answering, for the caller, each
  screen they may open: pack, key, label, nav, route (`/s/<pack>/<key>`) and record. A screen is
  listed when its pack is installed, active and shipped, the build holds it, and the caller passes
  the pipeline's own checks for every tool in `opens` as a person (`staffAuthority`: role, pack
  role, grants, restricted permissions; the tool's audience and actors) and `record.update` on
  every object in `writes`. A gate is "could call these", not a permission of its own. For any
  actor but a person it is empty: an assistant has the tools; MCP does not list it. It names
  nothing else (no counts, nothing greyed out). One unreadable installed manifest lists nothing and
  is logged once; the others still list. Its handler reads two statements, whatever is installed
  (beside the pipeline's own identity and rights reads every staff call makes).
- **Pack roles reach this one core read** (`PACK_ROLE_CORE_READS` in `pack-roles.ts`), so a fixed-
  role account's admin can ask for its screens. Nothing else is opened: a registry walk over every
  core operation and every carried pack's tools proves the coach, the team and the door reach what
  they reached before plus `screens.mine` (`packages/core/test/screens.test.ts`; `roles.json`
  shows the same diff).
- **The admin builds the screens in** (`apps/app/screens-plugin.ts`, the pattern of the gatekeeper
  configurators' plugin): at build time it reads every pack's declaration (its `index.ts` bundled
  with esbuild), finds each screen's block and export where it sits and the pack's hooks factory in
  its headless entry, and emits `virtual:cos-screens`, a registry keyed `<pack>/<screen>` of lazy
  `import()`s, so each screen is a chunk of its own and the first load downloads none. A declared
  screen whose block, export or hooks are missing fails the build. The admin's source names no
  pack: the development page's per-pack hooks come from the same generated module. The server's
  build gets an empty registry, and the screen route is client-only (`ssr: false`): no screen's
  code or data is rendered or dehydrated on the server.
- **The route** `/s/<pack>/<screen>` renders a screen only when `screens.mine` lists it; any other
  is the admin's "not found". A record screen is a tab on the record page (`s:<pack>.<screen>`),
  listed only for viewers the host lists it for. Each screen is wrapped in an error boundary that
  logs nothing of the error. Its block gets the pack's hooks over the staff client
  (`apps/app/src/lib/staff-client.ts`): the host's HTTP surface on the app's own origin with the
  staff session, an idempotency key on writes kept across retries, and `baseUrl` the app's own
  origin, never a prop or a URL parameter (the calendar screen builds its address from it). It is
  given nothing from the shell but its record's id. When a screen closes, its queries and
  mutations (and what was sent) are removed from the cache; the blocks' own rules (`gcTime: 0`,
  `forgetAfter`, hiding on `pagehide`) hold inside the admin as they do in an app.
- **A shell for fixed-role accounts.** `getSession` (the host, from the account on every
  navigation) says whether the account holds a pack role; such an account gets a small shell: its
  screens, its account menu (no email-confirmation read), sign out, and a home listing its
  screens or saying its work is in the app. No records, dashboards, settings, assistant, search,
  notifications or create dialogs, and every other path is "not found" from the layout's
  `beforeLoad`, before any loader runs: it makes no call its role is refused (asserted in e2e).
  A page forced into the full shell in the browser would have every other call refused by the
  host anyway: the shell is a convenience, the host is the boundary. Beyond operations (which the
  pipeline holds to the role), such an account reaches only its session, sign-in and sign-out and
  the health check: every other server function and `/api/*` route (the assistant's, system
  status) is refused before its handler runs: a route by `authorize`, a server function by the
  function middleware every server function runs (`start.ts`, `refusesFixedRole`), where its file
  is known (a coach's browser sending the admin's own health and hello-workflow requests is refused
  in e2e, `bookings.spec.ts`). The hello workflow needs an admin. MCP (`/mcp`, `/oauth/*`) does
  not refuse such an account: it holds it to its role, as ADR 0436 says (the tools, the operation
  list and the schema resources show only what the role allows). Pages outside the admin's layout
  (`/buy`, `/order/*`, `/sign-in`) are not caught by its `beforeLoad`; every call they make is an
  operation, which the pipeline holds to the role.
- **A staff session is used only from the host's own pages.** The screens call the HTTP surface
  from the browser with the staff cookie (Better Auth's, Access's, hosted support's), so every
  route that reads a staff cookie applies one rule (`staffCookieAllowed`,
  `apps/app/src/server/staff-origin.ts`) and refuses the session on a request that does not come
  from the host's own pages, even from an origin `API_ALLOWED_ORIGINS` lets in (the company's
  website, for its customers; amends ADR 0415):
  - an `Origin` naming a site must be the host's own; an `Origin` of `null` passes only with
    `Sec-Fetch-Site: same-origin`;
  - with no `Origin`, a `Sec-Fetch-Site` other than `same-origin` is refused, except a top-level
    GET navigation (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`): a link into the admin
    from an email still opens it, and its answer is never readable by the page that opened it;
  - a request with neither header (a native app, a script, an old browser) passes.
  The readers: `staffSession` in the HTTP adapter (`/api/v1/op/*`, `/api/v1/manifest`, the token
  exchange `/api/v1/auth/token`, media and the agreement PDFs; refused `403 staff_cross_origin`),
  `authorize` (TanStack Start's pages, server functions and `/api/*` routes, the assistant's
  socket and the native sign-in page; refused 403, except a public page such as a gatekeeper's
  callback, which is served as to anyone) and the MCP consent page (refused 403). The token
  exchange also takes only `application/json`, which no cross-site form or simple request sends.
  A customer's cookie from an allowed origin, a native app's bearer token, MCP's OAuth tokens, the
  calendar feed's secret address and the refusal of a simple content type without an `Origin` are
  unchanged.
- **The list is the account's, and goes stale at once on a refusal.** The admin keys its cached
  `screens.mine` by the signed-in account, and a call a screen makes that the host refuses as
  forbidden asks for the list again at once, so a grant removed while a screen is open takes it
  away without waiting for the minute's cache. Refusals that keep coming (retries, polling) ask
  again at most once every five seconds.
- **Staff and customer sessions stay on separate hostnames.** Screens live under the admin's
  existing protected paths (no new Cloudflare Access bypass), and the client-app binding
  (`ClientApp`) serves none of this: it never serves staff (ADR 0421).

## The first screens and their gates
Bookings: Front desk (`findPeople`, `bookFor`: any member, or a coach granted `bookings:desk`);
Class list (`roster`, `markAttended`: the coach role or any member; a viewer cannot tick), a tab
on the class and in the navigation. Memberships: a person's memberships and passes (`holdings`,
`givePass`: any member; not a viewer), a tab on Person. Rostering: Roster (`week`), My shifts with
each duty's checklist and My hours (`MyShiftsWithChecklist`: `mine`, `offer`), Offers (`offers`,
`take`), My time off (`myAway`, `away`), My calendar (`feed`, `feedRotate`): the team's tools, so
`rostering.team`, `rostering:roster` granted to another role, and any member, who holds the team's
tools as any unrestricted tool (Roster a viewer too: it only reads); Patterns (`patterns`,
`setPattern`), Who may do what (`qualifications`, `qualify`), Time off (`awayList`, `awayFor`),
Checklists (`checklistRuns`, `checklistCorrect`): the restricted `rostering:manage`, admins and
those granted it; Pay (`periods`, `lock`): the restricted `rostering:pay`, admins and those granted
it, a person only. Programs: Exercise bank (`writes: programs.exercise`), Program builder
(`importText`, `writes: programs.program`), a client's programs, a tab on Person (`logAdd`,
`sessionComplete`): Programs' tools declare no permission, so any member, never a viewer.
Courses: the course builder, a tab on the course (`writes: courses.course`: any member).

Inside a screen, what the gate does not decide is the host's to refuse, and each block has its
state for that: the roster's assign controls show only for a rosterer (`me.rosters`), pay only for
a payer (`me.pays`); a refused write (a viewer granted `rostering:manage` ending someone's time off
with `back`, a publish without `records:publish`) shows the host's words.

## Consequences
- A member holds the team's Rostering tools (ADR 0625 restricts only rostering others and pay), so
  a member sees the team's screens; an account with none of the rights (a coach without the grant,
  a door account) sees no Rostering section.
- The desk and a coach's list of today's classes use the browser's zone for "today"; the host's
  answers (each class's own zone, the coach role's today) decide what is shown.
- `screens.mine` is asked on every record page and with the navigation (cached a minute); getSession
  reads the account's pack role on every navigation (one primary-key read).
- Customising the navigation's order or hiding screens per business is not built (later, if asked).

## Amendments to other ADRs
- **ADR 0005, 0010**: "the host renders all UI from specs; extensions never ship UI" holds for
  runtime extensions. A shipped pack's declared screens are its blocks, built into the admin at
  build time and loaded lazily, never from an extension's files at run time.
- **ADR 0401**: staff use a pack's screens in the product's admin, on the host's address; a
  company's web app still never serves staff.
- **ADR 0415**: `API_ALLOWED_ORIGINS` lets a client app's site call the surface for its customers
  and the public only: a staff cookie session from it is refused, on the surface, the token
  exchange and every other route that reads a staff cookie.
- **ADR 0436**: a pack-role account that signs in to the admin gets its small shell with its
  screens, and is refused nothing it is shown; it reaches `screens.mine` beside its tools and reads.

## Amendment, 2026-11-24 (second security review of PR #303)
- The staff cookie rule was on `/op/*` and `/manifest` only; `/api/v1/auth/token` read the cookie
  itself, so a script on an allowed origin could exchange a staff member's cookie for a staff
  device session with a `text/plain` POST. The rule is now one function every staff-cookie reader
  applies (above), with `Sec-Fetch-Site` beside `Origin`, and the exchange takes JSON only
  (`apps/app/test/staff-cross-origin.test.ts` holds the exploit and the same attempt on each
  reader).
- `COS_DEV_ORG_PACKS` fails closed: it counts only in a Vite development build (`devOrgPacks`,
  `apps/runner/src/extensions/shipped-list.ts`), never on a Worker wrangler bundled.
- The pack-role guard on server functions is proven through TanStack Start's own path, not only by
  its predicate (`bookings.spec.ts`).
- Statement count: `screens.mine`'s handler reads two statements; a call through the pipeline also
  makes the identity and rights reads every staff call makes (not measured). The gate fingerprint
  is computed from every active shipped pack's manifest on each call (bounded by the number of
  packs). Open: caching it per manifest hash; `holdsPackRole`'s read for every staff account on
  `/api/assistant/*` and `system.ts` calls.
- A screen's code is a static asset anyone who knows its address can download; it holds the
  repository's open-source block code and no data, which the spec accepts.

## Amendment, 2026-11-24 (checklists on their own, ADRs 0651 and 0652)
A gate's tool may be one every staff account may call (`anyStaff`) or one held to a grantable core
permission (`corePermission`); both are in the gate fingerprint when set. Daily checklists declares
two screens: Today's checklists (`today`, `tick`: every staff account that may write, pack roles
included, so a fixed-role shell lists it too, and the host answers each with only what they may
do) and Checklist history (`history`: `checklists:write`, admins and those granted it).

**Amended 2026-11-24** (stage 44 step 6, [ADR 0649](0649-signing-at-the-desk.md)): `screens.mine`
also lists core's own staff screens (`CORE_SCREENS`, `pack: "core"`, route `/s/core/<key>`), each
declared in stage 47's shape and listed by the same rule: a person who could call every core
operation its gate names. The admin's build holds their components (`#/components/screens`). The
first is Sign at the desk (gated by `agreement.desk.start` and `agreement.desk.find`), so a coach
granted `agreements:desk` finds it in their small shell.

**Amended 2026-11-26** (stage 38 step 6, [ADR 0708](0708-the-knowledge-packs-blocks-and-screens.md)):
`/s/<pack>/<screen>?record=<id>` opens a record screen on that record, as its tab on the record
page does (the route still takes ids only and renders only a listed screen). The fixed-role
shell's layout sends a record's page (`/x/<object>/<id>`, what the host's notices link to) to the
record screen `screens.mine` lists for the account on that object, before answering "not found":
Knowledge's reader for a procedure, Bookings' Class list for a class.
