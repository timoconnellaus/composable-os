// Broken on purpose: an automation that runs only with owbase (ADR 0812) names an object owbase
// does not have (visits, not visit). A deployment without owbase cannot see that; `cos ext check`
// installs owbase from beside it first, so it can.
import { defineAutomation, defineExtension } from "@composable-os/sdk";

export default defineExtension({
  id: "owuser",
  version: "1.0.0",
  contractVersion: 1,
  label: "Thank-yous",
  permissions: { read: ["owbase.visit"], write: ["task"], operations: [], modules: ["ops"] },
  automations: {
    afterVisit: defineAutomation({
      label: "After a visit",
      description: "When a visit is attended, a thank-you task.",
      onlyWith: ["owbase"],
      trigger: { type: "fieldChanged", object: "owbase.visits", field: "state", to: "attended" },
      steps: [{ name: "thank", writes: [{ object: "task" }] }],
      async run(_event, step, ctx) {
        return step.do("thank", () => ctx.ops.call("task.create", { title: "Thank you" }));
      },
    }),
  },
});
