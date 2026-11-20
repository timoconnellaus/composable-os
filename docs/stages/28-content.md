# Stage 28: Content

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Behaviours, Packs and blocks), [`CONTEXT.md`](../../CONTEXT.md), ADRs
[0401](../adr/0401-platform-packs-screens.md), [0402](../adr/0402-staff-and-customers.md) and
[0404](../adr/0404-behaviours-are-the-vocabulary.md), stages [22](22-customers-and-audiences.md),
[23](23-http-surface-and-typed-client.md) and [25](25-states-orders-payments.md) (the `states`
behaviour), ADRs 0017, 0023, 0024, `packages/sdk/src/field-types.ts`,
`packages/core/src/fields/`; in `~/repos/ghetto`: `README.md` (EmDash), `src/pages/blog/`,
`src/staff/doc-list.ts`, `src/pages/staff/slides.astro`.

Status: spec proposed. Builds on stages 22 and 23. Uses `states` from stage 25 if it is there.

## Goal

A product can hold content that staff write and the public reads: blog posts, event descriptions,
announcements. Staff edit a draft without changing what is live, publish it or schedule it, and
can go back to an earlier version. The web app and the phone app each show the same content with
their own components, because it is stored as structured data and not as HTML. Claude can draft a
post over MCP, and a person publishes it. Ghetto's blog moves off EmDash.

## What exists today (from the code)

- **Field types** (ADR 0023): text, long text, number, currency, percent, date, datetime, boolean,
  selects, relation, user, email, phone, url, formula. No rich text, no image, no slug.
- **Audit** stores field diffs for every write (ADR 0017), which is a history of changes but not a
  version a reader is served.
- **R2** is bound and used for files such as synced email bodies. There is no media library.
- **Nothing is public.** After stage 22 the `public` audience exists with no operation using it.
- **Ghetto:** the blog is EmDash on Astro (`/blog`, `/blog/[slug]`). Staff documents, TV slides
  and programmes are each stored and edited their own way in Ghetto's repository.

## Scope

### The `publishable` behaviour
- An object declares `publishable`: which fields are content (versioned and served), its slug
  field, and optionally a publish time field.
- A publishable record has a working copy, which staff edit, and at most one **published
  version**, which is a snapshot of the content fields taken when it was published. Editing the
  working copy never changes what readers see.
- States: `draft`, `scheduled`, `published`, `unpublished`. Publishing snapshots the content and
  makes it live. Scheduling sets a time; the minute cron publishes when it passes, through the
  operations pipeline. Unpublishing removes it from public reads and keeps the versions.
- Every publish keeps its version. Staff can see earlier versions, compare two, and restore one
  into the working copy.
- Publishing is its own operation with its own risk class, so approval policy can require a person
  for it when the actor is an AI. Drafting is an ordinary write.

### New field types
- **`richText`**: structured JSON with a fixed schema. Blocks: paragraph, heading, list, quote,
  image, divider, embed (a link the client decides how to show), callout. Marks: bold, italic,
  link, code. The host validates it on write and limits its size. No HTML is stored or accepted.
- **`image`**: a reference to a media item, with alt text and a focal point.
- **`slug`**: unique per object among live records, made from the title by default. Changing a
  published record's slug keeps the old one as a redirect.

### Media
- A media item is a base record: the file in R2, its type, size, dimensions and alt text, who
  uploaded it.
- Staff upload from the admin. The host checks type and size, and stores nothing executable.
- Images are served through a host route in sizes the client asks for from a fixed list, cached
  at the edge. Only media referenced by published content is served publicly.
- Erase and Trash treat media like any record; a purge deletes the R2 object through the existing
  blob deletion path.

### Public reads
- An object declares which fields the public may read. With `publishable`, public reads serve the
  published version only, and only of records in the `published` state.
- `content.get { object, slug }` and `content.list { object, filter?, sort?, cursor? }` (public):
  through the visibility seam with the public scope, like stage 22's customer scope. A draft, an
  unpublished record and an old slug with no redirect all give the same not-found answer.
- An old slug answers with where the record now is.
- Public reads are cacheable. A publish, unpublish or slug change purges what it affects.
- **Preview:** staff make a link that shows a record's working copy. The link is signed, names one
  record, and expires.

### The editor
- A rich text editor in the admin's record page for `richText` fields, built on an existing editor
  library, reading and writing the JSON schema. Image blocks pick from the media library.
- The publish controls: publish, schedule, unpublish, versions, compare, restore, preview link.

### The Content pack (`packs/content`)
- `content.post`: title, slug, excerpt, body (`richText`), cover (`image`), author (user),
  category, publish time. `publishable`.
- `content.category`: name and slug.
- Views: Drafts, Scheduled, Published. A record tab of posts on their author.
- Hooks: `usePost`, `usePosts`.
- Blocks: a rich text renderer in a **web** skin and a **native** skin, mapping each block type to
  the client's own components; a post page and a post list for the web; a post screen for native.
- Other packs use the same parts. Ticketing's event gains a `richText` description and an `image`,
  and becomes publishable, with no change to how it is sold.

### Ghetto
- The Content pack is turned on in the `ghetto` product.
- Existing posts are imported from EmDash by a script: bodies converted to the `richText` schema,
  images copied into media, slugs and publish dates kept. Anything that does not convert is listed,
  not dropped.
- `/blog` and `/blog/[slug]` are served from the host's content, with the same addresses, and
  EmDash is removed from the site.

## Out of scope
- A page builder, layouts or navigation stored as content. Pages are code.
- More than one language.
- Comments, reactions, newsletters.
- Uploads from client apps, video hosting.
- Collaborative editing at the same time.
- Staff documents, TV slides and programmes as content types. They can follow once posts work.
- Moving Ghetto's site to TanStack Start. This stage removes the one thing that tied it to Astro.

## Acceptance criteria
1. **Live is a snapshot:** editing a published post's working copy does not change what
   `content.get` returns until it is published again.
2. **States:** draft, schedule, publish at the set time by the cron, unpublish; each public read
   matches the state.
3. **Versions:** every publish keeps a version; restoring one changes the working copy only.
4. **Not found is one answer:** a draft, an unpublished record, an unknown slug and a record of a
   non-publishable object are indistinguishable to the public.
5. **Fields:** the public gets only declared fields; the stage 22 isolation test runs with the
   public scope.
6. **Rich text is data:** HTML, script and unknown block types in a `richText` value are refused
   on write, for every actor; a fuzz test of malformed input never stores one.
7. **Two renderers:** the same fixture document renders through the web block and the native
   block, each covering every block type and mark.
8. **Slugs:** unique among live records; a changed slug redirects; a deleted record's slug can be
   used again.
9. **Media:** type and size limits hold; an image not referenced by published content is not
   served publicly; purge removes the R2 object.
10. **Preview:** a link shows the working copy; it stops working after its expiry and for any
    other record.
11. **Cache:** after a publish the next public read is the new version.
12. **AI:** over MCP, an assistant drafts a post; publishing it is queued for a person under the
    default policy.
13. **Ghetto:** every EmDash post is on the host with its slug and date; the blog's addresses
    answer as before; the import's list of anything not converted is empty or accepted.
14. `pnpm lint typecheck test` and e2e (write, schedule, publish, read publicly) pass in CI. ADRs,
    `CONTEXT.md` (Publish, Version, Working copy, Media, Preview) and `docs/architecture.md` are
    updated.

## Dependencies
- Stages 22 and 23. Stage 25's `states` if present; otherwise this stage carries its own four
  states and moves to `states` later.
- Independent of stages 26 and 27, apart from the event description, which is added by whichever
  lands second.

## Migrations and numbers
Migrations 0460 to 0469. ADRs 0440 to 0444.

## Suggested build order
1. The `richText` schema, its validation and the fuzz test.
2. `publishable`: working copy, versions, states, the publish operation.
3. Public reads, the not-found rule and the cache.
4. Media and image serving.
5. The editor and the publish controls.
6. The Content pack, hooks and both renderers.
7. Ghetto's import and the blog's routes.

## To settle at the interview
- **Which editor library,** and how its own document format maps to the `richText` schema.
- **The block list.** Each block is a promise every client must render. Start small.
- **Where EmDash's content format is documented,** and whether its posts convert cleanly. Read
  some real posts before promising a clean import.
- **Does Ghetto's blog move while the site is still Astro,** as proposed, or with the site.
- **Image resizing:** Cloudflare's image transformations, or sizes made at upload.
- **Who may publish.** A role question that leans on stage 14a.
- **Whether a published version is also what staff lists and search show,** or always the working
  copy.
