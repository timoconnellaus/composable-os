// Ask for a refund of an order's payments (order.refund). Nothing is sent from here: each refund
// goes to the Approvals inbox, and a person with the refund permission approves it there. The
// amount is typed in major units and defaults to everything that can still be refunded.
import { Button } from "@composable-os/ui/components/button";
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
import { Textarea } from "@composable-os/ui/components/textarea";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { formatMoney, fromMajorInput, toMajorInput } from "#/lib/money";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export function RefundDialog({
  orderId,
  currency,
  open,
  onOpenChange,
}: {
  orderId: string;
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const payments = useOp("order.payments", { id: orderId }, { enabled: open });
  const refund = useOpMutation("order.refund", { invalidates: ["approval."] });
  const refundable = payments.data?.refundable.reduce((sum, p) => sum + p.refundable, 0);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason("");
    setError(null);
    setSent(false);
    refund.reset();
  }, [open, refund.reset]);

  useEffect(() => {
    if (open && refundable !== undefined) setAmount(toMajorInput(refundable, currency));
  }, [open, refundable, currency]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const minor = fromMajorInput(amount, currency);
    if (minor === null || minor <= 0) {
      setError("Enter an amount greater than zero");
      return;
    }
    if (refundable !== undefined && minor > refundable) {
      setError(`At most ${formatMoney(refundable, currency)} can be refunded`);
      return;
    }
    if (!reason.trim()) {
      setError("Say why");
      return;
    }
    try {
      await refund.mutateAsync({
        id: orderId,
        reason: reason.trim(),
        ...(minor === refundable ? {} : { amount: minor }),
      });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="refund-dialog">
        <DialogHeader>
          <DialogTitle>Refund</DialogTitle>
          <DialogDescription>
            The refund waits in Approvals until a person with the refund permission approves it.
          </DialogDescription>
        </DialogHeader>
        {sent ? (
          <div className="grid gap-4">
            <p className="text-sm" role="status" data-testid="refund-requested">
              Refund sent for approval.{" "}
              <Link to="/approvals" className="font-medium underline underline-offset-4">
                Open Approvals
              </Link>
            </p>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : payments.isPending ? (
          <Skeleton className="h-32" />
        ) : refundable === 0 ? (
          <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">Nothing on this order can be refunded.</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="refund-amount">Amount ({currency})</Label>
              <Input
                id="refund-amount"
                data-testid="refund-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
              {refundable !== undefined && (
                <p className="text-xs text-muted-foreground">
                  Up to {formatMoney(refundable, currency)} can be refunded.
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="refund-reason">Reason</Label>
              <Textarea
                id="refund-reason"
                data-testid="refund-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                required
              />
            </div>
            {(error || payments.isError) && (
              <p className="text-sm text-destructive" role="alert">
                {error ?? errorMessage(payments.error)}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" data-testid="refund-submit" disabled={refund.isPending}>
                {refund.isPending ? "Sending…" : "Ask for refund"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
