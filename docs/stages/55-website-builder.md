# Stage 55: Website builder

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md) (Block, Client app, Client repo, Content, Publish, Version,
Working copy, Rich text, Document field, Change set), ADRs
[0009](../adr/0009-model-roles.md) and [0203](../adr/0203-gateway-first-model-registry.md) (model
roles, every call through AI Gateway), [0401](../adr/0401-platform-packs-screens.md) ("Pages are
code. There is no page builder."), [0402](../adr/0402-staff-and-customers.md),
[0421](../adr/0421-the-client-app-binding-and-customer-sign-in.md),
[0422](../adr/0422-client-repos-and-one-command-as-built.md),
[0424](../adr/0424-blocks-as-built.md), [0440](../adr/0440-rich-text-is-data.md) to
[0446](../adr/0446-publishable-without-its-public-half.md) (rich text, `publishable`, public reads,
preview links, media, the document field), [0480](../adr/0480-an-ai-asks-to-publish-a-person-approves.md)
(an AI asks to publish, a person approves), [0610](../adr/0610-three-homes-for-a-client-hosted-by-default.md)
(three homes; the standard tier has no repository), [0622](../adr/0622-warnings-in-a-writes-answer.md)
(warnings in a write's answer); stages [24](24-client-apps.md), [28](28-content.md),
[46](46-hosted-clients.md) and [47](47-pack-screens.md); `templates/client/apps/web`,
`skills/start-client-app`, `skills/add-block`, `packs/content`. Issues
[#122](https://github.com/timoconnellaus/composable-os/issues/122) (a theme editor or page builder,
left out of stage 24 on purpose), [#121](https://github.com/timoconnellaus/composable-os/issues/121)
(preview deployments per branch), [#119](https://github.com/timoconnellaus/composable-os/issues/119)
(edge cache), [#181](https://github.com/timoconnellaus/composable-os/issues/181) (media
follow-ups). In flight: PR #303 (stage 47's build, ADR 0660), PR #275 (ADR 0611, one host with a
database per client, a proposal), PR #311 (stage 48, My account).

Status: **spec agreed** (owner interviewed 2026-11-24: decisions 1 to 3; points 4 to 11 decided as
best practice the same day, open to override). **Not to be built yet** (decision 3): it is built
after the first gym is live on bookings and memberships, together with the first standard product
(the first product we host for businesses with no code of their own, on stage 46's fleet).

**This stage reverses a standing decision.** ADR 0401 says "Pages are code. There is no page
builder.", stage 24 and stage 28 list a page builder as out of scope, and `CONTEXT.md` says
"_Avoid_: page (pages are code)". The owner decided to change that (decision 1). The ADRs this
stage amends are listed under [Migrations and numbers](#migrations-and-numbers).

## Status

Not to be built yet (decision 3): every step waits for the first gym to be live on bookings and
memberships.

- **Step 1** — not built — needs: the first gym live (decision 3) — `sections` in the manifest and contract, layout choices,
  the composed document schema and its checks

- **Step 2** — not built — needs: the first gym live (decision 3) — Publishing together; an AI's request for it; the inbox's
  preview and section summaries

- **Step 3** — not built — needs: the first gym live (decision 3) — The site-wide preview link (migration 1210) and the `path`
  variant

- **Step 4** — not built — needs: step 1 — The Site pack's spine: page, settings, generic sections,
  `site.resolve`, `site.sitemap`, views, starter sites

- **Step 5** — not built — needs: step 4 — Pack sections: Bookings, Memberships, Content,
  Ticketing, Courses

- **Step 6** — not built — needs: step 4 — The renderer blocks; the template's catch-all route;
  `start-client-app` and `add-block`

- **Step 7** — not built — needs: step 6, stage 47 — The Website editor screen; e2e

- **Step 8** — not built — needs: step 6, stage 46 — The hosted site app for standard clients, with
  sign-in and My account

- **Step 9** — not built — needs: step 1, step 2, step 3, step 4, step 5, step 6, step 7, step 8 — The site
  and `SITE.md`; ADR amendments; `CONTEXT.md`, `docs/architecture.md`

## Goal

A business edits its own website from the admin its staff already use: its pages, its menus, the
sections each page is built from (a hero, text, pictures, the class timetable, membership plans and
passes, the latest posts, upcoming events, courses), a few layout choices per section, its brand
(logo, colours, font), basic search-engine fields and redirects from old addresses. It sees a change
on a preview of the real site before anything goes live and publishes it, page by page or all
together. An AI can build or change the site on request (the admin's assistant or an MCP client): it
drafts, the business looks at the preview, and a person approves before anything goes live. The
rules (what a plan costs, whether a class has places, what the public may see) stay in the host; a
section shows only what the host answers.

A business with no code of its own gets a site we host for it. A business with its own repository
uses the same pages in its own web app, with hand-written pages beside them.

## Who it is for

- **Gyms and studios first.** Home, classes and the timetable, prices (plans, passes, the intro
  offer), coaches, kids' classes, events and camps, online courses, the blog, location and opening
  hours, contact. Every one of these sections already exists as a pack's web block (Bookings,
  Memberships, Ticketing, Courses, Content); today they reach a site only by code.
- **Trades and services next** (a plumber, an electrician, a cleaner). What they need that a gym
  does not, as assumed by the draft and to be checked with the first such business during setup
  (point 11): a page per service and per area served (ordinary pages: search engines matter more
  than a timetable), a gallery of past jobs, a click-to-call phone number, an after-hours notice,
  licence or insurance numbers as plain footer text. A quote request form and reviews wait for
  Forms (stage 29) and stage 35's quotes. Nothing in this stage is gym-only: pack sections are
  offered only when their pack is installed, and the generic sections serve both.
- **What differs per kind:** the sections a pack declares, and a starter site per kind of business
  (seed data the AI or staff start from, not code).

## What exists today (from the code, checked 2026-11-24)

- **A client's website is code in its own repository.** `templates/client/apps/web` is a TanStack
  Start app on its own Worker with one binding, `HOST`, to the host's `ClientApp` entrypoint
  (ADR 0421). Its pages are route files (`src/routes/index.tsx` is a placeholder, beside
  `sign-in.tsx`, `account.tsx`, `agreements.tsx` and `before-you-go-on.tsx`). `src/server.ts`
  forwards sign-in, the browser's operation calls (an allow list), pictures and agreement PDFs to
  the host.
- **Blocks are copied, then owned by the client** (`cos add`, `blocks.lock.json`, `cos diff`,
  ADR 0424). Brand is CSS tokens in `apps/web/src/styles.css`; the `add-block` skill restyles by
  editing them.
- **Web blocks a site would use exist:** `bookings-timetable`, `bookings-drop-in`,
  `memberships-plans`, `memberships-passes`, `ticketing-events`, `courses-catalogue`,
  `courses-subscribe`, `content-post-list`, `content-post`, `content-rich-text` (`packs/*/blocks/`)
  and `web-sign-in` (`blocks/`).
- **Content** (stage 28): `content.post` is `publishable` (working copy, versions, schedule,
  unpublish, restore), has a `slug` with redirects kept on change (`core_slug_redirect`), a
  `richText` body, an `image` cover and search fields. The public reads it through `content.get` and
  `content.list` (published versions only, one not-found, ADR 0442). A preview link names one record
  (`content.previewLink`; `core_preview_link` holds one `object_type` and one `record_id`, ADR 0443).
  A slug is one segment (`SLUG_RE` in `packages/sdk/src/slug.ts`).
- **The document field** (ADR 0445, `packages/sdk/src/document.ts`): JSON checked against a schema
  its own object declares, up to 512 KB, on every write by every actor.
- **AI and publishing** (ADR 0480, `packages/core/src/records/publish.ts`): an AI actor may ask to
  publish one record; it is always reviewed, never approved by the adjudicator, approved only by a
  person holding `records:publish`, and refused if the working copy changed meanwhile. The request's
  diff summary is cut at 280 characters (`SUMMARY_CHARS`). There is no publishing of several records
  as one.
- **AI models**: code asks for a model role (`packages/core/src/ai/roles.ts`), never a model id.
  Each role maps to a provider and model; the shipped defaults put every text role on one provider
  (Workers AI), and every call goes through the deployment's AI Gateway (ADRs 0180, 0203).
- **Pack screens in the admin** (stage 47, spec agreed, being built in PR #303): a shipped pack
  declares staff screens built from its blocks.
- **The standard tier** (ADR 0610, stage 46): "settings only (name, brand, domain), no repository,
  one web app shared by every client of that product". Nothing says what that web app shows. This
  stage is its content model. The standard product itself is not specced (ADR 0610: "It has its own
  interview and stage"; stage 46 leaves it out of scope).
- **Not there:** pages, menus, a site-wide brand as data, redirects for addresses that were never a
  record's slug, a preview of several working copies together, publishing several records as one, a
  sitemap, public forms (stage 29, not specced), reviews.

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | **Businesses edit their own pages, menus and colours from the admin.** This reverses "pages are code" (ADR 0401) |
| 2 | **We host a site for businesses with no code of their own** (the standard tier), **and those with their own code can still have hand-written pages beside the edited ones** (the bespoke tier). One way of storing pages serves both |
| 3 | **Built after the first gym is live on bookings and memberships, together with the first product we host for businesses with no code of their own** (the standard product, on stage 46's fleet). The first gym has a site of its own and does not need this to go live |

### Decided as best practice without asking (2026-11-24), open to override

| # | Decision |
| --- | --- |
| 4 | **Every AI change waits for a person.** The AI drafts; a person at the business looks at the preview and approves before anyone sees it. No setting lets the AI publish on its own (as posts and programs, ADR 0480) |
| 5 | **Changes made together go live together**: several pages, the menus and the colours in one approval, all at once or not at all |
| 6 | **How much of the look a business changes**: its logo, a few colours, one font from a short list, which sections go on each page in what order, **plus a few layout choices per section** (for example the picture on the left or the right). No free design |
| 7 | **No pasted code** from other services (a chat widget, a tracking tag, an outside booking widget). What clients really need is added as built-in sections |
| 8 | **The first sections**: big heading with picture and button; text; picture and text; photo gallery; questions and answers; contact details, address and opening hours; coaches or staff profiles; class timetable; membership plans and passes; latest blog posts; upcoming events; online courses. An enquiry or quote form and reviews follow Forms (stage 29) |
| 9 | **Moving an existing site**: we rebuild the main pages with the AI and send every old address to its new page, so search rankings and old links keep working. No automatic copy of old pages |
| 10 | **How the first gym changes its site today** was not asked: the draft's assumptions stand, checked with the business during setup |
| 11 | **What a trade's site needs** was not asked: the draft's assumptions (above) stand, checked with the first such business during setup |
| 12 | **AI calls go through AI Gateway**, with one small map of which provider serves each function, so a provider can be swapped later. One provider for all AI for now, expanded only as needed; no provider choice per feature (the owner's decision of 2026-11-24, given to the coordinator). That map is the model-role registry, which exists: this stage adds no role and no provider ([What an AI may do](#what-an-ai-may-do)) |

## The design in one page

One data model and one renderer, used on every tier:

- **The Site pack** holds pages, the site's settings (brand, menus, contact, redirects) and the
  generic section types as publishable records the public reads.
- **A page is an ordered list of sections.** Each section type is code (a block a shipped pack
  ships) with a small settings document (data): its words, pictures, refs and a few layout choices.
  Never markup, never script, never a price.
- **The renderer** is a set of blocks: a catch-all route asks the host which page an address is and
  draws its sections. Each block asks the host for what it shows, as today.
- **A standard client** (no repository) is served the renderer by the **hosted site app**, which
  the platform ships in the release (decision 2). **A bespoke client** copies the renderer into its
  own web app on a catch-all route and keeps its own code routes beside it.
- **Staff and the AI edit working copies.** A site preview link shows every working copy together
  on the real site. A person publishes one page, or everything changed, all or nothing. An AI only
  asks; a person approves in the Approvals inbox, looking at the preview.

```
 admin (host address, staff)                      the site (the business's domain, public)
 ┌──────────────────────────┐                     ┌─────────────────────────────────────┐
 │ Website screen (pack     │  preview link  ───► │ catch-all route ── site.resolve ──┐ │
 │ screen, stage 47)        │  in a frame         │ sections = blocks:                │ │
 │ pages · sections ·       │                     │  hero, text, timetable, plans …   │ │
 │ menus · brand · redirects│                     │ brand → CSS tokens; head: SEO     │ │
 └──────┬───────────────────┘                     └───────────────────────────────────┼─┘
        │ record.create/update (working copies)                                     │ HOST
        │ record.publishMany (a person) / asked for by an AI, approved in the inbox   ▼
        └──────────────────────────────────────────────────────────────────►  host: site.page,
                                                                                site.settings
```

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **Stay code-only, with better tooling** (preview deployments per branch, #121, and a coding agent) | Decision 1. Every word change is our work; the AI path needs a coding agent holding the deploy secret that reaches every hosted client (stage 46); the approver sees a branch, not a list of changes |
| **Every client's site is the hosted one** (no client has website code) | Decision 2: bespoke clients keep hand-written pages beside the edited ones |
| **Free-form layout** (drag anything anywhere, spacing per element) | Decision 6. Unbounded data, sites that break on phones, and an AI change nobody can review |
| **Pasted HTML or script** | Decision 7. It would run on the business's domain, where customers sign in and pay, and could read what they type |
| **Sections stored as HTML or drawn by the host** | Rich text is data (ADR 0440); the host draws no screens |
| **One page object per pack** (a gym page, a trade page) | Sections already vary by pack; one page object is one editor and one renderer |
| **Redirects as records any write changes at once** | A redirect goes live at once. Kept inside the settings record, so it is published (and, for an AI, approved) like everything else |
| **One approval per page only** (ADR 0480 as it is) | An AI building a site would leave a person approving a dozen requests, and approving some but not all leaves menus pointing at pages that are not live (decision 5) |
| **Editing on the live site** (an "edit" button on the public page) | It puts staff sign-in on the customer hostname, which ADRs 0401 and 0421 forbid |
| **One hosted site Worker serving every standard client by hostname, on ADR 0610 as it stands** | ADR 0610 refuses one Worker serving several clients' data; each client's `HOST` binding and customer sign-in stay its own. If ADR 0611 (PR #275) is accepted, the site app follows the host's shape (below) |
| **An embedded map** in the contact section | It loads an outside service on every visit and sets its cookies. The address is a link that opens the visitor's own map app |

## Platform work and pack work

| Piece | Kind | Why |
| --- | --- | --- |
| `sections` in a shipped pack's manifest: type, label, settings schema (a document schema), layout choices, the web block and export, the public tools the block calls | **Platform** (`packages/sdk/src/manifest.ts`, `contract.ts`, `cos ext check`) | A pack must say what it adds to a page; runtime extensions may not declare it, as stage 47's `screens` |
| **A composed document schema**: a page's `sections` field accepts the union of the installed shipped packs' section types, checked on every write | **Platform** (`packages/sdk/src/document.ts`, the field registry, the reconciler) | A document field's schema is fixed by its own object today (ADR 0445) |
| **Publishing together**: `record.publishMany`, one batch, all or none; an AI's request is one pending action with every item's diff and fingerprint | **Platform** (`packages/core/src/records/publish.ts`, the approvals pipeline and inbox) | Decision 5 |
| **A site preview link**: one token that shows every working copy of named objects for up to a day | **Platform** (`core_preview_link`, a migration; `content.preview`, `content.previewLink`) | One record per link today (ADR 0443) |
| **The inbox shows the preview and a section-by-section summary** for a document field's change | **Platform** (approvals UI, diff summaries) | Today a document's diff is its words, cut at 280 characters |
| **Paths of more than one segment** (`/classes/kids`): the `slug` field type gains a `path` variant | **Platform** (`packages/sdk/src/slug.ts`, `packages/core/src/records/slug.ts`) | A slug is one segment (ADR 0442). `core_slug_redirect.slug` is plain text and holds a path as it is |
| The Site pack: `site.page`, `site.settings`, the generic sections, tools `site.resolve` and `site.sitemap`, views, the `site:edit` permission, starter sites as seed data | Pack (`packs/site`, new) | Composes `publishable`, `public` and document fields |
| Section declarations for Bookings, Memberships, Content, Ticketing and Courses | Pack (`packs/*/index.ts`), reusing the existing blocks behind a section wrapper | |
| The renderer: the catch-all route, brand to CSS tokens, the head (title, description, share image, `noindex`, canonical), `sitemap.xml`, `robots.txt`, menus, the notice bar, not-found | Blocks (`packs/site/blocks`), the client template and the `start-client-app` and `add-block` skills | |
| The Website editor screen in the admin | Pack screen (stage 47) | |
| The hosted site app for standard clients | **Platform** (the release, `cos deploy`, stage 46's fleet, `packages/create-composable-os`) | ADR 0610's shared web app, made concrete |

No new behaviour: pages are `publishable` with `public` reads.

## The model

### Records

- **`site.page`** (publishable, public): `title`, `path` (the `path` variant: lowercase segments
  joined by `/`, unique among live pages, the old path kept as a redirect on change), `sections`
  (document, the composed schema, at most 40 sections and 256 KB), `seoTitle`, `seoDescription`,
  `seoImage`, `noindex`. The public reads every field but staff notes.
- **`site.settings`** (publishable, public, exactly one per host, made at install):
  - `name`, `logo` (image);
  - `brand` (document): primary, accent, background and text colours as hex; a font from a fixed
    list of self-hosted fonts; a corner style from three;
  - `header` and `footer` menus (document): up to 8 items each, one level of children; an item is
    `{ kind: "page", id }`, `{ kind: "path", path }` (one of the app's own routes: the blog, events,
    courses, help pages, My account, sign-in) or `{ kind: "url", href }` (an outside address,
    checked as rich text links are, ADR 0440);
  - `contact`: address, phone (drawn as a tap-to-call link), email, opening hours as text;
  - `notice`: an optional one-line notice bar (an after-hours number, a closure), with an optional
    link;
  - `footerText`: plain text (licence or insurance numbers, a business registration number);
  - `homePage` (ref), `defaults` (search title suffix, share image);
  - `redirects` (document): up to 500 of `{ from, to, permanent }`, `to` a page ref or a path.
- **Section types** (generic, declared by the Site pack): hero (heading, text, picture, button),
  text (rich text), picture and text, gallery (up to 24 pictures), call to action, questions and
  answers, contact and hours (reads `site.settings`; the address opens the visitor's map app), staff
  profiles (people the business marks public, read through a pack tool, never staff accounts).
  **Declared by packs:** Bookings' timetable (class types, days ahead) and drop-in button;
  Memberships' plans and passes (which ones, in what order); Content's latest posts (category,
  count); Ticketing's upcoming events; Courses' catalogue and subscribe. **Later:** Forms' form and
  reviews (stage 29), Shop's featured goods (stage 37).
- **Layout choices** (decision 6): each section type declares at most four, each a short list (for
  example `pictureSide: left | right`, `background: plain | tinted | brand`, `width: narrow | wide`,
  `columns: 2 | 3`), stored in the section's settings and drawn by the block as fixed classes over
  the brand's tokens. No sizes, spacing or positions as numbers.
- **States**: a page's are `publishable`'s (draft, scheduled, published, unpublished). The settings
  record is published like a page; a host whose settings were never published shows a plain holding
  page.

### Operations

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `record.create` / `record.update` / `record.delete` on `site.page`, `site.settings` | staff | `site:edit` (new pack permission: members by default, as posts), and an AI actor the policy allows | write |
| `record.publish`, `schedulePublish`, `unpublish` (existing) | staff | a person with `records:publish`; AI actors only ask (always reviewed) | write |
| `record.publishMany { items: [{ object, id }], note? }` (new) | staff | a person with `records:publish`; AI actors only ask (`alwaysReview`, as ADR 0480) | write |
| `content.previewLink { objects?, id?, hours? }` (extended: a site-wide link names objects, not a record) | staff | `records:write` | write |
| `site.resolve { path }` (pack tool) | **public**, customer, staff | anyone; reads the published settings and pages through the public seam | read |
| `site.sitemap {}` (pack tool) | **public**, customer, staff | anyone; published, indexable pages and posts only | read |
| Each section block's existing reads (`content.list`, the timetable, plans, events) | as today | as today | read |

Opening `site.resolve` and `site.sitemap` to the public is a reviewed change (ADR 0402): they
return only what the public seam already returns. `site.resolve` answers `{ kind: "page", … }`,
`{ kind: "redirect", to, permanent }` or ADR 0442's one not-found, word for word, for a draft, an
unpublished page and an address that never existed.

### Checks the host makes (never the renderer)

- A section's settings fit its type, layout choices included; a ref names a record that exists.
  **At publish** (not on every edit), a section whose refs the public cannot read (an unpublished
  event, a hidden plan) is refused with the section's position, and a menu item pointing at an
  unpublished page is refused unless that page is in the same `publishMany`.
- Colours are valid hex. A text colour on its background below the usual readable contrast (4.5 to
  1) is a **warning** in the write's answer (ADR 0622), not a refusal.
- Redirects: no loop, no chain longer than one, no `from` that is a live page's path, at most 500.
- Prices, places and who may book are never in a section's settings: the plans section names which
  plans to show; the host's plan read says what they cost (for a signed-in member, after stage 34's
  `priceLines`).

### Screens

- **Web admin** (a pack screen, stage 47, `opens` a `site:edit` tool): Pages (a list with state), a
  page's editor (sections in order: add, move, remove; a settings form drawn from the section's
  schema, with its layout choices; the rich text editor and the media picker the admin already has),
  Menus, Brand (warnings shown), Contact and notice, Redirects, Search defaults. Beside the editor,
  the real site in a frame at the site preview link. Publish controls: this page, or "publish
  everything changed" (one `publishMany`). An AI's request in the inbox shows the same frame first
  and the section list beside it.
- **Customer web:** the site. Signed-in areas are not pages: they are My account (stage 48) and the
  existing code routes (sign-in, agreements, checkout), which the hosted site app carries and a
  bespoke client keeps in its own app.
- **Native:** nothing new. Web and native share logic, not screens.

### Notifications

People with `records:publish` are told when an AI asks to publish site changes (the inbox's existing
notice). Nothing is sent to customers by this stage.

### What an AI may do

- **May:** draft and change pages, sections, menus, brand, contact and redirects as working copies;
  make a site preview link; propose a starter site from a description ("a gym with kids' classes and
  three plans"); ask to publish one page or everything changed.
- **May not:** publish, schedule or unpublish (only ask; always reviewed, no setting turns that off);
  approve; change the domain, sign-in settings, who may publish or approval policy; add script or
  markup (the schema has no place for it); name a price (sections have no price field).
- An approval is refused if anything it covers changed since the AI asked (ADR 0480's fingerprint,
  per item).
- **Which model** (decision 12): the AI work here is done by the assistant (`assistant.core`,
  `assistant.subagent`) and by MCP clients, which bring their own model. This stage adds no model
  role. Every call goes through AI Gateway, and the role registry
  (`packages/core/src/ai/roles.ts`) is the map of provider per function: the shipped defaults put
  every text role on one provider. Choosing a provider per feature is not added.

### Privacy and erase

- Everything on a site is public by design. Staff profiles show only people the business marks
  public and only the fields declared public (name, photo, bio).
- Versions keep what was published. Erasing a person clears refs to them in working copies,
  versions and schedules as content does (ADRs 0320, 0441); a name typed into free text is the
  business's to remove, and the erase report lists published pages whose text contains the person's
  name. What must be removed and how fast is for the business to confirm with its lawyer.
- Every edit, publish, request and approval is in the audit log with who asked and who approved.
  Preview tokens are never stored or logged in plain (ADR 0443).
- The renderer sets no tracking and loads nothing from outside the business's domain and the host;
  fonts are self-hosted.

## Out of scope

- Pasted code, tracking tags, outside widgets, embedded maps.
- Forms and reviews sections (stage 29, which brings public writes).
- Signed-in areas as pages; members-only pages (My account is stage 48).
- More than one language (#138), collaborative editing (#140), comments.
- A theme marketplace, per-element styling, fonts uploaded by the business.
- Edge caching beyond what content reads already do (#119).
- Domains and hostnames (stage 46).
- Copying an existing site's pages automatically (decision 9).
- Pages in the native app.
- An online shop's product pages (stage 37's own blocks).
- The standard product's other parts (its packs, its sign-up): its own stage.

## Acceptance criteria

1. A manifest declaring `sections` in a runtime extension fails `cos ext check` and install; a
   shipped pack's section whose block or export is missing, or with more than four layout choices,
   fails the check.
2. A page's `sections` accepts only the installed packs' section types; an unknown type, a missing
   setting, an unknown layout choice, markup in text and a script address are refused on write, for
   every actor, with the path of the fault.
3. Turning off a pack leaves its sections stored but drawn as nothing, and publishing a page that
   uses them is refused naming them.
4. A draft page, an unpublished page and an unknown address are one not-found through
   `site.resolve`, word for word.
5. Editing a published page or the settings changes nothing the public sees until published.
6. `record.publishMany` with three pages and the settings makes all four current in one batch; with
   one of them invalid, none changes.
7. An AI (the assistant and an MCP client) builds a three-page site from a request; nothing is live;
   one pending action asks to publish all of it; under the autonomous preset and every floor it still
   waits; the adjudicator does not approve it; a person with `records:publish` approves it in the
   inbox, seeing the preview, and all of it goes live; an edit between asking and approving makes the
   approval fail.
8. A site preview link shows every working copy together on the real site, expires, and is not found
   for any other object.
9. A section pointing at an unpublished event, or a menu item at an unpublished page not in the same
   publish, is refused at publish with its position.
10. Redirects: an old path answers a permanent redirect; a loop, a chain and a `from` that is a live
    page are refused; a page's path change keeps the old one.
11. The plans section shows the prices the host answers; changing a plan's price changes the page
    without publishing it; the block lint passes on every section block.
12. Brand and layout: changing the primary colour and publishing changes the site's tokens; a
    low-contrast pair is saved with a warning; switching a picture-and-text section's picture side
    changes the page on a phone and a desktop width without overflow.
13. Search: each page's head has its title, description, share image, canonical address and
    `noindex` when set; `sitemap.xml` lists published, indexable pages and posts only.
14. A bespoke client's app with the catch-all route copied in serves pages and keeps its own code
    routes; `cos diff` shows upstream changes to the renderer.
15. A standard client with no repository is served the same site, with sign-in and My account, by
    the hosted site app (once stage 46's fleet and the standard product are built).
16. The Website screen is listed only for people who may use it (stage 47's rule); a coach account
    does not see it.
17. No model role is added; the AI's calls in criterion 7 go through the deployment's AI Gateway.
18. E2E, one per journey: staff build and publish a page; an AI's whole-site request approved in the
    inbox; a visitor follows an old address to its new page.
19. ADR 0401, stage 24's and stage 28's out-of-scope lines and `CONTEXT.md` ("page") amended with
    dated notes; `docs/architecture.md` describes the Site pack and the hosted site app; the site and
    `SITE.md` list the Website piece with its status. Issue #122 is closed by the merge.

## Dependencies

- **Built:** stage 28 (publishable, public reads, preview links, media, rich text), ADR 0480 (an AI
  asks to publish), the model-role registry and AI Gateway routing (ADRs 0180, 0203), and the pack
  blocks the sections reuse (stages 27, 31a, 32b, 42).
- **Being built:** stage 47 (pack screens, PR #303): the editor is a pack screen.
- **Spec agreed, part built:** stage 46 (hosted clients): the fleet the hosted site app is deployed
  on.
- **Not specced:** the **standard product** (ADR 0610; out of scope of stage 46). This stage is its
  website, and they are built together (decision 3). Stage 29 (Forms) for the form and reviews
  sections.
- **Timing** (decision 3): after the first gym is live on bookings and memberships.
- **Proposal in flight:** ADR 0611 (PR #275, one host with a database per client). If accepted, the
  hosted site app's deployment shape changes (step 8), nothing else.

## Migrations and numbers

Block **BQ** in [`parallel-work.md`](../parallel-work.md): migrations 1210–1229, ADRs 0820–0829.

Expected migrations: **1210**, a site-wide preview link (`core_preview_link` gains a scope: one
record, or a list of objects). The `path` variant needs none (`core_slug_redirect.slug` is text).
The Site pack's tables are `x_*`, made by the reconciler, never by a migration.

ADRs the build writes:

1. **ADR 0820**: pages are data, sections are code: the Site pack, its records and the renderer.
   **Amends ADR 0401** ("Pages are code. There is no page builder." becomes: pages may be data;
   screens and sections stay code a client can own; rules stay the host's), with dated notes on
   stage 24's and stage 28's out-of-scope lines and `CONTEXT.md`'s "page".
2. **ADR 0821**: sections declared by shipped packs, their layout choices, and the composed document
   schema. **Amends ADR 0445** (a document field's schema may be composed from installed shipped
   packs); follows stage 47's ADR 0660 (shipped packs only; runtime extensions still ship no UI, ADRs
   0005 and 0010).
3. **ADR 0822**: publishing together, all or none, and an AI asking for it as one request. **Amends
   ADR 0480** (one request may cover several records, each with its fingerprint) and **ADR 0441**.
4. **ADR 0823**: the site-wide preview link and the framed preview. **Amends ADR 0443** (a link may
   name objects, not one record).
5. **ADR 0824**: page paths of several segments, redirects that were never a record's slug, and
   `site.resolve` and `site.sitemap` opened to the public. **Amends ADR 0442**; the opening is
   reviewed under ADR 0402.
6. **ADR 0825**: the hosted site app for standard clients. **Amends ADR 0610** ("one web app shared
   by every client of that product" made concrete: one build, deployed with each client's own `HOST`
   binding). Refers to ADR 0611 if accepted by then. **Amends ADR 0422 and 0424** only by note: the
   client template gains the catch-all route, copied like any block.

## Suggested build order

None of it starts before decision 3's moment. Then:

| Step | What | Files and areas | Can be built beside | Collides with |
| --- | --- | --- | --- | --- |
| 1 | `sections` in the manifest and contract, layout choices, the composed document schema and its checks | `packages/sdk/src/manifest.ts`, `contract.ts`, `document.ts`; `packages/core/src/fields/`, the reconciler | 2, 3 | stage 47 (PR #303, same manifest and contract files): after it merges; any other manifest key in flight |
| 2 | Publishing together; an AI's request for it; the inbox's preview and section summaries | `packages/core/src/records/publish.ts`, the pipeline, the approvals inbox in `apps/app` | 1, 3, 4 | anything in `records/publish.ts` or the inbox: stage 38's request card (its ADR 0702, named in its spec, also amends 0480) |
| 3 | The site-wide preview link (migration 1210) and the `path` variant | `packages/core/src/operations/content.ts`, `packages/db/migrations`, `slug.ts` | 1, 2, 4 | any session editing `content.ts` (stage 38's `content.search`) |
| 4 | The Site pack's spine: page, settings, generic sections, `site.resolve`, `site.sitemap`, views, starter sites | `packs/site` (new) | 2, 3, any pack session | none (new folder); needs 1 before its sections compile |
| 5 | Pack sections: Bookings, Memberships, Content, Ticketing, Courses | `packs/*/index.ts`, `packs/*/blocks` | 6 | any build session in those packs (`index.ts`) |
| 6 | The renderer blocks; the template's catch-all route; `start-client-app` and `add-block` | `packs/site/blocks`, `templates/client/apps/web`, `skills/` | 5 | anything editing `templates/client` (stage 48 step 1) or `cos add`/`cos diff` |
| 7 | The Website editor screen; e2e | `packs/site/blocks`, `apps/app/e2e` | 8 | needs stage 47 merged |
| 8 | The hosted site app for standard clients, with sign-in and My account | the release bundle, `packages/create-composable-os`, stage 46's `apps/fleet` | 7 | stage 46 (fleet, `cos deploy`), PR #275, the standard product's stage, the release manifest |
| 9 | The site and `SITE.md`; ADR amendments; `CONTEXT.md`, `docs/architecture.md` | `apps/marketing`, `docs/` | last | the shared docs files |

**Size: large.** Three sessions at once (1, 2, 3), then the spine (4), then 5 and 6 side by side;
7 after stage 47; 8 with stage 46's fleet and the standard product.

## Decided by this spec, open to override

- One data model and one renderer for both tiers; code pages stay possible in a bespoke client's
  app.
- Sections are code (blocks) with settings as data; layout choices are short named lists, at most
  four per section type.
- Menus, brand, contact, the notice, footer text and redirects live in one publishable settings
  record.
- Publishing together is all or nothing.
- Section checks against public reads happen at publish, not on every edit.
- Low contrast (below 4.5 to 1) is a warning, not a refusal.
- A new pack permission `site:edit`, held by members by default; publishing keeps
  `records:publish`.
- Pack sections only for packs already built; Forms' and reviews wait for stage 29, Shop's for
  stage 37.
- The hosted site app is one build deployed with each standard client's own `HOST` binding, not one
  Worker serving every client (ADR 0610's refusal of shared Workers over client data). If ADR 0611
  is accepted, it follows the host's shape instead.
- The address in the contact section opens the visitor's map app; no embedded map.
- Starter sites per kind of business are seed data.
- No new model role; the assistant's roles do the work, through AI Gateway (decision 12).
- Nothing in the native app.

## Risks

- **Security:** the renderer runs on the business's domain where customers sign in. A section never
  draws unescaped text, and an outside address in a menu or button passes the rich text link checks
  (ADR 0440). The preview frame puts the site inside the admin: the site allows only the host's admin
  origin to frame it, and the frame never carries a staff credential.
- **AI:** a whole-site request is a large change a non-engineer approves. The preview is what they
  judge; the inbox makes it the main thing.
- **Drift:** a bespoke client's copied renderer lags; a new section type needs `cos add`.
- **Search ranking** for a moved site depends on complete redirects; the old site's sitemap is
  checked against them at the move (decision 9).
- **Money:** none charged here. A cached page could show an old price for minutes (ADR 0442's cache
  rules).
- **Needs real things to verify:** a real domain and the hosted fleet; a real client's old addresses;
  page speed on a phone.

## Questions for the owner

None. The two real choices were answered (decisions 1 to 3); the rest is decided above, open to
override.
