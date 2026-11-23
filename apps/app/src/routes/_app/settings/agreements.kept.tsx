// Settings → Agreements → Kept after erase (stage 44 step 8, ADR 0646): how long an erased
// person's acceptances are kept as the business's evidence (a human admin sets it), and finding a
// kept one by the address or the name it holds, for a dispute or a claim, to hold it from the
// purge. The host checks everything: finding and holding need agreements:manage and a person,
// the setting an admin; every search is audited.
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/agreements/kept")({
  component: KeptPage,
});

function KeptPage() {
  return (
    <PageLayout
      title="Kept after erase"
      width="md"
      back={{ to: "/settings/agreements", label: "Agreements" }}
      description="When a person is erased, their health answers go at once; what they agreed to is kept, no longer theirs, as the business's evidence until the period below ends, then deleted."
    >
      <Retention />
      <Find />
    </PageLayout>
  );
}

function Retention() {
  const retention = useOp("agreement.retention", {});
  const save = useOpMutation("agreement.setRetention", { invalidates: ["agreement."] });
  const [years, setYears] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      { years: Number(years) },
      {
        onSuccess: () => toast.success("Saved"),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>How long they are kept</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {retention.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : retention.isError ? (
          <p className="text-destructive">{errorMessage(retention.error)}</p>
        ) : (
          <p data-testid="agreement-retention">
            {retention.data?.years === null
              ? "The setting cannot be read, so nothing is deleted."
              : `${retention.data?.years} years from each erase.`}{" "}
            {retention.data?.kept ?? 0} kept now, {retention.data?.held ?? 0} on hold.
          </p>
        )}
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="keep-years">Years (1 to 50)</Label>
            <Input
              id="keep-years"
              type="number"
              min={1}
              max={50}
              className="w-28"
              value={years}
              onChange={(e) => setYears(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" disabled={!years || save.isPending}>
            Save
          </Button>
        </form>
        <p className="text-muted-foreground">
          Admins only. A shorter period deletes evidence for good at the next daily run. How long to
          keep it is a question for the business's lawyer.
        </p>
      </CardContent>
    </Card>
  );
}

function Find() {
  const [query, setQuery] = useState<{ email?: string; name?: string } | null>(null);
  const [text, setText] = useState("");
  const found = useOp("agreement.kept.find", query ?? { name: "--" }, { enabled: query !== null });
  const hold = useOpMutation("agreement.kept.hold", { invalidates: ["agreement."] });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setQuery(value.includes("@") ? { email: value } : { name: value });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Find a kept agreement</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="kept-find">The address the copy went to, or the name typed</Label>
            <Input
              id="kept-find"
              className="w-72"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" disabled={!text.trim()}>
            Find
          </Button>
        </form>
        {query === null ? null : found.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : found.isError ? (
          <p className="text-destructive">{errorMessage(found.error)}</p>
        ) : found.data?.items.length ? (
          <ul className="divide-y" data-testid="kept-agreements">
            {found.data.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-medium">
                  {item.title}, version {item.versionNumber}
                </span>
                <span className="text-muted-foreground">
                  agreed {formatDateTime(item.acceptedAt)}; erased {formatDateTime(item.erasedAt)}
                </span>
                {item.held ? (
                  <Badge variant="secondary">On hold</Badge>
                ) : item.until ? (
                  <span className="text-muted-foreground">
                    kept until {formatDateTime(item.until)}
                  </span>
                ) : null}
                <code className="text-xs">{item.id}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={hold.isPending}
                  onClick={() =>
                    hold.mutate(
                      { acceptanceId: item.id, held: !item.held },
                      { onError: (error) => toast.error(errorMessage(error)) },
                    )
                  }
                >
                  {item.held ? "Release" : "Hold"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Nothing kept matches.</p>
        )}
      </CardContent>
    </Card>
  );
}
