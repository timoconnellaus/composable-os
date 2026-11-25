// Settings → Agreements → Acceptances (stage 44 step 2, ADR 0642): who still has something due
// (members with a live subscription first), and every acceptance by document and by how it was
// made (paper marked). Titles, people and dates only: a name typed, a signature and health answers
// open from the Person page, one at a time.
import type { CoreInput } from "@composable-os/core";
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
import { MARK_WORDS } from "#/components/agreements/person-agreements";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";
import { useOp } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/agreements/acceptances")({
  component: AcceptancesPage,
});

const ALL = "all";
type By = NonNullable<CoreInput<"agreement.acceptances">["by"]>;
const BY_LABELS: Record<By, string> = {
  self: "By themselves",
  guardian: "By a parent or guardian",
  guest: "With an order",
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
  // At the desk (stage 44 step 6, ADR 0649): only those, by mark, and by device or who started
  // the session (chosen from an acceptance's own line), so one account's pattern shows.
  const [where, setWhere] = useState(ALL);
  const [mark, setMark] = useState(ALL);
  const [deskBy, setDeskBy] = useState<{
    deviceId?: string;
    startedBy?: string;
    label: string;
  } | null>(null);
  const docs = useOp("agreement.list", { retired: true });
  const filter = documentId === ALL ? {} : { documentId };
  const due = useOp("agreement.due.list", filter);
  const list = useOp("agreement.acceptances", {
    ...filter,
    ...(by === ALL ? {} : { by: by as By }),
    ...(where === "desk" ? { channel: "desk" as const } : {}),
    ...(mark === ALL
      ? {}
      : { mark: mark as "changed_recently" | "created_that_day" | "staff_address" }),
    ...(deskBy?.deviceId ? { deviceId: deskBy.deviceId } : {}),
    ...(deskBy?.startedBy ? { startedBy: deskBy.startedBy } : {}),
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
        <div className="grid gap-1">
          <Label htmlFor="acceptance-where">Where</Label>
          <Select value={where} onValueChange={setWhere}>
            <SelectTrigger id="acceptance-where" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Anywhere</SelectItem>
              <SelectItem value="desk">At the desk</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="acceptance-mark">Mark</Label>
          <Select value={mark} onValueChange={setMark}>
            <SelectTrigger id="acceptance-mark" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any</SelectItem>
              {Object.entries(MARK_WORDS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {deskBy && (
          <div className="flex items-end">
            <Button variant="outline" size="sm" onClick={() => setDeskBy(null)}>
              {deskBy.label} ×
            </Button>
          </div>
        )}
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
                    {BY_LABELS[a.by]}
                  </Badge>
                  <span className="text-muted-foreground text-sm">
                    {formatDateTime(a.acceptedAt)}
                  </span>
                  {a.desk && (
                    <div className="grid w-full gap-1 text-sm" data-testid="desk-acceptance">
                      <span className="text-muted-foreground">{a.desk.words}</span>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setDeskBy({
                              deviceId: a.desk?.device.id ?? undefined,
                              label: `Device: ${a.desk?.device.name}`,
                            })
                          }
                        >
                          {a.desk.device.name}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setDeskBy({
                              startedBy: a.desk?.startedBy.id,
                              label: `Started by ${a.desk?.startedBy.name}`,
                            })
                          }
                        >
                          {a.desk.startedBy.name}
                        </Button>
                        {a.desk.marks.map((m) => (
                          <Badge key={m.kind} variant="outline">
                            {MARK_WORDS[m.kind] ?? m.kind}
                            {m.by ? ` (by ${m.by})` : ""}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
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
