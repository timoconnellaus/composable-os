// Broken on purpose: the automation notifies an owner, and the extension does not declare the
// notification.send operation.
import { defineAutomation, defineExtension } from "@composable-os/sdk";

const remind = defineAutomation({
  label: "Remind the owner",
  description: "The day a renewal is due, reminds its owner.",
  trigger: {
    type: "dateRelative",
    object: "undeclaredperm.renewal",
    field: "dueOn",
    offsetDays: 0,
  },
  steps: [
    { name: "notifyOwner", notifies: [{ to: { field: "owner" }, message: "{record} is due" }] },
  ],
  async run(_event, step, ctx) {
    return step.do("notifyOwner", () =>
      ctx.notify({ field: "owner" }, { title: "{record} is due" }),
    );
  },
});

export default defineExtension({
  id: "undeclaredperm",
  version: "1.0.0",
  contractVersion: 1,
  label: "Undeclared permission",
  permissions: { modules: ["ops"] },
  objects: {
    renewal: {
      label: "Renewal",
      plural: "Renewals",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        dueOn: { type: "date", label: "Due on" },
        owner: { type: "user", label: "Owner" },
      },
    },
  },
  automations: { remind },
});
