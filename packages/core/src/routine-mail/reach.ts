// How a Person is reached by text or push (ADR 0670): the seam the send path asks, once per
// recipient and channel, when a routine message is prepared. Which number is textable is
// `textReach` (marks on phone numbers, a number checked by code, a STOP: ADR 0673, texts.ts);
// which app devices a Person has registered (ADR 0674) is the push step's, and until it is built
// nobody has a device, so a push row is kept as `no_channel` and its email goes as before. Each
// answer costs a bounded number of statements (the cost test counts them).
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { textReach } from "./texts.ts";

export type Reached =
  /** Where it goes (a number, a device), kept on the row until it is decided; and the caps' key. */
  | { to: string; key: string }
  /**
   * Why it cannot go: the row is `no_channel` with this reason; `stopped` when it is the
   * person's own stop (a STOP reply), and the row says so.
   */
  | { reason: string; stopped?: true };

export interface ChannelReach {
  /** The Person's textable mobile, or why there is none. */
  text(db: Kysely<CoreDatabase>, personId: string): Promise<Reached>;
  /** The Person's app, registered for push on a live device session, or why there is none. */
  push(db: Kysely<CoreDatabase>, personId: string): Promise<Reached>;
}

/** No number is textable and no device registered yet: the text and push steps fill these in. */
export const NO_REACH: ChannelReach = {
  text: async () => ({ reason: "no number the host may text (texts are not available yet)" }),
  push: async () => ({ reason: "no app device registered for push (push is not available yet)" }),
};

/** The host's reach: textable numbers (ADR 0673); no app device yet (the push step's). */
export const HOST_REACH: ChannelReach = { text: textReach, push: NO_REACH.push };
