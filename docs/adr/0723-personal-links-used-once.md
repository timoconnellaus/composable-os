# ADR 0723: Personal links, used once

Status: accepted, 2026-11-25 (stage 29, build step 5: `feat/stage-29-personal-links`, block BG:
migration 1010). Builds on ADRs [0720](0720-the-intake-door-one-public-write.md) (the intake door),
[0721](0721-the-submitters-person-and-certainty.md) (the submitter's Person and certainty),
[0590](0590-routine-mail.md) (routine mail), [0675](0675-consent-to-be-contacted.md) (the stop
link, whose token this follows) and [0711](0711-needs-your-attention.md) (Needs your
attention). The personal links stage 54 (Reviews) asks for. Amended by
[0724](0724-the-receipt-and-the-form-link-slot.md) for how routine mail carries one.

## Context

Decision 4 of stage 29: after a class, a member is asked for feedback by email and in the app. A
member is not signed in when they open an email, so the form must be answerable without an
account, as that member, and only once. Stage 54 asks the same for a review: one Person, one use,
expiring, a used, expired, wrong or erased-person link one identical answer, and the page shown by
an open link naming neither the Person nor their address.

## Decision

**A personal link is a host record, not a signed token.** `core_intake_link` (migration 1010) holds
one link: its Person, what is answered (a form object and its record; for a declared intake, stage
54, the object alone), the record it is about (a booking), what made it, when it expires, and when
and by which submission it was used. `core_intake_link_token` holds the SHA-256 of each email's
token for it. A token is 32 random bytes (`crypto.getRandomValues`), base64url, sent once in the
one email it was made for and kept nowhere else. There is no signing key: nothing secret is in the
database or in settings (AGENTS.md: auth secrets are env-only), and the runner, which writes the
email, and the door, which takes the answers, share nothing. This is the stop link's pattern (ADR
0675, after the review of PR #451); the spec's "a token, kept as a hash" is exactly it.

**One link, a token per email.** A child's feedback goes to each live guardian; each email carries
its own token for the same link, and the member's app item is the same link by its id. Answering
by any of them uses the link up.

**Made by the host alone.** The only maker is routine mail's form-link slot (ADR 0724), while it
prepares an email: no operation makes a link or returns a token, so the assistant, MCP, a tool and
a person's call have nothing to call. The spec's `intake.link` operation (the token given once to
a staff tool) is not built: see "Not built".

**Used once, by the database.** The answers' own batch sets `used_at` and `submission_id` by the
link's id alone; migration 1010's `BEFORE UPDATE` trigger fails the batch when the link is already
used, or when it has expired by the moment of use (`core_intake_link_used`). D1 runs one batch at
a time, so of two answers racing for one link exactly one commits and the other keeps nothing; the
loser is told the same words as for any link that cannot be used. The trigger also keeps what a
link names fixed (form, record, maker, made), lets its expiry only come sooner (a revoke is an
expiry), and lets its Person change only to the Person it was merged into. A link is never
replaced (a `BEFORE INSERT` trigger, as migration 0812's offers).

**One answer for every refusal.** An unknown token, a malformed one, a used, expired or revoked
link, a link whose Person was erased, merged away or put in the Trash, a link for another form,
and a form that no longer takes answers by link all answer `not_found` with "This link cannot be
used: it may have been used already or have expired" (`linkRefused`), the same work done whatever
the token looks like. The error names nothing about the link or the Person.

**Opening uses nothing.** `intake.open { link }` (and `x.forms.form { link }`) reads the link and
returns the form it is for, as `intake.open` returns any form: its version and published content,
nothing of the Person. A mail scanner that follows every link spends none; only an answer's batch
uses it.

**Answering.** `intake.submit { link }` (from `x.forms.submit`) takes the token from anyone holding
it: the answers are the link's Person's, certainty `link`, via `link`, to the link's own form and
nowhere else. The bearer names no Person and cannot choose one: an address typed in the answers
only fills the link's Person's empty fields (ADR 0721), never matches or makes a Person. A link
skips Turnstile and the fill time (the host sent it to one Person) but keeps the honeypot and the
caps; the per-mailbox spam count does not apply (a link is answered once). The form must be
published, open and within its dates; a link opens a form whoever it is open to (`public`,
`customers` or `links`), never a `staff` form or an anonymous one. The submission records what the
link was about in the submission object's `about` and `aboutObject` (host-only text fields of the
`intake` declaration): a relation is not possible, as the record may be any installed pack's.

**Signed in, by its id.** "Needs your attention" lists a live link as `form_to_fill` (ADR 0711's
later kind) with the link's id; `x.forms.form { linkId }` and `x.forms.submit { linkId }` take it
from a signed-in customer only, and only when the link's Person is the caller or a live dependant
of theirs. Anyone else, the public included, gets the one refusal.

**Never logged.** `link` is redacted by name in the audit input of `intake.open`, `intake.submit`
and both Forms tools; errors name no token; the token is stored only in the routine email row's
words until they are decided (as a stop link's, ADR 0590: cleared once sent).

**Erase and merge.** A link and its tokens are deleted with their Person (`ON DELETE CASCADE`, so
`person.erase` needs no change); `person.merge` moves the duplicate's links to the survivor in its
batch (`UPDATE OR IGNORE`, after `merged_into_id` is set; a link both had about one record stays
with the duplicate, which is no longer live).

## Not built

- **`intake.link` and `x.forms.ask`** (staff send a form by personal link to chosen people). The
  spec has the tool send "one email each, through approval as usual": that puts the token in the
  approval card and the outbound action's stored input, where staff read it, and a token in a staff
  tool's output would have to be redacted from every log. Both wait for a host-side ask (a host
  kind of routine mail about a Person, or a Forms object an ask is about) that carries the link
  the way feedback does; until then `forms:manage` is not added either.
- **Retention of used and expired links**: step 7 (with erase completeness). A used link is kept
  with its Person until then; it can do nothing.

## Consequences

- Feedback after a class reaches a member with no account, and the same link is answerable in the
  app; answering either way spends it.
- Reviews (stage 54) uses the same table and door: a declared intake's link has `form_id` null and
  its own object, and its form-link slot names the object; `linkOfCall` refuses a link with no
  form record until stage 54 builds that role.
- Not yet tried on a live host.

## Proof

| Check | Test |
| --- | --- |
| Two answers at once by one link keep one (the trigger) | `apps/runner/test/forms-links.test.ts` ("the link is used once"); `packages/core/test/intake-links.test.ts` |
| A link answers only its own form, as its own Person; its id only for its member | `apps/runner/test/forms-links.test.ts` ("a link answers only its own form") |
| Used, unknown and opened-after-use are one answer; no token in the audit log | `apps/runner/test/forms-links.test.ts` ("asks once, by a link…") |
| Opening uses nothing and names nobody | the same |
| What a link names never changes; expiry only sooner; Person only to the merged-into | `packages/core/test/intake-links.test.ts` |
| Erase deletes links and tokens; merge moves a live one | `apps/runner/test/forms-links.test.ts` ("erase and merge"); `packages/core/test/intake-links.test.ts` |
