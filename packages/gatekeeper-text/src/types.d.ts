// The text gatekeeper's session (ADR 0672). Only the host's own queues use it: its routine
// messages send a text, its phone check sends and checks a code, and its event hook receives the
// provider's verified receipts and replies. Every other caller (a person, an extension, an
// automation's own call, the assistant, MCP, Code Mode) is refused, not reviewed.

/** One text: one number, plain words. */
export interface TextMessage {
  /** The number in international form: `+` and 8 to 15 digits. */
  to: string;
  /** The words as sent, plain text, at most two segments. */
  text: string;
  /** The business's name the words begin with; HELP's answer names it. At most 30 characters. */
  business?: string;
  /** The host's key for this text: the same key never sends twice, and receipts carry it back. */
  idempotencyKey?: string;
}

export interface TextReceipt {
  /** `sent` once the provider took it; `pending` while it waits for a person. */
  status: "sent" | "pending";
  id: number;
  /** How many segments it is billed as. */
  segments: number;
}

/** What the provider reported, verified, for the host (ADR 0672). Never the words. */
export type TextEvent =
  | {
      kind: "receipt";
      eventId: string;
      provider: string;
      /** The host's key the text was sent with, when the gatekeeper knows it. */
      ref: string | null;
      providerRef: string;
      status: "delivered" | "failed";
      at: string;
      /** What the provider charged, in minor units, when it says. */
      costMinor?: number;
    }
  | {
      kind: "reply";
      eventId: string;
      provider: string;
      /** The number the reply came from, international form. */
      from: string;
      /** STOP (all texts off), START (back on), HELP (answered here with a fixed text). */
      keyword: "stop" | "start" | "help";
      at: string;
      /** HELP's answer, when one was sent: its segments, for the month's spend. */
      answeredSegments?: number;
    };

export interface TextEventHook {
  receiveEvent(event: TextEvent): Promise<void>;
}

export interface TextSession {
  /** Sends one routine text: only the host's routine messages' queue. */
  send(message: TextMessage): Promise<TextReceipt>;
  /** Sends a checking code to a number: only the host's phone check queue. */
  startCheck(input: { to: string }): Promise<{ started: true }>;
  /** Checks a code a member typed: only the host's phone check queue. */
  check(input: { to: string; code: string }): Promise<{ checked: boolean }>;
  /** Receives verified receipts and replies: only the host's text events queue. */
  subscribe(hook: TextEventHook): Promise<void>;
}
