// The page the buyer comes back to from the payment provider (stage 27). Coming back proves
// nothing: only the provider's verified word makes an order paid (ADR 0427), so this shows the
// order's real state from the host and keeps asking while it is pending.
import type { TicketingHooks } from "@composable-os/pack-ticketing/client";
import { formatMoney, orderStatus } from "@composable-os/pack-ticketing/client";
import type { ReactNode } from "react";

export function OrderConfirmation({
  ticketing,
  order,
  children,
}: {
  ticketing: TicketingHooks;
  /** The order, and a guest's token (from the link, or kept when the order started). */
  order: { id: string; token?: string | null };
  /** Shown below, for a part-paid order: the block's BalancePayment, for one. */
  children?: ReactNode;
}) {
  const { data, isPending, error } = ticketing.useOrder(order);
  if (isPending) return <p aria-busy="true">Checking your order…</p>;
  if (error || !data) return <p role="alert">We could not find this order.</p>;
  const status = orderStatus(data);
  return (
    <section className="grid gap-3" aria-live="polite">
      <h2 className="text-xl font-semibold">{status.title}</h2>
      {status.waiting ? (
        <p aria-busy="true">This usually takes a few seconds. You can leave this page open.</p>
      ) : null}
      <ul className="grid gap-1">
        {data.lines.map((line) => (
          <li key={line.id} className="flex justify-between gap-4">
            <span>
              {line.quantity} × {line.title}
            </span>
            <span>{formatMoney(line.total, data.currency)}</span>
          </li>
        ))}
      </ul>
      <p>
        Total {formatMoney(data.total, data.currency)} · paid{" "}
        {formatMoney(data.paid, data.currency)}
      </p>
      {status.kind === "part_paid" ? children : null}
    </section>
  );
}
