// The text gatekeeper's resource, action kinds and pending pool (ADR 0672). Apart from worker.ts,
// whose module exports only the Worker's entrypoints and classes.
import type { ActionKind } from "@composable-os/gatekeeper-interface/gatekeeper";

/** The one resource: the business's sender number (a deploy setting, TEXT_SENDER_NUMBER). */
export const SENDER_URL = "text://sender";

/** `text.routine`: applied by the host's decision (ADR 0590), never by an admin's switch. */
export const ROUTINE_KIND: ActionKind = {
  tag: "text.routine",
  label: "Send members' routine texts",
};
/** `text.send`: a held routine text, which a person reviews. */
export const SEND_KIND: ActionKind = { tag: "text.send", label: "Send a text" };

/** Sends that may wait for a decision at once (stage 30: one pool of 500). */
export const MAX_PENDING_TEXTS = 500;
