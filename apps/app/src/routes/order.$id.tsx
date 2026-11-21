// The guest's order page (stage 25; public, no sign-in): the order its link's token opens, and a
// Pay button that sends the buyer to the payment provider's own page. Coming back from there
// marks nothing paid: the page asks again every 2 seconds for up to a minute until the
// provider's confirmation has changed the order.
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@composable-os/ui/components/card";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@composable-os/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { guestOrder, guestPay } from "../lib/guest-api.ts";
import {
  formatMoney,
  fromMajorInput,
  ORDER_STATE_LABELS,
  ORDER_STATE_VARIANTS,
  toMajorInput,
} from "../lib/money.ts";

export const Route = createFileRoute("/order/$id")({
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search.token === "string" && search.token ? { token: search.token } : {},
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: GuestOrderPage,
});

const POLL_MS = 2_000;
const POLL_FOR_MS = 60_000;

/** Set just before the buyer leaves for the provider: when, and the state the order was in. */
interface PayingMark {
  at: number;
  state: string;
}

const markKey = (id: string) => `cos-order-paying:${id}`;

function readMark(id: string): PayingMark | null {
  try {
    const raw = sessionStorage.getItem(markKey(id));
    const mark = raw ? (JSON.parse(raw) as PayingMark) : null;
    return mark && Date.now() - mark.at < POLL_FOR_MS * 5 ? mark : null;
  } catch {
    return null;
  }
}

function writeMark(id: string, mark: PayingMark | null) {
  try {
    if (mark) sessionStorage.setItem(markKey(id), JSON.stringify(mark));
    else sessionStorage.removeItem(markKey(id));
  } catch {
    // No storage: the page still works, it just does not wait for the provider.
  }
}

function GuestOrderPage() {
  const { id } = Route.useParams();
  const { token } = Route.useSearch();
  // Read after hydration: sessionStorage is the browser's.
  const [mark, setMark] = useState<PayingMark | null>(null);
  const [pollStarted] = useState(() => Date.now());
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => setMark(readMark(id)), [id]);
  useEffect(() => {
    if (!mark) return;
    const timer = setTimeout(() => setGaveUp(true), POLL_FOR_MS - (Date.now() - pollStarted));
    return () => clearTimeout(timer);
  }, [mark, pollStarted]);

  const order = useQuery({
    queryKey: ["guestOrder", id, token],
    enabled: Boolean(token),
    queryFn: () => guestOrder({ data: { id, token: token ?? "" } }),
    retry: false,
    refetchInterval: (query) => {
      const result = query.state.data;
      if (!mark || gaveUp || !result?.ok || result.data.state !== mark.state) return false;
      return Date.now() - pollStarted < POLL_FOR_MS ? POLL_MS : false;
    },
  });

  const result = order.data;
  const sameState = mark !== null && result?.ok === true && result.data.state === mark.state;
  const waiting = sameState && !gaveUp;

  // The provider's confirmation changed the order: stop waiting for it.
  useEffect(() => {
    if (mark && result?.ok && result.data.state !== mark.state) {
      writeMark(id, null);
      setMark(null);
    }
  }, [id, mark, result]);

  return (
    <div className="flex min-h-svh justify-center px-4 py-8 sm:items-center sm:p-6">
      <div className="w-full max-w-lg">
        {!token || (result && !result.ok && result.error.code === "not_found") ? (
          <Shell title="Your order">
            <p className="text-sm text-muted-foreground" role="alert" data-testid="guest-invalid">
              This link is not valid or has expired.
            </p>
          </Shell>
        ) : order.isPending ? (
          <Shell title="Your order">
            <Skeleton className="h-40" />
          </Shell>
        ) : order.isError || !result ? (
          <Shell title="Your order">
            <p className="text-sm text-destructive" role="alert">
              Could not load your order. Try again in a moment.
            </p>
          </Shell>
        ) : !result.ok ? (
          <Shell title="Your order">
            <p className="text-sm text-destructive" role="alert">
              {result.error.message}
            </p>
          </Shell>
        ) : (
          <OrderView
            order={result.data}
            token={token}
            waiting={waiting}
            notYet={sameState && gaveUp}
            onLeaving={(state) => writeMark(id, { at: Date.now(), state })}
          />
        )}
      </div>
    </div>
  );
}

function Shell({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

type GuestOrder = Extract<Awaited<ReturnType<typeof guestOrder>>, { ok: true }>["data"];

function OrderView({
  order,
  token,
  waiting,
  notYet,
  onLeaving,
}: {
  order: GuestOrder;
  token: string;
  waiting: boolean;
  notYet: boolean;
  onLeaving: (state: string) => void;
}) {
  const money = (amount: number) => formatMoney(amount, order.currency);
  const payable = order.state === "pending" || order.state === "part_paid";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Your order
          <Badge
            variant={ORDER_STATE_VARIANTS[order.state]}
            data-testid="guest-order-state"
            data-state={order.state}
          >
            {ORDER_STATE_LABELS[order.state]}
          </Badge>
        </CardTitle>
        <CardDescription className="break-all font-mono text-xs">{order.id}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <Table aria-label="What you ordered">
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell>{line.title}</TableCell>
                <TableCell className="text-right tabular-nums">{line.quantity}</TableCell>
                <TableCell className="text-right tabular-nums">{money(line.total)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <dl className="grid gap-1 text-sm">
          <Amount label="Total">{money(order.total)}</Amount>
          <Amount label="Paid">{money(order.paid)}</Amount>
          <Amount label="Balance">{money(order.balance)}</Amount>
          {order.refunded > 0 && <Amount label="Refunded">{money(order.refunded)}</Amount>}
          {order.state === "part_paid" && order.balanceDueAt && (
            <Amount label="Balance due">{new Date(order.balanceDueAt).toLocaleDateString()}</Amount>
          )}
        </dl>

        {waiting ? (
          <p
            className="rounded-md border bg-muted/50 px-3 py-2 text-sm"
            role="status"
            data-testid="guest-waiting"
          >
            Waiting for the payment provider to confirm. This page updates by itself.
          </p>
        ) : payable ? (
          <>
            {notYet && (
              <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm" role="status">
                The payment provider has not confirmed a payment yet. If you paid, open this link
                again in a few minutes to see it.
              </p>
            )}
            <PayForm order={order} token={token} onLeaving={onLeaving} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Amount({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}

function PayForm({
  order,
  token,
  onLeaving,
}: {
  order: GuestOrder;
  token: string;
  onLeaving: (state: string) => void;
}) {
  const part = order.state === "part_paid";
  const [amount, setAmount] = useState(() => toMajorInput(order.balance, order.currency));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Until React hydrates, a click would submit the form natively; keep it disabled until then.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    let minor: number | undefined;
    if (part) {
      const parsed = fromMajorInput(amount, order.currency);
      if (parsed === null || parsed <= 0) {
        setError("Enter an amount greater than zero");
        return;
      }
      minor = parsed;
    }
    setPending(true);
    try {
      const result = await guestPay({
        data: { id: order.id, token, ...(minor !== undefined ? { amount: minor } : {}) },
      });
      if (!result.ok) {
        setError(result.error.message);
        setPending(false);
        return;
      }
      onLeaving(order.state);
      window.location.href = result.data.url;
    } catch {
      setError("Could not reach the payment provider. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      {part && (
        <div className="grid gap-2">
          <Label htmlFor="guest-amount">Amount to pay ({order.currency})</Label>
          <Input
            id="guest-amount"
            data-testid="guest-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </div>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" data-testid="guest-pay" disabled={!hydrated || pending}>
        {pending ? "Opening the payment page…" : "Pay"}
      </Button>
      <p className="text-xs text-muted-foreground">
        You pay on the payment provider's own page, then come back here.
      </p>
    </form>
  );
}
