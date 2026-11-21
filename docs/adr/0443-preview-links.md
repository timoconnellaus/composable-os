# ADR 0443: Preview links

Status: accepted, 2026-11-22 (stage 28, build step 3). Builds on ADR
[0442](0442-what-the-public-reads-of-content.md).

## Context
Staff want to see a post as the site will show it before publishing it, and to send that to
someone without an account (the person it is about, a sponsor). The spec says the link is signed,
names one record and expires.

## Decision

**`content.previewLink { object, id, hours? }`** (staff, `records:write`, risk `write`) makes a
token for one record of a content object (a publishable object the public reads): `pv_` and 43
characters of base64url from 32 random bytes. It works for `hours` (default 24, at most 168).
Only the token's SHA-256 is kept, in `core_preview_link` (migration 0460) with the object, the
record, when it ends and who made it; links that have ended are deleted as new ones are made.
The audit row keeps the object, the record and the end, never the token
(`auditSummary`). The admin's publish controls (step 5) put the token in the site's own address
for the post.

**`content.preview { object, slug, token }`** (audiences `staff`, `customer`, `public`, risk
`read`, `hostInternal` as ADR 0442's reads) answers `{ kind: "preview", object, id, values }`: the
fields the object's `public.read` lists, from the record's working copy, whatever its state,
through the seam (`previewSource` and `previewVisible`: the public's columns of the one record the
link names). A malformed token, a token that is not one, one for another object, one that has
ended, and a slug that is not the named record's are all ADR 0442's one not-found. The token is
never written anywhere it can be read back.

**A stored token, not a signature.** The spec says "signed". A random token whose hash the host
keeps is as unguessable as a signed one, needs no signing secret in the environment, and can be
ended early by deleting its row. It costs one indexed read per preview.

## Proof
`packages/core/test/content.test.ts` (criterion 10): a member's link shows the post's working copy
with its declared fields and not its staff note; asked for another post's slug, with a made-up
token, an hour later, and with another post's link, it is not found exactly as a draft is. The
token is not in `core_preview_link` and not in the audit log. The isolation suite calls
`content.preview` as a customer and as the public with made-up and malformed tokens and the
hidden posts' slugs: nothing of theirs comes back.

Each check removed, the test fails (restored after): the expiry not checked, 1 test fails; the
named record not checked against the slug, 1; the full definition returned instead of the public
one, 1. Selecting every column in the preview source alone fails no test, for ADR 0442's reason.

## Consequences
- A preview shows what the public would read, so a field staff keep to themselves is never in a
  preview. To show more, the object declares more as public.
- There is no list or revoke of links yet; they end on their own within a week. The editor (step
  5) can add both over the same table.
