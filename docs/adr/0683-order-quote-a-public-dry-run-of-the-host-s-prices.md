# ADR 0683: `order.quote`: a public dry run of the host's prices

Status: accepted, 2026-11-25 (stage 37, build step 3). Builds on
[ADR 0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) (orders are
priced by the host), [ADR 0690](0690-adjustments-on-orders-net-lines-and-the-pricing-seam.md) (the
pricing seam) and [ADR 0682](0682-goods-on-an-order-where-sold-the-channel-and-the-delivery.md).
Opens `order.quote` to customers and the public (ADR 0402: a reviewed change, in
`packages/core/open-operations.json`).

## Context
Each device keeps its own basket (decision 12). Its totals cannot be worked out by a block
(`scripts/check-blocks.mjs`): prices, postage and free postage are the host's. Starting an order
to learn its total would hold stock for every browser and leave orders to expire. A visitor must
be able to see the total before signing in or giving an address.

## Decision
- **`order.quote`** (audiences staff, customer, public; risk `read`; `records:read`;
  `hostInternal`, as `order.start`, because it reads the records as the host) takes the basket's
  lines and, optionally, the delivery chosen (`{ object, id, address? }`, the same shape as
  `order.start`'s). It prices them with the same function `order.start` uses (`priceOrder`:
  `priceLines`, the delivery, the goods rules, `applyAdjustments` with none), so a quote and the
  order it becomes agree.
- **It holds nothing and writes nothing.** No claim, no order, no row (the pipeline's own read
  counter aside). Stock is held only once an order starts (ADR 0680), and the database still
  refuses the last unit to the second buyer.
- **It refuses what `order.start` refuses** (not for sale, no price, outside the sale window, not
  sold in the channel, an address outside the option's countries), with the same rule, and
  **reports what the buyer still has to do or cannot have** in `problems`: `delivery_needed`,
  `address_needed`, `sold_out`, `not_enough`. `ready` is true when there are none.
- **Availability** is given per stock line as `stock.get` gives it: the numbers for staff, what
  the object's `show` allows for everyone else; one read of the counters for every line.
- **What it returns**: the channel, each line's unit price and total (whether it is goods), the
  delivery (its kind, own price, free over, whether it is free, what it costs on this order), the
  goods' total and the order's total, all in the currency's minor unit.
- **Cost.** One read of the counters for all lines; the rest is `priceLines`'s per-line reads (the
  record, whether the buyer may read it, and where its item is sold), at most three per line,
  under 250 statements at 50 lines (`packages/core/test/goods.test.ts`).

## Consequences
- A basket block shows the host's numbers and calculates nothing; it asks again when the basket
  or the delivery changes.
- An outsider can learn a public record's price and a stock line's availability as `show` allows,
  which `stock.get` and the records' public reads already tell them. Nothing else is opened.
- The quote's statements grow with the lines (bounded by `priceLines`), not constant; making
  `priceLines` read all lines at once is open work for the pricing seam, not this step.
- **A quantity that is too many is told only to a caller who is shown the count** (review of
  PR #450). Where `show` gives an outsider no number, the quote reports `sold_out` and never
  `not_enough`: otherwise asking with different quantities would find the count, for free and
  without signing in. `order.start` still refuses such an order at the database; each try there
  makes a pending order and a hold, so it is a costly way to learn the same thing.
- **`ready` is not a promise that `order.start` will accept.** The quote checks prices, the
  channel, the delivery and stock. It does not check agreements due, one per Person, or a sold
  out capacity that is not stock; `order.start` does.
