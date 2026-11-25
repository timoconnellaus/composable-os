// Consent to be contacted (stage 30, ADR 0678): before a caller's email is queued, the gatekeeper
// asks the integration host (`contactCheck` on the approval queue) with the addresses and the
// purpose the caller declared. The host drops who may not be contacted, refuses when nobody is
// left, and gives a stoppable message each Person's own stop link. The links come from the host
// and go only into the email itself: never into a receipt, `listSent()` or the approval's words.
//
// No imports: cos-runner's fake outbox uses this same module.

/** What the host answered: who may be sent to (each with their stop link, or none), how many not. */
export interface ContactAnswer {
  allowed: { to: string; stop: string | null }[];
  dropped: number;
}

/** The words a stop link is put after, at the end of each copy (routine mail's, ADR 0675). */
export const STOP_WORDS = "To stop getting these emails:";

/** A host's refusal, passed on as it is; anything else means the queue cannot ask. */
const REFUSAL = /^(Refused|Invalid email)/;

/**
 * Asks the host. Null when the queue cannot ask (a host older than ADR 0678, or a test's): the
 * host's own check of the submitted send still holds, but a send that declares a purpose needs
 * its stop links, so it is refused.
 */
export async function askContact(
  queue: unknown,
  input: { to: string[]; purpose: string | undefined },
): Promise<ContactAnswer | null> {
  const target = queue as Record<string, ((input: unknown) => Promise<unknown>) | undefined>;
  let answer: unknown;
  try {
    if (typeof target.contactCheck !== "function") throw new Error("no contactCheck");
    answer = await target.contactCheck({ channel: "email", to: input.to, purpose: input.purpose });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (REFUSAL.test(message)) throw new Error(message);
    answer = null;
  }
  const parsed = parseAnswer(answer);
  if (!parsed && input.purpose !== undefined) {
    throw new Error(
      "Refused: this email declares a purpose, and the host cannot add its stop links. Nothing was sent or queued.",
    );
  }
  return parsed;
}

function parseAnswer(answer: unknown): ContactAnswer | null {
  if (!answer || typeof answer !== "object") return null;
  const { allowed, dropped } = answer as { allowed?: unknown; dropped?: unknown };
  if (!Array.isArray(allowed) || typeof dropped !== "number") return null;
  return {
    allowed: allowed.flatMap((a) => {
      if (!a || typeof a !== "object") return [];
      const { to, stop } = a as { to?: unknown; stop?: unknown };
      return typeof to === "string" ? [{ to, stop: typeof stop === "string" ? stop : null }] : [];
    }),
    dropped: Math.max(0, Math.trunc(dropped)),
  };
}

/** A copy's text body with its stop link at the end. */
export function textWithStop(text: string, stop: string): string {
  return `${text}\n\n${STOP_WORDS} ${stop}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A copy's HTML body with its stop link at the end. */
export function htmlWithStop(html: string, stop: string): string {
  const link = escapeHtml(stop);
  return `${html}\n<p>${escapeHtml(STOP_WORDS)} <a href="${link}">${link}</a></p>`;
}
