// Settings → Agreements (stage 44 step 1, ADR 0640): the business's documents people agree to,
// each with its kind, state, the version in effect and where it is needed, and a new document.
// Anyone on the staff reads the list; writing and publishing need agreements:manage, which the
// host checks (a person publishes; the assistant can only draft).
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@composable-os/ui/components/select";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { KIND_LABELS } from "#/components/settings/agreement-labels";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/agreements/")({
  component: AgreementsPage,
});

function AgreementsPage() {
  const [showRetired, setShowRetired] = useState(false);
  const list = useOp("agreement.list", { retired: showRetired });
  const points = useOp("agreement.points", {});
  const labelOf = (point: string) =>
    points.data?.items.find((p) => p.point === point)?.label ?? point;
  return (
    <PageLayout
      title="Agreements"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="The documents people agree to, written by the business. A document is needed nowhere until a person publishes it and attaches it to a place."
    >
      <Button asChild variant="outline" className="w-fit">
        <Link to="/settings/agreements/acceptances">Acceptances and who has something due</Link>
      </Button>
      <Button asChild variant="outline" className="w-fit">
        <Link to="/settings/agreements/health">Health forms</Link>
      </Button>
      <Button asChild variant="outline" className="w-fit">
        <Link to="/settings/agreements/kept">Kept after erase</Link>
      </Button>
      <NewDocument />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Documents</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setShowRetired((v) => !v)}>
            {showRetired ? "Hide retired" : "Show retired"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {list.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : list.isError ? (
            <ErrorState
              title="Documents could not be loaded"
              error={list.error}
              onRetry={() => void list.refetch()}
            />
          ) : list.data?.items.length ? (
            <ul className="divide-y" data-testid="agreement-list">
              {list.data.items.map((doc) => (
                <li key={doc.id} className="flex flex-wrap items-center gap-2 py-3">
                  <Link
                    to="/settings/agreements/$id"
                    params={{ id: doc.id }}
                    className="font-medium hover:underline"
                  >
                    {doc.title}
                  </Link>
                  <Badge variant="secondary">{KIND_LABELS[doc.kind] ?? doc.kind}</Badge>
                  <Badge variant={doc.state === "live" ? "default" : "outline"}>{doc.state}</Badge>
                  <span className="text-muted-foreground text-sm">
                    {doc.current ? `Version ${doc.current.number}` : "Not published"}
                    {doc.scheduled
                      ? ` · version ${doc.scheduled.number} from ${formatDateTime(doc.scheduled.effectiveFrom)}`
                      : ""}
                  </span>
                  <span className="text-muted-foreground w-full text-sm">
                    {doc.points.length
                      ? `Needed: ${doc.points.map(labelOf).join(", ")}`
                      : "Needed nowhere yet"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">No documents yet.</p>
          )}
        </CardContent>
      </Card>
    </PageLayout>
  );
}

function NewDocument() {
  const navigate = useNavigate();
  const create = useOpMutation("agreement.create");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<keyof typeof KIND_LABELS>("terms");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const { id } = await create.mutateAsync({
        title,
        kind: kind as "terms" | "waiver" | "health" | "guardian" | "other",
      });
      setTitle("");
      await navigate({ to: "/settings/agreements/$id", params: { id } });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>New document</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
          <div className="grid min-w-60 flex-1 gap-1">
            <Label htmlFor="agreement-title">Title</Label>
            <Input
              id="agreement-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="agreement-kind">Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v)}>
              <SelectTrigger id="agreement-kind" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(KIND_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={create.isPending || !title.trim()}>
            Create draft
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
