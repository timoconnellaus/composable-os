// What a person gives when they agree (stage 44 step 2, ADRs 0642 and 0643): the name they type,
// a drawn signature as its strokes, and a health form's answers. Each is checked on every write,
// and none of their values ever appears in an error: the messages name the field and the rule only,
// so a refusal (which is audited, and may reach a log) carries no personal or health data.
import { z } from "zod";
import { BIDI_CONTROLS, CONTROLS, type Question } from "./documents.ts";

/** The name a person types (1 to 200 characters, no control or bidirectional characters). */
export const typedNameSchema = z
  .string()
  .trim()
  .min(1, "Type your name")
  .max(200, "A name is at most 200 characters")
  .refine((v) => !CONTROLS.test(v) && !BIDI_CONTROLS.test(v), "A name holds no control characters")
  .describe("The name the person typed beside the box: personal data, never shown to an AI");

/** The box a signature is drawn in, and the limits on what it may hold (ADR 0642). */
export const SIGNATURE_BOX = { width: 1000, height: 400 } as const;
export const SIGNATURE_LIMITS = {
  strokes: 30,
  points: 5_000,
  bytes: 32_768,
  /** The least ink, in box units, that counts as a signature (not a dot or a tap). */
  minLength: 120,
} as const;

const coordinate = (max: number) => z.number().int().min(0).max(max);

/**
 * A drawn signature: integer points in a 1000 by 400 box, at most 30 strokes and 5,000 points, at
 * most 32 KB as JSON. Refused: empty, a dot, or too little ink to be a signature.
 */
export const signatureSchema = z
  .object({
    width: z.literal(SIGNATURE_BOX.width),
    height: z.literal(SIGNATURE_BOX.height),
    strokes: z
      .array(
        z
          .array(z.tuple([coordinate(SIGNATURE_BOX.width), coordinate(SIGNATURE_BOX.height)]))
          .min(1)
          .max(SIGNATURE_LIMITS.points),
      )
      .min(1, "Draw your signature")
      .max(SIGNATURE_LIMITS.strokes, "A signature has at most 30 strokes"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const points = value.strokes.reduce((n, s) => n + s.length, 0);
    if (points > SIGNATURE_LIMITS.points) {
      ctx.addIssue({ code: "custom", path: ["strokes"], message: "Too many points" });
      return;
    }
    if (JSON.stringify(value).length > SIGNATURE_LIMITS.bytes) {
      ctx.addIssue({ code: "custom", path: ["strokes"], message: "The signature is too large" });
      return;
    }
    if (inkLength(value.strokes) < SIGNATURE_LIMITS.minLength) {
      ctx.addIssue({ code: "custom", path: ["strokes"], message: "Draw your signature" });
    }
  })
  .describe("A drawn signature as strokes in a 1000 by 400 box: personal data");
export type Signature = z.infer<typeof signatureSchema>;

/** The length of the lines a signature draws (a dot draws none). */
export function inkLength(strokes: readonly (readonly (readonly [number, number])[])[]): number {
  let total = 0;
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const [x0, y0] = stroke[i - 1] as readonly [number, number];
      const [x1, y1] = stroke[i] as readonly [number, number];
      total += Math.hypot(x1 - x0, y1 - y0);
    }
  }
  return total;
}

/** One answer of a health form: yes or no, and a note when the question asks for one on a yes. */
export const answerSchema = z
  .object({
    key: z.string().min(1).max(40),
    yes: z.boolean(),
    note: z.string().trim().max(1_000, "A note is at most 1,000 characters").optional(),
  })
  .strict();
export const answersSchema = z
  .array(answerSchema)
  .min(1)
  .max(40)
  .describe("A health form's answers: health information, never shown to an AI or logged");
export type Answer = z.infer<typeof answerSchema>;

/**
 * Checks answers against the form's questions: every question answered once, no other keys, a
 * note only on a yes. Returns the answers in the form's order and whether any is a yes. The
 * messages name question keys (the business's, not the person's) and never a value.
 */
export function checkAnswers(
  questions: readonly Question[],
  answers: readonly Answer[],
): { answers: Answer[]; anyYes: boolean } {
  const byKey = new Map<string, Answer>();
  for (const answer of answers) {
    if (byKey.has(answer.key)) throw answersError("A question is answered more than once");
    byKey.set(answer.key, answer);
  }
  const ordered: Answer[] = [];
  for (const question of questions) {
    const answer = byKey.get(question.key);
    if (!answer) throw answersError("Answer every question");
    if (answer.note && !answer.yes) throw answersError("A note goes with a yes only");
    if (answer.note && !question.noteOnYes) throw answersError("This question takes no note");
    ordered.push({
      key: question.key,
      yes: answer.yes,
      ...(answer.note ? { note: answer.note } : {}),
    });
    byKey.delete(question.key);
  }
  if (byKey.size) throw answersError("An answer is for a question this form does not ask");
  return { answers: ordered, anyYes: ordered.some((a) => a.yes) };
}

/** The error a bad set of answers gets: a fixed message, no value (ADR 0643). */
export class AnswersError extends Error {}
const answersError = (message: string) => new AnswersError(message);
