// A Person's "Conversations" tab (stage 36 step 3): their conversations in the shared inbox, every
// status, most recent first (inbox.list with their id). Their messages are on the Timeline tab
// already; a private conversation the reader may not read is in neither.
import { Button } from "@composable-os/ui/components/button";
import { Skeleton } from "@composable-os/ui/components/skeleton";
import { Link } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";
import { useMemo } from "react";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { formatDateTime, formatRelative } from "#/lib/format";
import { useInfiniteOp } from "#/lib/query";
import { ChannelIcon, ConversationMarks, StatusBadge } from "./labels.tsx";

export function PersonConversations({ personId }: { personId: string }) {
  const list = useInfiniteOp("inbox.list", {
    view: "all",
    personId,
    status: ["open", "waiting", "closed"],
    limit: 25,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  if (list.isPending) return <Skeleton className="h-16" aria-busy="true" />;
  if (list.isError && !items.length) {
    return (
      <ErrorState
        title="Could not load their conversations"
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  }
  if (!items.length) return <EmptyState icon={InboxIcon} title="No conversations" />;
  return (
    <div className="grid gap-3">
      <ul className="divide-y rounded-md border" aria-label="Conversations">
        {items.map((c) => {
          const at = c.lastInboundAt ?? c.openedAt;
          return (
            <li key={c.id} data-testid="person-conversation">
              <Link
                to="/inbox/$id"
                params={{ id: c.id }}
                className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50"
              >
                <ChannelIcon channel={c.channel} />
                <span className="min-w-0 flex-1 truncate">{c.subject ?? "(no subject)"}</span>
                <ConversationMarks conversation={c} />
                <StatusBadge status={c.status} />
                <time
                  dateTime={at}
                  title={formatDateTime(at)}
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {formatRelative(at)}
                </time>
              </Link>
            </li>
          );
        })}
      </ul>
      {list.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
