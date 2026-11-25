// Routine mail (ADR 0590): a shipped pack's declared email (a booking's confirmation, a class
// reminder) that the host composed, addressed and decided may go without a person. A send gets
// the routine kind only when both hold:
//
// 1. The integration host says the session is its own routine mail, decided routine. It is asked
//    of the approval queue the host opened the session with (`hostRoutineMail`), which only the
//    host's `sendRoutineMail` answers, for one row it wrote itself; a staff call, an extension,
//    an automation's own gatekeeper call, the assistant, MCP and Code Mode reach this gatekeeper
//    through queues that answer null, and nothing in the message can change the answer.
// 2. The message has routine shape: one recipient; plain text; no cc, bcc, reply-to or HTML; and
//    every link in it (the body and a calendar file's link) on the business's own site, which the
//    queue names.
//
// Anything else is an ordinary send, decided as before (`email.send` or `email.internal`), and
// the host holds it for a person.
//
// No imports: cos-runner's fake outbox uses this same module, so the two decide identically.

export const ROUTINE_KIND = { tag: "email.routine", label: "Send members' routine email" } as const;

/** The parts of a message the rule reads (an EmailSendMessage, or the fake outbox's). */
export interface RoutineCandidate {
  to: readonly string[];
  cc?: readonly string[] | undefined;
  bcc?: readonly string[] | undefined;
  replyTo?: string | undefined;
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
  calendar?: unknown;
}

const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"]*/gi;

/** Whether every link in `text` is on `site` (`https://gym.example`). */
function linksOn(text: string, site: string | null): boolean {
  for (const match of text.matchAll(LINK)) {
    const link = match[0];
    if (!site || !(link === site || link.startsWith(`${site}/`) || link.startsWith(`${site}?`))) {
      return false;
    }
  }
  return true;
}

/** Whether `message` has the shape of routine mail for the business's `site`. */
export function isRoutineShaped(message: RoutineCandidate, site: string | null): boolean {
  if (message.to.length !== 1) return false;
  if (message.cc?.length || message.bcc?.length || message.replyTo !== undefined) return false;
  if (message.html !== undefined || typeof message.text !== "string") return false;
  if (!linksOn(message.subject, null) || !linksOn(message.text, site)) return false;
  const events = message.calendar
    ? Array.isArray(message.calendar)
      ? message.calendar
      : [message.calendar]
    : [];
  for (const event of events as { url?: unknown; description?: unknown }[]) {
    if (event.description !== undefined) return false;
    if (event.url !== undefined && !(typeof event.url === "string" && linksOn(event.url, site))) {
      return false;
    }
  }
  return true;
}

/** The one-tap stop's route on the business's site (the client web app's stop page, ADR 0675). */
const STOP_PATH = "/stop";

/**
 * The one-tap stop a routine email may carry (ADR 0675): an https link on `site`'s stop route,
 * nothing else, or null. Only the host's routine mail, decided routine and of routine shape, may
 * set one: `site` is the routine queue's site, and null for any other send, so a caller's
 * `listUnsubscribe` is refused whatever it says.
 */
export function listUnsubscribeOf(value: unknown, site: string | null): string | null {
  if (!site || typeof value !== "string" || value.length > 600) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
  if (/[\s<>",\u0000-\u001f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.origin !== site || url.username || url.password || url.hash) return null;
    if (url.pathname !== STOP_PATH) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The headers a one-click unsubscribe takes (RFC 2369 and RFC 8058). */
export function unsubscribeHeaders(link: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${link}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Asks the session's approval queue whether it is the host's routine mail, decided routine, and
 * for which site. A queue without the method (another host, a test harness) is not.
 */
export async function hostRoutineMail(
  queue: unknown,
): Promise<{ siteOrigin: string | null } | null> {
  try {
    const target = queue as { hostRoutineMail?: () => Promise<unknown> };
    if (typeof target.hostRoutineMail !== "function") return null;
    const answer = (await target.hostRoutineMail()) as { siteOrigin?: unknown } | null;
    if (!answer || typeof answer !== "object") return null;
    return { siteOrigin: typeof answer.siteOrigin === "string" ? answer.siteOrigin : null };
  } catch {
    return null;
  }
}
