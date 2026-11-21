// Broken on purpose: a relation to an object no installed extension declares.
import { defineExtension } from "@composable-os/sdk";

export default defineExtension({
  id: "missingrelation",
  version: "1.0.0",
  contractVersion: 1,
  label: "Missing relation",
  permissions: {},
  objects: {
    visit: {
      label: "Visit",
      plural: "Visits",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        site: { type: "relation", label: "Site", to: "premises.site" },
      },
    },
  },
});
