// intake.* operations (stage 29 step 2, ADRs 0720 to 0722 and 0725): the public-write door.
//
//   intake.open    a pack's tool: staff, customers, the public   a form taking answers, to draw
//   intake.submit  a pack's tool: staff, customers, the public   the answers, kept by the host
//
// Both are `toolOnly`: a pack's own tool calls them for its own forms (Forms' `x.forms.form` and
// `x.forms.submit`), never a person, MCP or the assistant directly. Both are `hostInternal`
// (ADR 0413): the host reads the form past the caller's scope and, for `intake.submit`, makes the
// submission, the Person and a destination as its own change (ADR 0428's `recordHostChange`).
// `intake.submit` is the only operation that lets the public create a record that is not a
// purchase: opening it is a reviewed change (ADR 0402), and `open-operations.json` lists it.
import { INTAKE_VIAS } from "@composable-os/sdk";
import { z } from "zod";
import { ConflictError, NotFoundError } from "../errors.ts";
import { formIdBySlug, openForm } from "../intake/forms.ts";
import { NO_INTAKE_RUNTIME } from "../intake/runtime.ts";
import { askerOf, assertCalledByOwner, type RECEIVED, submitIntake } from "../intake/submit.ts";
import { defineOperation } from "../operation.ts";

const objectName = z.string().min(1).max(81).describe("The form object, e.g. forms.form");
const recordId = z.string().min(1).max(64);

export const intakeOpen = defineOperation({
  name: "intake.open",
  description:
    "From a pack's tool: one of its forms as the caller may answer it now (published, open, " +
    "within its dates and open to them; otherwise not found, whatever the reason). Returns the " +
    "published version's number and content (its questions, title and thank-you words) and, for " +
    "a caller who is not signed in, `shown`: the host's token of when the form was shown, which " +
    "intake.submit needs to tell a person from a script. Give the form's id, or its address " +
    "(`slug`) when the form object has one: a link or a QR code names a form by its address. " +
    "Read-only.",
  input: z
    .object({
      object: objectName,
      id: recordId.optional(),
      slug: z.string().min(1).max(200).optional().describe("The form's address, instead of id"),
    })
    .refine((input) => (input.id === undefined) !== (input.slug === undefined), {
      message: "Give the form's id or its slug, not both",
    }),
  output: z.object({
    id: z.string(),
    version: z.number(),
    content: z.record(z.string(), z.unknown()),
    anonymous: z.boolean(),
    turnstile: z
      .boolean()
      .describe("Whether the caller must pass a Turnstile token to intake.submit"),
    shown: z.string().nullable(),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  toolOnly: true,
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    assertCalledByOwner(ctx, "intake.open", input.object);
    const asker = askerOf(ctx);
    const form =
      input.id !== undefined
        ? await openForm(ctx, input.object, input.id, asker)
        : await openForm(
            ctx,
            input.object,
            await formIdBySlug(ctx, input.object, input.slug as string),
            asker,
          ).catch((error: unknown) => {
            // Named by its address, a form that is not open is not found by that address: its id
            // never comes back, so an address tells a caller nothing a wrong one would not.
            if (error instanceof NotFoundError) {
              throw new NotFoundError(input.object, input.slug as string);
            }
            throw error;
          });
    const runtime = ctx.intake ?? NO_INTAKE_RUNTIME;
    return {
      id: form.id,
      version: form.version,
      content: form.content,
      anonymous: form.anonymous,
      turnstile: asker === "public",
      shown: asker === "public" ? await runtime.signShown(form.id, ctx.now) : null,
    };
  },
});

export const intakeSubmit = defineOperation({
  name: "intake.submit",
  description:
    "From a pack's tool: send answers to one of its forms (the public-write door, ADR 0720). " +
    "The host checks the form takes answers from the caller now, a visitor's Turnstile token " +
    "and shown time, the caps and the answers against the published version; then keeps one " +
    "submission, matching or making the submitter's Person by the address answered (only " +
    "empty fields of a Person are filled), and any destination record the form names, in one " +
    "batch, and tells staff. Answers that break the version are refused naming the question's " +
    "key, never the value. A submission kept as spam, or dropped by the honeypot or the fill " +
    "time, is answered exactly as a kept one: { received: true }.",
  input: z.object({
    object: objectName,
    id: recordId,
    answers: z
      .record(z.string().max(40), z.unknown())
      .describe("The answers by question key, as the client sends them"),
    via: z.enum(INTAKE_VIAS).optional().describe("Which way in: site, app or page"),
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The version intake.open showed: refused when another has been published since"),
    turnstileToken: z.string().max(4096).optional().describe("A visitor's Turnstile token"),
    shown: z.string().max(200).optional().describe("intake.open's shown token"),
    honeypot: z.string().max(1000).optional().describe("The hidden field a person leaves empty"),
  }),
  output: z.object({ received: z.literal(true) }),
  permission: "records:write",
  risk: "write",
  audiences: ["staff", "customer", "public"],
  toolOnly: true,
  hostInternal: true,
  mcp: { expose: false },
  // What a person answered never reaches the audit row's input; the token is redacted by name.
  redact: ["answers", "honeypot", "shown"],
  // Only which questions were answered, never a value.
  auditSummary: (_output, input) => ({
    object: input.object,
    id: input.id,
    keys: Object.keys(input.answers),
  }),
  // Two first answers from one new address at once each make a Person; the database keeps one
  // address to one Person and refuses the second batch. Nothing was kept: the caller sends again,
  // and is then matched to the Person the first made.
  async explainFailure(error) {
    if (error.code !== "conflict") return null;
    return new ConflictError("Your answers were not kept: please send them again", {
      rule: "intake_retry",
    });
  },
  async handler(input, ctx) {
    return submitIntake(ctx, input) as Promise<typeof RECEIVED>;
  },
});

export const intakeOperations = [intakeOpen, intakeSubmit] as const;
