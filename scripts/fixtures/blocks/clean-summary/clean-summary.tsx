// A fixture block that keeps the rule: it shows the total the host worked out, and says "Total"
// and "price" only in its copy (scripts/check-blocks.test.mjs).
export function OrderSummary({ order }: { order: { total: string; placesLeft: string } }) {
  return (
    <p>
      Total price: {order.total}. {`${order.placesLeft} places left`}
    </p>
  );
}
