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
terms (`changeDiscount`), and voiding codes (`voidCodes`) are `personApproves` with `offers:manage`:
a person calls them, and anyone else's call waits in Approvals for a person (ADR 0552), which is the
tool form ADR 0693 asks for. Making codes (`generateCodes`) is `humanOnly`: see below.

**Single-use codes are kept as their hash.** The behaviour gains `codes.hashed: true`. The SDK's
`codeHash(code)` is `#` and the first 224 bits of the SHA-256 of the folded code in upper-case hex
(57 characters); `isCodeHash` recognises one. On such an object the host refuses any `word` that is
not a hash, whoever writes it (`rule: "code_hashed"`), and `codeMatches` hashes what a buyer types
before its indexed lookup. The reconciler's unique index and the folding are unchanged (a hash
folds to itself). Unsalted, because the lookup knows only the word typed; safe because the codes
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
