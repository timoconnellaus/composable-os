// The Forms automations. The notice of each new submission is the host's own (the door tells the
// form's chosen person, else the admins, ADR 0720); this one adds the low-rating notice: a first
// rating at or under the form's "tell at a rating of" tells the answers' owner (assignment rules),
// or the admins when they have none.
import { defineAutomation } from "@composable-os/sdk";
import { FORM } from "./tools.ts";

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const lowRating = defineAutomation({
  label: "Tell of a low rating",
  description:
    "When answers arrive with a rating at or under the form's 'tell at a rating of', tells the " +
    "answers' owner, or the admins when they have none. Answers kept as spam tell nobody.",
  trigger: { type: "record", object: "forms.submission", on: ["created"] },
  conditions: {
    and: [
      { field: "rating", op: "is_not_null" },
      { field: "status", op: "neq", value: "spam" },
    ],
  },
  steps: [
    {
      name: "tell",
      label: "Tell the owner, or the admins",
      reads: [FORM],
      notifies: [
        { to: { field: "owner" }, message: "A low rating: {record}" },
        { to: "admins", message: "A low rating: {record}" },
      ],
    },
  ],
  async run(event, step, ctx) {
    const submission = event.record;
    if (!submission) return { skipped: "no submission" };
    const rating = num(submission.data?.rating);
    const formId = submission.data?.form;
    if (rating === null || typeof formId !== "string") return { skipped: "no rating" };
    return step.do("tell", async () => {
      const form = await ctx.ops.call<{ values: Record<string, unknown> }>("record.get", {
        object: FORM,
        id: formId,
      });
      const level = num(form.values.lowRating);
      if (level === null || rating > level) return { told: false };
      const owner = submission.data?.owner;
      await ctx.notify(typeof owner === "string" && owner ? { field: "owner" } : "admins", {
        title: "A low rating: {record}",
        body: `Rated ${rating}. Open the answers to see why.`,
        link: "record",
      });
      return { told: true };
    });
  },
});

export const formsAutomations = { lowRating };
