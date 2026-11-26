// Settings → Inbox (stage 36 step 3, ADR 0749): the shared inbox's settings, a human admin's
// (inbox.settings.get and .update, audited). This step keeps the categories conversations are
// filed under. The inbox's addresses, the reopen window and the auto-acknowledgement (step 2),
// chat on or off (step 4), and reply targets with opening hours (step 5) join this page with them.
import { Button } from "@composable-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@composable-os/ui/components/card";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { same } from "#/lib/draft";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/inbox")({ component: InboxSettingsPage });

const MAX_CATEGORIES = 50;

function InboxSettingsPage() {
  const settings = useOp("inbox.settings.get", {});
  return (
    <PageLayout
      title="Inbox"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="How the shared inbox files its conversations."
    >
      {settings.isPending ? (
        <Skeleton className="h-48" aria-busy="true" />
      ) : settings.isError ? (
        <ErrorState
          title="Could not load the inbox's settings"
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <CategoriesCard saved={settings.data.categories} />
      )}
    </PageLayout>
  );
}

function CategoriesCard({ saved }: { saved: string[] }) {
  const update = useOpMutation("inbox.settings.update");
  const [draft, setDraft] = useState<string[]>(saved);
  const [adding, setAdding] = useState("");
  const dirty = !same(draft, saved);

  function add(event: FormEvent) {
    event.preventDefault();
    const name = adding.trim();
    if (!name) return;
    if (draft.some((c) => c.toLowerCase() === name.toLowerCase())) {
      toast.error(`${name} is already on the list`);
      return;
    }
    setDraft([...draft, name]);
    setAdding("");
  }

  function move(index: number, by: -1 | 1) {
    const next = [...draft];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(index + by, 0, item);
    setDraft(next);
  }

  async function save() {
    try {
      const out = await update.mutateAsync({ categories: draft });
      setDraft(out.categories);
      toast.success("Categories saved");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Categories</CardTitle>
        <p className="text-sm text-muted-foreground">
          What a conversation is filed under (bookings, payments, an injury), in the order staff see
          them. A conversation filed under one you take off keeps it until someone changes it.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        {draft.length === 0 ? (
          <p className="text-sm text-muted-foreground">No categories yet.</p>
        ) : (
          <ul className="grid gap-1" aria-label="Categories">
            {draft.map((name, i) => (
              <li
                key={name}
                className="flex items-center gap-2 rounded-md border px-3 py-1.5"
                data-testid="inbox-category"
              >
                <span className="flex-1 truncate text-sm">{name}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${name} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${name} down`}
                  disabled={i === draft.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${name}`}
                  onClick={() => setDraft(draft.filter((c) => c !== name))}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form className="flex items-end gap-2" onSubmit={add}>
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="new-category">New category</Label>
            <Input
              id="new-category"
              value={adding}
              maxLength={40}
              onChange={(e) => setAdding(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={!adding.trim() || draft.length >= MAX_CATEGORIES}
          >
            <PlusIcon />
            Add
          </Button>
        </form>
        <div className="flex justify-end gap-2">
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(saved)}>
              Discard
            </Button>
          )}
          <Button onClick={() => void save()} disabled={!dirty || update.isPending}>
            Save categories
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
