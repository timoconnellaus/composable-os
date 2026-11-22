// A Person's subscriptions (stage 32a): the ones they pay for or hold, newest first, each with its
// state and a link to its page, where staff with subscriptions:manage cancel or keep it going.
// Shown only when the Person has one.
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Link } from "@tanstack/react-router";
import { formatMoney } from "#/lib/money";
import { useOp } from "#/lib/query";
import { SubscriptionStateBadge } from "./subscription-state-badge";

export function PersonSubscriptionsCard({ personId }: { personId: string }) {
  const subs = useOp(
    "subscription.list",
    {
      filter: {
        or: [
          { field: "payerPersonId", op: "eq", value: personId },
          { field: "holderPersonId", op: "eq", value: personId },
        ],
      },
      sort: { field: "createdAt", direction: "desc" },
      limit: 20,
    },
    { staleTime: 30_000 },
  );
  if (subs.isPending || subs.error || !subs.data.items.length) return null;
  return (
    <Card className="gap-3 py-4" data-testid="person-subscriptions">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Subscriptions</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 px-4 text-sm">
        {subs.data.items.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-2">
            <Link
              to="/subscriptions/$id"
              params={{ id: s.id }}
              className="truncate font-medium hover:underline"
            >
              {s.planTitle}
            </Link>
            <SubscriptionStateBadge state={s.state} />
            <span className="text-muted-foreground">
              {`${formatMoney(s.amount, s.currency)} / ${s.interval}`}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
