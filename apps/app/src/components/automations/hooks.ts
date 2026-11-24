// Data hooks for the automation and notification UI: every read and write of automation.* and
// notification.* lives here, so the shapes the pages consume are in one place.

import type { CoreInput, CoreOutput } from "@composable-os/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { callOp } from "#/lib/operations";
import { opKey, useOp, useOpMutation } from "#/lib/query";

export type AutomationList = CoreOutput<"automation.list">;
export type AutomationItem = AutomationList["items"][number];
export type AutomationDetailData = CoreOutput<"automation.get">;
export type RunData = CoreOutput<"automation.runs">["items"][number];
export type NotificationData = CoreOutput<"notification.list">["items"][number];

export function useAutomations() {
  return useOp("automation.list", {}, { refetchOnWindowFocus: true });
}

export function useAutomation(id: string) {
  return useOp("automation.get", { id }, { refetchOnWindowFocus: true });
}

/**
 * Enabled manual automations for an object: record-page buttons (`bulk` false or true) or list
 * bulk actions (`bulk` only). Failures (e.g. no automation operations yet) read as none.
 */
export function useManualAutomations(object: string, which: "record" | "bulk"): AutomationItem[] {
  const list = useOp("automation.list", { manualFor: object }, { staleTime: 60_000, retry: false });
  return useMemo(
    () =>
      (list.data?.items ?? []).filter(
        (a) =>
          a.status === "active" &&
          !list.data?.killSwitch &&
          a.manual &&
          a.manual.object === object &&
          (which === "record" || a.manual.bulk),
      ),
    [list.data, object, which],
  );
}

type RunsInput = Omit<CoreInput<"automation.runs">, "cursor">;

/** A paged list of runs (automation.runs), newest first. */
export function useRuns(input: RunsInput, options: { enabled?: boolean } = {}) {
  const query = useInfiniteQuery({
    queryKey: opKey("automation.runs", input),
    queryFn: ({ pageParam }) =>
      callOp("automation.runs", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    ...(options.enabled === false ? { enabled: false } : {}),
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  return { query, items };
}

/** One run by id (run detail). */
export function useRun(runId: string | undefined) {
  return useOp(
    "automation.runs",
    { runId: runId ?? "", limit: 1, includeTests: true },
    {
      enabled: Boolean(runId),
      refetchInterval: (q) => (isLive(q.state.data?.items[0]) ? 5000 : false),
    },
  );
}

function isLive(run: RunData | undefined): boolean {
  return Boolean(run && ["queued", "running"].includes(run.status));
}

export function useSetEnabled() {
  return {
    enable: useOpMutation("automation.enable"),
    disable: useOpMutation("automation.disable"),
  };
}

// --- Notifications -----------------------------------------------------------------------------

/** The bell's unread count: polled every 60 s while the page is visible, and on focus. */
export function useUnreadCount() {
  return useOp(
    "notification.unreadCount",
    {},
    {
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
      retry: false,
    },
  );
}

export function useNotifications(unreadOnly: boolean, limit = 30) {
  const input = { unreadOnly, limit };
  const query = useInfiniteQuery({
    queryKey: opKey("notification.list", input),
    queryFn: ({ pageParam }) =>
      callOp("notification.list", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchOnWindowFocus: true,
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  return { query, items };
}

/** Mark read: ids or all; refreshes the bell and every list. */
export function useMarkRead() {
  return useOpMutation("notification.markRead");
}
