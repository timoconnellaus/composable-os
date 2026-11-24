// The Deals pack's headless entry (stage 23, ADR 0418): functions and hooks over the typed client,
// no markup. A client app imports it as `@composable-os/pack-deals/client` and hands it
// its generated staff client; its screens render what it returns.
//
// The convention for every pack:
// - The operations it uses are typed from the pack's own schemas (`z.input`, `z.output` of its
//   tools), so the entry and the host cannot disagree, and it needs nothing generated.
// - It takes the client as an argument and imports no React and no TanStack package: the hooks
//   are built from the app's own `useQuery`, so any version of the library fits.
// - It holds no rules. What a deal may do is the host's; this only reads and shapes.
import type { z } from "@composable-os/sdk";
import type { stageMetrics } from "../tools.ts";

/** The operations this entry calls, as the generated client types them. */
export type DealsOperations = {
  "x.deals.stageMetrics": {
    kind: "query";
    input: z.input<typeof stageMetrics.input>;
    output: z.output<typeof stageMetrics.output>;
  };
};

export type StageMetrics = DealsOperations["x.deals.stageMetrics"]["output"];

/** The part of a generated staff client this entry needs. A product's staff client fits it. */
export interface DealsClient {
  query<N extends keyof DealsOperations & string>(
    name: N,
    input: DealsOperations[N]["input"],
  ): { queryKey: readonly unknown[]; queryFn: () => Promise<DealsOperations[N]["output"]> };
}

/** `queryOptions` for a pipeline's stage metrics, optionally from a date (YYYY-MM-DD). */
export function stageMetricsQuery(api: DealsClient, pipelineId: string, since?: string) {
  return api.query("x.deals.stageMetrics", since ? { pipelineId, since } : { pipelineId });
}

/** One line per stage for a funnel: share of deals that entered it, in pipeline order. */
export function funnel(metrics: StageMetrics): { stage: string; entered: number; share: number }[] {
  const top = Math.max(1, ...metrics.stages.map((s) => s.entered));
  return metrics.stages.map((s) => ({
    stage: s.stage,
    entered: s.entered,
    share: Math.round((s.entered / top) * 1000) / 1000,
  }));
}

/** The app's `useQuery`, as far as these hooks use it. */
export type UseQuery = <T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
}) => {
  data: T | undefined;
  isPending: boolean;
  error: unknown;
};

/** Hooks for a React or React Native app: `const deals = createDealsHooks(useQuery, api)`. */
export function createDealsHooks(useQuery: UseQuery, api: DealsClient) {
  return {
    useStageMetrics(pipelineId: string, since?: string) {
      return useQuery(stageMetricsQuery(api, pipelineId, since));
    },
    useFunnel(pipelineId: string, since?: string) {
      const result = useQuery(stageMetricsQuery(api, pipelineId, since));
      return { ...result, data: result.data ? funnel(result.data) : undefined };
    },
  };
}
