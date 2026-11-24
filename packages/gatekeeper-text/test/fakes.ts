// State shared by the test Worker's harness and the test files. Both run in one isolate, so the
// module instance is shared.

import type {
  ActionDescription,
  ObservationDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import type { TextEvent } from "../src/types";

/** Every action the fake approval queues received, as `[id, description]`. */
export const submissions: [number, ActionDescription][] = [];
/** Every observation the fake approval queues authorized. */
export const observations: ObservationDescription[] = [];
/** Every event the host's hook received. */
export const received: TextEvent[] = [];

export function resetFakes(): void {
  submissions.length = 0;
  observations.length = 0;
  received.length = 0;
}
