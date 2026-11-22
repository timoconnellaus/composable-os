// Continuation offers (stage 32a, ADR 0491): the report the company works from when moving its
// subscribers off another platform. Who has taken their offer, with the date their new
// subscription starts charging, so the company ends exactly those old subscriptions at their
// period's end; who has not, to chase before their date; and a CSV of it
// (subscription.offer.export). Staff with subscriptions:manage withdraw an offer not yet taken,
// with a reason. Offers come in with `cos subscriptions offers import`; nothing here makes one.
import type { CoreInput, CoreOutput } from "@composable-os/core";
import { Badge } from "@composable-os/ui/components/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@composable-os/ui/components/table";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DownloadIcon, MailIcon } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { downloadText } from "#/components/list/export-csv";
import { formatDate } from "#/lib/format";
import { callOp } from "#/lib/operations";
import { errorMessage, opKey, useOpMutation } from "#/lib/query";

type OfferStatus = NonNullable<CoreInput<"subscription.offer.list">["status"]>;
type Offer = CoreOutput<"subscription.offer.list">["items"][number];

const STATUSES: { value: OfferStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "taken", label: "Taken" },
  { value: "open", label: "Not yet" },
  { value: "expired", label: "Expired" },
  { value: "withdrawn", label: "Withdrawn" },
];

const STATUS_WORDS: Record<OfferStatus, string> = {
  taken: "Taken",
  open: "Not yet",
  expired: "Expired",
  withdrawn: "Withdrawn",
};

export function OffersTable() {
  const [status, setStatus] = useState<OfferStatus | "all">("all");
  const [exporting, setExporting] = useState(false);
  const [withdrawing, setWithdrawing] = useState<Offer | null>(null);
  const input: CoreInput<"subscription.offer.list"> = {
    ...(status === "all" ? {} : { status }),
    limit: 50,
  };
  const list = useInfiniteQuery({
    queryKey: opKey("subscription.offer.list", input),
    queryFn: ({ pageParam }) =>
      callOp("subscription.offer.list", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const counts = list.data?.pages[0]?.counts;

  async function onExport() {
    setExporting(true);
    try {
      const file = await callOp("subscription.offer.export", status === "all" ? {} : { status });
      downloadText(file.filename, file.csv);
      toast.success(`Downloaded ${file.rowCount} offer(s)`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        People moving their subscription from another platform: each continues here free until the
        date they paid up to there. End the old subscription of everyone marked taken, at its
        period's end; chase the rest before their date.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="flex flex-wrap gap-2" aria-label="Offer status">
          {STATUSES.map((s) => (
            <Button
              key={s.value}
              size="sm"
              variant={status === s.value ? "default" : "outline"}
              onClick={() => setStatus(s.value)}
              aria-pressed={status === s.value}
            >
              {s.label}
              {counts && s.value !== "all" ? ` (${counts[s.value]})` : ""}
            </Button>
          ))}
        </fieldset>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => void onExport()}
          disabled={exporting}
        >
          <DownloadIcon className="size-4" aria-hidden />
          Download CSV
        </Button>
      </div>
      {list.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : list.isError && !items.length ? (
        <ErrorState
          title="Could not load the offers"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : !items.length ? (
        <EmptyState
          icon={MailIcon}
          title="No continuation offers"
          description="Import them with cos subscriptions offers import (docs/importing.md)."
        />
      ) : (
        <div className="rounded-md border">
          <Table aria-label="Continuation offers">
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Paid up to</TableHead>
                <TableHead>Charged from</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((o) => (
                <TableRow key={o.id} data-testid="offer-row" data-status={o.status}>
                  <TableCell>
                    {o.personId ? (
                      <Link
                        to="/people/$id"
                        params={{ id: o.personId }}
                        className="font-medium hover:underline"
                      >
                        {o.email}
                      </Link>
                    ) : (
                      o.email
                    )}
                    {o.personName ? (
                      <span className="ml-2 text-xs text-muted-foreground">{o.personName}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={o.status === "taken" ? "default" : "secondary"}>
                      {STATUS_WORDS[o.status]}
                    </Badge>
                    {o.page ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {o.page === "open"
                          ? "checkout open"
                          : o.page === "completing"
                            ? "being confirmed"
                            : "checkout not confirmed closed"}
                      </span>
                    ) : null}
                    {o.reissuedAs ? (
                      <span className="ml-2 text-xs text-muted-foreground">reissued</span>
                    ) : null}
                    {o.subscribedWithout ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        subscribed without it
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>{formatDate(o.freeUntil)}</TableCell>
                  <TableCell>
                    {o.subscriptionId ? (
                      <Link
                        to="/subscriptions/$id"
                        params={{ id: o.subscriptionId }}
                        className="hover:underline"
                      >
                        {o.chargedFromStart
                          ? `${formatDate(o.chargesFrom)} (at once)`
                          : formatDate(o.chargesFrom)}
                      </Link>
                    ) : (
                      ""
                    )}
                  </TableCell>
                  <TableCell>{o.reference ?? ""}</TableCell>
                  <TableCell className="text-right">
                    {o.status === "open" || o.status === "expired" ? (
                      <Button size="sm" variant="ghost" onClick={() => setWithdrawing(o)}>
                        Withdraw
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {list.hasNextPage && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
      <WithdrawDialog offer={withdrawing} onDone={() => setWithdrawing(null)} />
    </div>
  );
}

function WithdrawDialog({ offer, onDone }: { offer: Offer | null; onDone: () => void }) {
  const withdraw = useOpMutation("subscription.offer.withdraw", {
    invalidates: ["subscription.offer.list"],
  });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!offer) return;
    setError(null);
    try {
      const out = await withdraw.mutateAsync({ id: offer.id, reason: reason.trim() });
      toast.success(
        out.pageOpen
          ? "Withdrawn. A checkout from it was open: if it is completed you will be told."
          : "Withdrawn",
      );
      setReason("");
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <Dialog open={offer !== null} onOpenChange={(open) => !open && onDone()}>
      <DialogContent>
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Withdraw this offer?</DialogTitle>
            <DialogDescription>
              {offer
                ? `${offer.email} will no longer be able to continue free until ${formatDate(offer.freeUntil)}.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="offer-withdraw-reason">Reason</Label>
            <Input
              id="offer-withdraw-reason"
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
            <Button type="submit" disabled={withdraw.isPending || !reason.trim()}>
              Withdraw
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
