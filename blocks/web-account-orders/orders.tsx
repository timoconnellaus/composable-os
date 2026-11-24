// Orders (stage 48), for the web: the one list of the signed-in customer's orders, newest first,
// each with its state, its lines, tax, deposit, what was paid, what is still to pay and by when,
// and what was refunded. Every figure is the host's, in the currency's minor unit, shown in the
// order's currency (my.list on `order` and `orderLine`, through the seam: their own orders only,
// never a child's). A paid order's receipt is the payment provider's email until the host has a
// receipt document (stage 35): then `receiptUrl` is set and the row links to it.
import {
  type AccountHooks,
  type AccountOrder,
  accountDay,
  formatMinor,
  ORDERS_PAGE,
  orderMoney,
  orderStateWords,
  RECEIPT_EMAILED_WORDS,
  showsReceiptNote,
} from "@composable-os/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<AccountHooks, "useOrders">;

export function YourOrders({ account }: { account: Hooks }) {
  // One entry per page shown: the first page, then each older page asked for.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  return (
    <div className="grid gap-3">
      {cursors.map((cursor, i) => (
        <OrdersPage
          key={cursor ?? "first"}
          account={account}
          cursor={cursor}
          first={i === 0}
          last={i === cursors.length - 1}
          onMore={(next) => setCursors([...cursors, next])}
        />
      ))}
    </div>
  );
}

function OrdersPage({
  account,
  cursor,
  first,
  last,
  onMore,
}: {
  account: Hooks;
  cursor: string | undefined;
  first: boolean;
  last: boolean;
  onMore: (cursor: string) => void;
}) {
  const page = account.useOrders(cursor);
  if (page.isPending) return <p aria-busy="true">Loading your orders…</p>;
  if (page.error || !page.data) return <p role="alert">We could not load your orders.</p>;
  const { orders, nextCursor } = page.data;
  if (first && !orders.length) {
    return <p className="text-muted-foreground text-sm">You have no orders yet.</p>;
  }
  return (
    <>
      <ul className="grid gap-3" aria-label={first ? "Your orders" : "Older orders"}>
        {orders.map((order) => (
          <OrderRow key={order.id} order={order} />
        ))}
      </ul>
      {last && nextCursor ? (
        <Button type="button" variant="outline" onClick={() => onMore(nextCursor)}>
          {`Show ${ORDERS_PAGE} older orders`}
        </Button>
      ) : null}
    </>
  );
}

function OrderRow({ order }: { order: AccountOrder }) {
  return (
    <li className="grid gap-2 rounded-md border p-3" data-order={order.id} data-state={order.state}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong>{accountDay(order.createdAt)}</strong>
        <span>{orderStateWords(order)}</span>
      </div>
      <ul className="grid gap-1" aria-label="What was ordered">
        {order.lines.map((line) => (
          <li key={line.id} className="flex justify-between gap-2 text-sm">
            <span>{line.quantity > 1 ? `${line.title} (${line.quantity})` : line.title}</span>
            <span>{formatMinor(line.total, order.currency)}</span>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        {orderMoney(order).map((row) => (
          <div key={row.key} className="contents" data-money={row.key}>
            <dt>{row.label}</dt>
            <dd className="text-right">{row.value}</dd>
          </div>
        ))}
      </dl>
      {order.receiptUrl ? (
        <a className="text-sm underline" href={order.receiptUrl} download>
          Download receipt
        </a>
      ) : showsReceiptNote(order) ? (
        <p className="text-muted-foreground text-sm">{RECEIPT_EMAILED_WORDS}</p>
      ) : null}
    </li>
  );
}
