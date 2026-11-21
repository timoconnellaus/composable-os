// Broken on purpose: the formula names a field that does not exist (amout for amount).
import { defineExtension } from "@composable-os/sdk";

export default defineExtension({
  id: "badformula",
  version: "1.0.0",
  contractVersion: 1,
  label: "Bad formula",
  permissions: {},
  objects: {
    invoice: {
      label: "Invoice",
      plural: "Invoices",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        amount: { type: "currency", label: "Amount" },
        withTax: { type: "formula", label: "With tax", expression: "round(amout * 1.1, 2)" },
      },
    },
  },
});
