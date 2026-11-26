// The shared inbox (stage 36 step 3): conversations with people by email and chat, most recent
// first (inbox.list), in three views (mine, unassigned, all) with filters by status, channel and
// category. The view lives in `?view=`, so links land on it. The list shows only what the host
// returns: a private conversation is there only for admins and whoever has it.
//
// The "due soon" view waits for reply targets (step 5), which set the due times it sorts by.
import { Button } from "@composable-os/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@composable-os/ui/components/select";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@composable-os/ui/components/tabs";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { InboxIcon, MessageSquareTextIcon, RotateCwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState } from "#/components/empty-state";
import {
  CHANNEL_LABELS,
  ChannelIcon,
  type ConversationChannel,
  ConversationMarks,
  type ConversationStatus,
  conversationWho,
  StatusBadge,
} from "#/components/inbox/labels";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime, formatRelative } from "#/lib/format";
import { useInfiniteOp, useOp } from "#/lib/query";

type InboxView = "mine" | "unassigned" | "all";
const VIEWS: readonly InboxView[] = ["mine", "unassigned", "all"];
const ANY = "any";
/** The status filter: open and waiting (the default), one status, or every status. */
type StatusFilter = "active" | ConversationStatus | typeof ANY;

const STATUS_FILTERS: Record<StatusFilter, { label: string; status: ConversationStatus[] }> = {
  active: { label: "Open and waiting", status: ["open", "waiting"] },
  open: { label: "Open", status: ["open"] },
  waiting: { label: "Waiting on them", status: ["waiting"] },
  closed: { label: "Closed", status: ["closed"] },
  any: { label: "Any status", status: ["open", "waiting", "closed"] },
};

export const Route = createFileRoute("/_app/inbox/")({
  validateSearch: (search: Record<string, unknown>): { view?: InboxView } =>
    VIEWS.includes(search.view as InboxView) && search.view !== "all"
      ? { view: search.view as InboxView }
      : {},
  component: InboxPage,
});

function InboxPage() {
  const { view = "all" } = Route.useSearch();
  const navigate = useNavigate({ from: "/inbox/" });
  const [status, setStatus] = useState<StatusFilter>("active");
  const [channel, setChannel] = useState<ConversationChannel | typeof ANY>(ANY);
  const [category, setCategory] = useState<string>(ANY);
  const categories = useOp("inbox.categories", {}, { staleTime: 60_000 });
  const { user } = Route.useRouteContext();
  const works = user.role !== "viewer";

  return (
    <PageLayout
      title="Inbox"
      width="lg"
      description="Email and chat from the people you serve, one conversation each."
      actions={
        works ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/inbox/saved-replies">
              <MessageSquareTextIcon />
              Saved replies
            </Link>
          </Button>
        ) : undefined
      }
      tabs={
        <Tabs
          value={view}
          onValueChange={(next) =>
            navigate({ search: next === "all" ? {} : { view: next as InboxView }, replace: true })
          }
        >
          <TabsList>
            <TabsTrigger value="mine">Mine</TabsTrigger>
            <TabsTrigger value="unassigned">Unassigned</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
      }
      toolbar={
        <>
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger size="sm" className="w-44" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(STATUS_FILTERS) as StatusFilter[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_FILTERS[s].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={channel}
            onValueChange={(v) => setChannel(v as ConversationChannel | typeof ANY)}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="Channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any channel</SelectItem>
              {(Object.keys(CHANNEL_LABELS) as ConversationChannel[]).map((c) => (
                <SelectItem key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(categories.data?.categories.length ?? 0) > 0 && (
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger size="sm" className="w-40" aria-label="Category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any category</SelectItem>
                {categories.data?.categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </>
      }
    >
      <ConversationList
        view={view}
        status={STATUS_FILTERS[status].status}
        channel={channel === ANY ? null : channel}
        category={category === ANY ? null : category}
      />
    </PageLayout>
  );
}

function Loading() {
  return (
    <div className="grid gap-2" aria-busy="true">
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </div>
  );
}

const EMPTY: Record<InboxView, string> = {
  mine: "You have no conversations here",
  unassigned: "Every conversation here has someone",
  all: "No conversations here",
};

function ConversationList({
  view,
  status,
  channel,
  category,
}: {
  view: InboxView;
  status: ConversationStatus[];
  channel: ConversationChannel | null;
  category: string | null;
}) {
  const input = {
    view,
    status,
    ...(channel ? { channel } : {}),
    ...(category ? { category } : {}),
    limit: 25,
  };
  const list = useInfiniteOp("inbox.list", input, { staleTime: 10_000 });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  if (list.isPending) return <Loading />;
  if (list.isError && !items.length) {
    return (
      <ErrorState
        title="Could not load the inbox"
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  }
  if (!items.length) {
    return (
      <EmptyState
        icon={InboxIcon}
        title={EMPTY[view]}
        description="Messages arrive here as people write to you."
      />
    );
  }
  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void list.refetch()}
          disabled={list.isFetching}
        >
          <RotateCwIcon />
          Refresh
        </Button>
      </div>
      <ul className="divide-y rounded-md border" aria-label="Conversations">
        {items.map((c) => {
          const at = c.lastInboundAt ?? c.openedAt;
          return (
            <li key={c.id} data-testid="conversation-row" data-conversation={c.id}>
              <Link
                to="/inbox/$id"
                params={{ id: c.id }}
                className="grid gap-1 px-4 py-3 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ChannelIcon channel={c.channel} />
                  <span className="min-w-0 truncate font-medium">{conversationWho(c)}</span>
                  <ConversationMarks conversation={c} />
                  <time
                    dateTime={at}
                    title={formatDateTime(at)}
                    className="ml-auto shrink-0 text-xs text-muted-foreground"
                  >
                    {formatRelative(at)}
                  </time>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {c.subject ?? "(no subject)"}
                  </span>
                  {c.category && (
                    <span className="text-xs text-muted-foreground">{c.category}</span>
                  )}
                  <span className="text-xs text-muted-foreground" data-testid="row-assignee">
                    {c.assignee ? (c.assignee.name ?? "Someone") : "Unassigned"}
                  </span>
                  <StatusBadge status={c.status} />
                </div>
              </Link>
            </li>
          );
        })}
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
