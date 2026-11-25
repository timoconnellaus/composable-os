// The Forms tools. They become operations x.forms.<tool>, run in the sandbox, and reach the host
// only through ctx.ops. None of them holds a rule: whether a form takes answers from the caller,
// the spam checks, the caps, the answers' shape, the submitter's Person and who may tick a
// "keep me updated" line are all the door's (`intake.open` and `intake.submit`, ADR 0720); the
// inbox's moves are the submission's states. A tool asks, and reports what the host answered.
import { defineTool, type ExtensionContext, OpsCallError, z } from "@composable-os/sdk";

export const FORM = "forms.form";
export const SUBMISSION = "forms.submission";

/** A record as record.get and record.update return it. */
interface HostRecord {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
}

/** What intake.open answers. */
interface OpenForm {
  id: string;
  version: number;
  content: Record<string, unknown>;
  anonymous: boolean;
  turnstile: boolean;
  shown: string | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

const formId = z.string().min(1).max(64).describe("The form (forms.form record id)");
const submissionId = z.string().min(1).max(64).describe("The submission (forms.submission id)");
const answers = z
  .record(z.string().max(40), z.unknown())
  .describe(
    "The answers by question key: text, email, phone and date as strings (a date YYYY-MM-DD), " +
      "number and rating as numbers, a choice as a string or a list of strings, yes/no and a " +
      "tick box as true or false. Leave out what was not answered.",
  );
const received = z.object({
  received: z
    .literal(true)
    .describe("The answers were sent: shown the same whatever the host's spam checks decided"),
});

// --- Answering (the public and customers) --------------------------------------------------------

const openOutput = z.object({
  id: z.string(),
  version: z.number().describe("The version shown: send it with the answers"),
  title: z.string().nullable(),
  questions: z
    .object({ items: z.array(z.record(z.string(), z.unknown())) })
    .describe("The questions, in the platform's question schema, in order"),
  thanks: z.string().nullable().describe("The words to show once the answers are sent"),
  anonymous: z.boolean().describe("Nothing kept says who answered"),
  turnstile: z.boolean().describe("A Turnstile token must be sent with the answers"),
  shown: z.string().nullable().describe("Send back as `shown` with the answers"),
});

export const form = defineTool({
  description:
    "A form by its address, as the caller may answer it now: its version, title, questions and " +
    "thank-you words, whether it is anonymous, whether a Turnstile token is needed, and the " +
    "host's token of when it was shown (send it back with the answers). A form that is not " +
    "open to the caller now (a draft, closed, not published, out of its dates, for signed-in " +
    "customers only, or no such address) is not found, the same answer whatever the reason. " +
    "Or open the form a personal link is for: `link`, the token from its email (no sign-in " +
    "needed; a signed-in member's own link from Needs your attention is `linkedForm`). A link " +
    "that cannot be used (used, expired, unknown) is one answer whatever is wrong, and opening " +
    "it uses nothing. Read-only.",
  input: z.object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("The form's address, e.g. ask-about-a-trial"),
    link: z.string().min(1).max(200).optional().describe("A personal link's token"),
  }),
  output: openOutput,
  risk: "read",
  audiences: ["customer", "public"],
  // A personal link's token never reaches the audit log.
  redact: ["link"],
  async handler(input, ctx) {
    return drawn(
      await ctx.ops.call<OpenForm>("intake.open", {
        object: FORM,
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.link !== undefined ? { link: input.link } : {}),
      }),
    );
  },
});

/** What `form` and `linkedForm` give a client to draw. */
function drawn(open: OpenForm) {
  const questions = open.content.questions as { items: Record<string, unknown>[] } | undefined;
  return {
    id: open.id,
    version: open.version,
    title: text(open.content.title),
    questions: { items: Array.isArray(questions?.items) ? questions.items : [] },
    thanks: text(open.content.thanks),
    anonymous: open.anonymous,
    turnstile: open.turnstile,
    shown: open.shown,
  };
}

export const linkedForm = defineTool({
  description:
    "The form a signed-in member's own personal link is for (or a child's they are a guardian " +
    "of): `linkId` is the id Needs your attention gives (me.attention, kind form_to_fill). As " +
    "`form` gives it; a link that cannot be used is one answer. Read-only.",
  input: z.object({
    linkId: z.string().min(1).max(64).describe("The personal link's id, from Needs your attention"),
  }),
  output: openOutput,
  risk: "read",
  audiences: ["customer"],
  async handler(input, ctx) {
    return drawn(
      await ctx.ops.call<OpenForm>("intake.open", { object: FORM, linkId: input.linkId }),
    );
  },
});

export const submit = defineTool({
  description:
    "Send answers to a form the caller may answer (from `form`). The host checks the form is " +
    "still open to them, a visitor's Turnstile token and when the form was shown, the caps and " +
    "the answers against the version shown, then keeps them in the business's inbox, linked to " +
    "the sender's person by the email answered. Answers that break the form are refused naming " +
    "the question's key; a form published again since it was shown is refused with 'load it " +
    "again'; too many answers just now is 'try again later'. Kept, kept as spam or dropped, the " +
    "answer is the same. By a personal link (`link`, as `form` opened it; signed in, " +
    "`submitLinked`), the answers are the link's person's, once: no Turnstile token or shown " +
    "time is needed, and a link that cannot be used is one answer.",
  input: z.object({
    id: formId,
    version: z.number().int().positive().describe("The version `form` showed"),
    answers,
    via: z
      .enum(["site", "app", "page"])
      .optional()
      .describe("Which way in: the business's website, its app, or the form's own page"),
    turnstileToken: z.string().max(4096).optional().describe("A visitor's Turnstile token"),
    shown: z.string().max(200).optional().describe("`form`'s shown token"),
    honeypot: z.string().max(1000).optional().describe("The hidden field a person leaves empty"),
    link: z.string().min(1).max(200).optional().describe("A personal link's token"),
  }),
  output: received,
  risk: "write",
  audiences: ["customer", "public"],
  // What a person answered never reaches the audit row (the door keeps only the question keys),
  // nor does a personal link's token.
  redact: ["answers", "turnstileToken", "shown", "honeypot", "link"],
  async handler(input, ctx) {
    return ctx.ops.call<{ received: true }>("intake.submit", {
      object: FORM,
      id: input.id,
      version: input.version,
      answers: input.answers,
      ...(input.via ? { via: input.via } : {}),
      ...(input.turnstileToken ? { turnstileToken: input.turnstileToken } : {}),
      ...(input.shown ? { shown: input.shown } : {}),
      ...(input.honeypot !== undefined ? { honeypot: input.honeypot } : {}),
      ...(input.link !== undefined ? { link: input.link } : {}),
    });
  },
});

export const submitLinked = defineTool({
  description:
    "Send answers by a signed-in member's own personal link (or a child's they are a guardian " +
    "of), from Needs your attention: `linkId` as `linkedForm` opened it. The answers are the " +
    "link's person's, once; a link that cannot be used is one answer, the same as for a token.",
  input: z.object({
    linkId: z.string().min(1).max(64).describe("The personal link's id, from Needs your attention"),
    id: formId,
    version: z.number().int().positive().describe("The version `linkedForm` showed"),
    answers,
    honeypot: z.string().max(1000).optional().describe("The hidden field a person leaves empty"),
  }),
  output: received,
  risk: "write",
  audiences: ["customer"],
  redact: ["answers", "honeypot"],
  async handler(input, ctx) {
    return ctx.ops.call<{ received: true }>("intake.submit", {
      object: FORM,
      id: input.id,
      version: input.version,
      answers: input.answers,
      via: "app",
      linkId: input.linkId,
      ...(input.honeypot !== undefined ? { honeypot: input.honeypot } : {}),
    });
  },
});

// --- Staff ---------------------------------------------------------------------------------------

export const enter = defineTool({
  description:
    "Enter answers on someone's behalf (a phone call, a paper form) or fill in a staff form (an " +
    "incident report), for any published form. The submission is marked as entered by staff, " +
    "and the person is found or made from the email answered, filling only their empty " +
    "fields. Staff cannot tick a 'keep me updated' line for someone: only the person can.",
  input: z.object({ formId, answers }),
  output: received,
  risk: "write",
  permission: "forms:answer",
  redact: ["answers"],
  async handler(input, ctx) {
    return ctx.ops.call<{ received: true }>("intake.submit", {
      object: FORM,
      id: input.formId,
      answers: input.answers,
    });
  },
});

const inboxStates = ["new", "inHand", "done"] as const;
const stateLabel: Record<string, string> = {
  new: "new",
  inHand: "in hand",
  done: "done",
  spam: "spam",
};

/** The submission's state now, for a refusal's words. */
async function stateOf(ctx: ExtensionContext, id: string) {
  const record = await ctx.ops.call<HostRecord>("record.get", { object: SUBMISSION, id });
  return text(record.values.status);
}

const moved = z.object({
  id: z.string(),
  status: z.string(),
});

export const move = defineTool({
  description:
    "Move a submission in the inbox: new, in hand or done. Refused when the move is not one the " +
    "inbox has (a spam submission is taken out with notSpam first), or when someone moved it " +
    "meanwhile.",
  input: z.object({
    submissionId,
    to: z.enum(inboxStates),
    from: z
      .enum([...inboxStates, "spam"])
      .optional()
      .describe("Only if it is still in this state: for a move two people may make at once"),
  }),
  output: moved,
  risk: "write",
  permission: "forms:answer",
  async handler(input, ctx) {
    const after = await ctx.ops.call<HostRecord>("record.update", {
      object: SUBMISSION,
      id: input.submissionId,
      ...(input.from ? { from: input.from } : {}),
      values: { status: input.to },
    });
    return { id: after.id, status: text(after.values.status) ?? input.to };
  },
});

export const markSpam = defineTool({
  description:
    "Mark a submission as spam: it leaves the inbox and is kept in Spam. A person's act: the " +
    "assistant may suggest it, and the suggestion waits for a person to approve it. Undo with " +
    "notSpam.",
  recordAction: {
    object: SUBMISSION,
    label: "Mark as spam",
    idInput: "submissionId",
    confirm: "Move these answers to Spam?",
    hideWhen: { field: "status", values: ["spam"] },
  },
  input: z.object({ submissionId }),
  output: moved,
  risk: "write",
  // Anyone but a person waits for a person (ADR 0552): the move into spam is this tool's and the
  // host's only.
  personApproves: true,
  permission: "forms:answer",
  async handler(input, ctx) {
    // Marked twice (two people, or an approval after a person did it): already done.
    if ((await stateOf(ctx, input.submissionId)) === "spam") {
      return { id: input.submissionId, status: "spam" };
    }
    const after = await ctx.ops.call<HostRecord>("record.update", {
      object: SUBMISSION,
      id: input.submissionId,
      values: { status: "spam" },
    });
    return { id: after.id, status: text(after.values.status) ?? "spam" };
  },
});

export const notSpam = defineTool({
  description:
    "Take a submission out of Spam: it is back in the inbox as new. A person's act: the " +
    "assistant may suggest it, and the suggestion waits for a person to approve it.",
  recordAction: {
    object: SUBMISSION,
    label: "Not spam",
    idInput: "submissionId",
    hideWhen: { field: "status", values: ["new", "inHand", "done"] },
  },
  input: z.object({ submissionId }),
  output: moved,
  risk: "write",
  personApproves: true,
  permission: "forms:answer",
  async handler(input, ctx) {
    try {
      const after = await ctx.ops.call<HostRecord>("record.update", {
        object: SUBMISSION,
        id: input.submissionId,
        from: "spam",
        values: { status: "new" },
      });
      return { id: after.id, status: text(after.values.status) ?? "new" };
    } catch (error) {
      if (!(error instanceof OpsCallError) || error.code !== "conflict") throw error;
      const now = await stateOf(ctx, input.submissionId);
      throw new OpsCallError(
        "conflict",
        `These answers are not in Spam (they are ${stateLabel[now ?? ""] ?? "elsewhere"}).`,
        { reason: "not_spam" },
      );
    }
  },
});
