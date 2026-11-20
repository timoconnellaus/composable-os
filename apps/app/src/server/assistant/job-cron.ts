// The agents' sweep (ADR 0344), on the 10-minute cron: starts what is queued (a routine in cos-runner
// can queue a job but cannot reach the objects), and nudges a running job gone quiet.
import { sweepAgentJobs } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { agentJobsFor, type OperationsEnv } from "../operations.ts";

export async function runAgentJobCron(env: unknown): Promise<void> {
  const appEnv = env as OperationsEnv;
  await sweepAgentJobs(createCrmDb(appEnv.DB), agentJobsFor(appEnv));
}
