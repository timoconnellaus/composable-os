// The host's sign-in mail (ADR 0456): a send gets the sign-in kind only when both hold:
//
// 1. The integration host says the session is its own sign-in mail. It is asked of the approval
//    queue the host opened the session with (`isHostSignInMail`), which only the host's
//    `callAsHost` with purpose `sign-in` answers true; a staff call, an extension, an automation,
//    the assistant and MCP all reach this gatekeeper through queues that answer false, and nothing
//    in the message can change the answer.
// 2. The message is exactly one of the host's fixed templates: one recipient, a plain-text body,
//    no cc, bcc, reply-to, HTML or related records, the subject and body word for word, and the
//    product's name the same in both. The templates are the sign-in code (a six-digit code), and,
//    for changing a sign-in address (stage 48, ADR 0712), the code sent to the new address (a
//    six-digit code) and the notice to the old one (the new address shown only in part,
//    `a•••@example.com`).
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
  calendar?: unknown;
}

const SUBJECT_RE = /^Your ([^\n\r]{1,100}) sign-in code$/;
const BODY_RE =
  /^Your sign-in code for ([^\n\r]{1,100}) is (\d{6})\.\n\nIt works once and expires in five minutes\. If you did not ask for it, ignore this email\.$/;

// Changing a sign-in address (ADR 0712): the code to the new address, and the notice to the old.
const CHANGE_SUBJECT_RE = /^Confirm your new ([^\n\r]{1,100}) sign-in address$/;
const CHANGE_BODY_RE =
  /^Your code to make this your sign-in address for ([^\n\r]{1,100}) is (\d{6})\.\n\nIt works once and expires in 15 minutes\. If you did not ask for this, ignore this email: nothing changes\.$/;
const CHANGED_SUBJECT_RE = /^Your ([^\n\r]{1,100}) sign-in address was changed$/;
const CHANGED_BODY_RE =
  /^The address you sign in to ([^\n\r]{1,100}) with was changed to [^\s@•]•••@[A-Za-z0-9.-]{1,253}\.\n\nYou can no longer sign in with this address\. If you did not ask for this, contact us at once\.$/;

const TEMPLATES: readonly (readonly [RegExp, RegExp])[] = [
  [SUBJECT_RE, BODY_RE],
  [CHANGE_SUBJECT_RE, CHANGE_BODY_RE],
  [CHANGED_SUBJECT_RE, CHANGED_BODY_RE],
];

/** Whether `message` is exactly one of the host's sign-in templates (see the top of the file). */
export function isSignInCodeMessage(message: SignInCandidate): boolean {
  if (message.to.length !== 1) return false;
  if (message.cc?.length || message.bcc?.length || message.replyTo !== undefined) return false;
  if (message.html !== undefined || message.relatedRecords?.length) return false;
  if (message.calendar !== undefined) return false;
  const text = message.text;
  if (typeof text !== "string") return false;
  return TEMPLATES.some(([subjectRe, bodyRe]) => {
    const subject = subjectRe.exec(message.subject);
    const body = bodyRe.exec(text);
    return Boolean(subject && body && subject[1] === body[1]);
  });
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
