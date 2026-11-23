# Stage 47: Pack screens in the admin

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md) (Block, Pack, Pack role, Grant), ADRs
[0005](../adr/0005-extensions.md) and [0010](../adr/0010-dashboards-sql-views.md) (the admin
renders all UI from specs; extensions never ship UI), [0401](../adr/0401-platform-packs-screens.md),
0403, 0421 (the client-app binding never serves staff), 0436 and 0449 (pack roles, grants,
`user.me`), 0451 and 0629 (role clients, grants), 0453 (a pack's hooks), 0600, 0625 and 0626
(restricted permissions, who rosters); `apps/app/src/routes/blocks.tsx` and
`apps/app/pack-blocks-plugin.ts` (how the development page loads blocks today);
`apps/app/src/components/integrations/configurator/vite-plugin.ts` and `registry.ts` (the
precedent for code built into the admin at build time and loaded lazily);
`packages/core/src/pack-roles.ts`; `apps/app/src/routes/_app.tsx`, `components/app-sidebar.tsx`
and `lib/nav.ts`; `packages/create-composable-os/src/blocks.ts` and `scripts/check-blocks.mjs`.

Status: **spec agreed** (owner interviewed 2026-11-24: decisions 1 to 4). Build may start.

## Goal

Staff use a pack's own screens on the web, in the product's admin, on the host's address. A coach
at the front desk, a rosterer, whoever handles pay, a cleaner with a browser and no app: each
signs in to the admin and sees the screens they may open, and nothing else.

## Why (what was found, 2026-11-24)

Packs ship web blocks for staff: Bookings' front desk and class list, Memberships' staff view of a
person's passes, Courses' builder, Programs' builder, exercise bank and coach's client view, and
all of Rostering's screens. In production the admin mounts none of them. They run only on the
development `/blocks` page (`apps/app/src/routes/blocks.tsx`: "A production build mounts nothing").
A company's own web app never serves staff (ADR 0421). So on the web staff have only the generic
record pages and the assistant, and a fixed-role account (a coach, the door, a cleaner) can sign in
to the admin but is refused every call the shell makes (ADR 0436). Their only working surface is
the app.

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | Staff use packs' screens **in the product's admin**, on the host's address. Packs' screens appear in its navigation. Not in the company's website, which keeps staff and customer sign-ins on separate addresses (ADR 0401, 0421) |
| 2 | **Fixed-role accounts** (a coach, a cleaner, the door) **can use the web admin for just their own screens** |
| 3 | **Build it now**, before more features |
| 4 | Until it is built the site says the staff screens are built for the app and for the web, where the admin does not show them yet (done, PR #297). When this stage merges those lines change back |

## The design in one page

- **A shipped pack declares its staff screens** in its manifest: a label, the block and export that
  render it, where it sits in the navigation, and the tool or tools that decide who may open it.
- **Only shipped packs.** Their blocks are code in this repository, reviewed like the rest of it,
  and built into the admin's bundle at build time. An extension written inside a running product
  still never ships UI: ADRs 0005 and 0010 stand for runtime extensions and are amended for shipped
  packs only. Nothing is loaded at run time from an extension's files, and there is no frame.
- **The host decides who sees a screen.** One staff operation answers, for the caller, the screens
  they may open: a screen is listed when the pack is installed and enabled and the caller could
  call every tool the screen names as its gate (the same check the pipeline makes:
  `staffAuthority`, pack roles, grants, restricted permissions). The navigation renders that
  answer. A block still asks the host for everything it shows, so a screen opened by URL without
  the right gets the host's refusals and shows its "not yours" state.
- **A shell a fixed-role account can use.** An account with a pack role gets a small shell: its
  screens, its own account menu, sign out. No records, dashboards, settings, assistant or search:
  the calls those make are refused for it anyway, so the shell does not make them.
- **The block gets what it gets on the development page**: the pack's hooks over a staff client
  that calls the host's HTTP surface on the same origin with the staff session. The client's base
  is the app's own origin (the calendar screen builds its address from it).

### What was weighed and rejected

- **Staff screens in the company's website.** One hostname would hold staff and customer cookies;
  ADRs 0401 and 0421 keep them apart on purpose.
- **Pack-specific routes written by hand in `apps/app`.** A workaround in app code for each pack;
  the admin's source names no pack today and should not start.
- **Loading a pack's screen code at run time** (from R2, or in a frame). Shipped packs are built
  with the product; run-time loading adds a way for unreviewed code to reach the staff origin.
- **Rendering pack screens from specs** (A2UI, generated views). The screens exist as blocks, are
  tested, and share logic with their native twins; rewriting them as specs is a second
  implementation.

## The model

### The declaration

In a shipped pack's manifest (`packages/sdk/src/manifest.ts`), a new top-level key:

```ts
screens: {
  desk: {
    label: "Front desk",
    block: "bookings-desk",          // a web block of this pack
    export: "Desk",                  // the component it exports
    nav: { group: "Bookings", order: 10 },
    opens: ["bookFor"],              // this pack's tools: all must be callable by the viewer
    record: undefined,               // or { object: "person", as: "personId" }: see below
  },
}
```

- `block` must be a web block of the same pack (never a native one, never another pack's).
  `export` must be exported by one of its files.
- `opens` names one or more of the pack's own tools. The contract check refuses an empty list, a
  tool of another pack, and a tool open to customers or the public as the only gate.
- `nav.group` is free text shown as the section heading; screens with no `nav` are reachable only
  from a record (below) or a link.
- **Record screens.** A screen may declare `record: { object, as }`: it then appears as a tab on
  that object's record page and receives the record's id as the prop `as` (Memberships' staff view
  of one person; Programs' coach view of one client). The object must be one the pack declares or
  a base object (Person, Organisation). The tab is listed only for viewers who pass `opens`.
- A runtime extension declaring `screens` fails `cos ext check` and install, and the key is ignored
  at run time (as `restricted`, `staffing` and `redactResult` are).

### Who may open what: `screens.mine`

A staff operation (staff audience only; reads nothing but the caller's rights and the installed
packs' manifests): returns, for the caller, each screen they may open: pack, key, label, nav, the
route, and `record` if it is a record screen. Rules:

- The pack is installed, enabled and shipped.
- For every tool in `opens`, the caller passes the pipeline's own authority check for that tool as
  a person (`staffAuthority` with their role, pack role, grants and restricted permissions).
- A non-human caller gets an empty list. Screens are for people; an assistant has the tools.
- The answer names nothing the caller may not open: no counts, no greyed-out entries.
- It must be callable by a fixed-role account: the pack-role reach rule (`packRoleReaches`) gains
  this one core read. Nothing else is opened to pack roles.

### The admin: build, route and navigation

- **Build.** A Vite plugin (the pattern of the gatekeeper configurators' plugin) finds every
  shipped pack's declared screens at build time, resolves their blocks (with the base-layer
  sibling imports the development resolver handles today), and emits one lazily loaded chunk per
  screen and a registry keyed `pack/screen`. A declared screen whose block or export does not
  exist fails the build. Tailwind already reads the packs' blocks.
- **Route.** `/_app/s/$pack/$screen` (and the record tab) renders the screen from the registry
  inside the admin's shell, wrapped in an error boundary, with the pack's hooks over the staff
  client (same origin, the staff session, an idempotency key on writes, as `/blocks` does today).
  A screen not in `screens.mine` for the viewer renders the admin's "not found".
- **Navigation.** The sidebar shows a section per `nav.group` with the viewer's screens, from
  `screens.mine`. It replaces nothing: objects, views, dashboards and settings stay as they are.
- **The development page stays** for blocks that are not screens (customer blocks, parts of
  screens) and for tests that mount a block with props.

### A shell for fixed-role accounts

- When the signed-in account has a pack role, the admin renders the small shell: the screens from
  `screens.mine`, the account menu, sign out. It makes no call a pack role cannot make.
- An account with a pack role and no screen sees a plain page saying its work is in the app.
- This closes the note in ADR 0436 ("a door account that signs in to the admin sees a viewer's
  screens and is refused every call"): amend it.
- An ordinary member, viewer or admin keeps the full shell, plus their screens.

### The first screens

Declared in this stage, each already a tested block:

| Pack | Screens |
| --- | --- |
| Bookings | Front desk; a class's list (a record screen on the class) |
| Memberships | A person's memberships and passes (a record screen on Person) |
| Rostering | Roster (the week, with assign for rosterers); Patterns; Who may do what; Time off; Pay; Checklists (when merged); My shifts; Offers; My time off; My calendar |
| Programs | Exercise bank; Program builder; a client's programs (a record screen on Person) |
| Courses | Course builder |

Ticketing has no staff web block (door scanning is in the app). Agreements' staff side is already
core admin screens.

Each pack's `opens` gates are chosen so that exactly the people the host lets use the screen see
it: for example Pay opens with a pay tool (restricted, `rostering:pay`), Roster with the week read
(the team), Front desk with `bookFor` (`bookings:desk` or staff).

### What an AI may do

Nothing new. `screens.mine` answers a non-human caller with nothing. Screens call the pack's tools
as the signed-in person; `humanOnly` and `personApproves` are unchanged.

### Privacy and safety

- A screen receives no data from the shell but its route's parameters. Everything it shows it
  reads from the host as the viewer.
- Screen routes carry ids only. The blocks' own rules on private text (leave notes, pay, health
  marks, the calendar address) are unchanged and are re-checked in the admin: nothing private in
  URLs, storage or logs, and query data cleared when the screen closes.
- Staff and customer sessions stay on separate hostnames. The admin never renders a customer
  block as a screen: the contract refuses a screen whose block calls only customer tools.
- Cloudflare Access: screens live under the admin's existing protected paths. No new bypass.

## Out of scope

- Screens for extensions written inside a product (runtime extensions).
- A separate staff web app, or staff screens on the company's website.
- New screens that do not exist as blocks today (Settings → Rostering, a native rosterer screen).
- Customising the navigation's order or hiding screens per business (later, if asked).
- Signing at the desk tablet (stage 44 step 6): it builds on this stage.

## Acceptance criteria

1. With Bookings installed, an admin sees "Front desk" in the admin's navigation in a production
   build, opens it, books a member into a class, and the booking exists. No `/blocks`.
2. A coach account (`bookings.coach`) signs in to the admin, sees only its screens (today's class
   list), ticks a member, and can reach nothing else: every other admin route renders "not found"
   and makes no refused call.
3. A coach granted `bookings:desk` also sees Front desk; with the grant removed it is gone on the
   next load, and its URL renders "not found".
4. With Rostering installed: a team account sees Roster, My shifts, Offers, My time off and My
   calendar; a granted rosterer also sees Patterns, Who may do what and Time off, and the assign
   controls; only a pay holder sees Pay; a member with none of these sees no Rostering section.
5. A record screen: Memberships' view appears as a tab on a Person for staff who may use it, and
   not for a viewer who may not.
6. `screens.mine` for an assistant or MCP client is empty; for a customer it does not exist.
7. A pack disabled or not installed contributes no screens, in the navigation or by URL.
8. A runtime extension declaring `screens` is refused by `cos ext check` and at install.
9. A screen whose block or export is missing fails the admin's build.
10. The admin's source names no pack: the registry is generated.
11. One screen throwing does not take the shell down (error boundary), and the admin's first load
    does not download any screen's code until it is opened.
12. E2E: the journeys that today drive staff blocks through `/blocks` for the desk, the class
    list, the roster week, offers and pay run through the admin's real navigation, for the right
    kind of account. One test per journey.
13. Cost: `screens.mine` reads a bounded, small number of rows (a statement-count test).
14. The site: the Bookings and Rostering cards (home row 5, gym page G4) and `SITE.md` change back
    to staff using these screens on the web, in the product's admin; the "does not show them yet"
    lines go. The app screens' "not yet tried on phones" lines stay.

## Dependencies

None unbuilt. Checklists (stage 45 step 4b) adds its screen if merged first, or in its own PR.

## Migrations and numbers

Block **BA** in [`parallel-work.md`](../parallel-work.md): migrations 0890 to 0909 (none expected),
ADRs 0660 to 0669. ADR 0660: pack screens in the admin (amends 0005, 0010, 0401 and 0436 with
dated notes).

## Suggested build order

| Step | What | Files |
| --- | --- | --- |
| 1 | The `screens` declaration and its contract checks; `screens.mine`; the pack-role reach for it | `packages/sdk` (manifest, contract), `packages/core` (operation, `pack-roles.ts`) |
| 2 | The build plugin, the registry, the route, the record tab, the error boundary, the staff client with the app's origin | `apps/app` (a Vite plugin, a route, `record` components) |
| 3 | Navigation from `screens.mine`; the fixed-role shell | `apps/app` (`_app.tsx`, sidebar, nav) |
| 4 | The first screens declared in Bookings, Memberships, Rostering, Programs and Courses; e2e through the navigation; the site and `SITE.md` | `packs/*/index.ts`, `apps/app/e2e`, `apps/marketing` |

One build session may take all four; step 4 must not land without 1 to 3.

## Decided by this spec, open to override

- Screens are for shipped packs only.
- A screen's gate is "could call these tools", not a separate permission.
- A fixed-role account's shell shows screens only.
- Record screens are tabs on the record page.
- An assistant gets no screens.
