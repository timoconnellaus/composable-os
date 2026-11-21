# ADR 0444: Media, the editor and the Content pack

Status: accepted, 2026-11-22 (stage 28, build steps 4 to 6). Builds on ADRs
[0440](0440-rich-text-is-data.md) to [0443](0443-preview-links.md),
[0320](0320-erase-reaches-every-store.md) (the blob deletion path), [0424](0424-blocks-as-built.md) and
[0453](0453-pack-hooks-over-the-clients-operations.md). Amends ADRs 0442 and 0443.

## Context
The spine (ADRs 0440 to 0443) stored rich text, versions and public reads, and left a seam: a
rich text picture names a `media` record that did not exist. Steps 4 to 6 add the media library
and its serving, the editor and the publish controls in the admin, and the Content pack with its
hooks and two renderers. The spine review asked for two gaps to be closed: restoring a record
whose slug was taken meanwhile, and listing and stopping preview links.

## Decision

### Media (step 4, criterion 9)
- **A base record, `media`** (`core_media`, migration 0461; `fields/media.ts`): one original in
  R2 (`media/<id>`, in the bucket the host already binds as `BLOBS`), its type, size and
  dimensions as the host read them, its name and alt text, who uploaded it. It declares no
  customer or public scope: outsiders read no media record. `rec_media` is its live view.
- **What may be uploaded is read from the bytes**: JPEG, PNG, GIF, WebP or AVIF by their magic
  numbers, never the name or the client's type; at most 10 MB, checked from the header and again
  while the body is read. SVG is not taken (it can carry script), nor anything else.
- **The bytes never pass through an operation's input.** `POST /api/media?name=&alt=` (cos-app,
  `http/media.ts`) reads the body and calls `media.upload` with it as `ctx.upload`; the operation
  is a person's (`actors: ["human"]`), refuses a call with no file (an MCP client, an import),
  stores the original and then commits the row. A browser may post only from the host's own
  origin. The client-app binding serves no upload.
- **`media.serve` decides who is served a picture**, `GET /api/media/<id>?w=<width>` streams it.
  Staff: any live item. A customer or the public: only an item the current version of a record
  they may read references, so a draft's picture, an unpublished post's, a deleted post's and a
  deleted item are not served; every other answer is ADR 0442's one not-found. Which items a
  version references is written with the version (`core_published_media`, by
  `records/publish.ts`), so the check is an index read and then the public's seam. Widths are
  rounded up to one of 320, 640, 960, 1280, 1920; Cloudflare Images (`IMAGES`, optional) makes
  them, else the original is served. A public answer may be kept 5 minutes
  (`cache-control: public, max-age=300`): an unpublished picture stops within that. A staff
  answer is `private, no-store`. Every answer is `nosniff` with a `default-src 'none'` policy.
- **The `image` field type** (`{ media, alt, focal? }`, the SDK's `IMAGE_SCHEMA`): a document
  type with a fixed schema, its media id checked like any ref. A post's cover is one.
- **Trash and purge**: `media.delete` and `media.restore` (the Trash lists pictures); the Trash
  purge deletes the row, and a trigger queues its key on `core_blob_deletion` in the same batch,
  so the existing drain deletes the R2 object after the commit and the 10-minute cron retries.

### The editor and the publish controls (step 5)
- **Tiptap 3.32.3** (ProseMirror), checked as current at build time and pinned to a release more
  than two weeks old. Its schema is the platform's blocks and marks (StarterKit without strike,
  underline or code blocks; a quote, picture, embed, callout and button of our own). Its document
  never leaves the editor: `toRichText` (`apps/app/src/lib/rich-text-map.ts`) maps it to the
  platform's schema, dropping any node, mark or attribute the schema does not name, any link or
  embed the host would refuse, and anything in text that reads as markup (entities decoded first,
  so `&lt;b&gt;` cannot come back as a tag). A paste is parsed by that schema: a table or a code
  block keeps its words, a `<script>` is never parsed. The host checks the result again on save.
  A picture's caption is plain text in the editor (a stored caption's marks are kept until it is
  edited).
- **The publish controls** (`components/record/publish-card.tsx`) on every publishable record's
  page: the state, publish now, schedule, cancel, unpublish, the versions with what changed since
  each and restore, and, for content the public reads, preview links. Every one is an operation;
  the host refuses a member without the publish permission.
- **Restoring from the Trash** a record whose slug another live record took meanwhile is a
  `conflict` naming the slug and the record that holds it (`assertRestorable`), before the
  write, never an internal error from the unique index. Amends ADR 0442.
- **Preview links are listed and stopped**: `content.previewLinks` (staff, read: when each was
  made, by whom, until when, and an id that is the start of its token's hash, never the token) and
  `content.revokePreview` (one by id, or `all`). Amends ADR 0443.

### The Content pack (step 6, criterion 7)
- `packs/content`: `content.post` (title, slug, excerpt, body `richText`, cover `image`, author
  `user`, category, date; publishable with the slug and date; the public reads all but the
  author) and `content.category` (name, slug; every live one public). Views: Drafts, Scheduled,
  Published, on `publishState`. One tool, `categories`, open to the public through `public.list`.
- **Hooks over the client's operations** (ADR 0453): `usePosts`, `usePost`, `usePreview` (the
  host's `content.list`, `content.get`, `content.preview`), `useCategories` (the tool), and for
  staff `usePublish`, `useSchedulePublish`, `useUnpublish`. A customer's or the public's client
  gets the four reading hooks; the staff client all seven.
- **Two renderers of one schema**: `content-rich-text` (web, React elements on the base layer's
  button) and `content-native-rich-text` (React Native's own components and the native base
  layer's theme), each drawing every block and mark, a picture from the media route, and a video
  from the player address built from its id (web) or as a card that opens it (native; no web
  view). Blocks: `content-post` (the post page, with the redirect and the preview),
  `content-post-list`, `content-native-post`.
- **Criterion 12 is undecided** and nothing here depends on it: `record.publish` stays a
  person's, and `usePublish` is the one hook that would change (its entry in
  `CONTENT_HOOKS_CALL` and its operation), not a block.

## Proof
- `packages/core/test/media.test.ts` (criterion 9, against a real local R2 bucket): a PNG is
  stored with its size and dimensions; an SVG with script, HTML, a script, a PDF and a truncated
  header are refused whatever their name; over 10 MB and an empty file are refused; a call with no
  file is refused. A picture in rich text or a cover names a live item; a missing one is refused.
  Staff are served any live picture; the public not one in no post, nor in a draft, served once
  the post is published, still while only the working copy dropped it, not after the next publish,
  not once unpublished, not while the post is deleted, again once it is restored, not once the
  picture is deleted. The route uploads for staff, refuses an upload from the public, from another
  site, over the limit and over the binding, and streams with the right headers. A deleted picture
  is in the Trash and comes back; purged, its key is queued and the drain deletes the R2 object.
- `packages/core/test/content.test.ts`: restoring a post whose slug was taken is a conflict naming
  the slug and the holder, and works once the other's slug changes; two preview links are listed
  without their tokens, one is stopped and the other still works, `all` stops the rest.
- `apps/app/test/rich-text-map.test.ts`: a paste with a strike, a script in text, escaped markup,
  a `javascript:` link, a table, a code block, a `data:` embed, a `javascript:` button and a bare
  image comes out as exactly the platform's blocks, with no markup and no bad address; markup in
  six spellings never survives; the fixture goes in and out unchanged.
- `packs/content/test/renderers.test.tsx` (criterion 7): the fixture through the web block and
  the native block: every block type and mark as its own element, the picture at the asked width,
  the video's player, every word; script text is escaped. `packs/content/test/content.test.ts`:
  the pack's checks, the tool, the hooks a public and a staff client get.
  `apps/runner/test/content.test.ts`: the pack installed in the real host; a post published and
  read with the pack's hooks over the public; the categories; an assistant's draft is a working
  copy it cannot publish.
- `apps/app/e2e/content.spec.ts` (criterion 14): write a post in the editor (typed, and an HTML
  paste with a script and a table), schedule it, publish it, read it publicly with no account.

Each check removed, the tests fail (restored after): the public served any live picture (2
tests fail); any bytes a picture (2); no size limit (1); the purge leaving pictures (1); restore
over a taken slug (1); a revoked preview link still working (1); markup kept in the editor's text
(1); a bad link kept (1); callouts not drawn by the web renderer (2) and by the native one (2).

## Consequences
- Cloudflare Images is not bound by default: until a deployment adds `"images": { "binding":
  "IMAGES" }`, every width is the original. Nothing else changes when it is added.
- A user has no record page, so the spec's "record tab of posts on their author" is not built; a
  post's author is a staff account the public does not read.
- On a host behind Cloudflare Access (ADR 0455), `/api/media/*` is a staff path: the public is
  served pictures through the client-app binding, which Access does not front, and a client app
  forwards its own `/api/media/<id>` route to it.
- An uploaded original whose row then fails to commit is left in R2 with no row naming it, never a
  row with no object; nothing serves it.

## Amendment, 2026-11-22 (issue #181): pictures on a company's own site and app
- **The client template's web app has a media route** (`mediaRoute` in `src/host.ts`, called by
  `src/server.ts`): `GET /api/media/<id>?w=` on the site's own hostname is forwarded to the host
  over the `HOST` binding with the id, the width and the customer's cookie and nothing else, and
  the picture comes back with the host's type and cache headers, `nosniff` and a `default-src
  'none'` policy. The web blocks ask it by default (`mediaBase` for another origin). It is in a
  host module, so `cos upgrade` brings it to a repo that has not edited its `host.ts`
  (ADR 0451's recorded hashes), and `cos init` gives it to an adopted site.
- **A phone asks the host itself** at `/api/v1/media/<id>?w=`, served by the same handler beside
  the HTTP surface, so Cloudflare Access lets it through with the rest of `/api/v1` and nothing in
  the Access layout changes; `/api/media/*` stays a staff path (the admin's uploads and pictures).
  The mobile template's `mediaUrlFor({ hostUrl })` and the pack's `hostMediaUrl(hostUrl)` build
  it. `docs/deploying.md` says so.
- **`media.serve` reads the reader's fields.** `core_published_media` keeps the field each picture
  is in (migration 0500, filled from the current versions; block AC, after 0470 which it reads).
  An outsider is served a picture only when a record they may read shows it in a field their scope
  lists; a staff-only picture among the content is not theirs. It reads one query per object that
  uses the picture, however many records do, so a picture whose first twenty uses are hidden and a
  later one public is served (the cap of twenty uses is gone).
- **Proof:** `apps/app/test/company-web-media.test.ts` (through the real binding: a published
  post's picture served with the host's headers, a draft's and a made-up one not found, POST
  refused, a bearer token and other headers not passed on, HEAD); `packages/core/test/media.test.ts`
  (a picture only in a field the public does not read is not served, and is once it is in one;
  twenty-one uses, the first twenty deleted posts', served; migration 0500's backfill finds what
  publishing writes; `/api/v1/media/<id>` for a phone). Both serving tests fail against the
  previous `media.serve` (2 failed). `packages/create-composable-os/test/client-repo.test.ts`: a
  repo made before the route gets it on `cos upgrade`, with a new recorded hash; an adopted site
  gets it from `cos init`.
