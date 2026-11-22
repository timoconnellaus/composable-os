// Test mode (ADR 0133): an automation run against a real record with nothing written. Every
// operation the run calls goes through the pipeline with `InvocationContext.simulate`: the gate
// is evaluated and recorded, writes are dry-run exactly as the approval queue dry-runs them
// (approvals/queue.ts), and the records they would create or change join an in-memory overlay
// that the run's later reads see (approvals/simulation.ts). No statement, audit row or event
// leaves the pipeline.
import { Overlay } from "../approvals/simulation.ts";
import type { RecordChange } from "../operation.ts";
import type { RunOperationRecord, TestNotification } from "./types.ts";

export interface TestGateRecord {
  operation: string;
  gate: "auto" | "review" | "deny";
  bulkSize: number;
  reason: string;
}

export interface TestWrite {
  object: string;
  id: string;
  action: string;
  title: string | null;
  operation: string;
}

/** The state of one test run: its overlay and what the pipeline recorded. */
export interface TestSimulation {
  overlay: Overlay;
  gates: TestGateRecord[];
  writes: TestWrite[];
  notifications: TestNotification[];
  /** Per-call records, in order (the run host also keeps its own). */
  operations: RunOperationRecord[];
  /**
   * Set when the simulation is not a test run but the operations a dry-run handler calls
   * (approvals/dry-run.ts): they are simulated over the dry run's overlay, and nothing reads
   * what they record.
   */
  dryRun?: boolean;
  /** A dry run's: what the calls it simulated would change, for the outer preview. */
  collect?: (changes: RecordChange[]) => void;
  /** A dry run's: notes for the reviewer from the calls it simulated. */
  notes?: string[];
  /**
   * Test mode: calls it could not simulate and so did not run (an extension tool that may write,
   * a call that reaches another runtime). Each would run for real; the step got a placeholder.
   */
  notRun?: { operation: string; note: string }[];
}

export function createTestSimulation(): TestSimulation {
  return {
    overlay: new Overlay(),
    gates: [],
    writes: [],
    notifications: [],
    operations: [],
    notRun: [],
  };
}
