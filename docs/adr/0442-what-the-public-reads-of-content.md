# ADR 0442: What the public reads of content: published versions, by slug, one not-found, cached

Status: accepted, 2026-11-22 (stage 28, build step 3). Builds on ADRs
[0402](0402-staff-and-customers.md), [0438](0438-the-public-scope.md) (whose "stage 28" note this
fills), [0446](0446-publishable-without-its-public-half.md) and [0441](0441-publishable-states-schedules-and-versions.md).

## Context
The public must read a blog's posts and an event's page: only what was published, never the
working copy staff are editing, only the fields the object declares, by an address that survives a
change of title. A draft, an unpublished post and an address that never existed must be one answer,
so nobody can find out what is being written. Public reads are many and the same for everyone, so
they should be cached, and a publish must show at once.

## Decision

**Published only, in the seam's source.** A publishable object that declares `public` gets a
second view, its **live view** `pub_x_<ext>_<object>` (built with the `rec_*` views,
`extensions/schema.ts`): one row per live (not deleted) record that has a current version. Its
content columns (and a content document's declared paths) are `json_extract` of the current
version's content; its other own columns are the record's (the slug, a state `when` tests); its
formulas and other extensions' fields are NULL, since they read the working copy; `updated_at` is
when the version was published. The public scope's source on such an object is the live view
(`PublicScope.source`, `visibility/public.ts`), and `when` still holds beside it. Nothing else in
the seam changed: a record that is not published is not in the source, so it is not found exactly
as one that does not exist, through every read there is (`public.list`, `public.get`, a pack's
tool, buying). The live view is not a `rec_*` view, so `query.sql` does not read it.

**What may be declared.** On a publishable object `public.read` must list the slug (it is how the
public reads) and may not list a formula or a path of a document that is not content; the object
names `publishable.slug` and declares no `customer` or `customerVia`. `publishedAt` and
`publishedVersion` may be listed. `cos ext check` (the SDK) and the host (`publicProblems`) hold
the same lines.

**Slugs.** A field type `slug`: lowercase letters and digits in words joined by single hyphens, at
most 120 characters; only on an object's own fields. Unique among the object's live records by a
partial unique index the reconciler makes (`<table>__<column>__unique ... WHERE deleted_at IS NULL
AND <column> IS NOT NULL`), so a deleted record's slug can be taken again and the database refuses
a second one whatever wrote it; `records/slug.ts` says so first, in words (`slug_taken`, naming
the field). A slug left empty on a new record is made from the title (`slugify`: accents dropped,
anything else a hyphen, at most 80 characters, `-2`, `-3` for the next ones). The slug is the
record's address, not content: it is not versioned, and a change is live at once. When the slug of
a record that has ever been published changes, its old slug goes into `core_slug_redirect`
pointing to the record; a record that takes a slug removes any redirect of it, so a live slug
always wins. Erasing a person clears a slug that mentions them rather than leave a broken one.

**Three public operations** (`operations/content.ts`), each `risk: read`, audiences `staff`,
`customer`, `public`:

| Operation | What |
| --- | --- |
| `content.get { object, slug }` | `{ kind: "record", object, id, values }` for the published record with that slug, or `{ kind: "redirect", object, slug }` for an old slug whose record the public reads now |
| `content.list { object, filter?, sort?, cursor?, limit }` | a page of published records; newest first by the object's date, else `publishedAt`, when the public reads it |
| `content.preview { object, slug, token }` | ADR 0443 |

They read as the public whoever calls, staff included, so they only ever answer what the public
is given. They are open to be called directly, not `toolOnly` as `public.*` are (ADR 0438): a
blog's site reads posts through its binding with no pack tool between, and what they answer is
decided by the object's declaration, which is reviewed (`cos ext check`, `outside_audience`), as
`public.*`'s is. They are `hostInternal` because they read three bookkeeping tables beside the
records (redirects, preview links, the cache's generation); every record they return is read
through the public's seam.

**One not-found.** A draft, an unpublished record, a deleted one, an unknown slug, a malformed one,
a redirect whose record the public cannot read, and an object that is not public content (not
publishable, publishable but not public, not an object) all answer `not_found`, "Not found",
details `{ object }` (only what the caller sent), word for word.

**The cache.** A content read's answer is kept in the Worker's cache (`caches.default`), keyed by
the object's **generation** (`core_content_generation`, migration 0460) and a hash of the
operation and input. The pipeline bumps an object's generation in the batch of every committed
change to one of its records when the object is public content: a publish, a scheduled publish
going live, an unpublish, a slug change, a delete, any edit. So a stale answer is never read:
nothing is purged, the key moves. Each object's row carries a random `epoch`, so deployments
behind one cache never share a key. Old entries age out after an hour. Where there is no cache
the database answers. This is a deviation in form from the spec's "a publish purges what it
affects": a purge across Cloudflare's data centres needs the zone API and a credential; a moved
key needs neither and is exact. Edits of a working copy move the key too, which only costs a miss.

## Proof
- `packages/core/test/content.test.ts`: criterion 1 (an edit of a published post's working copy,
  its staff note included, changes nothing `content.get` or `content.list` returns until it is
  published again; only the declared fields come back); criterion 4 (a draft, an unpublished post,
  a deleted one, an unknown slug, a malformed one, a public object that is not publishable, a
  publishable one that is not public, an unknown object and a core object give the identical
  answer; staff calling `content.get` are told the same; `public.get` called directly is unknown);
  criterion 8 (two posts with one title get `hello-world` and `hello-world-2`; a taken slug is
  refused in words and by the database; a published post's changed slug redirects and a draft's
  does not; unpublished, the redirect is not found; a new post takes the old slug and wins it;
  deleted, its slug is free; a post without a slug is not published); criterion 11 (a read is
  served from the cache, shown by changing the version behind the pipeline's back; after a publish
  the next read is the new version; after an unpublish, not found); the declaration's checks.
- Criterion 5: the stage 22 isolation suite (`isolation-suite.ts`, run by
  `audiences-isolation.test.ts` and over HTTP by `http-isolation.test.ts`) gains a post the public
  reads whose working copy has moved on, a draft and an unpublished one. Every open operation is
  called as a customer and as the public with their ids, their slugs, made-up tokens and hostile
  filters; no response holds the working copy's edits, the staff note, the draft's or the
  unpublished one's values or ids, and a hidden post's id or slug answers as a guessed one. A
  public read of the live post has exactly its five declared fields.

Each check removed, the tests fail (restored after): `content.get` reading as staff, 8 tests fail
(content and isolation); a draft answered differently from an unknown slug, 7; the public's source
the working copy instead of the live view, 8; the public scope's field list ignored, 5. Selecting
every column in the public source (`*`) alone fails no test: the narrowed definition still decides
which fields are returned, so that is two layers and the tests catch the one that answers.

## Consequences
- A publishable object the public reads costs one more view, rebuilt with the others.
- Restoring a record from the Trash whose slug another live record has taken now fails on the
  unique index (an internal error, nothing written); the Trash's restore should say so in words
  (left for a later change).
- Ticketing's event becomes publishable in step 6: its public reads, its buying (`buyableSource`)
  and `capacity.get` then follow the published version with no change here.

## Amendment, 2026-11-22 (stage 28, ADR 0444)
Restoring a record from the Trash whose slug another live record took meanwhile is now a
`conflict` naming the slug and the record holding it, checked before the write; the internal
error this ADR listed under its consequences is gone. A picture in a published version is served
to the public by `media.serve` (ADR 0444).

## Amendment, 2026-11-24 (stage 54, ADR 0810)
"`public.read` must list the slug" and "the object names `publishable.slug` and declares no
`customer` or `customerVia`" are relaxed. A publishable object the public reads may have no slug:
`content.list` lists it, and `content.get` (with `content.preview` and its links) answers it with
the one not-found. One may declare a `customer`, its author, beside `public`: then it has no slug
and `public.read` never lists the author. `customerVia` is still refused. When a slug is
declared, `public.read` still lists it. See [ADR 0810](0810-publishable-with-an-author.md).
