// me.attention (stage 48 step 4, ADR 0711): "Needs your attention" at the top of My account. One
// customer read, worked out in core (customers/attention.ts) from agreements, orders,
// subscriptions and the `allowance` behaviour, never from a pack's code. Open to customers only,
// outside MCP and the assistant. `hostInternal`: it reads the host's own subscription, order,
// acceptance and allowance rows for the caller (taken from the principal, never from input), and
// a pass's title through the seam.
import { z } from "zod";
import { ATTENTION_KINDS, attentionOf } from "../customers/attention.ts";
import { defineOperation } from "../operation.ts";

const item = z.object({
  key: z.string().describe("Stable for the same cause: kind, record and Person"),
  kind: z
    .enum(ATTENTION_KINDS)
    .describe(
      "agree: a document to agree to (me.agreements.due has it). card_failing: a card payment " +
        "for a subscription you pay failed. confirm_payment: a payment waits for you to confirm " +
        "it with your bank. balance_due: the rest of a deposit to pay. finish_paying: an order " +
        "holding places you started paying for and did not finish. pass_expiring: a pass about " +
        "to expire with uses still on it. pass_used_up: a pass with no uses left. " +
        "trial_ending: a free trial about to end. form_to_fill: a form the business asked you " +
        "(or a child linked to you) to answer, such as feedback after a class, until it is " +
        "answered or its link expires.",
    ),
  person: z
    .object({ id: z.string(), name: z.string(), self: z.boolean() })
    .describe("Whose it is: you (self), or a child linked to you"),
  record: z
    .object({ object: z.string(), id: z.string(), title: z.string() })
    .describe(
      "What it is about: an agreement document, a subscription, an order, a pass by its object, " +
        "or the form to answer",
    ),
  at: z
    .string()
    .nullable()
    .describe(
      "The moment it is about: the version taking effect, the first failed payment, the " +
        "payment started, the balance due, the held order expiring, the pass or trial ending, " +
        "the form's link expiring",
    ),
  amount: z
    .number()
    .nullable()
    .describe("Money due or to be charged, in the currency's minor unit; null where none"),
  currency: z.string().nullable(),
  usesLeft: z.number().nullable().describe("A pass's uses left; null for other kinds"),
  link: z
    .string()
    .nullable()
    .describe(
      "form_to_fill: the personal link's id, sent back as linkId to open and answer the form " +
        "(signed in only); null for other kinds",
    ),
});

export const meAttention = defineOperation({
  name: "me.attention",
  description:
    "What needs your attention, as a signed-in customer, soonest first: a document to agree to " +
    "(for you or a child linked to you), a card payment that failed, a payment waiting for you " +
    "to confirm with your bank, the rest of a deposit to pay, an order you started paying for " +
    "and did not finish, a pass about to expire with uses left or with none left (yours or a " +
    "child's), a free trial about to end, and a form you were asked to answer (yours or a " +
    "child's). `days` is how far ahead it looks for a pass or a " +
    "trial ending. An item goes once its cause is fixed. Read-only.",
  input: z.object({}),
  output: z.object({
    days: z.number().describe("How many days ahead a pass or trial ending is listed"),
    items: z.array(item),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  handler: (_input, ctx) => attentionOf(ctx),
});

export const meAttentionOperations = [meAttention] as const;
