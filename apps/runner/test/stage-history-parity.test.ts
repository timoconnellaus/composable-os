// Stage 25, acceptance criterion 2: the proof that moving `stages` onto the transition engine and
// `core_stage_history` onto the engine's one history table changed nothing Deals reads.
//
// The expected values below were recorded on the tree before the engine existed (commit ae850f2)
// and have not been edited since. The seed is deterministic (a seeded generator, a fixed
// `dealsUntil`), so the same rows and numbers must come back.
//
// Two values depend on the time of the run and are left out: `days_in_stage` of a record's
// current stage (it runs to now) and the tool's `avgDaysInStage`, which averages over it.
import { env } from "cloudflare:workers";
import { type ActingUser, installShippedExtensions, seedRecordId } from "@composable-os/core";
import { seedDatabase } from "@composable-os/db/seed";
import { beforeAll, describe, expect, it } from "vitest";
import { call, createAdmin, db, host } from "./helpers.ts";

const NB = seedRecordId("deals", "pipeline", "newBusiness");
const RN = seedRecordId("deals", "pipeline", "renewals");

interface HistoryRow {
  id: string;
  object_type: string;
  record_id: string;
  stage_id: string;
  group_id: string | null;
  stage_type: string;
  entered_at: string;
  left_at: string | null;
  is_current: number;
  days_in_stage: number | null;
  entered_by: string | null;
}

interface Metrics {
  pipelineId: string;
  stages: Record<string, unknown>[];
  velocity: Record<string, unknown>;
}

let admin: ActingUser;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function historyRows(): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = [];
  for (let offset = 0; ; offset += 2000) {
    const { results } = await env.DB.prepare(
      "SELECT * FROM rec_stage_history ORDER BY id LIMIT 2000 OFFSET ?",
    )
      .bind(offset)
      .all<HistoryRow>();
    rows.push(...results);
    if (results.length < 2000) break;
  }
  return rows.map((row) => ({
    ...row,
    days_in_stage: row.left_at === null ? null : row.days_in_stage,
  }));
}

async function metrics(pipelineId: string): Promise<Metrics> {
  const out = await call<Metrics>(admin, "x.deals.stageMetrics", { pipelineId });
  return {
    ...out,
    stages: out.stages.map(({ avgDaysInStage: _, ...stage }) => stage),
  };
}

beforeAll(async () => {
  admin = await createAdmin();
  await installShippedExtensions({ db, host });
  await seedDatabase(env.DB, {
    people: 50,
    organisations: 40,
    activities: 0,
    tasks: 0,
    deals: 400,
    owners: [admin.id],
    dealsUntil: "2026-11-01",
  });
}, 120_000);

describe("stage history and stage metrics on the seeded data (stage 25, AC 2)", () => {
  it("rec_stage_history returns the rows it returned before the engine", async () => {
    const rows = await historyRows();
    expect(Object.keys(rows[0] ?? {})).toEqual([
      "id",
      "object_type",
      "record_id",
      "stage_id",
      "group_id",
      "stage_type",
      "entered_at",
      "left_at",
      "is_current",
      "days_in_stage",
      "entered_by",
    ]);
    const summary = {
      rows: rows.length,
      current: rows.filter((r) => r.is_current).length,
      first: rows[0],
      last: rows[rows.length - 1],
      sha256: await sha256(JSON.stringify(rows)),
    };
    expect(summary).toEqual(EXPECTED_HISTORY);
  });

  it("x.deals.stageMetrics gives the numbers it gave before the engine", async () => {
    const out = { newBusiness: await metrics(NB), renewals: await metrics(RN) };
    expect(out).toEqual(EXPECTED_METRICS);
  });
});

const EXPECTED_HISTORY: unknown = {
  rows: 1269,
  current: 400,
  first: {
    id: "sth_01JGFJQ9WR7NSEET44269S7JWV",
    object_type: "deals.deal",
    record_id: "rec_01JGFJQ9755EFNAB1A6KWKZHY5",
    stage_id: "rec_0000000000N2YWYRHEKWK4C0T8",
    group_id: "rec_00000000007SSCWD89D57ZJ0PZ",
    stage_type: "open",
    entered_at: "2026-09-03T14:40:51.746Z",
    left_at: "2026-09-08T14:40:51.746Z",
    is_current: 0,
    days_in_stage: 5,
    entered_by: null,
  },
  last: {
    id: "sth_01JGFKGSNK52NG1NSZDV1EJKHM",
    object_type: "deals.deal",
    record_id: "rec_01JGFKGQ9BT9JDRRSGBNFS7KE5",
    stage_id: "rec_00000000005M49ENS0KC5AMNDA",
    group_id: "rec_00000000007SSCWD89D57ZJ0PZ",
    stage_type: "open",
    entered_at: "2026-10-24T07:28:22.795Z",
    left_at: null,
    is_current: 1,
    days_in_stage: null,
    entered_by: null,
  },
  sha256: "4916fe8af5ebf9a8db3988d82e9167f5cf6c2544fe976ef31d496c5f787c52b4",
};
const EXPECTED_METRICS: unknown = {
  newBusiness: {
    pipelineId: "rec_00000000007SSCWD89D57ZJ0PZ",
    stages: [
      {
        stageId: "rec_0000000000N2YWYRHEKWK4C0T8",
        stage: "Lead",
        type: "open",
        entered: 342,
        current: 51,
        avgDaysBeforeMovingOn: 10.03,
      },
      {
        stageId: "rec_0000000000ZMYB65GSNT7NW9P9",
        stage: "Qualified",
        type: "open",
        entered: 273,
        current: 51,
        avgDaysBeforeMovingOn: 10.3,
      },
      {
        stageId: "rec_00000000005M49ENS0KC5AMNDA",
        stage: "Proposal",
        type: "open",
        entered: 207,
        current: 38,
        avgDaysBeforeMovingOn: 10.91,
      },
      {
        stageId: "rec_00000000008X55SHMQPDZ2QKFG",
        stage: "Negotiation",
        type: "open",
        entered: 153,
        current: 48,
        avgDaysBeforeMovingOn: 9.7,
      },
      {
        stageId: "rec_0000000000XCXZ8J8MBYPWY6BD",
        stage: "Won",
        type: "won",
        entered: 89,
        current: 89,
        avgDaysBeforeMovingOn: null,
      },
      {
        stageId: "rec_0000000000SP11E7JSZB3FCZBE",
        stage: "Lost",
        type: "lost",
        entered: 65,
        current: 65,
        avgDaysBeforeMovingOn: null,
      },
    ],
    velocity: {
      won: 89,
      avgDaysToWin: 42.28,
      wonValue: 6107900,
    },
  },
  renewals: {
    pipelineId: "rec_0000000000RYTFS1ZGERSAQDS7",
    stages: [
      {
        stageId: "rec_0000000000H35A2FMTZZ0XRWBJ",
        stage: "Upcoming renewal",
        type: "open",
        entered: 58,
        current: 15,
        avgDaysBeforeMovingOn: 10.14,
      },
      {
        stageId: "rec_00000000000HBGV93NJZ98XJPC",
        stage: "Renewal in discussion",
        type: "open",
        entered: 38,
        current: 12,
        avgDaysBeforeMovingOn: 9.5,
      },
      {
        stageId: "rec_0000000000BKXQ2RM5X3CY4J0A",
        stage: "Renewal committed",
        type: "open",
        entered: 25,
        current: 12,
        avgDaysBeforeMovingOn: 9.69,
      },
      {
        stageId: "rec_0000000000XS3342J4V15TJNE3",
        stage: "Renewed",
        type: "won",
        entered: 10,
        current: 10,
        avgDaysBeforeMovingOn: null,
      },
      {
        stageId: "rec_0000000000JTZF3E2J897A167N",
        stage: "Churned",
        type: "lost",
        entered: 9,
        current: 9,
        avgDaysBeforeMovingOn: null,
      },
    ],
    velocity: {
      won: 10,
      avgDaysToWin: 27.3,
      wonValue: 903700,
    },
  },
};
