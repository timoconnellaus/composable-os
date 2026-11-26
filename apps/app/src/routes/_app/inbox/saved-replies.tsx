// Saved replies (stage 36 step 3, ADR 0749): the inbox's shared ones and your own, by title
// (savedReply.list). Everyone who works the inbox keeps their own; admins write the shared ones.
// Their words take only the fixed slots (the person's first name, your first name, the business's
// name), which the host fills when one goes into a reply. Archived ones are kept and no longer
// offered in the reply box.
import type { CoreOutput } from "@composable-os/core";
import { Badge } from "@composable-os/ui/components/badge";
import { Button } from "@composable-os/ui/components/button";
import { Checkbox } from "@composable-os/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@composable-os/ui/components/dialog";
import { Input } from "@composable-os/ui/components/input";
import { Label } from "@composable-os/ui/components/label";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { Switch } from "@composable-os/ui/components/switch";
import { Tabs, TabsList, TabsTrigger } from "@composable-os/ui/components/tabs";
import { Textarea } from "@composable-os/ui/components/textarea";
import { createFileRoute } from "@tanstack/react-router";
import { MessageSquareTextIcon, PlusIcon } from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { CHANNEL_LABELS, type ConversationChannel } from "#/components/inbox/labels";
import { PageLayout } from "#/components/layout/page-layout";
import { errorMessage, useInfiniteOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/inbox/saved-replies")({ component: SavedRepliesPage });

type SavedReply = CoreOutput<"savedReply.list">["items"][number];
type Scope = "all" | "shared" | "mine";

const SLOTS = [
  { slot: "person.firstName", label: "Their first name" },
  { slot: "staff.firstName", label: "Your first name" },
  { slot: "business.name", label: "Business name" },
] as const;
const CHANNELS: ConversationChannel[] = ["email", "chat"];

function SavedRepliesPage() {
  const { isAdmin } = Route.useRouteContext();
  const [scope, setScope] = useState<Scope>("all");
  const [archived, setArchived] = useState(false);
  // null: closed; "new": a new one; otherwise the one being edited.
  const [editing, setEditing] = useState<SavedReply | "new" | null>(null);

  return (
    <PageLayout
      title="Saved replies"
      width="md"
      back={{ to: "/inbox", label: "Inbox" }}
      description={
        isAdmin
          ? "Ready words for a reply: the inbox's shared ones, which you keep, and your own."
          : "Ready words for a reply: the inbox's shared ones, which admins keep, and your own."
      }
      actions={
        <Button size="sm" onClick={() => setEditing("new")}>
          <PlusIcon />
          New saved reply
        </Button>
      }
      tabs={
        <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="shared">Shared</TabsTrigger>
            <TabsTrigger value="mine">Mine</TabsTrigger>
          </TabsList>
        </Tabs>
      }
      toolbar={
        <div className="flex items-center gap-2">
          <Switch id="show-archived" checked={archived} onCheckedChange={setArchived} />
          <Label htmlFor="show-archived">Show archived</Label>
        </div>
      }
    >
      <SavedReplyList scope={scope} archived={archived} onEdit={setEditing} />
      {editing && (
        <SavedReplyDialog
          reply={editing === "new" ? null : editing}
          mayShare={isAdmin}
          onClose={() => setEditing(null)}
        />
      )}
    </PageLayout>
  );
}

function SavedReplyList({
  scope,
  archived,
  onEdit,
}: {
  scope: Scope;
  archived: boolean;
  onEdit: (reply: SavedReply) => void;
}) {
  const list = useInfiniteOp("savedReply.list", { scope, archived, limit: 50 });
  const archive = useOpMutation("savedReply.archive");
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  async function setArchivedOn(reply: SavedReply, on: boolean) {
    try {
      await archive.mutateAsync({ id: reply.id, archived: on, version: reply.version });
      toast.success(on ? `${reply.title} archived` : `${reply.title} is offered again`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  if (list.isPending) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  }
  if (list.isError && !items.length) {
    return (
      <ErrorState
        title="Could not load saved replies"
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  }
  if (!items.length) {
    return (
      <EmptyState
        icon={MessageSquareTextIcon}
        title={archived ? "No archived saved replies" : "No saved replies yet"}
        description={archived ? undefined : "Save the words you write again and again."}
      />
    );
  }
  return (
    <div className="grid gap-3">
      <ul className="grid gap-3" aria-label="Saved replies">
        {items.map((reply) => (
          <li
            key={reply.id}
            className="grid gap-2 rounded-md border p-3"
            data-testid="saved-reply"
            data-saved-reply={reply.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{reply.title}</span>
              <Badge variant={reply.shared ? "secondary" : "outline"}>
                {reply.shared ? "Shared" : "Yours"}
              </Badge>
              {reply.channels.map((c) => (
                <Badge key={c} variant="outline">
                  {CHANNEL_LABELS[c]}
                </Badge>
              ))}
              {reply.canEdit && (
                <div className="ml-auto flex gap-2">
                  {!reply.archived && (
                    <Button variant="outline" size="sm" onClick={() => onEdit(reply)}>
                      Edit
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={archive.isPending}
                    onClick={() => void setArchivedOn(reply, !reply.archived)}
                  >
                    {reply.archived ? "Restore" : "Archive"}
                  </Button>
                </div>
              )}
            </div>
            <p className="line-clamp-3 text-sm whitespace-pre-wrap text-muted-foreground">
              {reply.body}
            </p>
          </li>
        ))}
      </ul>
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

function SavedReplyDialog({
  reply,
  mayShare,
  onClose,
}: {
  reply: SavedReply | null;
  mayShare: boolean;
  onClose: () => void;
}) {
  const create = useOpMutation("savedReply.create");
  const update = useOpMutation("savedReply.update");
  const [title, setTitle] = useState(reply?.title ?? "");
  const [body, setBody] = useState(reply?.body ?? "");
  const [channels, setChannels] = useState<ConversationChannel[]>(reply?.channels ?? CHANNELS);
  const [shared, setShared] = useState(reply?.shared ?? false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const busy = create.isPending || update.isPending;

  function insertSlot(slot: string) {
    const token = `{{${slot}}}`;
    const el = bodyRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      if (reply) {
        await update.mutateAsync({ id: reply.id, title, body, channels, version: reply.version });
        toast.success("Saved reply changed");
      } else {
        await create.mutateAsync({ title, body, channels, shared });
        toast.success("Reply saved");
      }
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{reply ? "Edit saved reply" : "New saved reply"}</DialogTitle>
            <DialogDescription>
              Plain words, with slots the inbox fills in for each conversation.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="reply-title">Title</Label>
            <Input
              id="reply-title"
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reply-body">Words</Label>
            <Textarea
              id="reply-body"
              ref={bodyRef}
              value={body}
              rows={8}
              maxLength={10_000}
              onChange={(e) => setBody(e.target.value)}
              required
            />
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">Insert:</span>
              {SLOTS.map((s) => (
                <Button
                  key={s.slot}
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => insertSlot(s.slot)}
                >
                  {s.label}
                </Button>
              ))}
            </div>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Fits</legend>
            <div className="flex gap-4">
              {CHANNELS.map((c) => (
                <div key={c} className="flex items-center gap-2">
                  <Checkbox
                    id={`fits-${c}`}
                    checked={channels.includes(c)}
                    onCheckedChange={(on) =>
                      setChannels((list) =>
                        on === true ? [...new Set([...list, c])] : list.filter((x) => x !== c),
                      )
                    }
                  />
                  <Label htmlFor={`fits-${c}`}>{CHANNEL_LABELS[c]}</Label>
                </div>
              ))}
            </div>
          </fieldset>
          {!reply && mayShare && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="reply-shared"
                checked={shared}
                onCheckedChange={(on) => setShared(on === true)}
              />
              <Label htmlFor="reply-shared">Shared with everyone on the inbox</Label>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !title.trim() || !body.trim() || channels.length === 0}
            >
              {reply ? "Save changes" : "Save reply"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
