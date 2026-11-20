// Broken on purpose: the stage rule requires a field the object does not have (lostReason).
import { defineExtension } from "@composable-os/sdk";

export default defineExtension({
  id: "stagerule",
  version: "1.0.0",
  contractVersion: 1,
  label: "Stage rule",
  permissions: {},
  objects: {
    step: {
      label: "Step",
      plural: "Steps",
      titleField: "name",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        position: { type: "number", label: "Order", required: true },
        type: {
          type: "select",
          label: "Type",
          required: true,
          options: [
            { value: "open", label: "Open" },
            { value: "won", label: "Won" },
            { value: "lost", label: "Lost" },
          ],
        },
      },
    },
    application: {
      label: "Application",
      plural: "Applications",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        step: { type: "relation", label: "Step", to: "stagerule.step" },
      },
      stages: {
        field: "step",
        stage: { type: "type", order: "position" },
        requiredByType: { lost: ["lostReason"] },
      },
    },
  },
});
