# ADR 0470: The import door, and its interchange format

Status: accepted, 2026-11-22 (`feat/content-import`, the first client's blog move). Builds on ADRs
[0440](0440-rich-text-is-data.md) to [0444](0444-media-the-editor-and-the-content-pack.md),
[0446](0446-publishable-without-its-public-half.md), [0451](0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md)
and [0455](0455-staff-invites-and-native-sign-in-by-tokens.md). Amends ADRs 0444 and 0455.

## Context
A client moving its blog onto a host had no way to write content from a script. `cos client
generate` writes customer and role clients, never the staff client (ADR 0451); the Content pack
has no roles; `media.upload` is a person's and takes its file from the upload route, never an
input; and there was no import operation or command. The host may be behind Cloudflare Access,
where `/api/media` is a staff path and only `/api/v1/*` is bypassed. Imports have to be safe to
run again, must never overwrite what a person changed, and must keep old posts' dates. A CRM
import (stage 12) should be able to follow the same shape.

## Decision

**One command, `cos content import <folder> --host <url>`** (`packages/create-composable-os/src/
content-import/`), and one generic operation beneath it, **`record.import`**. The format and the
command are content's; the operation is any extension object's, so a later import of other records
uses it unchanged.

**Who it runs as: a person, signed in for the run.** The command uses the native staff sign-in
(ADR 0455): with `--email`, the host's code by email; without it, the system browser at the host's
`/native/staff-sign-in`, which hands a one-time code to `http://127.0.0.1:<port>/cos-sign-in`, a
port the command listens on, exchanged with its PKCE verifier. The device session the host answers
with is held in the command's memory only (no keychain: the CLI keeps no credential anywhere today,
and an import is one run) and signed out on the host when the run ends. No token is read from a
file or the environment, and none is printed.
- **The actor is `human`, and cannot be forged by an AI caller on this route.** The HTTP surface
  makes a call with a staff device token a staff call as actor `human` (`apiContext`, ADR 0455); a
  device session is issued only to a person who signed in by an emailed code or in a browser. An
  MCP client's credential is an OAuth token for `/mcp`, which is not a device session and is
  refused on `/api/v1/*` (401); the assistant and automations run inside the host with their own
  actors and never come through this route. `record.import` and `media.upload` are
  `actors: ["human"]`, so even a forged context with another actor is refused.
- **Loopback redirects (amends ADR 0455).** `NATIVE_REDIRECT_URIS` may list a loopback address
  with no port, `http://127.0.0.1/cos-sign-in` (or `[::1]`): a code may then be sent to that
  address on any port, as RFC 8252 (7.3) has it for a tool that cannot know its port in advance
  (`nativeRedirectAllowed`). Only the IP literals over http, the same path, no query, fragment or
  user; never `localhost`. PKCE binds the code to the command that asked for it.

**Pictures: a staff-token upload route beside the surface.** `POST /api/v1/media?name=` takes a
staff device token (`Authorization: Bearer cos_at_…`) and nothing else: no cookie (so no page on
another site can post to it with a staff member's Access or session cookie), no customer's token,
no public caller. It builds the call's context from the token and refuses one that is not a
person's staff session, then calls `media.upload` exactly as `/api/media` does: the type from the
bytes, at most 10 MB, a person only. It is under `/api/v1/*`, so Cloudflare Access lets it through
and the Access layout needs no new path (its test covers it). The client-app binding never takes
it. **Uploads are de-duplicated by content**: a picture's SHA-256 is kept (`core_media.sha256`,
migration 0501); `media.upload` returns the item the library has for the same bytes, and
`media.findByHash` says which files it has, so a re-run uploads nothing.

**`record.import { object, records: [{ key, values }], dryRun, checkReferences }`** (up to 25 a
call, `bulk-write`, a person only). Each record is named by an **import key** the source gives it
(a post file's name). What the import last wrote is kept in `core_import_key` (migration 0501) with
the record, in the same batch as the write:
- a new key creates the record (a slug another record holds is a conflict, never a second record);
- a key whose record still holds exactly what the import last wrote has the fields the source
  changed updated, and nothing else; if nothing changed, nothing is written;
- a record whose imported fields someone changed since, or that was deleted, is a **conflict**,
  reported with the fields, and never overwritten.
Keys rather than slugs, because a person may rename a post's address and the import must still
find it, and because records without slugs (a CRM's) need the same.
Values are checked by the record operations' own code (`checkRecordValues`: types, schemas,
required fields, references), compared as the record will hold them. `dryRun` checks and says what
would happen, writing nothing; with `checkReferences: false` it does so before the pictures and
categories an import brings exist.

**The interchange format** (version 1, [docs/importing.md](../importing.md)): a folder of one JSON
file per post in the platform's own shapes (rich text as `RICH_TEXT_SCHEMA`), with a picture named
by `file` where the stored shape has `media` (a rich text image block; `cover` and `seoImage` as
`{ file, alt, focal? }`), a `pictures/` folder, the category by name, `date`, `byline`, the search
fields, and `status` (draft, scheduled, published). It is the first client's converter's output.
The command checks every file before signing in; the host then checks every record in a dry run;
only then is anything written. Every problem is reported with its file.

**Publishing is the person's, for the batch, on the command line.** `--publish` shows how many
posts will be published and scheduled and asks (or `--yes`, for a script); each `published` post
is published, and each `scheduled` one scheduled for its `date` (one whose time has passed is
published, and said so). Without `--publish` every post is a draft and the report says which were
published or scheduled in the source. A post's `date` is the `publishable` date field (ADR 0441):
publishing keeps a date that is set, so an old post keeps its own, and `content.list` orders by it.
`publishedAt` is when it was published here. A published post is published again only when its
content changed.

**The Content pack (0.2.0)** gains `byline` (plain text the public reads; a post's author is a
staff account the public never reads) and the search fields `seoTitle`, `seoDescription`,
`seoImage` (an `image`) and `noindex`, all content and public. `postHead()` gives a page's head
from them, falling back to the title, excerpt and cover; the `content-post` block's `PostHead`
renders it as React 19 head elements; the post blocks show the byline.

## Proof
- `apps/app/test/content-import.test.ts`, the command's own engine against cos-app's real surface
  and media route with a staff device session: a bad folder (unknown block, missing picture, not
  JSON, unknown field) stops before any write; a folder of posts and pictures imports as drafts,
  as actor `human` in the person's name; a re-run changes nothing and uploads nothing; a change in
  the source updates only that field; a person's edit since is a conflict and is kept; `--publish`
  publishes with the posts' dates and the public list is in their order, a second run publishes
  nothing, and not confirmed writes nothing; a scheduled post is scheduled only with `--publish`;
  a dry run writes nothing. The upload route refuses no credential, a cookie, a made-up token and
  an MCP token; an MCP, assistant or automation context cannot call `media.upload` or
  `record.import`; the run's session ends on the host.
- `packages/core/test/media.test.ts`: the token route refuses no token, a cookie, a customer's or
  the public's context and AI actors, and is off where not turned on.
- `packages/core/test/native-redirects.test.ts`: loopback on any port only as listed; never a name,
  https, another path, a query or a fragment.
- `packages/create-composable-os/test/content-import.test.ts`: the format, every problem named with
  its file, and the command refusing a bad folder before it calls the host.

Each check removed, a test fails (restored after): the route's bearer-token check (the app test and
the core test, 1 each); the route's staff-person check (the core test, 1; the app test still
refuses through `media.upload`'s own actor rule); `media.upload` open to any actor (1);
`record.import` open to any actor (1); a person's edit overwritten (1); pictures not found by hash
(2); the import key ignored (4); a dry run writing (4); a loopback redirect to any path (1); an
unknown field in a post file let through (1).

## Consequences
- A staff member who can run `cos` can write what they could write in the admin, from a script,
  and no more; the host's checks and audit are the same.
- An import key ties a record to its source. Deleting a record leaves its key, so a re-run reports
  it rather than making it again; import it under a new key to make it anew.
- Two posts in one call that would get the same address from their titles are refused by the
  slug index as a whole call; the folder check refuses two posts at one address first.
- Pictures uploaded before migration 0501 have no hash; uploading such a file again stores it again
  once.

## Amended 2026-11-22 (ADR 0457)
- `cos deploy` lists `http://127.0.0.1/cos-sign-in` in `NATIVE_REDIRECT_URIS` on every host, with
  the mobile app's redirect when there is one; the CRM's installer sets it when unset.
- The browser sign-in asks on the host's page before the code goes to the command.
- `--email` works for an invited or confirmed address; the command says what to check if no code
  arrives.
- Without `--publish`, a post already published (or scheduled) here and unchanged gets no note; a
  changed one is said to be saved, not published.

## Amended 2026-11-22 (ADR 0485)
- The door's generic half is lifted out of `content-import/` into `import-door/` (the host over a
  session, the run's sign-in and confirmation, `record.import` in batches with its outcomes, media
  by hash), so `cos courses import` uses the same code. The content import's behaviour is unchanged.
- A second token route beside the surface: `POST /api/v1/media/<id>/captions`, a video's captions with
  a staff device token only, under the same rules as `POST /api/v1/media`.
- A video's row keeps a SHA-256 too (`media.videoUpload`'s and `media.videoFromUrl`'s `sha256`), so
  `media.findByHash` finds videos on a re-run as it finds pictures.
