// Orders (stage 25): every order, newest first (order.list), with a state filter; the part-paid
// orders whose balance is past due (order.overdue); and the payments that arrived after their
// order closed (order.paidLate), each to honour or refund. The view lives in `?view=`, so the
// notifications' links land on it.
import { Button } from "@composable-os/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@composable-os/ui/components/select";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@composable-os/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@composable-os/ui/components/tabs";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ShoppingBagIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { OrderStateBadge } from "#/components/orders/order-state-badge";
import { RefundDialog } from "#/components/orders/refund-dialog";
import { formatDate, formatDateTime } from "#/lib/format";
import { formatMoney, ORDER_STATE_LABELS, type OrderStateName } from "#/lib/money";
import { callOp } from "#/lib/operations";
import { errorMessage, opKey, useOp, useOpMutation } from "#/lib/query";

type OrdersView = "all" | "overdue" | "paid-late";
const VIEWS: readonly OrdersView[] = ["all", "overdue", "paid-late"];
const ANY = "any";

export const Route = createFileRoute("/_app/orders/")({
  validateSearch: (search: Record<string, unknown>): { view?: OrdersView } =>
    VIEWS.includes(search.view as OrdersView) && search.view !== "all"
      ? { view: search.view as OrdersView }
      : {},
  component: OrdersPage,
});

function OrdersPage() {
  const { view = "all" } = Route.useSearch();
  const navigate = useNavigate({ from: "/orders/" });
  const [state, setState] = useState<OrderStateName | typeof ANY>(ANY);

  return (
    <PageLayout
      title="Orders"
      width="lg"
      description="What buyers have ordered and paid. Payments are taken on the payment provider's own page."
      tabs={
        <Tabs
          value={view}
          onValueChange={(next) =>
            navigate({ search: next === "all" ? {} : { view: next as OrdersView }, replace: true })
          }
        >
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="overdue">Overdue</TabsTrigger>
            <TabsTrigger value="paid-late">Paid late</TabsTrigger>
          </TabsList>
        </Tabs>
      }
      toolbar={
        view === "all" ? (
          <Select value={state} onValueChange={(v) => setState(v as OrderStateName | typeof ANY)}>
            <SelectTrigger size="sm" className="w-40" aria-label="State">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any state</SelectItem>
              {(Object.keys(ORDER_STATE_LABELS) as OrderStateName[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {ORDER_STATE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : undefined
      }
    >
      {view === "overdue" ? (
        <OverdueOrders />
      ) : view === "paid-late" ? (
        <PaidLate />
      ) : (
        <AllOrders state={state === ANY ? null : state} />
      )}
    </PageLayout>
  );
}

function Loading() {
  return (
    <div className="grid gap-2" aria-busy="true">
      <Skeleton className="h-10" />
      <Skeleton className="h-10" />
      <Skeleton className="h-10" />
    </div>
  );
}

function OrderLink({ id }: { id: string }) {
  return (
    <Link
      to="/orders/$id"
      params={{ id }}
      className="font-mono text-xs font-medium hover:underline"
    >
      {id}
    </Link>
  );
}

function AllOrders({ state }: { state: OrderStateName | null }) {
  const input = {
    ...(state ? { filter: { field: "state", op: "eq" as const, value: state } } : {}),
    sort: { field: "createdAt", direction: "desc" as const },
    limit: 50,
  };
  const orders = useInfiniteQuery({
    queryKey: opKey("order.list", input),
    queryFn: ({ pageParam }) =>
      callOp("order.list", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = useMemo(() => orders.data?.pages.flatMap((p) => p.items) ?? [], [orders.data]);

  if (orders.isPending) return <Loading />;
  if (orders.isError && !items.length) {
    return (
      <ErrorState
        title="Could not load orders"
        error={orders.error}
        onRetry={() => void orders.refetch()}
      />
    );
  }
  if (!items.length) {
    return (
      <EmptyState
        icon={ShoppingBagIcon}
        title={state ? `No ${ORDER_STATE_LABELS[state].toLowerCase()} orders` : "No orders yet"}
      />
    );
  }
  return (
    <div className="grid gap-3">
      <div className="rounded-md border">
        <Table aria-label="Orders">
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((order) => (
              <TableRow key={order.id} data-testid="order-row">
                <TableCell>
                  <OrderLink id={order.id} />
                </TableCell>
                <TableCell>
                  <OrderStateBadge state={order.state} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(order.total, order.currency)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(order.paid, order.currency)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(order.balance, order.currency)}
                </TableCell>
                <TableCell>{order.email ?? ""}</TableCell>
                <TableCell>
                  <time dateTime={order.createdAt}>{formatDateTime(order.createdAt)}</time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {orders.hasNextPage && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void orders.fetchNextPage()}
            disabled={orders.isFetchingNextPage}
          >
            {orders.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}

function OverdueOrders() {
  const overdue = useOp("order.overdue", { limit: 200 });
  if (overdue.isPending) return <Loading />;
  if (overdue.isError) {
    return (
      <ErrorState
        title="Could not load overdue orders"
        error={overdue.error}
        onRetry={() => void overdue.refetch()}
      />
    );
  }
  if (!overdue.data.items.length) {
    return <EmptyState icon={ShoppingBagIcon} title="No balances are overdue" />;
  }
  return (
    <div className="rounded-md border">
      <Table aria-label="Orders">
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead className="text-right">Balance</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Email</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {overdue.data.items.map((order) => (
            <TableRow key={order.id} data-testid="order-row">
              <TableCell>
                <OrderLink id={order.id} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMoney(order.balance, order.currency)}
              </TableCell>
              <TableCell>
                {order.balanceDueAt ? (
                  <time dateTime={order.balanceDueAt}>{formatDate(order.balanceDueAt)}</time>
                ) : (
                  ""
                )}
              </TableCell>
              <TableCell>{order.email ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PaidLate() {
  const late = useOp("order.paidLate", { limit: 200 });
  const honour = useOpMutation("order.honourLate");
  const [refunding, setRefunding] = useState<{ id: string; currency: string } | null>(null);
  const [honouring, setHonouring] = useState<string | null>(null);

  async function onHonour(id: string) {
    setHonouring(id);
    try {
      await honour.mutateAsync({ id });
      toast.success(`Kept the late payment on ${id}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setHonouring(null);
    }
  }

  if (late.isPending) return <Loading />;
  if (late.isError) {
    return (
      <ErrorState
        title="Could not load late payments"
        error={late.error}
        onRetry={() => void late.refetch()}
      />
    );
  }
  if (!late.data.items.length) {
    return <EmptyState icon={ShoppingBagIcon} title="No late payments to decide on" />;
  }
  return (
    <>
      <div className="rounded-md border">
        <Table aria-label="Orders">
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Received</TableHead>
              <TableHead>Order state</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {late.data.items.map((payment) => (
              <TableRow key={`${payment.provider}:${payment.eventId}`} data-testid="order-row">
                <TableCell>
                  <OrderLink id={payment.orderId} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(payment.amount, payment.currency)}
                </TableCell>
                <TableCell>
                  <time dateTime={payment.receivedAt}>{formatDateTime(payment.receivedAt)}</time>
                </TableCell>
                <TableCell>
                  <OrderStateBadge state={payment.orderState} />
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void onHonour(payment.orderId)}
                      disabled={honouring === payment.orderId}
                    >
                      Honour
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setRefunding({ id: payment.orderId, currency: payment.currency })
                      }
                    >
                      Refund
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {refunding && (
        <RefundDialog
          orderId={refunding.id}
          currency={refunding.currency}
          open
          onOpenChange={(open) => {
            if (!open) setRefunding(null);
          }}
        />
      )}
    </>
  );
}
