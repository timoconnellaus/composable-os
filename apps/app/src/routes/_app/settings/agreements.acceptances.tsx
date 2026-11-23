// Settings → Agreements → Acceptances (stage 44 step 2, ADR 0642): who still has something due
// (members with a live subscription first), and every acceptance by document and by how it was
// made (paper marked). Titles, people and dates only: a name typed, a signature and health answers
// open from the Person page, one at a time.
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Label } from "@composable-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@composable-os/ui/components/select";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";
import { useOp } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/agreements/acceptances")({
  component: AcceptancesPage,
});

const ALL = "all";
const BY_LABELS: Record<string, string> = {
  self: "By themselves",
  guardian: "By a parent or guardian",
  paper: "Recorded from paper",
};
const REASONS: Record<string, string> = {
  never: "never agreed",
  agree_again: "agree again",
  ask_again: "asked again",
  guardian: "needs a guardian",
};

function AcceptancesPage() {
  const [documentId, setDocumentId] = useState(ALL);
  const [by, setBy] = useState(ALL);
  const docs = useOp("agreement.list", { retired: true });
  const filter = documentId === ALL ? {} : { documentId };
  const due = useOp("agreement.due.list", filter);
  const list = useOp("agreement.acceptances", {
    ...filter,
    ...(by === ALL ? {} : { by: by as "self" | "guardian" | "paper" }),
  });
  return (
    <PageLayout
      title="Acceptances"
      width="md"
      back={{ to: "/settings/agreements", label: "Agreements" }}
      description="Who still has to agree to what, and everything people agreed to."
    >
      <div className="flex flex-wrap gap-3">
        <div className="grid gap-1">
          <Label htmlFor="acceptance-document">Document</Label>
          <Select value={documentId} onValueChange={setDocumentId}>
            <SelectTrigger id="acceptance-document" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Every document</SelectItem>
              {docs.data?.items.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="acceptance-by">How</Label>
          <Select value={by} onValueChange={setBy}>
            <SelectTrigger id="acceptance-by" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any way</SelectItem>
              {Object.entries(BY_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Due</CardTitle>
        </CardHeader>
        <CardContent>
          {due.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : due.data?.items.length ? (
            <ul className="divide-y" data-testid="agreements-due">
              {due.data.items.map((item) => (
                <li key={item.personId} className="flex flex-wrap items-center gap-2 py-2">
                  <Link
                    to="/people/$id"
                    params={{ id: item.personId }}
                    search={{ tab: "agreements" }}
                    className="font-medium hover:underline"
                  >
                    {item.name}
                  </Link>
                  {item.subscribed && <Badge variant="secondary">member</Badge>}
                  <span className="text-muted-foreground text-sm">
                    {item.due
                      .map((d) => `${d.title} (${REASONS[d.reason] ?? d.reason})`)
                      .join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">Nobody has anything due.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Acceptances</CardTitle>
        </CardHeader>
        <CardContent>
          {list.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : list.data?.items.length ? (
            <ul className="divide-y" data-testid="agreements-acceptances">
              {list.data.items.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 py-2">
                  {a.personId ? (
                    <Link
                      to="/people/$id"
                      params={{ id: a.personId }}
                      search={{ tab: "agreements" }}
                      className="font-medium hover:underline"
                    >
                      {a.personName ?? a.personId}
                    </Link>
                  ) : (
                    <span>No longer on file</span>
                  )}
                  <span className="text-sm">
                    {a.title}, version {a.versionNumber}
                  </span>
                  <Badge variant={a.by === "paper" ? "outline" : "secondary"}>
                    {BY_LABELS[a.by] ?? a.by}
                  </Badge>
                  <span className="text-muted-foreground text-sm">
                    {formatDateTime(a.acceptedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">Nothing agreed yet.</p>
          )}
          {list.data?.next && (
            <p className="text-muted-foreground mt-2 text-sm">
              Showing the newest 50: narrow by document or how.
            </p>
          )}
        </CardContent>
      </Card>
      <Button asChild variant="outline" className="w-fit">
        <Link to="/settings/agreements">Back to documents</Link>
      </Button>
    </PageLayout>
  );
}
