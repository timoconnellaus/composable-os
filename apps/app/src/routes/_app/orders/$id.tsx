// One order (stage 25): its state, amounts, buyer and lines (order.get), and its money in detail
// (order.payments): checkouts opened, payments the provider confirmed and refunds asked for. The
// actions are the ones that apply to its state. None of them marks an order paid: only the
// provider's confirmation does.
import type { CoreOutput } from "@composable-os/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@composable-os/ui/components/alert-dialog";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@composable-os/ui/components/dialog";
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
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { OrderStateBadge } from "#/components/orders/order-state-badge";
import { RefundDialog } from "#/components/orders/refund-dialog";
import { RecordSearch } from "#/components/record-picker";
import { formatDateTime, formatDueDay } from "#/lib/format";
import { formatMoney } from "#/lib/money";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/orders/$id")({ component: OrderPage });

const KIND_LABELS: Record<string, string> = {
  full: "Whole price",
  deposit: "Deposit",
  balance: "Balance",
  part: "Part of the balance",
};

const OUTCOME_LABELS: Record<string, string> = {
  applied: "Applied",
  late: "Late",
  mismatch: "Did not match",
};

const RESOLVED_LABELS: Record<string, string> = {
  honoured: "Honoured",
  refunded: "Refunded",
};

const REFUND_STATUS_LABELS: Record<string, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
};

/** The end of a day (YYYY-MM-DD) in UTC, as ISO 8601. */
function endOfDayUtc(day: string): string {
  return `${day}T23:59:59.999Z`;
}

function OrderPage() {
  const { id } = Route.useParams();
  const order = useOp("order.get", { id });
  const payments = useOp("order.payments", { id });
  const [refundOpen, setRefundOpen] = useState(false);

  if (order.isPending) {
    return (
      <PageLayout title={`Order ${id}`} width="lg" back={{ to: "/orders", label: "Orders" }}>
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-32" />
          <Skeleton className="h-48" />
        </div>
      </PageLayout>
    );
  }
  if (order.isError) {
    return (
      <PageLayout title={`Order ${id}`} width="lg" back={{ to: "/orders", label: "Orders" }}>
        <ErrorState
          title="Could not load this order"
          error={order.error}
          onRetry={() => void order.refetch()}
        />
      </PageLayout>
    );
  }

  const o = order.data;
  const money = (amount: number) => formatMoney(amount, o.currency);
  const refundable = payments.data?.refundable.reduce((sum, p) => sum + p.refundable, 0) ?? 0;
  const unresolvedLate =
    payments.data?.payments.some((p) => p.outcome === "late" && p.resolved === null) ?? false;

  return (
    <PageLayout
      title={`Order ${o.id}`}
      titleAddon={<OrderStateBadge state={o.state} testId="order-state" />}
      width="lg"
      back={{ to: "/orders", label: "Orders" }}
      actions={
        <OrderActions
          order={o}
          canRefund={refundable > 0}
          canHonour={o.state === "expired" && unresolvedLate}
          onRefund={() => setRefundOpen(true)}
        />
      }
    >
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Detail label="Total">{money(o.total)}</Detail>
              <Detail label="Paid">{money(o.paid)}</Detail>
              <Detail label="Balance">{money(o.balance)}</Detail>
              <Detail label="Refunded">{money(o.refunded)}</Detail>
              {o.pay === "deposit" && (
                <>
                  <Detail label="Deposit">{o.deposit === null ? "None" : money(o.deposit)}</Detail>
                  <Detail label="Balance due">
                    {o.balanceDueAt ? formatDueDay(o.balanceDueAt) : "Not set"}
                  </Detail>
                </>
              )}
              {o.state === "pending" && o.expiresAt && (
                <Detail label="Expires">{formatDateTime(o.expiresAt)}</Detail>
              )}
              {o.paidAt && <Detail label="Paid on">{formatDateTime(o.paidAt)}</Detail>}
              <Detail label="Email">{o.email ?? "None"}</Detail>
              <Detail label="Person">
                {o.personId ? (
                  <Link
                    to="/people/$id"
                    params={{ id: o.personId }}
                    className="font-medium hover:underline"
                  >
                    Open person
                  </Link>
                ) : (
                  "No one yet"
                )}
              </Detail>
              <Detail label="Created">{formatDateTime(o.createdAt)}</Detail>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <CardContent>
            <Table aria-label="Lines">
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Unit price</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {o.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell>{line.title}</TableCell>
                    <TableCell className="text-right tabular-nums">{line.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(line.unitPrice)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(line.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Money currency={o.currency} payments={payments} />
      </div>
      <RefundDialog
        orderId={o.id}
        currency={o.currency}
        open={refundOpen}
        onOpenChange={setRefundOpen}
      />
    </PageLayout>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 sm:justify-start">
      <dt className="text-muted-foreground sm:w-28 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 break-words text-right sm:text-left">{children}</dd>
    </div>
  );
}

type OrderData = CoreOutput<"order.get">;

function OrderActions({
  order,
  canRefund,
  canHonour,
  onRefund,
}: {
  order: OrderData;
  canRefund: boolean;
  canHonour: boolean;
  onRefund: () => void;
}) {
  const cancel = useOpMutation("order.cancel");
  const honour = useOpMutation("order.honourLate");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [personOpen, setPersonOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCancel() {
    setError(null);
    try {
      await cancel.mutateAsync({ id: order.id });
      toast.success("Order cancelled");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCancelOpen(false);
    }
  }

  async function onHonour() {
    setError(null);
    try {
      await honour.mutateAsync({ id: order.id });
      toast.success("Kept the late payment");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const open = order.state === "pending" || order.state === "part_paid";
  return (
    <>
      {error && (
        <p className="w-full text-sm text-destructive sm:w-auto" role="alert">
          {error}
        </p>
      )}
      {canHonour && (
        <Button size="sm" onClick={() => void onHonour()} disabled={honour.isPending}>
          Honour late payment
        </Button>
      )}
      {order.state === "part_paid" && (
        <Button size="sm" variant="outline" onClick={() => setExtendOpen(true)}>
          Extend due date
        </Button>
      )}
      {!order.personId && (
        <Button size="sm" variant="outline" onClick={() => setPersonOpen(true)}>
          Set person
        </Button>
      )}
      {canRefund && (
        <Button size="sm" variant="outline" onClick={onRefund} data-testid="order-refund">
          Refund
        </Button>
      )}
      {open && (
        <Button size="sm" variant="outline" onClick={() => setCancelOpen(true)}>
          Cancel order
        </Button>
      )}

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel order {order.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              {order.state === "part_paid"
                ? "Its places go back. What was paid is not refunded by this: refund it as a separate step."
                : "Its places go back and the buyer can no longer pay for it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep order</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onCancel()} disabled={cancel.isPending}>
              Cancel order
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ExtendDialog order={order} open={extendOpen} onOpenChange={setExtendOpen} />
      <SetPersonDialog orderId={order.id} open={personOpen} onOpenChange={setPersonOpen} />
    </>
  );
}

function ExtendDialog({
  order,
  open,
  onOpenChange,
}: {
  order: OrderData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const extend = useOpMutation("order.extendBalanceDue");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const day = String(new FormData(event.currentTarget).get("due") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      setError("Choose a date");
      return;
    }
    try {
      await extend.mutateAsync({ id: order.id, balanceDueAt: endOfDayUtc(day) });
      toast.success(`Balance now due ${formatDueDay(endOfDayUtc(day))}`);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Extend due date</DialogTitle>
          <DialogDescription>
            The buyer pays the rest from their order link by the end of this day (UTC).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="balance-due">Balance due</Label>
            <Input
              id="balance-due"
              name="due"
              type="date"
              required
              defaultValue={order.balanceDueAt?.slice(0, 10)}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={extend.isPending}>
              {extend.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SetPersonDialog({
  orderId,
  open,
  onOpenChange,
}: {
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setPerson = useOpMutation("order.setPerson", { invalidates: ["person."] });
  const [error, setError] = useState<string | null>(null);

  async function onSelect(personId: string) {
    setError(null);
    try {
      await setPerson.mutateAsync({ id: orderId, personId });
      toast.success("Person set");
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set person</DialogTitle>
          <DialogDescription>
            The address this order was placed with matched several people. Merge them first, then
            choose the one that remains.
          </DialogDescription>
        </DialogHeader>
        <RecordSearch
          object="person"
          label="Person"
          placeholder="Search people"
          autoFocus
          onSelect={(record) => void onSelect(record.id)}
        />
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Money({
  currency,
  payments,
}: {
  currency: string;
  payments: ReturnType<typeof useOp<"order.payments">>;
}) {
  const money = (amount: number, c = currency) => formatMoney(amount, c);
  return (
    <section aria-labelledby="order-money" className="grid gap-3">
      <h2 id="order-money" className="text-lg font-semibold">
        Money
      </h2>
      {payments.isPending ? (
        <Skeleton className="h-32" />
      ) : payments.isError ? (
        <ErrorState
          title="Could not load this order's money"
          error={payments.error}
          onRetry={() => void payments.refetch()}
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Checkouts</CardTitle>
            </CardHeader>
            <CardContent>
              {payments.data.checkouts.length ? (
                <Table aria-label="Checkouts">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Opened</TableHead>
                      <TableHead>For</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Provider</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.data.checkouts.map((c) => (
                      <TableRow key={`${c.provider}:${c.ref}`}>
                        <TableCell>{formatDateTime(c.createdAt)}</TableCell>
                        <TableCell>{KIND_LABELS[c.kind] ?? c.kind}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(c.amount)}</TableCell>
                        <TableCell>{c.provider}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">No checkout opened yet.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Payments</CardTitle>
            </CardHeader>
            <CardContent>
              {payments.data.payments.length ? (
                <Table aria-label="Payments" data-testid="order-payments">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Received</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Resolved</TableHead>
                      <TableHead>Provider</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.data.payments.map((p) => (
                      <TableRow key={`${p.provider}:${p.eventId}`}>
                        <TableCell>{formatDateTime(p.receivedAt)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(p.amount, p.currency)}
                        </TableCell>
                        <TableCell>{OUTCOME_LABELS[p.outcome] ?? p.outcome}</TableCell>
                        <TableCell>
                          {p.resolved ? (RESOLVED_LABELS[p.resolved] ?? p.resolved) : ""}
                        </TableCell>
                        <TableCell>{p.provider}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="order-payments">
                  No payment confirmed by the provider yet.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Refunds</CardTitle>
            </CardHeader>
            <CardContent>
              {payments.data.refunds.length ? (
                <Table aria-label="Refunds" data-testid="order-refunds">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Asked</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.data.refunds.map((r) => (
                      <TableRow key={r.id} data-testid="order-refund-row" data-status={r.status}>
                        <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(r.amount)}</TableCell>
                        <TableCell>{REFUND_STATUS_LABELS[r.status] ?? r.status}</TableCell>
                        <TableCell className="max-w-64 truncate" title={r.reason ?? undefined}>
                          {r.reason ?? ""}
                        </TableCell>
                        <TableCell>
                          {r.pendingActionId && (
                            <Link to="/approvals" className="text-sm font-medium hover:underline">
                              In Approvals
                            </Link>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="order-refunds">
                  No refunds.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}
