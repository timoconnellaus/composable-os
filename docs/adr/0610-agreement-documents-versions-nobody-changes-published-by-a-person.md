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
- **The working copy** holds everything a version will: title, body (rich text, without the
  `embed` and `button` blocks a signed copy cannot hold), tick label, how a person agrees (typed or
  drawn), who agrees (participant or payer), for whom (everyone or dependants), and for a `health`
  document its questions (up to 40, each a key, the text, whether a "yes" asks for a note) and
  months before it is asked again. So none of these change what anyone is asked until a person
  publishes. `agreement.create` and `agreement.draft.save` are ordinary writes with
  `agreements:manage`: the assistant may write them for a person who holds it, through the gate,
  and under a cautious policy they wait for approval like any write (their dry run writes nothing).
- **A version nobody changes.** `agreement.publish` snapshots the working copy into
  `core_agreement_version` with the next number, the change (`first`, `small`, `agree_again`), the
  effective moment, who published it and when, the `draft_rev` it came from, and the SHA-256 hash
  of the canonical JSON (keys sorted) of what a person is shown (title, body, tick label,
  questions). Triggers refuse **every** update and delete of a version, and every delete of a
  document, for every writer: an operation, host code, a raw statement. A version insert is refused
  unless the working copy is still at its `draft_rev` and the number is the next.
- **A person publishes what they read.** `agreement.publish`, `agreement.attach`,
  `agreement.detach` and `agreement.retire` are `actors: ["human"]` with `agreements:manage`:
  the pipeline refuses the assistant, MCP clients (Code Mode calls as `mcp`), automations and
  extension code before the gate is asked, so nothing is ever queued; there is no approval card for
  a legal text. The publish names the working copy's hash the person reviewed
  (`agreement.publishPreview`); a copy changed since (the assistant drafting meanwhile) is refused,
  in the handler and, for a change between the read and the commit, by the version trigger.
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
- What a person accepts in step 2 points at a row the database guarantees: the version id and its
  hash are enough to show, print and prove the words.
- A mistaken publish cannot be undone, only superseded; the editor asks before it publishes and
  shows the change against the newest version.
- The runner's bundle grew by 38 KiB (7,101 to 7,139 KiB of 7,168): the operations are in the
  registry the runner carries.

## Proof
`packages/core/test/agreements.test.ts`: raw SQL updates and deletes of a version refused, and a
batch the host writes; out-of-order and stale inserts refused; `agree_from` and the counter never
go back; every AI actor refused publish, attach, detach and retire with every grant, nothing
queued, the counter unmoved; a member without the permission refused, granted one publishes; the
assistant drafts, and under a cautious policy its dry run changes nothing until approved; a copy
changed since review refused; scheduling and the cron; the counter's bumps; audit; `query.sql`
refused on every table and no view names one. The e2e journey
`apps/app/e2e/agreements.spec.ts`.
