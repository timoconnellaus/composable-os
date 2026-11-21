// The host's sign-in mail (ADR 0456): a send gets the sign-in kind only when both hold:
//
// 1. The integration host says the session is its own sign-in mail. It is asked of the approval
//    queue the host opened the session with (`isHostSignInMail`), which only the host's
//    `callAsHost` with purpose `sign-in` answers true; a staff call, an extension, an automation,
//    the assistant and MCP all reach this gatekeeper through queues that answer false, and nothing
//    in the message can change the answer.
// 2. The message is exactly the fixed code template: one recipient, a plain-text body, no cc,
//    bcc, reply-to, HTML or related records, the subject and body word for word, the product's
//    name the same in both, and a six-digit code.
//
// Anything else is an ordinary send, decided as before (`email.send` or `email.internal`).
//
// No imports: cos-runner's fake outbox uses this same module, so the two decide identically.

export const SIGN_IN_KIND = { tag: "email.signin", label: "Send sign-in codes" } as const;

/** The parts of a message the rule reads (an EmailSendMessage, or the fake outbox's). */
export interface SignInCandidate {
  to: readonly string[];
  cc?: readonly string[] | undefined;
  bcc?: readonly string[] | undefined;
  replyTo?: string | undefined;
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
  relatedRecords?: readonly string[] | undefined;
}

const SUBJECT_RE = /^Your ([^\n\r]{1,100}) sign-in code$/;
const BODY_RE =
  /^Your sign-in code for ([^\n\r]{1,100}) is (\d{6})\.\n\nIt works once and expires in five minutes\. If you did not ask for it, ignore this email\.$/;

/** Whether `message` is exactly the host's sign-in code template. */
export function isSignInCodeMessage(message: SignInCandidate): boolean {
  if (message.to.length !== 1) return false;
  if (message.cc?.length || message.bcc?.length || message.replyTo !== undefined) return false;
  if (message.html !== undefined || message.relatedRecords?.length) return false;
  if (typeof message.text !== "string") return false;
  const subject = SUBJECT_RE.exec(message.subject);
  const body = BODY_RE.exec(message.text);
  return Boolean(subject && body && subject[1] === body[1]);
}

/**
 * Asks the session's approval queue whether it is the host's sign-in mail. A queue without the
 * method (another host, a test harness) is not: the answer defaults to no.
 */
export async function isHostSignInMail(queue: unknown): Promise<boolean> {
  try {
    const target = queue as { isHostSignInMail?: () => Promise<unknown> };
    if (typeof target.isHostSignInMail !== "function") return false;
    return (await target.isHostSignInMail()) === true;
  } catch {
    return false;
  }
}
