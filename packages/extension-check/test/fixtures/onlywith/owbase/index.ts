// The extension owuser's automation runs only with (ADR 0812), beside it as Bookings is beside
// Reviews in packs/.
import { defineExtension } from "@composable-os/sdk";

export default defineExtension({
  id: "owbase",
  version: "1.0.0",
  contractVersion: 1,
  label: "Visits",
  objects: {
    visit: {
      label: "Visit",
      plural: "Visits",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "booked", label: "Booked" },
            { value: "attended", label: "Attended" },
          ],
        },
      },
    },
  },
});
