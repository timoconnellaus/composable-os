// A fixture block that breaks the rule: it works out the price itself (scripts/check-blocks.test.mjs).
export function OrderSummary({ lines }: { lines: { unitPrice: number; quantity: number }[] }) {
  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  return <p>Total: {total}</p>;
}
