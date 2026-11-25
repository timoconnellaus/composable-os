// The copy of a signed agreement (stage 44 step 4, ADR 0645, amending ADR 0571): the host's own
// mail, with the signed PDF this gatekeeper makes from checked values when the send is applied,
// never from bytes a caller supplies. A message may carry `agreement` only when both hold:
//
// 1. The integration host says the session is its own agreements mail. It is asked of the
//    approval queue the host opened the session with (`isHostAgreementMail`), which only the
//    host's `callAsHost` with purpose `agreements` answers true; a staff call, an extension, an
//    automation, the assistant, MCP and Code Mode reach this gatekeeper through queues that answer
//    false, and nothing in the message can change the answer.
// 2. The message is one recipient, plain text, with no cc, bcc, reply-to, HTML or calendar.
//
// Anything else carrying `agreement` is refused, so no other caller can attach a file, or send
// someone's agreement anywhere. The values themselves are checked in validate.ts; health answers
// have no place in them at all (decision 21: the copy says "your answers are in the app").
//
// No imports but types: cos-runner's fake outbox uses this same module.
import type { AgreementPdf } from "@composable-os/pdf";

export const AGREEMENT_KIND = {
  tag: "email.agreement",
  label: "Send copies of signed agreements",
} as const;

/** The file name the copy's PDF is attached as. */
export const AGREEMENT_FILENAME = "agreement.pdf";

/** What a message's `agreement` holds: the PDF's values, without answers of any kind but `in-app`. */
export type EmailAgreement = Omit<AgreementPdf, "answers" | "blank"> & {
  answers?: "in-app";
  /** For the approval card: how it was agreed and when, in one line (no name). */
  summary: string;
};

/** The parts of a message the rule reads (an EmailSendMessage, or the fake outbox's). */
export interface AgreementCandidate {
  to: readonly string[];
  cc?: readonly string[] | undefined;
  bcc?: readonly string[] | undefined;
  replyTo?: string | undefined;
  text?: string | undefined;
  html?: string | undefined;
  calendar?: unknown;
}

/** Whether `message` has the one shape a copy of an agreement may have. */
export function isAgreementShaped(message: AgreementCandidate): boolean {
  if (message.to.length !== 1) return false;
  if (message.cc?.length || message.bcc?.length || message.replyTo !== undefined) return false;
  if (message.html !== undefined || typeof message.text !== "string") return false;
  return message.calendar === undefined;
}

/**
 * Asks the session's approval queue whether it is the host's agreements mail. A queue without the
 * method (another host, a test harness) is not: the answer defaults to no.
 */
export async function isHostAgreementMail(queue: unknown): Promise<boolean> {
  try {
    const target = queue as { isHostAgreementMail?: () => Promise<unknown> };
    if (typeof target.isHostAgreementMail !== "function") return false;
    return (await target.isHostAgreementMail()) === true;
  } catch {
    return false;
  }
}

/** What the approver is shown of the attachment, in one line: never a name, a mark or an answer. */
export function agreementSummary(agreement: EmailAgreement): string {
  return `Signed agreement: ${agreement.title}, version ${agreement.versionNumber}, ${agreement.summary}`;
}
