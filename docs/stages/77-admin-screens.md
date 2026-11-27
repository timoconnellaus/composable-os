# Stage 77: An organisation's own admin screens

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Packs
and blocks, "Screens in the admin"; Extensions; Trust boundaries), [`CONTEXT.md`](../../CONTEXT.md)
(Block, Screen, Extension, Working copy, Extension principal, Operation, Risk class), ADRs
[0960](../adr/0960-screens-as-published-versions-and-one-desktop-app.md) (and its notes of
2026-11-27), [0660](../adr/0660-pack-screens-in-the-admin.md),
[0424](../adr/0424-blocks-as-built.md), [0043](../adr/0043-extension-executor-and-stable-loader-ids.md),
[0404](../adr/0404-behaviours-are-the-vocabulary.md) and
[0405](../adr/0405-skills-ship-with-the-platform.md); stages [47](47-pack-screens.md),
[66](66-one-host-many-clients.md), [75](75-screen-versions.md) and [76](76-desktop-app.md); code:
`packages/sdk/src/contract.ts` (`ScreenSpec`, `recordAction`), `apps/app/screens-plugin.ts`,
`apps/app/src/components/screens/screens.tsx`, `apps/app/src/lib/staff-client.ts`,
`apps/app/src/server/call-operation.ts`, `packs/bookings/blocks/*/block.json`,
`scripts/check-blocks.mjs`, `packages/core/src/extensions/install.ts` (what a runtime extension
may not declare), `apps/runner/src/extensions/` and `apps/runner/src/executor/` (the working
copy, builds, checks and the executor).

Status: **spec agreed (owner, 2026-11-27)**: in stage 75's interview and chat, and in this
stage's own interview the same day, whose answers are decisions 9 to 12. Steps 11 to 13 (the
admin without the server, and as a version) were agreed in stage 75's interview as its step 8.
First written as steps 8 to 11 of stage 75, and moved here so that stage 75 is screen versions
alone. Revised the same day after the coordinator's review of PR #535.

## Goal

An organisation changes the screens its staff use without a deploy and, mostly, without code.
It makes a screen of its own from blocks, adds something to a block we ship, or puts its own
block in place of a default, anywhere, a card in a long list included. A person can turn on
edit mode, point at something on the screen and ask the assistant to change it. The admin
itself becomes a published version that runs without the server, which is what the desktop app
loads.

## What exists today (from the code)

- **A pack's staff screens are code built into the admin** (stage 47, ADR 0660): a pack declares
  `screens` (`ScreenSpec`: label, block, export, `nav`, the tools in `opens`, `record` for a tab
  on a record page); `apps/app/screens-plugin.ts` reads them at build time into one lazy chunk
  each. The admin renders them at `/s/<pack>/<screen>`, and `?record=<id>` opens one on a record.
  `screens.mine` answers which screens a caller may open.
- **A runtime extension declaring a screen is refused** (`install.ts`): only a shipped pack's
  blocks are built in.
- **A block already says which operations it calls** (`block.json`: `operations`), and the block
  lint refuses one that works out a price, a capacity or a permission. A block has no declared
  settings: it takes props.
- **A pack's block in the admin already calls the host from the browser:** the staff client
  (`staff-client.ts`) over `/api/v1/op/<name>` on the page's origin, with the staff session.
- **The rest of the admin calls operations through one server function** (`call-operation.ts`),
  and is rendered on the server. About 75 route files.
- **Lists, record tabs and panels, and dashboards are declared, not coded,** and saved views
  and dashboards are records (`core_views`).
- **Extension code runs in a sandbox on the host** (ADR 0043): the organisation's Worker under
  Worker Loader, with no network, as `extension:<id>` within its declared permissions. Its
  source has a working copy, a check and a commit (`extension.write`, `extension.check`,
  `extension.propose`), is compiled and type-checked when saved, approved as a diff, rolled back
  by reverting, and switched off after three failed runs. A tool is an operation,
  `x.<ext>.<tool>`, with a permission and a risk class.
- **Nothing lets a block be filled from outside,** nothing saves an arrangement of blocks, and
  no extension code produces anything a screen shows except through a tool's answer or a
  computed dashboard widget.
- **Prior art, in another project of the owner's:** plugins that run under Worker Loader and
  hand back a tree which the app draws, checked by rebuilding it from an allowed list. It showed
  that one sandbox per account beats one per plugin, that a reused loader id serves old code,
  and that "the app draws everything" later needed a way to show a plugin's own page.

## Decided by the owner (2026-11-27)

| # | Decision |
| --- | --- |
| 1 | The admin's staff screens become a published version, and the desktop app is for staff first |
| 2 | An organisation can have its own admin screens |
| 3 | A screen is a saved record of which block fills each **region**, not code. A block can fill a region, and a block has regions of its own: something added to an appointment card, or another card in place of the default. First answered as "a screen is code that we build", and reversed the same day |
| 4 | What fills a region is a standard block or a custom one. A standard block is ours and is named, never copied, so a release updates it. A custom block is the organisation's own code |
| 5 | Arranging blocks needs no build |
| 6 | The admin has an edit mode beside the assistant: a person turns it on, selects something on the screen and asks for a change to it or an addition |
| 7 | The word is "region", over "slot", "part" and "area" |
| 8 | A person at the organisation who holds the permission publishes |
| 9 | Custom blocks are allowed everywhere, a card in a long list included ("I want custom cards everywhere") |
| 10 | A custom block is written as JSX and run on the host, in the organisation's extension sandbox under Worker Loader. It hands back a description that the admin draws with our components. No code of the organisation's runs in the browser. This is the owner's proposal, in place of a frame in the browser, a worker in the browser, and the build service decided earlier the same day, which is not built |
| 11 | A custom block uses our components only. A block that brings its own page, in a frame, may come later, for a whole area of a screen and never for a card |
| 12 | The first regions are on the Bookings timetable, the Bookings class list and a person's record page |
| 13 | A custom block's button acts as the person who pressed it, with a confirmation drawn by us for anything riskier than an ordinary edit (interview `acd7a47d-5119-4107-a90b-04cf99940d2e`, 2026-11-27). This differs, knowingly, from the assistant's cards, whose buttons act as the assistant (ADR 0346, amended 2026-11-06) |
| 14 | A new version of a custom block goes live when its extension's change is approved, with no separate publish (the same interview) |
| 15 | While someone is editing, they see their block that is not yet approved, drawn with its buttons switched off (the same interview) |

## The design in one page

```
 a saved screen (a record in the organisation's database)
 ┌───────────────────────────────────────────────────────────────┐
 │ "Front desk"                                                   │
 │  region: main  ◄── standard block: Bookings timetable          │
 │  region: side  ◄── standard block: class list                  │
 │                      └ region: row.footer ◄── a field (added)  │
 │                      └ region: row        ◄── custom block     │
 │  region: below ◄── custom block: "Gradings due"                │
 └───────────────────────────────────────────────────────────────┘

 standard block   our code, in the admin's build, updated by a release
 declared fill    a field, a value, a tool's button: data, no code
 custom block     the organisation's JSX, in its extension, run on the host:

   the admin ── "draw block B for these 50 rows" ──► the host
                                                      │ reads each row as the viewer
                                                      ▼
                                   the organisation's sandbox (Worker Loader, no network)
                                                      │ a tree per row
                                                      ▼
   the admin ◄── trees, checked and rebuilt ───────── the host
   draws them with our components; a button runs a named tool as the person

 edit mode: select a block or a region ─► the assistant ─► the working copy ─► a person publishes
```

## The model

### Regions

- **A region** is a named place a screen or a block offers. It is declared in the block's
  `block.json` (`regions`), beside its operations:
  - `hands`: what it gives whatever fills it. `none`, `record:<object>` (one record of that
    type), or `selection` (the screen's selection, below).
  - `repeated`: true where the block draws the region once per row.
  - `mode`: whether a fill may `add` to it, `replace` its default, or both.
  - `max`: how many fills may be added (4 unless it says otherwise). Added fills are drawn in
    their saved order, after the default.
  - `version`: a number, raised when what the region hands or allows changes.
- **Its name** is `<block>#<path>`, for example `bookings-class-list#row.footer`. A path is
  lower-case words joined by dots. A screen's own regions are `screen#<name>`.
- **A block draws a region** with the `Region` component of `@composable-os/client`
  (`<Region name="row.footer" hand={row}>…default…</Region>`). With nothing filled it draws its
  children, which are the default. Outside the admin (a block copied into a client's web app
  with `cos add`) it always draws its children.
- **The declaration is the contract a release keeps.** A region is changed or removed only by a
  release that says so, and such a release carries a rewrite of saved screens for it.
- **Block settings.** A standard block that can be placed declares `settings`, a JSON schema, in
  its `block.json`, and `placeable: true`. `screen.save` and the release check validate a fill's
  settings against it. The admin's build holds a chunk for every placeable web block, not only
  for blocks a pack declares as a screen.

### The screen record

- **A screen** is a record in the organisation's database (`core_screen`): a key, a label, where
  it sits in the navigation, what opens it, its selection's names, and its fills.
  ```json
  { "layout": "two-columns",
    "selection": { "class": "bookings.class", "day": "date" },
    "fills": [
      { "region": "screen#main", "fill": { "block": "bookings-timetable", "settings": {},
          "sets": { "class": "class" } } },
      { "region": "bookings-class-list#row.footer", "at": "screen#side",
        "fill": { "field": "x_gradings.level" } } ] }
  ```
  At most 64 fills, four levels of block inside block, and 64 KB.
- **It has a working copy and published versions,** the words `publishable` uses (ADR 0446).
  `screen.save` writes the working copy and takes the version it was read at, so two people
  editing do not overwrite each other. `screen.publish` makes the working copy the published
  version; `screen.revert` publishes an earlier one. The last ten published versions are kept,
  and any published in the last 90 days.
- **An organisation's own screen** starts from a layout (one region, or two or three in a row or
  a column) and fills them. It names the tools that open it (`opens`, as a pack's screen does),
  or says any staff member may. A person can gate a screen only by tools they may call.
- **A changed shipped screen** is a screen record that names the pack's screen it is based on
  and holds only the fills that differ. It keeps the pack's gate, which it cannot change. With
  the record removed, the screen is as the pack made it.
- **Listing.** `screens.mine` adds the organisation's published screens the caller may open, and
  the fills of a changed shipped screen. A record that names a block the admin's build does not
  hold is not listed (ADR 0660's rule, kept). A fixed-role account sees the changes to the pack
  screens it already opens, and none of an organisation's own screens.

### Three kinds of fill

- **A standard block:** named, with its settings. It is the release's current one.
- **A declared fill,** for a region that hands a record: one of that record's fields, a formula
  value in the extension formula language, a line of text, or the button of a tool that takes
  that record (`recordAction`). No code.
  - The host reads a field, and works out a formula, **as the person looking**: a field they may
    not see reads as empty, in a formula too.
  - Text is drawn as text, never as HTML.
  - A button runs its tool through the pipeline.
- **A custom block,** below.

### Custom blocks

- **Where it lives.** A custom block is a `.tsx` file in one of the organisation's own
  extensions (`blocks/<name>.tsx`), declared in the manifest:
  `blocks: { <name>: { region, reads, tools } }`.
  - `region` names the region contract it is written for, with its version.
  - `reads` lists the fields it is handed: fields of the region's record, and of records one
    relation away.
  - `tools` lists the tools of its own extension that its buttons may run.
  It works the same in a runtime extension (written in the product) and in an extension in the
  organisation's repository (arriving by `cos deploy`).
- **What it is.** A function from what it is handed to a tree, written as JSX with the SDK's
  own JSX runtime (`@composable-os/sdk/blocks`). It is not React: no state, no effects, nothing
  that runs on a click.
- **It is compiled when saved,** by the build extensions already have (the transpile, the import
  check and the type check), which gains JSX. There is no build service.
- **It runs on the host,** in the organisation's sandbox under Worker Loader, on a loader id
  of its own, apart from the Worker its extension's tools run in: no network, an empty `env`,
  and no run host.
- **A render is a pure function.** The block is given no host module: it cannot call an
  operation, read a record or use a model while it draws. Everything it shows comes from what
  it is handed, the time included (`now` is handed in).
- **Nothing is carried from one person's render to another's.** "Pure" above limits host
  modules and the network, not what code can keep in a variable of a warm Worker, and a loader
  id per organisation and commit is shared by everyone who looks. So a render Worker is never
  reused across people: its id holds the person (or a fingerprint of what they may see), or each
  call gets a fresh one. Step 6 measures both and step 8 enforces the one chosen. The same
  holds for a working copy drawn for two editors.
- **What it is handed.** The host reads the region's record with the fields in `reads`, **as the
  person looking**, never with the extension's own wider reach, and hands the block that and
  the selection values it declared. A field the person may not see is absent.
- **One call for a page.** The admin asks for a block's trees for all the rows it shows, up to
  100, in one request, and the host makes one call into the sandbox.
- **What it returns** is a `BlockTree`: a closed list of nodes, with a schema version. Version 1:

  | Node | Holds |
  | --- | --- |
  | `text` | Text, and a style: body, heading, label or muted |
  | `row`, `column` | Children, a gap and an alignment |
  | `badge` | Text and a tone: neutral, good, warning or bad |
  | `value` | A label and a value, drawn as a field is |
  | `icon` | A name from the admin's icon set |
  | `image` | The id of a file of the organisation's, served by the host's media rules |
  | `link` | A label, and a record or a screen of the admin by its id |
  | `button` | A label, a style, one of the block's declared tools and its input |
  | `divider` | Nothing |

  There is no raw HTML, no style or class, and no address the browser fetches: a link names a
  record or a screen, and an image names a file. An id in a link, an image or a button's
  input is one the block was handed, or is checked against what the person may read when the
  tree is rebuilt. Text is never turned into a link. The host serves the current schema version and
  the one before. This repository already has a catalogue of components the client trusts, for
  the assistant's cards (ADR 0346, `agent-a2ui`). Step 7 makes `BlockTree` a profile of that
  catalogue, adding to it what is missing, or writes the ADR that says why there are two.
- **The host does not pass a tree through.** It rebuilds each tree from that list and refuses a
  tree whole if anything else is in it. A tree is at most 64 nodes, eight deep and 16 KB, and a
  call's answer at most 256 KB. The admin checks it again before drawing.
- **A button** names a tool and carries its input, fixed when the tree was made, which is how a
  button in a row knows its record. Pressing it makes the admin call that tool's operation **as
  the person signed in**, through the pipeline: its permission, its risk class and any approval
  apply, and its input is checked against the tool's schema. The host refuses a tool the block
  did not declare. The call is recorded as the person's, with the block and its commit beside
  it. Afterwards the region is drawn again.
  - **This differs from the assistant's cards,** whose buttons run as the assistant because a
    button's label is not what it runs (ADR 0346, amended 2026-11-06). A block's label is no
    more trustworthy. So: for any tool riskier than an ordinary write, the admin itself draws
    a confirmation that names the tool and the record, which the block cannot change. Each
    press is bound to a handle the host issued when it made the tree (the person, the block,
    its commit, the tool, a hash of the input, an expiry), so a press can only be the button
    that was drawn. Step 9 records this against ADR 0346.
  - **Decided by the owner** (decision 13). Step 9 amends ADR 0346 with a dated note: a custom
    block's button is the person's, behind the admin's own confirmation and the handle, where
    a card's button is the assistant's.
- **What a block can therefore do** is bounded twice: by what the person looking may see, and
  by its extension's tools, each of which a person approved with the extension and may only do
  what the extension's permissions allow. A block that newly names a tool, or an extension that
  asks for more, is a wider change and waits for a human admin, as today.
- **Limits and failure.** A call has two seconds and a CPU limit set by step 6. A block that
  fails, is refused or is late is not drawn: the region shows its default, with a line saying
  so for people who may edit the screen. It never breaks the page.
  - Failures are counted per block. Three in a row switch off that block, not its extension.
  - A tree refused for its size is not counted when the size came from the person's data (a
    long note): the row shows its default.
  - What a render logs or throws can hold the person's fields. None of it is kept, and an
    editor is shown the kind of failure (threw, late, too large, not in the schema), never its
    message.
- **Caching.** A tree depends only on the block's commit, the schema version and what the block
  was handed, and what it was handed is already the person's own view. Trees are kept for the
  length of a request at first; step 6 says whether a longer cache, keyed by those three and the
  client, is worth having.
- **Before approval.** A block in an extension's working copy is drawn only in edit mode, only
  for the person editing, with its buttons shown and switched off. Since a render is pure and
  has no network, this shows the person what they are approving.
- **After approval.** A new commit of a block is what every screen that uses it draws, from the
  extension's approval on. No `screen.publish` is needed, and the screen's last publisher is
  told.
- **The block lint applies:** no price, capacity or permission worked out in a block.

### The selection

- A screen holds named values, declared in its record with their types: a record of a named
  type (by id), or a date.
- A standard block declares in `block.json` which values it `sets` and which it `takes`. A fill
  maps them to the screen's names. A custom block declares `takes` only.
- When two blocks set the same value, the later setting stands and both show it.
- The values are in the address as `?sel.<name>=<value>`, beside `?record=`, so a link reopens
  the screen as it was.

### The release check

- **What it compares,** for every fill of every organisation's published screens and working
  copies: the region exists; it hands the same type at the same version; add or replace is
  still allowed; `repeated` is unchanged; a named standard block exists and the fill's settings
  fit its schema; a button's tool exists and takes that record; a field or a formula still
  resolves; a custom block's region version is the one it was written for.
- **When.** Against every organisation's live records, on staging's copy first, and again in
  the update itself while organisations are paused (stage 66), so a screen saved in between is
  not missed.
- **A fill that no longer fits is switched off, and the update goes on.** Its region draws its
  default. The organisation's admins are told which screen and which fill, and the record keeps
  the fill, marked, so it can be mended. A screen is data that staff change often; it must not
  stop every organisation's update, as an extension's failed checks do (stage 66, decision 7).
- **A release that changes or removes a region carries a rewrite** of saved screens, run in the
  update, so a region can be renamed while it is in use.

### Edit mode

- With it on, the admin outlines what can be selected: each block and each region, which the
  page knows by name (the screen, the region, what fills it).
- Selecting one hands that name to the assistant with the request. The assistant answers with
  the smallest change that does it: a block's setting, a declared fill, a standard block, or a
  custom block it writes to an extension's working copy.
- The change is made on the screen's working copy and shown at once to the person editing. A
  custom block is drawn there before approval, as above. Publishing the screen is a person's
  step, and a custom block is approved as its extension's diff.
- A part of a standard block that is no region cannot be changed. The assistant says so and
  offers what it can do. The request is kept in the organisation's own database
  (`core_screen_request`: the screen, the block, what was asked), where its admins and our
  support, when given access, can read it. It is not sent to us.
- A request about the data and not the screen (a new field on the appointment) is an extension
  change and goes the way those go today.
- Edit mode ships first with settings, declared fills and standard blocks (step 10), and gains
  custom blocks when steps 7 to 9 are built.

### The admin without the server, and as a version

- **Without the server.** The admin's own screens call operations through the HTTP surface, as
  a pack's block in the admin already does, in place of the server function. They sign in with
  a token session where there is no cookie and route by hash where there is no server. Step 11
  starts with a count of what depends on the server (route loaders, the assistant's socket, MCP
  consent, the server-only routes) and splits step 12 by area.
- **As a version.** Each release builds the admin into static files with a manifest, in stage
  75's manifest format, signed by our key. It belongs to the release and the deployment, not to
  an organisation: it is served by the host and is not in an organisation's version store. What
  differs between organisations is their screen records and custom blocks, which arrive as data
  and as trees.

## Amendment proposed to ADR 0960

ADR 0960 keeps a client's own code out of the desktop app until Electrobun's internal bridge can
be switched off for a view. That rule stands, for code. Under decision 10 a custom block's code
never reaches the app: the app receives a tree, checks it and draws it with our components. So
**a custom block is shown in the desktop app from the start.** The ADR gains a dated note saying
so in this PR, for review with it. A block that brings its own page (decision 11, later) would
be code in the app, and the ADR's rule would apply to it unchanged.

## Out of scope

- A block that brings its own page in a frame (decision 11). The prior art above needed one in
  the end; it is left for a stage of its own, for a whole area of a screen only.
- Anything of the organisation's that runs on a click, a drag or a keystroke. A custom block
  draws, and a button runs a tool.
- A customer's screens (a client's website and app): stage 75. Blocks copied with `cos add`
  stay the client's, as today.
- A screen for one person only. A screen is for everyone who may open it.
- Screens in the mobile app. The tree is drawn by the admin's web components only, though
  nothing in it is web-only.
- A layout beyond regions in rows and columns.
- A default fill for a block wherever it appears. A fill belongs to one screen.
- An organisation's own screens for fixed-role accounts.

## Acceptance criteria

1. A block declares regions and settings, and with nothing filled it renders exactly as before:
   no picture in `apps/screens` changes. A block copied with `cos add` draws its defaults.
2. A person with the permission saves a screen made of standard blocks. It appears in the
   navigation of those who may open it. Nothing was built or deployed.
3. A fill added to a region and a default replaced both render. Removing the fill restores the
   default. A fill whose settings do not fit the block's schema is refused.
4. A changed shipped screen holds only its differences and keeps the pack's gate. Removing the
   record restores the pack's screen.
5. A declared field is shown only to a person who may see that field, and a formula over a
   hidden field shows nothing of it to that person (tests with two people). A declared button
   runs its tool through the pipeline, and an approval applies where the tool's risk asks.
6. The working copy is seen only in edit mode by those who may edit. Publishing shows it to
   everyone who may open the screen. Reverting restores the version before. A save from a stale
   copy is refused.
7. An assistant can change a working copy and cannot publish: a person does, MCP included.
8. Picking a class in the timetable changes what the class list shows, and the address reopens
   the screen with the same class.
9. An update with a saved screen that names a region the release removed goes on: the fill is
   switched off, the region shows its default, the admins are told, and no other organisation is
   held up. A fill saved while the update was being prepared is caught by the second check. A
   release's rewrite moves fills from a renamed region.
10. A custom block's source goes through the working copy, the check and a person's approval
    of its extension's diff. Before that it is drawn only for the person editing, with its
    buttons switched off.
11. A custom block's code never reaches the browser or the desktop app: the admin receives
    trees only (asserted on the wire).
12. During a render a block can call no operation, read no record and reach no network. It is
    handed only the fields it declared, as the person looking may see them: two people with
    different visibility get different trees from one block. A block written to keep what it was
    handed and show it later shows person B nothing of person A's, in a published screen and
    in a working copy drawn for two editors.
13. A tree with a node, a key or a value outside the schema is refused whole, on the host and
    again in the admin. Text holding markup is shown as text.
14. A block in a list of 100 rows is drawn with one call to the sandbox, inside the limits step
    6 set. A block that throws, runs out of time or returns too much leaves its region's
    default and a line for editors, and the rest of the page is unaffected.
15. A button in a row runs its tool on that row's record as the person signed in. A tool the
    block did not declare is refused. The record of the call names the person, the block and
    its commit.
16. The block lint refuses a custom block that works out a price, a capacity or a permission.
17. In edit mode a person selects a region and asks for an addition; a working-copy change
    appears without a reload. A request that no region can meet is answered plainly and kept in
    the organisation's database, and nothing is sent to us.
18. One organisation's screens, working copies, custom blocks and trees are out of reach of
    another's (two-client tests, the sandbox's id included).
19. Every screen of the admin works from static files against `/api/v1` with a token session,
    and the admin in a browser works as before.
20. A release produces the admin as a signed version that stage 76's app can load and check,
    and that app draws a custom block's tree.

## Dependencies

Stage 47 (pack screens), which is built. Step 13 uses stage 75's manifest format (its step 3).
Stage 76 needs step 13. Stage 14's re-spec, in flight, owns roles: the two permissions below
are given to an organisation's admins by default and are fitted to its model when it lands.

## Migrations and numbers

Block CF: migrations 1510–1529, ADRs 0970–0979. Expected: `core_screen` and its versions,
`core_screen_request`.

## Suggested build order

1. **The region contract, block settings and the first regions:** `regions`, `settings` and
   `placeable` in `block.json`, checked by the block lint and `cos ext check`; the `Region`
   component; a chunk for every placeable block; regions on the Bookings timetable, the
   Bookings class list and a person's record page; defaults drawn as before.
2. **The screen record:** `core_screen` and its versions, `screen.save`, `screen.publish`,
   `screen.revert` and the reads, their two permissions, `screens.mine`, own screens and
   changed shipped screens drawn by the admin.
3. **Declared fills:** a field, a formula value, text, a tool's button.
4. **The selection.**
5. **The release check** for standard blocks and declared fills: both runs, switching a fill
   off, the rewrite a release carries. Step 8 adds custom blocks' region versions to it.
6. **The render spike:** one block drawn for 1, 50 and 100 rows in the sandbox, cold and warm,
   on Cloudflare; its time, its cost, the limits to set, and whether a cache is worth having.
   It also settles how a render Worker is kept from one person to the next (the person in its
   id, or a fresh one per call) and what that costs, and a budget for a whole page: several
   custom blocks over hundreds of rows, how many calls run at once, the host's reads as the
   person, and what a region shows while its trees load. Its result is recorded here.
7. **Custom blocks, declared and checked:** `blocks` in the manifest, JSX in the build, the
   `BlockTree` schema and the rebuilding check, the lint, what the proposal shows a person.
8. **Custom blocks, run:** the render call into the sandbox, one call for a page, what a block
   is handed and as whom, the limits, failure, the three-failures rule, the cache if step 6
   asks for one.
9. **Custom blocks, drawn:** the admin's components for each node, the second check, buttons
   and the record of their calls, the working copy drawn for its editor.
10. **Edit mode,** with settings, declared fills and standard blocks; custom blocks once step 9
    is built.
11. **The admin without the server, the count and the seam:** what depends on the server; the
    server function replaced by the HTTP surface; token sessions.
12. **The admin without the server, the routes,** by the areas step 11 names, a PR each.
13. **The admin as a version,** built and signed by a release.
14. **Docs, the skills and the records:** `write-extension` gains blocks and regions; ADRs
    0660, 0424, 0005 and 0010 amended (an extension may carry custom blocks, which are not
    screens built into the admin and are never code in the browser); `docs/architecture.md`
    (Extensions, "Screens in the admin", Trust boundaries); `CONTEXT.md`: Screen and Block
    amended, and region, fill, declared fill, standard block, custom block, block tree and
    selection added.

Steps 1 to 10 need nothing from stage 75. Steps 11 and 12 are independent of all of them.

## Decided by this spec, open to override

- **A render is pure:** a block calls nothing while it draws. If a block needs more than its
  region's record and what is one relation away, the answer is a wider `reads`, not a call.
- **A custom block is part of an extension,** so approval, history and rollback are the ones
  that exist, and it works from the product and from a repository alike.
- **A block's buttons run only its own extension's tools.** There is no list of refused
  operations to keep, because a block names no operation directly.
- **A fill that no longer fits is switched off; it does not stop the update.**
- **A fill belongs to one screen.**
- **Few regions at first.** Every region is a promise a release must keep. A block starts with
  the regions a real need asked for, and gains more the same way.
- **Few nodes at first,** for the same reason. A node is added when a real block needs it.
- **Two permissions:** changing a screen's working copy, and publishing. Edit mode needs the
  first. An organisation's admins hold both by default.
- **`screen.publish` is a write a person makes.** An assistant asks.
- **The admin is one version for every organisation,** kept with the release.
- **Requests no region could meet stay in the organisation's database.**
- **Where a database is placed is its location, never its region,** so the two words do not
  meet.

## Questions for the owner

None open. Decisions 9 to 12 answer this stage's interview, and decisions 13 to 15 the coordinator's
(2026-11-27).

## Status

Spec agreed (owner, 2026-11-27). No build step is built yet. Each build step changes its own
line here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — not built — The region contract, block settings and the first regions

- **Step 2** — not built — needs: step 1 — The screen record

- **Step 3** — not built — needs: step 2 — Declared fills

- **Step 4** — not built — needs: step 2 — The selection

- **Step 5** — not built — needs: step 3 — The release check

- **Step 6** — not built — The render spike

- **Step 7** — not built — needs: step 1, step 6 — Custom blocks, declared and checked

- **Step 8** — not built — needs: step 2, step 5, step 7 — Custom blocks, run

- **Step 9** — not built — needs: step 8 — Custom blocks, drawn

- **Step 10** — not built — needs: step 3 — Edit mode

- **Step 11** — not built — The admin without the server, the count and the seam

- **Step 12** — not built — needs: step 11 — The admin without the server, the routes

- **Step 13** — not built — needs: step 12, stage 75 step 3 — The admin as a version

- **Step 14** — not built — needs: step 4, step 9, step 10, step 13 — Docs, the skills and the records
