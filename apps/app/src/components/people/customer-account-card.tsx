// A Person's customer account (stage 22, ADR 0402): whether they can sign in to a client app, and
// when they last did. Read-only, from customer.list, which only admins may call, so the card shows
// only for admins.
import { Badge } from "@composable-os/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { formatDateTime } from "#/lib/format";
import { useOp } from "#/lib/query";

export function CustomerAccountCard({ personId }: { personId: string }) {
  const accounts = useOp("customer.list", { personId, limit: 1 }, { staleTime: 30_000 });
  if (accounts.isPending || accounts.error) return null;
  const account = accounts.data.items[0];
  return (
    <Card className="gap-3 py-4" data-testid="customer-account">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Customer account</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1 px-4 text-sm">
        {account ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate">{account.email}</span>
              <Badge variant={account.status === "active" ? "outline" : "destructive"}>
                {account.status}
              </Badge>
              {account.linkState === "needs_merge" && <Badge variant="outline">needs merge</Badge>}
            </div>
            <p className="text-muted-foreground">
              {account.lastSignInAt
                ? `Last signed in ${formatDateTime(account.lastSignInAt)}`
                : "Never signed in"}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">No customer account</p>
        )}
      </CardContent>
    </Card>
  );
}
