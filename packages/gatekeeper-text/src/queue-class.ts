// Which of the host's queues a text session belongs to (ADR 0672, as the email gatekeeper's
// `queueClassOf`, ADR 0645). The integration host opens a queue for its own work with one purpose
// and answers for it; every other caller (a person, an extension, an automation's own call, the
// assistant, MCP, Code Mode) reaches this gatekeeper through a queue that answers none of them,
// and is refused: a text has no free path. The class is read from the queue, never from the
// message.
//
// - `routine`: the host's routine messages (`routine-mail`), one row of core_routine_mail.
// - `check`: the host's phone check (`phone-check`), a code to a member's own number.
// - `events`: the host's text events hook (`text-events`), receipts and replies.

export type TextQueueClass = "routine" | "check" | "events" | "caller";

async function answer(queue: unknown, method: string): Promise<unknown> {
  try {
    // Called as a method: on an RPC stub, `.call` would itself be a remote call.
    const target = queue as Record<string, (() => Promise<unknown>) | undefined>;
    if (typeof target[method] !== "function") return null;
    return await target[method]();
  } catch {
    return null;
  }
}

/** The class of the caller behind `queue`. A queue that answers none of the host's is a caller. */
export async function queueClassOf(queue: unknown): Promise<TextQueueClass> {
  const purpose = await answer(queue, "hostPurpose");
  if (purpose === "routine-mail") return "routine";
  if (purpose === "phone-check") return "check";
  if (purpose === "text-events") return "events";
  return "caller";
}

/**
 * Whether the host decided this routine text may go without a person, and the business's site
 * its links may point to (the email gatekeeper's `hostRoutineMail`, ADR 0590). Null: a held one,
 * which a person reviews.
 */
export async function hostRoutine(queue: unknown): Promise<{ siteOrigin: string | null } | null> {
  const routine = (await answer(queue, "hostRoutineMail")) as { siteOrigin?: unknown } | null;
  if (!routine || typeof routine !== "object") return null;
  return { siteOrigin: typeof routine.siteOrigin === "string" ? routine.siteOrigin : null };
}

/** Why a caller is refused: the same words for every one. */
export const REFUSED =
  "Refused: a text goes only from the host's own routine messages and phone checks (ADR 0672).";
