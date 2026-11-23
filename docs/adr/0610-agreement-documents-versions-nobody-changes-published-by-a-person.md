# ADR 0610: Agreement documents: a working copy, versions nobody changes, published by a person

Status: accepted, 2026-11-23 (stage 44, build step 1). Stricter than
[ADR 0480](0480-an-ai-asks-to-publish-a-person-approves.md) (an AI asks to publish a record, a
person approves) and separate from [ADR 0446](0446-publishable-without-its-public-half.md)'s
version store. Uses [ADR 0440](0440-rich-text-is-data.md) (rich text) and
[ADR 0449](0449-permissions-granted-one-by-one.md) (permissions granted one by one). Stage 44's
spec, decisions 1, 7 and 12.

## Context
A business asks its members to agree to its terms, a waiver, health questions and a parent's
consent. What a person agreed to is evidence: for a bank dispute, an insurer, a claim years later.
So the words they were shown must be kept exactly and for good, and nobody (not staff, not the
assistant, not host code by mistake) may change them afterwards. Decision 12: only a person with a
specific permission writes and publishes documents; the assistant may draft, never publish.
Publishable records (ADR 0446) were weighed and rejected (the spec's table): there an AI may ask to
publish, a version can be unpublished and restored, and the permission is `records:publish`.

## Decision
- **Core tables, not records** (migration 0790): `core_agreement_document` (the kind, fixed when it
  is made; the state, `draft`, `live` or `retired`, retired being final; the working copy with its
  `draft_rev`; the current version; `agree_from`), `core_agreement_version`,
  `core_agreement_point` (ADR 0611) and `core_agreement_rev`. No `rec_*` view reads them, so
  `query.sql` (which refuses every `core_` name), dashboards, exports, search, embeddings and the
  assistant's bulk reads never see them. Staff read them through `agreement.*` read operations
  (`records:read`); the text is the business's, not personal data.
- **The working copy** holds everything a version will: title, body, tick label, how a person
  agrees (typed or drawn), who agrees (participant or payer), for whom (everyone or dependants), and
  for a `health` document its questions (up to 40, each a key, the text, whether a "yes" asks for a
  note) and months before it is asked again. So none of these change what anyone is asked until a
  person publishes. `agreement.create` and `agreement.draft.save` are ordinary writes with
  `agreements:manage`: the assistant may write them for a person who holds it, through the gate,
  and under a cautious policy they wait for approval like any write (their dry run writes nothing).
  A save is compare-and-set on `draft_rev`: the database lets the rev move by exactly one, so of two
  saves made from the same rev only the first applies; a save that names `draftRev` (the editor's)
  is refused when someone else saved since. Each save records its actor (`draft_updated_via`), so
  the editor can say "changed by the assistant".
- **What a body may hold.** Rich text (ADR 0440) without what the hash or the signed copy cannot
  pin: no `embed` or `button` (the copy cannot show them) and no `image` (a picture can be deleted
  from the media library later, and the hash covers only its id). A link is allowed only when its
  text is its own address, so every rendering shows where it goes; the editor says a linked page
  is not part of what a person agrees to. Titles, tick labels, questions and body text refuse
  bidirectional override and isolate characters (U+202A to U+202E, U+2066 to U+2069), C0 and C1
  control characters, and tag characters (U+E0000 to U+E007F) outside a subdivision-flag emoji. A
  text made only of characters nobody sees (zero-width spaces and joiners, direction marks, soft
  hyphen, U+034F, U+180E, the Hangul fillers U+3164, U+115F, U+1160 and U+FFA0, the blank Braille
  pattern U+2800, variation selectors) is not text; those characters are allowed inside text,
  which several languages and emoji need.
- **Publishing spends the reviewed rev.** A publish names the version number its preview showed and
  is refused on a mismatch (another publish landed between the preview and the click); it moves
  `draft_rev` in its own batch, so the same hash and rev never publish twice; and a publish with
  nothing changed since the newest version is refused (`agreement_unchanged`), so "agree again"
  can never ask everyone to re-agree to unchanged text.
- **Extension ids.** An extension cannot take the namespace of a core permission as its id
  (`agreements`, `orders`, `people`, …, derived from the permission list), or it could declare a
  core permission as its own grantable one.
- **A version nobody changes.** `agreement.publish` snapshots the working copy into
  `core_agreement_version` with the next number, the change (`first`, `small`, `agree_again`), the
  effective moment, who published it and when, the `draft_rev` it came from, and the **hash**:
  SHA-256 of the canonical JSON (keys sorted) of **everything the version holds**: the kind, title,
  body, tick label, questions, how, who, for whom and ask-again months.
- **What the database refuses, for every writer** (an operation, host code, a raw statement), as
  long as the triggers exist:
  - any update or delete of a version, and any delete of a document;
  - an insert whose id already exists, on the version and the document. D1 runs with recursive
    triggers off, so the rows an `INSERT OR REPLACE` deletes fire no delete trigger; refusing the
    insert is what stops a REPLACE;
  - any change of a document's id (so an `UPDATE OR REPLACE` cannot rewrite another document), and
    any update of an attachment row (it is added or removed, never moved);
  - any change to a working-copy column unless `draft_rev` moves by exactly one in the same
    statement, so every change, raw ones included, shows as a new rev in the editor;
  - any insert into `core_agreement_rev` beyond its one row, so a REPLACE cannot reset it;
  - a version insert unless the working copy is still at its `draft_rev`, the number is the next,
    and every content column equals the working copy's at commit;
  - a new document that is not a blank draft;
  - a change of kind, a document going from live back to draft, any change to a retired one;
  - the current version set to none, to an older version or to another document's; `agree_from`
    or the counter going back.
- **What a raw writer can still do** (host code by mistake, an operator with the database): write
  the working copy with the rev moved, recording any actor it likes; make a newer published version
  current before its effective moment, or move `agree_from` forward; retire a document; attach a
  live document or detach one; bump the counter; and give a version whose content matches the
  working copy a made-up hash (below). Anyone who can change the schema can drop the triggers. The
  guarantee is against changing or removing what was published, not against every write.
- **The hash is the host's.** SQLite has no SHA-256, so the trigger compares the content and the
  host computes the hash. A writer with raw access could still insert a version whose content
  matches the working copy but whose hash is made up; every read that matters recomputes the hash
  from the stored content (`intact` on `agreement.version.get`, `agreement.get` and the preview),
  the editor marks a version that does not match, and step 2's acceptance must refuse one.
- **A person publishes what they read.** `agreement.publish`, `agreement.attach`,
  `agreement.detach` and `agreement.retire` are `actors: ["human"]` with `agreements:manage`:
  the pipeline refuses the assistant, MCP clients (Code Mode calls as `mcp`), automations and
  extension code before the gate is asked, so nothing is ever queued; there is no approval card for
  a legal text. `agreement.publishPreview` returns the exact snapshot (every field), its hash and
  its `draftRev`; the editor's confirm step shows that snapshot and publishes that hash and rev,
  and any change since, in any field, is refused (the handler compares both; between the read and
  the commit, the version trigger). Publish is refused in the editor while it holds unsaved edits,
  and a copy someone else saved is never swapped in silently.
- **Retiring and attaching.** Retiring a document whose newest version is still scheduled cancels
  it: the cron reads live documents only, the summary no longer shows it as scheduled, and the
  version reads as "never in force". A document is attached only once a version is in force: one
  whose only version is still scheduled is refused (`agreement_not_in_force`).
- **Effective dates.** Left out, now. Never in the past, never before the newest version's. A
  future one schedules the version; the minute cron (`agreement.takeEffect`, the platform's own
  system step, refused from any other origin) makes it current when its time comes. The newest
  version in effect is current; `agree_from` is the newest `first` or `agree_again` in effect, and
  the database refuses to lower it. A published version is never withdrawn: a newer one taking
  effect at the same moment replaces its wording.
- **The counter.** `core_agreement_rev` (one row) is bumped in the batch of every publish, every
  version the cron makes current, and every attach, detach and retire. Step 2's guard
  (`core_write_guard` kind `agreements`) will compare it at commit. It bumps a little more often
  than strictly needed (a small change asks nobody), so it also covers a version that becomes
  acceptable early; documents change rarely and a retry is cheap. The database refuses to lower or
  delete it.
- **The permission** `agreements:manage`: admins by default, grantable one by one (ADR 0449). The
  MCP `admin` scope carries it, which lets an admin's client draft; it can never publish.
- **Audit.** Every operation is audited by the pipeline; a publish's summary names the document,
  the version, its number and change.

## Consequences
- What a person accepts in step 2 points at a row the database guarantees will not change and
  whose content matched the working copy when it was made; the hash, recomputed on read, shows the
  content is still what was hashed. The version id and its hash are enough to show, print and prove
  the words and the terms.
- A mistaken publish cannot be undone, only superseded; the editor shows the exact snapshot before
  it publishes.
- The runner's bundle grew from 7,101 to 7,139 KiB at first, of 7,168; the review's fixes are
  measured in the PR.

## Proof
`packages/core/test/agreements.test.ts`: raw SQL updates and deletes of a version refused, and a
batch the host writes; `INSERT OR REPLACE` refused on a version, a document (a retired one
revived) and the counter; a forged next version, a rewound current version, a state back to
draft and a kind change refused; a blank-draft rule on a new document; a version with a forged
hash read as not intact; out-of-order and stale inserts refused; `agree_from` and the counter
never go back; every AI actor refused publish, attach, detach and retire with every grant, nothing
queued, the counter unmoved; a member without the permission refused, granted one publishes; the
assistant drafts, and under a cautious policy its dry run changes nothing until approved; an AI
change to who, for whom, how or ask-again after the preview refused, and on a second version a
flipped term listed and refused; two saves of one rev never both applied; pictures, link text
that is not its address, bidi controls and zero-width-only text refused; retiring cancels a
scheduled version, which never takes effect; a document not yet in force is not attached;
scheduling and the cron; the counter's bumps; audit; `query.sql` refused on every table and no
view names one. The e2e journeys `apps/app/e2e/agreements.spec.ts`, one of them an MCP client
changing the copy while the person reads the confirm.

## Amended 2026-11-23, after the security review of PR #266
The first version of this ADR hashed only the words (title, body, tick label, questions) and said
the database refused every writer. Both were wrong: an AI could change who agrees, for whom, how or
the ask-again months after a person's preview and the publish carried it, and `INSERT OR REPLACE`
got past the delete triggers. The decision above is the corrected one: the hash covers the
whole version, the publish names the preview's rev as well, saves are compare-and-set, the content
is compared in the insert trigger, an existing id is refused on insert, and the confirm step
shows the exact snapshot. Pictures were refused and links pinned to their address at the same time
(the coordinator's decision).
