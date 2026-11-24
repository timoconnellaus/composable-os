# ADR 0700: The published-text index and `content.search`

Status: accepted, 2026-11-24 (stage 38, build step 1). Amends ADR
[0442](0442-what-the-public-reads-of-content.md) (a fourth public read of content). Builds on ADRs
[0440](0440-rich-text-is-data.md) (rich text is data), [0441](0441-publishable-states-schedules-and-versions.md)
and [0446](0446-publishable-without-its-public-half.md) (versions), and the FTS5 index of
`search.global` (migration 0006). Migration 0970.

## Context
Stage 38's help pages need a search box on the business's website that finds the right page as
the reader types, and the assistant (step 7) and staff (step 2) need to point at a section of a
long procedure, not only at the record. What existed searched working copies (`search.global`,
`search.hybrid`, for staff) and `content.list` filtered on fields, with no words. A public search
must never find a draft's words or a field the public does not read, and a result must link to the
heading it was found under.

## Decision

**Sections and anchors are the SDK's, computed, never stored.** A heading starts a section; the
blocks before the first heading are a section without one. `headingAnchors(doc)` (in
`@composable-os/sdk/rich-text`, a new subpath export that pulls in nothing else) makes each
heading's anchor from its words (accents dropped, lowercase, hyphens, at most 60 characters) and
its place: a repeated heading gets `-2`, `-3`, a heading with no letters or digits is `section`.
`richTextSections(doc)` splits a document with those anchors. The host's index, the web content
renderer (the heading's `id`) and the native one (its `nativeID`, and an `onAnchorLayout` callback
to scroll to it) call the one function, so `#<anchor>` from a search result lands on the heading
the search found. No schema change: an anchor follows its heading's words.

**The index.** `core_published_text` (migration 0970): one row per section of a published
record's current version (object, record, version, field, section number, anchor, heading, body),
with an external-content FTS5 table over heading and body (`unicode61 remove_diacritics 2`, prefix
indexes 2 and 3, as `core_search`). The record's title is its title field's section 0, in the
heading column, so a title match outranks a body one (`bm25` weights 5 and 1). Only
`content/published-text.ts` writes it.

**What is indexed is the declaration's.** A publishable object that declares `public` (with its
slug, ADR 0442), and of it only the content fields that are `text`, `longText` or `richText` and
that `public.read` lists. A content field the public does not read is never indexed, so no snippet
can show it. Step 2 adds `staffRead` objects for staff.

**Written in the publish batch.** `publishWrites` (every publish: a person's, an approved request's
and the minute cron's scheduled one) replaces the record's rows with the new version's sections;
`unpublishWrites` deletes them. It is two statements whatever the length: the sections are one
JSON parameter of an `INSERT ... SELECT FROM json_each(?)`, so a document of a thousand blocks costs
what a short one does (D1 runs at most 1,000 statements per invocation and binds at most 100
variables per statement; the parameter is at most the version's size, under D1's 2 MB value).
Erase remakes a scrubbed current version's rows (`erase-stores.ts`), a hard-deleted record's rows
go with its search entry, and a renamed object's rows follow it (the reconciler).

**Caught up by the minute cron.** `content.reindex` (automation only, `runReindexDue` in
cos-runner's tick) keeps, in `core_settings` (`published_text_index`), the fields each object's rows
were made from. When an object's declaration changes (a field opened or closed to the public, the
object made public or private) or the index's own shape changes (`INDEX_VERSION`), it makes the
object's rows again from the current versions, 50 records a call, and an object no longer
searched loses its rows; each bumps the object's content generation. The first tick after this
migration fills the index for everything published before it. With nothing to do it is one read.

**`content.search { object, q, cursor?, limit? }`** (`operations/content.ts`): audiences staff,
customer and public, `risk: read`, `hostInternal` (it reads the index beside the records). It
reads as the public whoever calls, as `content.get` does: an object that is not public content
(not publishable, not public, nothing searchable, not an object) is the one not-found answer of ADR
0442. Every word of `q` is a quoted prefix term (`searchTerms` and `ftsQuery`, shared with
`search.global`), so no FTS syntax gets through. It reads at most 200 matching sections, keeps the
best one of each record, and keeps only records the public's seam returns now (the live view: a
draft, an unpublished, deleted or `when`-failing record is not found, whatever the index holds).
Each hit is the record's id, slug, title (when the public reads it) and its highlighted parts, the
version, the section (field, heading, anchor; null at the top) and a snippet as plain and matching
segments, never HTML. A page is up to 50 hits; `nextCursor` is an offset. Answers are cached by the
object's generation like the other content reads.

**Rate limits and privacy.** A customer's call is limited per account and operation by the
pipeline (ADR 0402); a public call per client address at the edge, as every public read is. No
query text is kept with who asked: the cache key is a hash, and a successful read by anyone but a
person on the staff is counted per hour, not logged with its input (ADR 0090).

## Consequences
- Every publishable object the public reads gains search, posts included, with no pack change.
- A search reads the newest published wording at once; an edit of the working copy is never found
  until a person publishes it (criteria 2 and 9).
- Ranking is FTS5's bm25 over sections, best section per record; no synonyms, no stemming, one
  language.
- 200 sections is the most one search looks at before keeping one per record: a word in very
  many sections of very many pages may push a later page's only match out of the results.
- Passages for the assistant (step 7) are these sections; that step embeds them.

## Proof
- `packages/core/test/published-text.test.ts`: found by a prefix of a body word only once
  published, with the section's heading and anchor and plain segments; a draft's and an edit's
  words never found until published; unpublished and deleted pages not found and their rows gone;
  a field the public does not read never found; a non-content object the one not-found; paging;
  the cron filling the index from nothing and following a narrowed declaration; a publish of 500
  sections a fixed few statements, each under 100 bound values, and its last section found.
- `packs/content/test/renderers.test.tsx`: the same anchors as each heading's `id` on the web and
  `nativeID` in the app, two equal headings told apart.
