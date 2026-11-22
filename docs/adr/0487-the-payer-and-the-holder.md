# ADR 0487: A subscription's payer and its holder are two People

Status: accepted, 2026-11-22 (stage 32a, build step 2). The interview answered question 13 (32b)
"a payer and a holder (a parent pays for a child), each holder with their own allowance", with no
shared family pool. Builds on [ADR 0485](0485-recurring-billing-the-provider-runs-the-schedule.md).

## Context
32a sells a course subscription a Person pays for and uses. 32b will let one Person pay for
another's membership. If 32a's record knew only one Person, 32b would split it with a migration
that guesses, row by row, which role the stored Person had.

## Decision
- `core_subscription` and `core_subscription_checkout` have two columns from the start:
  `payer_person_id` (who pays; the provider's customer is theirs) and `holder_person_id` (who what
  the subscription grants is for). In 32a `subscription.start` sets both to the same Person; there
  is no way to name another holder yet.
- **Billing follows the payer:** the subscription's customer declaration names the payer, so a
  customer reads, cancels and resumes the subscriptions they pay for; the portal opens the payer's
  provider customer; the period's order is the payer's.
- **What it grants follows the holder:** step 3's `subscription` access kind reads the holder, and
  its one-trial rule counts trials by holder per plan object. 32b's memberships are the holder's,
  each with its own allowance.
- The registry shows both (`payerPersonId`, `holderPersonId`); a customer sees the holder of a
  subscription they pay for.

## A payer's provider customer (amended after review, 2026-11-22)
- **Reused only for a caller who proved who they are.** A signed-in customer starting their own
  subscription, or staff starting one for a Person, reuses the provider customer of that Person's
  most recently started subscription (one card, one portal). A guest who only typed an address
  never does: they always get a new provider customer from the address, so a guest's card and
  invoices are never attached to someone else's billing, and a saved card of theirs is never
  offered to the guest.
- **One Person can so have two provider customers** (each subscription a guest starts makes its
  own). The portal opens the customer of the payer's most recently started subscription that has
  one; an older one's invoices are in its own portal, which staff reach in the provider's dashboard.
  A later start while signed in reuses that newest one too. Merging customers at the provider is not
  the host's to do.

## Consequences
- 32b adds a way to name a holder (and the holder's read of what they hold) without changing this
  table.
- Until then the two columns are always equal; nothing reads one where the other is meant.
