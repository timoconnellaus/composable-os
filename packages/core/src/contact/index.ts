// Consent to be contacted (stage 30 step 5, ADR 0675): the seam Journeys, the shared inbox and
// Reviews use. One register (register.ts), one suppression list (suppression.ts), one question
// every sender asks at the moment of sending (decide.ts: `contactDecision`), and the host's stop
// links (stop.ts: `stopLink`, taken by the public `contact.stop`). Nobody writes the register or
// reads it except through these.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { ValidationError } from "../errors.ts";
import { appendChoice, type ContactChannel } from "./register.ts";

export {
  addressSuppressed,
  CONTACT_REFUSALS,
  type ContactDecision,
  type ContactOptions,
  type ContactQuestion,
  type ContactRefusal,
  contactDecision,
  registerRefusal,
} from "./decide.ts";
export {
  allows,
  appendChoice,
  CHOICE_HOWS,
  type ChoiceHow,
  type ChoicesInForce,
  type ChoiceValue,
  CONTACT_CHANNELS,
  CONTACT_PURPOSES,
  type ContactChannel,
  type ContactChoice,
  type ContactPurpose,
  choiceHistory,
  choiceKey,
  choicesInForce,
  isKindScope,
  isPurposeScope,
  mergeChoiceStatements,
  PURPOSE_SCOPES,
  STOP_HOWS,
  valueProblem,
} from "./register.ts";
export {
  readStopToken,
  STOP_PARAM,
  STOP_PATH,
  type StopScope,
  stopLink,
  stopToken,
} from "./stop.ts";
export { addressHash, saltedHash, suppress, suppressed, unsuppress } from "./suppression.ts";

/**
 * A form's or a checkout's consent question (stage 29, orders), for host code only: the answer to
 * "news and offers by email?", with the words the person was shown. The question is never ticked
 * in advance; a yes without its words is refused. The statement, for the caller's batch.
 */
export function recordFromForm(
  db: Kysely<CoreDatabase>,
  answer: {
    personId: string;
    channel: ContactChannel;
    yes: boolean;
    wording: string;
    how: "form" | "checkout";
    at: string;
  },
) {
  const wording = answer.wording.trim();
  if (!wording || wording.length > 1000) {
    throw new ValidationError("A consent answer keeps the words the person was shown");
  }
  return appendChoice(db, {
    personId: answer.personId,
    channel: answer.channel,
    scope: "news_and_offers",
    value: answer.yes ? "yes" : "no",
    how: answer.how,
    at: answer.at,
    wording,
  });
}
