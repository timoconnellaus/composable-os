// Settings → Agreements → Health forms (stage 44 step 2, ADR 0643): the People whose current
// health form has a yes, where a health notice sends staff. Only a person with
// agreements:health opens it (the host refuses anyone else), and every opening is audited.
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/agreements/health")({
  component: HealthFormsPage,
});

function HealthFormsPage() {
  const list = useOp("agreement.healthReviews", {});
  return (
    <PageLayout
      title="Health forms"
      width="md"
      back={{ to: "/settings/agreements", label: "Agreements" }}
      description="People who answered yes on their current health form. Open someone's Agreements tab to read the answers."
    >
      <Card>
        <CardHeader>
          <CardTitle>A yes to look at</CardTitle>
        </CardHeader>
        <CardContent>
          {list.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : list.isError ? (
            <p className="text-destructive text-sm">{errorMessage(list.error)}</p>
          ) : list.data?.items.length ? (
            <ul className="divide-y" data-testid="health-reviews">
              {list.data.items.map((item) => (
                <li key={item.acceptanceId} className="flex flex-wrap items-center gap-2 py-2">
                  <Link
                    to="/people/$id"
                    params={{ id: item.personId }}
                    search={{ tab: "agreements" }}
                    className="font-medium hover:underline"
                  >
                    {item.name ?? item.personId}
                  </Link>
                  <span className="text-muted-foreground text-sm">
                    {item.title}, {formatDateTime(item.acceptedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">No health form has a yes.</p>
          )}
        </CardContent>
      </Card>
    </PageLayout>
  );
}
