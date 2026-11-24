# ADR 0691: Staff discounts: `orders:discount`, the limit, approval above it

Status: accepted, 2026-11-24 (stage 34, build step 1; [the spec](../stages/34-offers.md),
decision 5). Extends [ADR 0449](0449-permissions-granted-one-by-one.md) (permissions granted one
by one) and follows [ADR 0480](0480-an-ai-asks-to-publish-a-person-approves.md) and
[ADR 0552](0552-a-tool-a-person-approves.md) (an AI asks, a person approves). Builds on
[ADR 0690](0690-adjustments-on-orders-net-lines-and-the-pricing-seam.md).

(The spec's numbering table listed this decision as 0693; this build step was given ADRs 0690
and 0691, so it is 0691 and the `discount` behaviour moves to 0693.)

## Context
The owner (decision 5): staff may give a discount at the desk on their own, up to a limit the
owner sets; anything above it waits for the owner's approval. An AI may ask, never decide. The
pipeline already queues a call by actor and risk class (the gate), or always (`alwaysReview`,
ADR 0552's `personApproves`), but nothing queued a person's call because of what it asks for.

## Decision

**`order.adjust` and `order.unadjust`.** Staff only (no customer or public audience), `risk:
write`, `actors: ["human", "assistant", "mcp"]` (no automation or extension gives one). Input:
the order, an optional line, a percentage (up to two decimals, of what is left to pay, rounded down
per line) **or** an amount in minor units, and a reason (required). On a pending order whose
checkout has not opened; refused when it takes nothing off, more than is left, or the whole order
(ADR 0690). `order.unadjust` takes one off again (marked removed, the order repriced).

**A core permission, `orders:discount`.** Admins by default, grantable one by one by a human
admin as `orders:refund` is (ADR 0449): the owner grants it to desk staff. A member or viewer
without it is refused.

**The limit is a human admin's setting.** `order.settings.update { discountLimit: { percent,
amount } }` (`settings:manage`, `actors: ["human"]`, audited), core setting
`order_discount_limit`. A call is within it when every staff adjustment on the order with this one
is at most `amount` and at most `percent` of what the order costs before adjustments. Until a
human admin sets one the limit is nothing, so every staff discount waits: the conventional safe
default.

**Above the limit it waits: an operation's own rule for review.** A new operation option,
`reviewWhen(input, db)`: when the gate would apply a call at once and it is not the approved
application of a pending action, the pipeline asks it, and `true` queues the call as a forced
review (`review_source: always`, so the policy adjudicator never approves it; a `deny` still
applies). `order.adjust`'s says "over the limit". Its `alwaysReview: ["assistant", "mcp"]` makes
an AI's call wait whatever the preset or the amount.

**Only a human admin approves one.** `approval.approve` / `approval.decide` refuse an
`order.adjust` action to any actor but a person, and to a person who is not an admin
(`settings:manage`, the permission that sets the limit): a desk member cannot approve their own
discount. The applied adjustment records who gave it (`given_by`: the account that asked) and the
approval it waited in.

**While one waits, the order cannot be paid.** `openCheckout` refuses a pending order with an
`order.adjust` action waiting (`rule: "discount_waiting"`): its price is not settled until a person
decides. The order keeps its expiry: a discount approved after the order expired fails on the
order's state, and staff start a new order.

## Consequences
- `reviewWhen` is general: any later rule of the form "a person's call of this waits when it asks
  for more than X" uses it instead of a special case in the pipeline.
- The desk's discount is a person's act or an admin's decision, never an AI's and never a pack's.
- A waiting discount holds the order's checkout, not its places; an order left waiting expires as
  any unpaid order does.

## Proof
`packages/core/test/order-adjustments.test.ts` (criterion 8): a desk member granted
`orders:discount` gives 10% with a reason and it applies; 50% waits, the checkout is refused
meanwhile, the desk and a member cannot approve it and an admin can, and the applied adjustment
names the approval; the limit counts every staff discount by amount and percentage; the assistant's
and an MCP client's requests wait under every preset; a member and a viewer without the permission
are refused; only a human admin sets the limit.
