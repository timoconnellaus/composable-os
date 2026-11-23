// Settings → Routine email (admins; ADR 0590): the fixed emails the shipped packs send members
// without a person's approval (a booking's confirmation, a class reminder), each kind with its
// switch and what it sent in the last week; the business's own site, the only place they link
// to; and the log of what went out on its own and what was held for a person. Changing a switch
// or the site is a human admin's only (routineMail.settings.update).
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@composable-os/ui/components/card";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { Switch } from "@composable-os/ui/components/switch";
import { createFileRoute } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { EmptyState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/routine-email")({
  component: RoutineEmailPage,
});

function RoutineEmailPage() {
  const { isAdmin } = Route.useRouteContext();
  return (
    <PageLayout
      title="Routine email"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="The fixed emails your packs send members on their own: confirmations, changes, cancellations and reminders."
    >
      {isAdmin ? (
        <div className="grid gap-6">
          <KindsCard />
          <SiteCard />
          <LogCard />
        </div>
      ) : (
        <p
          className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
        >
          <LockIcon className="size-4" aria-hidden />
          Only admins can see routine email.
        </p>
      )}
    </PageLayout>
  );
}

const POLICY: Record<"auto" | "review" | "deny", string> = {
  auto: "Routine email goes out on its own. Everything else a pack or the assistant sends still waits for approval.",
  review:
    "Each routine email waits for approval now: your approval policy is Cautious, or this deployment's floor reviews outbound actions.",
  deny: "No routine email is sent: this deployment's floor refuses outbound actions.",
};

function KindsCard() {
  const state = useOp("routineMail.get", {});
  const update = useOpMutation("routineMail.settings.update");
  if (state.isPending) return <Skeleton className="h-48" />;
  if (state.isError) {
    return (
      <EmptyState title="Could not load routine email" description={errorMessage(state.error)} />
    );
  }
  const { kinds, sendsOnItsOwn } = state.data;

  async function toggle(id: string, on: boolean) {
    try {
      await update.mutateAsync({ kinds: { [id]: on } });
      toast.success(on ? "Turned on" : "Turned off: it is not sent, and not queued");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>What is sent on its own</CardTitle>
        <CardDescription>
          Each email's words are fixed by its pack, and it goes only to the person the record is
          about (and their parents or guardians), never to an address anyone types. One with
          anything unusual in it (a link in a name, more than 20 to one person in a day, a change an
          AI made that nobody approved) waits in Approvals instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p
          className="rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
          data-testid="routine-policy"
        >
          {POLICY[sendsOnItsOwn]}
        </p>
        {kinds.length === 0 ? (
          <p className="text-sm text-muted-foreground">No installed pack sends routine email.</p>
        ) : (
          <ul className="grid gap-3">
            {kinds.map((kind) => (
              <li
                key={kind.id}
                className="flex items-start justify-between gap-4 rounded-md border p-3"
                data-testid={`routine-kind-${kind.id}`}
              >
                <div className="grid gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor={`routine-${kind.id}`} className="font-medium">
                      {kind.label}
                    </Label>
                    <Badge variant="secondary">{kind.extensionLabel}</Badge>
                    {!kind.on && <Badge variant="outline">Off: not sent, not queued</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">{kind.description}</p>
                  <p className="text-xs text-muted-foreground">
                    Last 7 days: {kind.lastWeek.sent} sent, {kind.lastWeek.waiting} waiting for
                    approval, {kind.lastWeek.off} not sent while off
                    {kind.lastWeek.other ? `, ${kind.lastWeek.other} refused or failed` : ""}.
                  </p>
                </div>
                <Switch
                  id={`routine-${kind.id}`}
                  checked={kind.on}
                  disabled={update.isPending}
                  onCheckedChange={(on) => void toggle(kind.id, on)}
                  aria-label={`Send ${kind.label}`}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SiteCard() {
  const state = useOp("routineMail.get", {});
  const update = useOpMutation("routineMail.settings.update");
  const site = state.data?.siteOrigin;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("siteOrigin") ?? "").trim();
    try {
      await update.mutateAsync({ siteOrigin: value || null });
      toast.success(value ? "Saved. Routine email links only there." : "Removed: no links");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your site</CardTitle>
        <CardDescription>
          The only place routine email links to (a pack's "your bookings" page must be on it).
          Empty: the emails carry no link and say to sign in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.isPending ? (
          <Skeleton className="h-10" />
        ) : (
          <form onSubmit={onSubmit} className="flex items-end gap-2" key={site ?? ""}>
            <div className="grid flex-1 gap-2">
              <Label htmlFor="routine-site">Site address</Label>
              <Input
                id="routine-site"
                name="siteOrigin"
                type="url"
                placeholder="https://www.example.com"
                defaultValue={site ?? ""}
              />
            </div>
            <Button type="submit" variant="outline" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

const STATUS: Record<string, string> = {
  sent: "Sent",
  waiting: "Waiting for approval",
  off: "Not sent (off)",
  denied: "Refused",
  failed: "Failed",
  ready: "Sending",
  sending: "Sending",
};
const RULE: Record<string, string> = {
  person: "their own",
  guardian: "a parent or guardian",
  order: "the order's address",
};

function LogCard() {
  const log = useOp("routineMail.log", { limit: 50 });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recently</CardTitle>
        <CardDescription>
          Every routine email asked for: the record it is about, who it went to and why, what
          started it, and what became of it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {log.isPending ? (
          <Skeleton className="h-24" />
        ) : log.isError ? (
          <p className="text-sm text-destructive">{errorMessage(log.error)}</p>
        ) : log.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="grid gap-2 text-sm" data-testid="routine-log">
            {log.data.items.map((item) => (
              <li key={item.id} className="grid gap-0.5 border-b pb-2 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item.kind}</span>
                  <span className="text-muted-foreground">{item.message}</span>
                  <Badge variant={item.status === "sent" ? "secondary" : "outline"}>
                    {STATUS[item.status] ?? item.status}
                  </Badge>
                  {!item.routine && item.status !== "off" && <Badge variant="outline">Held</Badge>}
                </div>
                <span className="text-muted-foreground">
                  {formatDateTime(item.at)} · to {item.recipient} ({RULE[item.recipientRule]}) ·
                  about {item.object} {item.recordId} · started by {item.trigger}
                  {item.triggeredBy ? ` (${item.triggeredBy.actor})` : ""}
                </span>
                {item.heldReason && (
                  <span className="text-muted-foreground">Held: {item.heldReason}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
