// Subscriptions (stage 32a): every subscription the payment provider runs for this org, newest
// first (subscription.list), in the views staff need: all, trials, failing (past due or unpaid,
// the daily list of failing payments) and ending (set to end with their period). The state is the
// host's mirror of the provider's; nothing here moves one. The view lives in `?view=`, so the
// notifications' links land on it.
import type { CoreInput } from "@composable-os/core";
import { Button } from "@composable-os/ui/components/button";
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
import { RepeatIcon } from "lucide-react";
import { useMemo } from "react";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { SubscriptionStateBadge } from "#/components/subscriptions/subscription-state-badge";
import { formatDate } from "#/lib/format";
import { formatMoney } from "#/lib/money";
import { callOp } from "#/lib/operations";
import { opKey } from "#/lib/query";

type SubscriptionsView = "all" | "trials" | "failing" | "ending";
const VIEWS: readonly SubscriptionsView[] = ["all", "trials", "failing", "ending"];

type ListInput = CoreInput<"subscription.list">;

const FILTERS: Record<SubscriptionsView, ListInput["filter"] | undefined> = {
  all: undefined,
  trials: { field: "state", op: "eq", value: "trialing" },
  failing: { field: "state", op: "in", value: ["past_due", "unpaid"] },
  ending: {
    and: [
      { field: "cancelAtPeriodEnd", op: "eq", value: true },
      { field: "state", op: "in", value: ["trialing", "active", "past_due"] },
    ],
  },
};

const EMPTY: Record<SubscriptionsView, string> = {
  all: "No subscriptions yet",
  trials: "No one is on a trial",
  failing: "No payments are failing",
  ending: "No subscriptions are set to end",
};

export const Route = createFileRoute("/_app/subscriptions/")({
  validateSearch: (search: Record<string, unknown>): { view?: SubscriptionsView } =>
    VIEWS.includes(search.view as SubscriptionsView) && search.view !== "all"
      ? { view: search.view as SubscriptionsView }
      : {},
  component: SubscriptionsPage,
});

function SubscriptionsPage() {
  const { view = "all" } = Route.useSearch();
  const navigate = useNavigate({ from: "/subscriptions/" });
  return (
    <PageLayout
      title="Subscriptions"
      width="lg"
      description="What members pay for every period. The payment provider charges and retries; the state here follows what it confirms."
      tabs={
        <Tabs
          value={view}
          onValueChange={(next) =>
            navigate({
              search: next === "all" ? {} : { view: next as SubscriptionsView },
              replace: true,
            })
          }
        >
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="trials">Trials</TabsTrigger>
            <TabsTrigger value="failing">Failing</TabsTrigger>
            <TabsTrigger value="ending">Ending</TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      <SubscriptionsTable view={view} />
    </PageLayout>
  );
}

function SubscriptionsTable({ view }: { view: SubscriptionsView }) {
  const filter = FILTERS[view];
  const input: ListInput = {
    ...(filter ? { filter } : {}),
    sort:
      view === "failing"
        ? { field: "failingSince", direction: "asc" }
        : view === "all"
          ? { field: "createdAt", direction: "desc" }
          : { field: "currentPeriodEnd", direction: "asc" },
    limit: 50,
  };
  const list = useInfiniteQuery({
    queryKey: opKey("subscription.list", input),
    queryFn: ({ pageParam }) =>
      callOp("subscription.list", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  if (list.isPending) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (list.isError && !items.length) {
    return (
      <ErrorState
        title="Could not load subscriptions"
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  }
  if (!items.length) return <EmptyState icon={RepeatIcon} title={EMPTY[view]} />;
  return (
    <div className="grid gap-3">
      <div className="rounded-md border">
        <Table aria-label="Subscriptions">
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>{view === "failing" ? "Failing since" : "Period to"}</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((s) => (
              <TableRow key={s.id} data-testid="subscription-row">
                <TableCell>
                  <Link
                    to="/subscriptions/$id"
                    params={{ id: s.id }}
                    className="font-medium hover:underline"
                  >
                    {s.planTitle}
                  </Link>
                  {s.cancelAtPeriodEnd || s.cancelAt ? (
                    <span className="ml-2 text-xs text-muted-foreground">ending</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <SubscriptionStateBadge state={s.state} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {`${formatMoney(s.amount, s.currency)} / ${s.interval}`}
                </TableCell>
                <TableCell>{s.email ?? ""}</TableCell>
                <TableCell>
                  {formatDate(
                    (view === "failing" ? s.failingSince : (s.cancelAt ?? s.currentPeriodEnd)) ??
                      null,
                  )}
                </TableCell>
                <TableCell>{formatDate(s.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
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
    </div>
  );
}
