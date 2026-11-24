// A journey's messages filled in for a sample Person (stage 53 step 3, ADR 0800): what the editor
// and the publish dialog show, so a person approves the exact wording with real values in it. The
// host fills the same slots the same way when it sends (step 4), where every value's mark is also
// checked (ADR 0590); the preview says which values would hold a message for a person.
import { unroutineText } from "@composable-os/sdk";
import { siteLink } from "../routine-mail/index.ts";
import { type JourneyDefinition, parseTemplate } from "./definition.ts";

/** What the preview shows where the host puts the unsubscribe link (stage 30's one-tap stop). */
export const UNSUBSCRIBE_PREVIEW =
  "Stop these messages: (the host adds this link to every message)";

/** The longest a filled value may be, as routine mail's text slots (ADR 0590). */
const VALUE_MAX = 120;

export interface SampleValues {
  firstName: string | null;
  business: string | null;
  record: string | null;
  /** In a guardian's version: the member's (the child's) first name. */
  member?: string | null;
}

export interface RenderedMessage {
  subject: string;
  body: string;
  /** Why this message would be held for a person rather than sent on its own (empty: it would not). */
  holds: string[];
}

/** Fills one template. A slot with no value is left empty and named in `holds`. */
function fill(
  template: string,
  values: SampleValues,
  siteOrigin: string | null,
  holds: string[],
): string {
  const { pieces } = parseTemplate(template);
  return pieces
    .map((piece) => {
      if ("text" in piece) return piece.text;
      if (piece.slot === "unsubscribe") return UNSUBSCRIBE_PREVIEW;
      if (piece.slot.startsWith("site:")) {
        const link = siteOrigin
          ? siteLink(`${siteOrigin}${piece.slot.slice(5)}`, siteOrigin)
          : null;
        if (!link) {
          holds.push(
            "No site is set in Settings → Routine email, so a {site:} link cannot be made",
          );
          return "";
        }
        return link;
      }
      const value = values[piece.slot as keyof SampleValues] ?? null;
      if (value === null || !value.trim()) {
        holds.push(`{${piece.slot}} has no value for this Person`);
        return "";
      }
      const why = unroutineText(value, VALUE_MAX);
      if (why) holds.push(`{${piece.slot}} holds ${why}`);
      return value;
    })
    .join("");
}

export function renderMessage(
  message: { subject: string; body: string },
  values: SampleValues,
  siteOrigin: string | null,
): RenderedMessage {
  const holds: string[] = [];
  const subject = fill(message.subject, values, siteOrigin, holds);
  const body = fill(message.body, values, siteOrigin, holds);
  return { subject, body, holds: [...new Set(holds)] };
}

export interface PreviewedStep {
  step: string;
  position: number;
  member: RenderedMessage;
  guardian: RenderedMessage | null;
}

/** Every message of a definition, in order, for the Person and (where it has one) their guardian. */
export function renderJourney(
  definition: JourneyDefinition,
  values: { member: SampleValues; guardian: SampleValues },
  siteOrigin: string | null,
): PreviewedStep[] {
  const out: PreviewedStep[] = [];
  definition.steps.forEach((step, position) => {
    if (step.type !== "send") return;
    out.push({
      step: step.id,
      position,
      member: renderMessage(step, values.member, siteOrigin),
      guardian: step.guardian ? renderMessage(step.guardian, values.guardian, siteOrigin) : null,
    });
  });
  return out;
}
