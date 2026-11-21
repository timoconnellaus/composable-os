// The Deals pack's client entry (headless hooks; stage 23, ADR 0418; under client/ since stage 24): functions and hooks over a typed client.
import { describe, expect, it } from "vitest";
import {
  createDealsHooks,
  type DealsClient,
  funnel,
  type StageMetrics,
  stageMetricsQuery,
  type UseQuery,
} from "../client/index.ts";

const metrics: StageMetrics = {
  pipelineId: "rec_pipe",
  stages: [
    {
      stageId: "a",
      stage: "Lead",
      type: "open",
      entered: 10,
      current: 4,
      avgDaysInStage: 2,
      avgDaysBeforeMovingOn: 1,
    },
    {
      stageId: "b",
      stage: "Proposal",
      type: "open",
      entered: 4,
      current: 2,
      avgDaysInStage: 5,
      avgDaysBeforeMovingOn: 3,
    },
    {
      stageId: "c",
      stage: "Won",
      type: "won",
      entered: 1,
      current: 1,
      avgDaysInStage: null,
      avgDaysBeforeMovingOn: null,
    },
  ],
  velocity: { won: 1, avgDaysToWin: 12, wonValue: 5000 },
};

/** A client as the generated one behaves: `[operation, input]` keys, the call behind them. */
const asked: unknown[] = [];
const api: DealsClient = {
  query(name, input) {
    asked.push([name, input]);
    return { queryKey: [name, input], queryFn: async () => metrics };
  },
};

describe("the Deals headless entry", () => {
  it("builds query options with the client's key rule", async () => {
    const q = stageMetricsQuery(api, "rec_pipe", "2026-01-01");
    expect(q.queryKey).toEqual([
      "x.deals.stageMetrics",
      { pipelineId: "rec_pipe", since: "2026-01-01" },
    ]);
    expect(await q.queryFn()).toBe(metrics);
    expect(stageMetricsQuery(api, "rec_pipe").queryKey).toEqual([
      "x.deals.stageMetrics",
      { pipelineId: "rec_pipe" },
    ]);
  });

  it("shapes a funnel from the metrics, and holds no markup", () => {
    expect(funnel(metrics)).toEqual([
      { stage: "Lead", entered: 10, share: 1 },
      { stage: "Proposal", entered: 4, share: 0.4 },
      { stage: "Won", entered: 1, share: 0.1 },
    ]);
  });

  it("hooks are the app's own useQuery over these options", () => {
    const calls: unknown[] = [];
    const useQuery: UseQuery = <T>(options: {
      queryKey: readonly unknown[];
      queryFn: () => Promise<T>;
    }) => {
      calls.push(options.queryKey);
      return { data: metrics as T, isPending: false, error: null };
    };
    const deals = createDealsHooks(useQuery, api);
    expect(deals.useFunnel("rec_pipe").data?.[1]).toEqual({
      stage: "Proposal",
      entered: 4,
      share: 0.4,
    });
    expect(deals.useStageMetrics("rec_pipe").data).toBe(metrics);
    expect(calls).toHaveLength(2);
  });
});
