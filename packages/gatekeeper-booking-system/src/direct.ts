// The session's rules without a Worker around them: every input checked and every answer shaped
// as the gatekeeper's session does, with nothing to record. For running the conformance suite
// against a system object directly (the fake in memory, or a real system from a person's test
// script); the gatekeeper's own session (session.ts) is what the host reaches.

import { checkedReads } from "./reads.js";
import type { BookingSystem } from "./system.js";
import type { BookingSystemSession } from "./types.js";

export function directSession(system: BookingSystem): BookingSystemSession {
  return checkedReads(() => system);
}
