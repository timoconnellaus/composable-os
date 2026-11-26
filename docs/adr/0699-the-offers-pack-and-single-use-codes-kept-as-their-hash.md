# ADR 0699: The Offers pack, and single-use codes kept as their hash

Status: accepted, 2026-11-26 (stage 34, build step 5; [the spec](../stages/34-offers.md)). Builds
on [ADR 0693](0693-the-discount-behaviour-codes-automatic-prices-one-deal-limits-held-by-the-database.md)
(the `discount` behaviour, amended below) and
[ADR 0940](0940-a-rate-limit-per-client-address-for-public-operations.md) (code words folded,
looked up by index, `randomCodes`); follows [ADR 0628](0628-the-staff-calendar-feed-and-the-shared-calendar-writer.md)'s
"a secret shown once" (`redactResult`) and [ADR 0552](0552-a-tool-a-person-approves.md) (a tool a
person approves).

## Context
Step 4 built the host's side of discounts and left the pack to declare them: the discounts and
promo codes staff run, who may make one live, and how a batch of single-use codes is made and
handed out. The spec says an AI never reads "unredeemed voucher codes, gift card codes, single-use
codes or invite tokens". ADR 0940 keeps every code word folded but in clear, so a code record's
word would be in `record.list`, in `rec_x_<ext>_<object>` (which an assistant reads with
`query.sql`), in the audit row of the `record.createMany` that wrote it, and in the audit row of
the order a buyer typed it on.

## Decision

**The Offers pack** (`packs/offers`, `@composable-os/pack-offers`, optional) declares two objects:
- `offers.discount`, on the `discount` behaviour: what is off (`percent`, `amount`, set `price`),
  `automatic` (a member's price, a customer rate) or a shared `code`, `who` (anyone, signed in,
  members, new customers, an organisation, a tag), `appliesTo` (a multi-select of the objects the
  shipped packs sell: drop-ins, ticket types, pass types, courses, bundles, shop variants), `from`
  and `until`, `totalUses`, `perPerson` and `minSpend`. States `draft` → `active` ↔ `paused` →
  `ended`, every move `by: ["host"]` through one of the pack's tools.
- `offers.code`, its `codes`: single-use codes, each with `uses` (1 by default), `active`, its batch
  and who made it. Every field but `active` is read-only (the pack's tools write it).

Members' prices and customer rates are discounts that apply by themselves, not objects of their
own: the spec's model names one `offers.discount`, and the host's rules do not differ between them.

**Who may do what.** `offers:manage` is a pack permission, not restricted (the spec restricts only
`offers:vouchers`): admins and members hold it, a pack role does not. Anyone on the staff, the
assistant included, reads discounts (`discounts`, `codeBatches`) and drafts one (`draftDiscount`):
a draft applies to nobody. Making it live (`activateDiscount`), pausing, ending and changing its
terms (`changeDiscount`), and voiding a batch (`voidBatch`) are `personApproves` with `offers:manage`:
a person calls them, and anyone else's call waits in Approvals for a person (ADR 0552), which is the
tool form ADR 0693 asks for. Making codes (`generateCodes`) is `humanOnly`: see below.

**Single-use codes are kept as their hash.** The behaviour gains `codes.hashed: true`. The SDK's
`codeHash(code)` is `#` and the first 224 bits of the SHA-256 of the folded code in upper-case hex
(57 characters); `isCodeHash` recognises one. On such an object the host refuses any `word` that is
not a hash, whoever writes it (`rule: "code_hashed"`), and `codeMatches` hashes what a buyer types
before its indexed lookup. The reconciler's unique index and the folding are unchanged (a hash
folds to itself). Unsalted, because the lookup knows only the word typed (and the pack hashes in
the sandbox, which holds no secret); safe because the codes
are `randomCodes`' 80 bits. It is never for a word a person chose (six characters can be found from
a hash by trying them all): shared words stay on the discount's own `code`, in clear, as ADR 0940
keeps them.

**Shown once, to the person who makes them.** `generateCodes` (`humanOnly`, `offers:manage`,
`bulk-write`) makes up to 500 codes with `randomCodes`, writes their hashes 50 at a time with
`record.createMany` (all or none each, well inside one host call's batch; a chunk refused because a
code was taken is made again once with new codes), and answers with the codes under
`redactResult: ["codes"]`: never in the audit log, an approval's stored result or a replayed reply.
If the batch stops part way, the answer says so (`complete: false`, `problem`) and holds the codes
made, so none is lost; nothing is rolled back (the rest can be made in another batch). Decided: the
assistant cannot ask for codes (refused, not queued), because an approved call's answer goes to
nobody (`approval.approve` returns no tool output): codes made on an approval could never be
handed out. It drafts the discount and says that a person makes the codes. Its own write of a code
record is refused (read-only fields), and its switching a voided code back on waits for a person
(ADR 0693).

**A code typed is never in the audit log.** `order.start`, `order.startHeld`, `order.quote`,
`order.applyCode` and `discount.check` declare `auditRedact: ["code"]`: the audit row leaves it
out; a waiting call keeps it for its approver. The order's adjustments still name the discount and
the code's record.

**Nothing is opened.** Discounts and codes declare no `public`, `signedIn`, `customer` or
`customerVia`, and every tool is staff-only: a buyer learns of a discount only through the host's
`discount.check`, `order.quote` and the order's deal.

## Consequences
- A staff member typing on a live discount's record page is a person, and the host lets the write
  through (ADR 0693): `offers:manage` decides the pack's tools, not the generic record form. A rule
  "terms change only through named tools while live" would be platform work; not built.
- "Members of chosen plans" (`discount.plans`) is not declared: a relation to `memberships.plan`
  would make Offers require Memberships (a relation is a dependency), which a shop without a gym
  does not install. `members` means any live subscription. Named records (`discount.records`) are
  left out for the same reason. Either needs a reference to another pack's records that does not
  make the pack depend on it.
- `cos ext check` installs the packs a manifest names before checking it; one that requires an
  extension still being installed (Memberships, requiring Bookings, reached from Offers through
  Bookings) is now left out until that one is in place, as the checked extension's own dependants
  already were (`packages/extension-check/src/node/check.ts`).
- Steps 6 to 10 add subscriptions' periods, vouchers, gift cards, referrals, the blocks' code
  fields and the screens to this pack. A block or tool that passes a buyer's code on should keep it
  out of its own audit row (`redact`), as the host's operations now do.

## Proof
`packs/offers/test/offers.test.ts` (the manifest, every tool, the hashes, the chunks, a partial
batch); `packages/core/test/discounts.test.ts`, "codes kept as their hash" (a clear code refused, a
typed code found by its hash, the hash typed not a code; it fails with the host's refusal taken
out); `apps/runner/test/offers.test.ts` (the pack in the real host with Ticketing, Bookings and
Memberships: a 20% code paid on the fake provider; a member's drop-in price; a batch whose codes
each work once and are in no record, audit row or audit change; a per-person code over `+tag`
addresses; the one answer for an expired, an ended and an unknown code; the assistant's draft,
make live and code writes; a drop-in discount refused on a ticket). The batch test fails when the
host's hashed lookup is taken out, and the assistant's test fails when the host's rule that a code
write by a non-person waits is taken out.

## Amended 2026-11-26, after the review of PR #479
- **A person approves the terms they were shown** (review item 1). When a call waits for a person
  and its input names a discount (the assistant asking to make one live, to change it, to void a
  batch), the queue keeps that discount's terms as they are then, every field the behaviour names
  (`discounts/terms.ts`, in `simulated.discounts`), and says them in words in the approval's notes
  ("It names the discount "Ten off" as it is now: What is off: percent; Percentage off: 10; …").
  Approving it is refused with a `conflict` (`rule: "discount_changed"`) naming each field that
  changed since, before anything applies (`approval.approve`). Chosen over making a non-person's
  edits wait while an activation is pending: it is one host rule for every waiting call that names
  a discount, whatever tool or path; it also catches a change a person made after the ask (the
  approver may not be that person); and it needs no search of pending actions on every write.
  Drafts stay anyone's to edit, which is what drafting is.
- **A discount past its draft is changed only by a person** (review item 2, amending ADR 0693):
  the host's rule now covers every state but the object's initial one, live, paused and ended
  alike, as a rule of the behaviour rather than of a pack's `live` list: a paused discount's terms
  are terms a person approved, which a person's resume makes live again.
- **A person's own tool is not queued twice** (review item 3). A write by a `humanOnly` or
  `personApproves` tool (with a permission) of its own extension's records, in a run a person
  called, or one a person (never the adjudicator) approved, is not queued by the approval policy:
  under `cautious` a person's `generateCodes` stopped at 0 codes and left a pending write of codes
  nobody could hold. The deploy floor and a deny still apply; a tool the assistant calls still
  waits at the tool itself, so its writes run only once a person approved it
  (`pipeline.ts`, `personsOwnRun`).
- **Codes typed to void are a person's at the screen** (item 4): `voidCodes` (typed codes) is
  `humanOnly`, so they never sit in clear in a pending action's input; `voidBatch` (by the batch's
  name) is `personApproves`, which the assistant may ask for.
- **No code left unheld** (items 5 and 6): `generateCodes` refuses an ended discount, and when a
  chunk's write fails it looks up which of that chunk's codes the database kept (a write that
  committed and lost its answer) and gives those to the person with the rest.
- **The check says what it left out** (item 7): `cos ext check` prints "checked without ../<pack>
  installed" with why, and refuses a discount's `objects` option naming an object that a pack
  beside it, installed for the check, does not declare.
- **The cost of the unsalted hash** (decided, no change): reversing one stored hash of an 80-bit
  code takes about 2^80 SHA-256 tries; against N stored hashes, about 2^80/N (2^60 for a million
  codes: years of a large GPU fleet), far above what any discount is worth. A per-deployment
  pepper would need the host to hash on write, since the pack hashes in the sandbox; not built.

## Amended 2026-11-26, after the second review of PR #479
- **A run standing as an AI's is not a person's act** (S1). The policy skip above holds only for a
  run whose writes stand as a person's: never one the runner marks `ai` (`markStanding`, ADR 0590:
  it used a model, read outside text through a gatekeeper, or is a runtime extension's run, whose
  code an AI may have written), whoever called the tool. Proved in
  `packages/core/test/discounts.test.ts` with the standing set on the call; a real tool run that
  uses a model or reads outside text is not built into a test.
- **Each action is checked just before it applies** (S2). The terms check runs before the claim
  and again inside the apply loop, so of the assistant's queued change to 90% and its queued
  "make live" (whose words say 10%) approved together, the change applies and the make live is
  refused (`discount_changed`). Its words also name any other request waiting on the same
  discount, saying that one approved with it applies first and this one is then refused.
- **Only what depends on the terms is bound to them** (M2): a record write of the discount, or a
  tool its object names in a move into a live state. Pausing, ending and voiding codes are always
  approvable, whatever changed meanwhile.
- **No way round the draft** (M6): the `discount` contract refuses `states.create.in` for any state
  but the initial one (and the live ones, already the host's) by anyone but the host, and any move
  back to the initial state by anyone but the host.
- **Words, not stored values** (M3): choices by their labels, yes or no, money with the order
  currency.
- Left as notes, not built:
  - **M1, a narrow race**: between the check and the activating tool's own write, a non-person's
    edit of the draft can still land. Closing it means the move into a live state re-checking the
    approved terms under `ctx.approval`.
  - **M4, a deploy floor**: under a floor that reviews the extension's bulk writes,
    `generateCodes`' chunk write is still queued and the tool stops at 0 codes, leaving a pending
    write of hashes nobody holds. The tool could refuse up front under such a floor.
  - **M5, the `objects` check**: a typo in the pack's own name (`membership.passtype`) is not
    caught, only an unknown object of a pack beside it that was installed for the check.
