# ADR 0685: Postage priced by the host: fixed, and free over an amount

Status: accepted, 2026-11-25 (stage 37, build step 3: the fixed price and free over an amount;
by weight and a carrier's rate are later steps of stage 37). Builds on
[ADR 0682](0682-goods-on-an-order-where-sold-the-channel-and-the-delivery.md) (the delivery
option) and [ADR 0690](0690-adjustments-on-orders-net-lines-and-the-pricing-seam.md) (the pricing
seam).

## Context
The owner wants a fixed price for each way of sending first, and free postage over an amount
(decision 5). A block must not calculate prices; a caller must never send one.

## Decision
- **The delivery line is priced in the pricing seam** (`priceOrder`, `orders/goods.ts`), never by
  a caller: its unit price is the option's own price field (`sellable.price`), which may be 0. An
  option with no price cannot be chosen (`no_price`), so the Shop's seeded post option is unsold
  until a price is set.
- **Free over an amount**: when the option declares `delivery.freeOver` and the record has a value,
  the delivery costs nothing when the goods on the order (the goods lines' totals, before the
  delivery and before adjustments) are at least that amount. Lines that are not goods (a pass) do
  not count towards it.
- `order.start` and `order.quote` price through the same function, so the postage a quote shows is
  the postage the order charges.
- Promo codes and discounts stay stage 34's: whether free over counts the goods before or after a
  discount is its decision. Adjustments today are staff discounts after the order starts; they
  are spread over the delivery line like any other.
- Later: by weight (weight bands per option, the order's total weight, an unweighed line refused
  on a banded option), and a carrier's live rate through a shipping gatekeeper, fixed on the order
  at `order.start`.

## Consequences
- The delivery line is an ordinary order line: refunds, tax shares and the finance reports treat
  it as one. Whether postage is taxed is the option's tax code, for the business to confirm.
- **Free postage is decided on the goods' prices before a staff discount.** A discount staff
  give afterwards can take the goods below "free over" and the postage stays free. Only staff
  can do it.

## Amended 2026-11-25: free over counts the goods' net after the deal (stage 34 step 4, [ADR 0693](0693-the-discount-behaviour-codes-automatic-prices-one-deal-limits-held-by-the-database.md))
The order's one deal (a promo code or a member's price) is worked out before the goods rules, and
"free over" is measured on the goods' net after it (the stage 34 spec's rule 8): goods of 110.00
with 20% off are 88.00, under a 100.00 free over, so postage is charged. Free postage still
applies beside a deal (stage 34, decision 12): it is the option's rule, not a second deal. A code
put on a pending order later decides it again from the option's price and free over as the order
was started (`core_order_delivery.price`, `free_over`). A staff discount given afterwards still
leaves free postage as it was (above).
