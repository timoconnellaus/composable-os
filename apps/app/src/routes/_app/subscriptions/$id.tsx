// One subscription (stage 32a): its plan and price as agreed, its state, trial, period and end,
// who pays and who holds it, and the paid order of each period. Staff with subscriptions:manage
// cancel it at its period's end or now, with a reason, or keep it going; each asks the payment
// provider, and the state changes only once the provider confirms (the host refuses the rest).
// A period's refund is the order's own (order.refund, through approval).
// Stage 32b (ADRs 0530, 0531): staff move it to another plan (an upgrade now, prorated; a downgrade
// from the next period: the host decides which), pause it for a set time within the plan's
// bounds, or end a pause; each asks the provider, and shows once the provider confirms.
import type { CoreOutput } from "@composable-os/core";
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
import { SubscriptionStateBadge } from "#/components/subscriptions/subscription-state-badge";
import { formatDate, formatDateTime } from "#/lib/format";
import { formatMoney } from "#/lib/money";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/subscriptions/$id")({ component: SubscriptionPage });

type SubscriptionData = CoreOutput<"subscription.get">;

const RUNNING = new Set(["trialing", "active", "past_due"]);
const FINAL = new Set(["ended", "expired"]);

function SubscriptionPage() {
  const { id } = Route.useParams();
  const sub = useOp("subscription.get", { id });
  const back = { to: "/subscriptions", label: "Subscriptions" } as const;
  if (sub.isPending) {
    return (
      <PageLayout title="Subscription" width="lg" back={back}>
        <Skeleton className="h-40" aria-busy="true" />
      </PageLayout>
    );
  }
  if (sub.isError) {
    return (
      <PageLayout title="Subscription" width="lg" back={back}>
        <ErrorState
          title="Could not load this subscription"
          error={sub.error}
          onRetry={() => void sub.refetch()}
        />
      </PageLayout>
    );
  }
  const s = sub.data;
  return (
    <PageLayout
      title={s.planTitle}
      titleAddon={<SubscriptionStateBadge state={s.state} testId="subscription-state" />}
      width="lg"
      back={back}
      actions={<SubscriptionActions subscription={s} />}
    >
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Subscription {s.id}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-sm">
              <Detail label="Price">
                {`${formatMoney(s.amount, s.currency)} every ${s.interval}${s.taxed ? ", tax included" : ""}`}
              </Detail>
              <Detail label="Payer">
                <PersonLink id={s.payerPersonId ?? null} fallback={s.email ?? ""} />
              </Detail>
              <Detail label="Holder">
                <PersonLink id={s.holderPersonId} fallback="" />
              </Detail>
              {s.trialEnd && <Detail label="Trial ends">{formatDateTime(s.trialEnd)}</Detail>}
              <Detail label="Period">
                {`${formatDate(s.currentPeriodStart)} to ${formatDate(s.currentPeriodEnd)}`}
              </Detail>
              {s.cancelAtPeriodEnd && (
                <Detail label="Ends">
                  {`When this period does (${formatDateTime(s.currentPeriodEnd)})`}
                </Detail>
              )}
              {s.cancelAt && <Detail label="Ends on">{formatDateTime(s.cancelAt)}</Detail>}
              {s.failingSince && (
                <Detail label="Failing since">{formatDateTime(s.failingSince)}</Detail>
              )}
              {s.endedAt && (
                <Detail label="Ended">
                  {`${formatDateTime(s.endedAt)}${s.endReason ? ` (${s.endReason})` : ""}`}
                </Detail>
              )}
              {s.change && <Detail label="Change">{changeText(s)}</Detail>}
              <Detail label="Started">{formatDateTime(s.createdAt)}</Detail>
            </dl>
          </CardContent>
        </Card>
        <PeriodOrders subscriptionId={s.id} />
      </div>
    </PageLayout>
  );
}

/** The plan change or pause the host shows on the subscription, in words. */
function changeText(s: SubscriptionData): string {
  const c = s.change;
  if (!c) return "";
  // What the provider answered, when it is not a plain yes (review of 32b): staff see it and act.
  const answer =
    c.callOutcome === "unknown"
      ? " The payment provider's answer was lost: its next event decides, or withdraw it."
      : c.callOutcome === "pending"
        ? " Waiting for approval."
        : "";
  if (c.kind === "pause") {
    const ending =
      c.endOutcome === "refused"
        ? " Ending it early was refused by the payment provider: try again."
        : c.endOutcome === "unknown"
          ? " Ending it early did not finish (the provider's answer was lost): try again."
          : "";
    return c.state === "applied"
      ? `Paused until ${formatDateTime(c.pauseUntil)}.${ending}`
      : `Pause asked: from ${c.pauseFrom ? formatDateTime(c.pauseFrom) : "now"} until ${formatDateTime(c.pauseUntil)}.${answer}${ending}`;
  }
  const to = `${c.toPlanTitle} (${formatMoney(c.toAmount ?? 0, s.currency)})`;
  // A withdraw whose undo at the provider did not finish keeps the change open (second review).
  const withdrawing =
    c.endOutcome === "refused"
      ? " Withdrawing it was refused by the payment provider: try again."
      : c.endOutcome === "unknown"
        ? " Withdrawing it did not finish (the provider's answer was lost): try again."
        : "";
  if (c.state === "lapsed")
    return `The change to ${to} was never shown by the provider, so it did not happen`;
  if (c.kind === "upgrade") {
    return c.actionUrl
      ? `Upgrading to ${to}: the payer must confirm its charge on the provider's page.${answer}${withdrawing}`
      : `Upgrading to ${to}, once its prorated charge is paid.${answer}${withdrawing}`;
  }
  return `Changes to ${to} on ${formatDateTime(c.effectiveAt)}.${answer}${withdrawing}`;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 sm:justify-start">
      <dt className="text-muted-foreground sm:w-28 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 break-words text-right sm:text-left">{children}</dd>
    </div>
  );
}

function PersonLink({ id, fallback }: { id: string | null; fallback: string }) {
  if (!id) return <>{fallback}</>;
  return (
    <Link to="/people/$id" params={{ id }} className="hover:underline">
      {fallback || id}
    </Link>
  );
}

function PeriodOrders({ subscriptionId }: { subscriptionId: string }) {
  const orders = useOp("order.list", {
    filter: { field: "subscriptionId", op: "eq", value: subscriptionId },
    sort: { field: "createdAt", direction: "desc" },
    limit: 50,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Paid periods</CardTitle>
      </CardHeader>
      <CardContent>
        {orders.isPending ? (
          <Skeleton className="h-10" />
        ) : orders.isError ? (
          <p className="text-sm text-destructive">{errorMessage(orders.error)}</p>
        ) : !orders.data.items.length ? (
          <p className="text-sm text-muted-foreground" data-testid="subscription-orders">
            No period has been paid yet.
          </p>
        ) : (
          <Table aria-label="Paid periods" data-testid="subscription-orders">
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.data.items.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>
                    <Link
                      to="/orders/$id"
                      params={{ id: o.id }}
                      className="font-mono text-xs hover:underline"
                    >
                      {o.id}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <OrderStateBadge state={o.state} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(o.paid, o.currency)}
                  </TableCell>
                  <TableCell>{formatDate(o.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

type Asking = "period_end" | "now" | null;
type Changing = "plan" | "pause" | null;

function SubscriptionActions({ subscription: s }: { subscription: SubscriptionData }) {
  const cancel = useOpMutation("subscription.cancel");
  const resume = useOpMutation("subscription.resume");
  const unpause = useOpMutation("subscription.unpause");
  const withdraw = useOpMutation("subscription.change.withdraw");
  const [asking, setAsking] = useState<Asking>(null);
  const [changing, setChanging] = useState<Changing>(null);
  const [error, setError] = useState<string | null>(null);
  const ending = s.cancelAtPeriodEnd || s.cancelAt !== null;
  const open = s.change && (s.change.state === "requested" || s.change.state === "waiting");
  const pausing = s.state === "paused" || s.change?.kind === "pause";

  async function onUnpause() {
    setError(null);
    try {
      await unpause.mutateAsync({ id: s.id, reason: "Ended early by staff" });
      toast.success("Asked the payment provider to end the pause");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onResume() {
    setError(null);
    try {
      await resume.mutateAsync({ id: s.id });
      toast.success("Asked the payment provider to keep it going");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (FINAL.has(s.state)) return null;
  return (
    <>
      {error && (
        <p className="w-full text-sm text-destructive sm:w-auto" role="alert">
          {error}
        </p>
      )}
      {s.cancelAtPeriodEnd && RUNNING.has(s.state) && (
        <Button size="sm" onClick={() => void onResume()} disabled={resume.isPending}>
          Keep it going
        </Button>
      )}
      {s.state === "active" && !ending && !open && (
        <>
          <Button size="sm" variant="outline" onClick={() => setChanging("plan")}>
            Change plan
          </Button>
          <Button size="sm" variant="outline" onClick={() => setChanging("pause")}>
            Pause
          </Button>
        </>
      )}
      {open && s.change?.kind !== "pause" && (
        <Button
          size="sm"
          variant="outline"
          disabled={withdraw.isPending}
          onClick={() => {
            setError(null);
            withdraw
              .mutateAsync({ id: s.id, reason: "Withdrawn by staff" })
              .then((out) =>
                out.asked === "sent" || out.asked === "not_needed"
                  ? toast.success("The change is withdrawn")
                  : toast.warning(
                      "Asked the payment provider to undo it; its answer was lost. It shows here until it is undone: try again",
                    ),
              )
              .catch((err: unknown) => setError(errorMessage(err)));
          }}
        >
          Withdraw the change
        </Button>
      )}
      {pausing && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void onUnpause()}
          disabled={unpause.isPending}
        >
          {s.state === "paused" ? "End the pause now" : "Withdraw the pause"}
        </Button>
      )}
      {RUNNING.has(s.state) && !ending && (
        <Button size="sm" variant="outline" onClick={() => setAsking("period_end")}>
          Cancel at period end
        </Button>
      )}
      <ChangePlanDialog
        subscription={s}
        open={changing === "plan"}
        onDone={() => setChanging(null)}
      />
      <PauseDialog subscription={s} open={changing === "pause"} onDone={() => setChanging(null)} />
      <Button size="sm" variant="outline" onClick={() => setAsking("now")}>
        End now
      </Button>
      <CancelDialog
        subscription={s}
        when={asking}
        onDone={() => setAsking(null)}
        pending={cancel.isPending}
        onCancel={async (reason) => {
          await cancel.mutateAsync({ id: s.id, reason, now: asking === "now" });
          toast.success(
            asking === "now"
              ? "Asked the payment provider to end it now"
              : "Asked the payment provider to end it when the period does",
          );
        }}
      />
    </>
  );
}

function CancelDialog({
  subscription: s,
  when,
  onDone,
  onCancel,
  pending,
}: {
  subscription: SubscriptionData;
  when: Asking;
  onDone: () => void;
  onCancel: (reason: string) => Promise<void>;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await onCancel(reason.trim());
      setReason("");
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <Dialog open={when !== null} onOpenChange={(open) => !open && onDone()}>
      <DialogContent>
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{when === "now" ? "End it now?" : "Cancel at period end?"}</DialogTitle>
            <DialogDescription>
              {when === "now"
                ? "Nothing more is charged and what it gives stops once the payment provider confirms. Nothing is refunded: refund a period from its order."
                : `Nothing more is charged; what it gives lasts until ${formatDateTime(s.currentPeriodEnd)}. It can be kept going until then.`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="subscription-cancel-reason">Reason</Label>
            <Input
              id="subscription-cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={500}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone}>
              Keep it
            </Button>
            <Button type="submit" disabled={pending || !reason.trim()}>
              {when === "now" ? "End now" : "Cancel at period end"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChangePlanDialog({
  subscription: s,
  open,
  onDone,
}: {
  subscription: SubscriptionData;
  open: boolean;
  onDone: () => void;
}) {
  const plans = useOp(
    "record.list",
    { object: s.planObject, limit: 100 },
    { enabled: open, staleTime: 30_000 },
  );
  const change = useOpMutation("subscription.change");
  const [planId, setPlanId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const asked = await change.mutateAsync({ id: s.id, planId, reason: reason.trim() });
      toast.success(
        asked.kind === "upgrade"
          ? "Asked the payment provider: it charges the rest of the period now"
          : `It changes when this period ends, on ${formatDate(asked.effectiveAt)}`,
      );
      setPlanId("");
      setReason("");
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const options = (plans.data?.items ?? []).filter((p) => p.id !== s.planId);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onDone()}>
      <DialogContent>
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Change plan?</DialogTitle>
            <DialogDescription>
              A dearer plan starts now: the payment provider charges the rest of this period at
              once, and the new plan applies only once that is paid. A cheaper one starts when this
              period ends, with nothing refunded.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="subscription-change-plan">New plan</Label>
            <select
              id="subscription-change-plan"
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              required
            >
              <option value="">Choose a plan</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title ?? p.id}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="subscription-change-reason">Reason</Label>
            <Input
              id="subscription-change-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={500}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone}>
              Keep this plan
            </Button>
            <Button type="submit" disabled={change.isPending || !planId || !reason.trim()}>
              Change plan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PauseDialog({
  subscription: s,
  open,
  onDone,
}: {
  subscription: SubscriptionData;
  open: boolean;
  onDone: () => void;
}) {
  const pause = useOpMutation("subscription.pause");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await pause.mutateAsync({
        id: s.id,
        ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
        until: new Date(`${until}T00:00:00`).toISOString(),
        reason: reason.trim(),
      });
      toast.success("Asked the payment provider to pause it");
      setFrom("");
      setUntil("");
      setReason("");
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onDone()}>
      <DialogContent>
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Pause this subscription?</DialogTitle>
            <DialogDescription>
              Nothing is charged and what it gives stops while it is paused. On the end date the
              payment provider resumes it and charges a new period, less the unused part of this
              one. The plan sets the shortest and longest pause.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="subscription-pause-from">From (empty: now)</Label>
            <Input
              id="subscription-pause-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="subscription-pause-until">Until</Label>
            <Input
              id="subscription-pause-until"
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="subscription-pause-reason">Reason</Label>
            <Input
              id="subscription-pause-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={500}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone}>
              Keep it running
            </Button>
            <Button type="submit" disabled={pause.isPending || !until || !reason.trim()}>
              Pause
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
