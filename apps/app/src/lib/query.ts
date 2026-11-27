// TanStack Query over operations. Every read goes through `useOp` (keyed by operation name and
// input) and every write through `useOpMutation`, so cache invalidation is by operation name:
// `invalidateOps(client, "person.")` refetches every person.* query after a write.
import type { CoreInput, CoreOperationName, CoreOutput } from "@composable-os/core";
import {
  QueryClient,
  type QueryKey,
  type UseQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { callOp, OperationCallError } from "./operations.ts";

/** A read refused while the host still installs its packs is retried this often, this many times. */
const INSTALLING_RETRY_MS = 5_000;
const INSTALLING_RETRIES = 6;

/** Whether an operation was refused because the host is still installing its packs. */
export function installing(error: unknown): boolean {
  return (
    error instanceof OperationCallError &&
    (error.details as { installing?: unknown } | undefined)?.installing === true
  );
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // Typed operation errors (forbidden, not_found, ...) will not fix themselves on retry,
        // except "still installing its packs" (issue #558): asked again every few seconds for
        // up to 30 s. Writes are never retried.
        retry: (failures, error) =>
          installing(error)
            ? failures < INSTALLING_RETRIES
            : !(error instanceof OperationCallError) && failures < 2,
        retryDelay: (failures, error) =>
          installing(error) ? INSTALLING_RETRY_MS : Math.min(1000 * 2 ** failures, 30_000),
      },
    },
  });
}

/** Query key for an operation call: `["op", name, input]`. */
export function opKey<N extends CoreOperationName>(name: N, input?: CoreInput<N>): QueryKey {
  return input === undefined ? ["op", name] : ["op", name, input];
}

/** Refetches every cached query whose operation name starts with `prefix` (e.g. "person."). */
export function invalidateOps(client: QueryClient, prefix: string): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === "op" &&
      typeof query.queryKey[1] === "string" &&
      query.queryKey[1].startsWith(prefix),
  });
}

/** Runs a read operation as a query. */
export function useOp<N extends CoreOperationName>(
  name: N,
  input: CoreInput<N>,
  options: Omit<UseQueryOptions<CoreOutput<N>, Error>, "queryKey" | "queryFn"> = {},
) {
  return useQuery<CoreOutput<N>, Error>({
    queryKey: opKey(name, input),
    queryFn: () => callOp(name, input),
    ...options,
  });
}

/** The read operations that page by cursor: `cursor` in, `nextCursor` out. */
type PagedOperationName = {
  [N in CoreOperationName]: CoreInput<N> extends { cursor?: string | undefined }
    ? CoreOutput<N> extends { nextCursor: string | null }
      ? N
      : never
    : never;
}[CoreOperationName];

/** Runs a cursor-paged read as an infinite query, under the same key as `useOp` would use. */
export function useInfiniteOp<N extends PagedOperationName>(
  name: N,
  input: CoreInput<N>,
  options: { staleTime?: number } = {},
) {
  return useInfiniteQuery({
    queryKey: opKey(name, input),
    queryFn: ({ pageParam }) =>
      // The cursor is the one field every paged input has (PagedOperationName).
      callOp(name, { ...input, ...(pageParam ? { cursor: pageParam } : {}) } as CoreInput<N>),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: CoreOutput<N>) => page.nextCursor ?? undefined,
    ...options,
  });
}

/**
 * Reads every write can change besides its own object: the audit log and History tabs, timelines
 * (system activities for tracked fields, job changes, task completion), Trash, and search.
 */
export const WRITE_SIDE_EFFECTS = ["audit.", "activity.", "trash.", "search."] as const;

/** Refetches what any write may have changed: its object's queries plus WRITE_SIDE_EFFECTS. */
export function invalidateAfterWrite(
  client: QueryClient,
  name: string,
  extra: readonly string[] = [],
): Promise<void> {
  const object = `${name.split(".")[0]}.`;
  const prefixes = new Set([object, ...WRITE_SIDE_EFFECTS, ...extra]);
  return Promise.all([...prefixes].map((prefix) => invalidateOps(client, prefix))).then(
    () => undefined,
  );
}

/**
 * Runs a write operation as a mutation. On success it invalidates queries for the operation's
 * object (`person.update` → every `person.*` query), the side effects every write may have
 * (audit, timelines, Trash, search) and any extra `invalidates` prefixes.
 */
export function useOpMutation<N extends CoreOperationName>(
  name: N,
  { invalidates = [] }: { invalidates?: string[] } = {},
) {
  const client = useQueryClient();
  return useMutation<CoreOutput<N>, Error, CoreInput<N>>({
    mutationFn: (input) => callOp(name, input),
    onSuccess: () => invalidateAfterWrite(client, name, invalidates),
  });
}

/** A short, user-facing message for any error from an operation call. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
