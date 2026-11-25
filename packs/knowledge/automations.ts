// The Knowledge automations (stage 38 step 5, ADR 0706). The notices of read and understood (a
// version to read, the 7-day reminder, the owners' weekly notice, the welcome of a new account)
// are the host's, in this pack's words (`acknowledge.notices` in index.ts): only the host knows who
// must read a procedure and who has not. This one is the review reminder: on a procedure's next
// review date (its last publish plus its "review every" months, a formula; none when it is 0),
// its owner is told to check it is still right, or the admins when it has none.
import { defineAutomation } from "@composable-os/sdk";
import { PROCEDURE } from "./tools.ts";

export const reviewDue = defineAutomation({
  label: "Time to review a procedure",
  description:
    "On a published procedure's next review date (its last publish plus its review period, 12 " +
    "months unless set; never when 0), tells its owner to check it is still right, or the " +
    "admins when it has no owner.",
  trigger: { type: "dateRelative", object: PROCEDURE, field: "nextReview", offsetDays: 0 },
  // No condition: the next review is empty while the procedure is not published (no version).
  steps: [
    {
      name: "tell",
      label: "Tell the owner, or the admins",
      notifies: [
        { to: { field: "owner" }, message: "Time to check this is still right: {record}" },
        { to: "admins", message: "Time to check this is still right: {record}" },
      ],
    },
  ],
  async run(event, step, ctx) {
    const procedure = event.record;
    if (!procedure) return { skipped: "no procedure" };
    return step.do("tell", async () => {
      const owner = procedure.data?.owner;
      await ctx.notify(typeof owner === "string" && owner ? { field: "owner" } : "admins", {
        title: "Time to check this is still right: {record}",
        body:
          "Read the procedure as it is published. If it is still right, publish it again as a " +
          "small fix to start a new review period; if not, change it and publish.",
        link: "record",
      });
      return { told: typeof owner === "string" && owner ? "owner" : "admins" };
    });
  },
});

export const knowledgeAutomations = { reviewDue };
