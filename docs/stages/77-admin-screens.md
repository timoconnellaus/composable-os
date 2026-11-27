# Stage 77: An organisation's own admin screens

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Packs
and blocks, "Screens in the admin"; Extensions; Trust boundaries), [`CONTEXT.md`](../../CONTEXT.md)
(Block, Screen, Extension, Working copy, Extension workspace, Operation, Risk class), ADRs
[0960](../adr/0960-screens-as-published-versions-and-one-desktop-app.md) (and its note of
2026-11-27), [0660](../adr/0660-pack-screens-in-the-admin.md),
[0424](../adr/0424-blocks-as-built.md), [0043](../adr/0043-extension-executor-and-stable-loader-ids.md),
[0404](../adr/0404-behaviours-are-the-vocabulary.md) and
[0405](../adr/0405-skills-ship-with-the-platform.md);
stages [47](47-pack-screens.md), [75](75-screen-versions.md) and [76](76-desktop-app.md); code:
`packages/sdk/src/contract.ts` (`ScreenSpec`, `recordAction`), `apps/app/screens-plugin.ts`,
`apps/app/src/components/screens/screens.tsx`, `apps/app/src/lib/staff-client.ts`,
`apps/app/src/server/call-operation.ts`, `packs/bookings/blocks/*/block.json`,
`scripts/check-blocks.mjs`, `packages/core/src/extensions/install.ts` (what a runtime extension
may not declare), `apps/runner/src/extensions/` (the working copy, builds and checks).

Status: **spec proposed (2026-11-27)**. Its direction was agreed by the owner the same day, in
stage 75's interview and chat, and is recorded below. Steps 9 and 10 (the admin without the
server, and as a version) were agreed in that interview as stage 75's step 8, so they and
stage 76 do not wait on this stage's interview. Every other step is not built until this
stage's own interview settles the questions at its end. First written as steps 8 to 11 of stage 75, and moved here so
that stage 75 is screen versions alone.

## Goal

An organisation changes the screens its staff use without a deploy and, mostly, without code.
It makes a screen of its own from blocks, adds something to a block we ship, or puts its own
block in place of a default. A person can turn on edit mode, point at something on the screen
and ask the assistant to change it. The admin itself becomes a published version that runs
without the server, which is what the desktop app loads.

## What exists today (from the code)

- **A pack's staff screens are code built into the admin** (stage 47, ADR 0660): a pack declares
  `screens` (`ScreenSpec`: label, block, export, `nav`, the tools in `opens`, `record` for a tab
  on a record page); `apps/app/screens-plugin.ts` reads them at build time into one lazy chunk
  each. The admin renders them at `/s/<pack>/<screen>`, and `?record=<id>` opens one on a record.
- **A runtime extension declaring a screen is refused** (`install.ts`): only a shipped pack's
  blocks are built in.
- **A block already says which operations it calls** (`block.json`: `operations`), and the block
  lint refuses one that works out a price, a capacity or a permission.
- **A pack's block in the admin already calls the host from the browser:** the staff client
  (`staff-client.ts`) over `/api/v1/op/<name>` on the page's origin, with the staff session.
- **The rest of the admin calls operations through one server function** (`call-operation.ts`),
  and is rendered on the server. About 75 route files.
- **Lists, record tabs and panels, and dashboards are declared, not coded,** and saved views
  and dashboards are records (`core_views`).
- **An extension's source has a working copy, a check and a commit** (`extension.write`,
  `extension.check`, `extension.propose`), is approved as a diff and rolled back by reverting.
  Its builds are a transpile and a type check in a sandboxed Worker.
- **Nothing lets a block be filled from outside,** and nothing saves an arrangement of blocks.

## Decided by the owner (2026-11-27)

| # | Decision |
| --- | --- |
| 1 | The admin's staff screens become a published version, and the desktop app is for staff first |
| 2 | An organisation can have its own admin screens |
| 3 | A screen is a saved record of which block fills each **region**, not code. A block can fill a region, and a block has regions of its own: something added to an appointment card, or another card in place of the default. First answered as "a screen is code that we build", and reversed the same day |
| 4 | What fills a region is a standard block or a custom one. A standard block is ours and is named, never copied, so a release updates it. A custom block is the organisation's own code |
| 5 | A custom block written inside the product is built by a build service of ours, in a sandbox. Arranging blocks needs no build |
| 6 | The admin has an edit mode beside the assistant: a person turns it on, selects something on the screen and asks for a change to it or an addition |
| 7 | The word is "region", over "slot", "part" and "area" |
| 8 | A person at the organisation who holds the permission publishes |

## The design in one page

```
 a saved screen (a record in the organisation's database)
 ┌───────────────────────────────────────────────────────────────┐
 │ "Front desk"                                                   │
 │  region: main  ◄── standard block: Bookings timetable          │
 │  region: side  ◄── standard block: class list                  │
 │                      └ region: card.footer ◄── a field (added) │
 │  region: below ◄── custom block: "Gradings due"                │
 └───────────────────────────────────────────────────────────────┘
        standard block   ours, in the release, updated by it
        declared fill    a field, a value, a tool's button: no code
        custom block     the organisation's code, approved as a diff,
                         built by our service, run in a frame of its own

 edit mode: select a block or a region ─► the assistant ─► a draft ─► a person publishes
```

## The model

- **A region** is a named place a screen or a block offers. Its declaration says what it hands
  to whatever fills it (nothing, one record of a named type, or the screen's selection), whether
  it is **repeated** (drawn once per row of a list), whether a fill may **add** to it, **replace**
  its default or both, and what its default is. A block's regions are declared in its
  `block.json` beside its operations. The declaration is the contract a release keeps: a region
  is removed or changed only by a release that says so, and the release check below finds every
  saved screen it touches.
- **A screen** is a record in the organisation's database (`core_screen`): a key, a label, where
  it sits in the navigation, the permission that opens it, and a tree of regions and their
  fills, each fill with its settings. It has a draft and a published copy, and its past
  published copies are kept. Saving a draft, publishing and going back are operations
  (`screen.save`, `screen.publish`, `screen.revert`); nothing is built or deployed.
  - An organisation's **own screen** starts from a layout (one, two or three regions in a row
    or a column) and fills them.
  - A **changed shipped screen** is a screen record that names the pack's screen it is based
    on and holds only the fills that differ. With the record removed, the shipped screen is as
    the pack made it.
- **Three kinds of fill.**
  - A **standard block**: named, with its settings. It is the release's current one.
  - A **declared fill**, for a region that hands a record: one of that record's fields, a
    formula value in the extension formula language, a line of text, or the button of a tool
    that takes that record (`recordAction`). No code. The host reads the field for the person
    looking, so the visibility rules apply, and the button runs the tool through the pipeline.
  - A **custom block**: the organisation's code, below.
- **A custom block** is a file in one of the organisation's own extensions (`blocks/`), so it
  has what an extension's code has: a working copy, a check, a commit, approval as a diff by a
  person, and rollback by reverting. Its `block.json` names the region contract it is written
  for and the operations it calls. It never runs before it is approved.
  - **It runs in a frame of its own,** on an origin that is not the admin's, with no session,
    no storage of the admin's and no way to the page around it. It is handed what its region
    hands, and asks the admin to call an operation for it; the admin makes the call as the
    person signed in, only if the block declared that operation, and through the pipeline. This
    is the rule "no ambient authority for extension code" for code that runs in a browser.
  - The block lint applies to it: no prices, capacity or permission worked out in a block.
  - Its look comes from the admin's theme, handed in as tokens.
- **The build service** takes a custom block's approved source and makes its bundle: in a
  sandbox with no network and no secrets, against the release's region contracts and typed
  client. The bundle is stored as a version in stage 75's store. Step 6 is its spike.
- **The selection.** A screen holds a small set of named values (the class picked, the day
  shown). A block declares which it sets and which it takes, and the screen record wires them.
  They are in the address, as `?record=` is today, so a link reopens the screen as it was.
- **The release check.** An update checks every organisation's saved screens against the new
  release's blocks and regions, on staging first: a data check, with no rebuild. A custom block
  is rebuilt only when the contract it names changed. A screen or block that no longer fits
  stops the update before live, naming it, as an organisation's extension that fails the
  release's checks does (stage 66, decision 7).
- **Edit mode.** With it on, the admin outlines what can be selected: each block and each
  region, which the page knows by name (the screen, the region's path, what fills it).
  Selecting one hands that name to the assistant with the request. The assistant answers with
  the smallest change that does it: a block's setting, a declared fill, a standard block, or a
  custom block it writes for approval. The change is made on the screen's draft and shown at
  once to the person editing. A part of a standard block that is no region cannot be changed:
  the assistant says so, offers what it can do, and the request is recorded, since it tells us
  which region is missing. A request about the data and not the screen (a new field on the
  appointment) is an extension change and goes the way those go today.
- **The admin without the server.** The admin's own screens call operations through the HTTP
  surface, as a pack's block in the admin already does, in place of the server function; they
  sign in with a token session where there is no cookie, and route by hash where there is no
  server. Step 9 starts with a count of what depends on the server.
- **The admin as a version.** Each release builds the admin into a version in stage 75's store,
  with a manifest signed by our key. It is one version for every organisation, published by the
  release. What differs between organisations is their screen records and custom blocks.

## Out of scope

- A customer's screens (a client's website and app): stage 75, and blocks copied with `cos add`
  stay the client's as today.
- A screen for one person only. A screen is for everyone who may open it.
- Screens in the mobile app.
- A layout beyond regions in rows and columns. Anything else is a custom block that fills a
  screen's one region.
- A default fill for a block wherever it appears. A fill belongs to one screen.
- Custom blocks in the desktop app, until stage 76's frame question is settled (see "Decided by
  this spec").

## Acceptance criteria

1. A block declares regions, and with nothing filled it renders exactly as before: no picture
   in `apps/screens` changes.
2. A person with the permission saves a screen made of standard blocks. It appears in the
   navigation of those who may open it. Nothing was built or deployed.
3. A fill added to a region and a default replaced both render. Removing the fill restores the
   default.
4. A changed shipped screen holds only its differences, and removing the record restores the
   pack's screen.
5. A declared field is shown only to a person who may see that field. A declared button runs
   its tool through the pipeline, and an approval applies where the tool's risk asks for one.
6. A draft is seen only by those editing it. Publishing shows it to everyone who may open the
   screen. Going back restores the copy before.
7. An assistant can change a draft and cannot publish: a person does.
8. Picking a class in the timetable changes what the class list shows, and the address
   reopens the screen with the same class.
9. An update with a saved screen that names a region or a block the release removed stops on
   staging and names the screen and the organisation. A screen that still fits is untouched.
10. A custom block's source goes through the working copy, the check and a person's approval of
    its diff. It is not built and does not run before that.
11. A custom block cannot call an operation it did not declare, read the staff session, reach
    the page around it or reach the network (tests in a real browser).
12. The block lint refuses a custom block that works out a price, a capacity or a permission.
13. The build service builds a block with no network and no secrets, and a build that fails
    says why and changes nothing.
14. In edit mode a person selects a region and asks for an addition; a draft change appears
    without a reload. A request that no region can meet is answered plainly and recorded.
15. One organisation's screens, drafts and custom blocks are out of reach of another's
    (two-client tests).
16. Every screen of the admin works from static files against `/api/v1` with a token session,
    and the admin in a browser works as before.
17. A release produces the admin as a signed version that stage 76's app can load and check.

## Dependencies

Stage 47 (pack screens), which is built. Steps 7 and 10 need stage 75's version store (its step
3), and step 10 its publish pointer's checks (its step 4). Stage 76 needs step 10.

## Migrations and numbers

Block CF: migrations 1510–1529, ADRs 0970–0979.

## Suggested build order

1. **The region contract and the first regions:** `regions` in `block.json`, checked by the
   block lint and `cos ext check`; the regions on the blocks question 2 names; defaults drawn
   as before.
2. **The screen record:** `core_screen` and its past copies, `screen.save`, `screen.publish`,
   `screen.revert` and the reads, their permissions, own screens and changed shipped screens
   drawn by the admin.
3. **Declared fills:** a field, a formula value, text, a tool's button.
4. **The selection.**
5. **The release check** of saved screens, in the update.
6. **The build service's spike:** bundling a block in a sandbox, where it runs, its time and
   its limits. Its result is recorded here and decides step 7's shape.
7. **Custom blocks:** in an extension, approved as a diff, built by the service, drawn in a
   frame of their own with declared operations.
8. **Edit mode.**
9. **The admin without the server:** the count first, then the screens over the HTTP surface,
   token sessions and hash routes.
10. **The admin as a version,** built and signed by a release.
11. **Docs, the skills and the ADRs:** `write-extension` gains blocks and regions; ADRs 0660
    and 0424 amended; "region" and "screen record" in `CONTEXT.md`.

Steps 1 to 5 and 8 need nothing from stage 75 and can start before it is finished. Step 9 is
independent of all of them.

## Decided by this spec, open to override

- **A custom block runs in a frame of its own, never in the admin's page.** Code an assistant
  wrote does not get a staff member's whole authority.
- **A custom block is part of an extension,** so approval, history and rollback are the ones
  that exist. ADR 0660's rule (a runtime extension declares no screens) becomes: it declares
  no screens built into the admin, and may carry custom blocks.
- **A fill belongs to one screen.**
- **Few regions at first.** Every region is a promise a release must keep. A block starts with
  the regions a real need asked for, and gains more the same way.
- **The admin is one version for every organisation.**
- **Two permissions:** changing a screen's draft, and publishing. Edit mode needs the first.
- **`screen.publish` is a write a person makes.** An assistant asks.
- **A screen made only of standard blocks and declared fills is shown in the desktop app** from
  the start: it holds none of the organisation's code. A custom block is not shown there until
  Electrobun's internal bridge can be switched off for a view, by an option of its own or a
  fork we keep (ADR 0960).
- **Where a database is placed is its location, never its region,** so the two words do not
  meet.

## Questions for the owner

1. **May a custom block fill a repeated region, such as the card of every appointment in a
   list?** Recommended: not at first. A custom block runs in a frame of its own, and a list of
   fifty appointments would be fifty frames, which is slow. In a repeated region an
   organisation would use declared fills (a field, a value, a button) and standard blocks,
   which cover "add something to the appointment card", and a custom block would fill whole
   areas of a screen. The other answer is to allow it and accept slow long lists.
2. **Which screens do you want to be able to change first?** Regions are added a block at a
   time, where a real need is. Recommended: the Bookings timetable and class list, and a
   person's record page.

## Status

Spec proposed (2026-11-27). No build step is built yet. Each build step changes its own line
here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — not built — needs: the owner's agreement on the spec — The region contract and the first regions

- **Step 2** — not built — needs: step 1, the owner's agreement on the spec — The screen record

- **Step 3** — not built — needs: step 2, the owner's agreement on the spec — Declared fills

- **Step 4** — not built — needs: step 2, the owner's agreement on the spec — The selection

- **Step 5** — not built — needs: step 2, the owner's agreement on the spec — The release check

- **Step 6** — not built — needs: the owner's agreement on the spec — The build service's spike

- **Step 7** — not built — needs: step 2, step 6, stage 75 step 3, the owner's agreement on the spec — Custom blocks

- **Step 8** — not built — needs: step 3, the owner's agreement on the spec — Edit mode

- **Step 9** — not built — The admin without the server

- **Step 10** — not built — needs: step 9, stage 75 step 4 — The admin as a version

- **Step 11** — not built — needs: step 8, step 10, the owner's agreement on the spec — Docs, the skills and the ADRs
