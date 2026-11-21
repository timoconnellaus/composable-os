// A fixture extension for the generator's tests: one object and one tool open to customers, as an
// org's own extension or a pack would ship it (ADR 0414).
import { defineExtension, defineTool, z } from "@composable-os/sdk";

const greet = defineTool({
  description:
    "Fixture: greets the signed-in customer by the name they give. Writes nothing. Used by the " +
    "client generator's tests to check that a product's own tools are typed.",
  risk: "read",
  audiences: ["customer"],
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ greeting: z.string() }),
  async handler(input) {
    return { greeting: `Hello, ${input.name}` };
  },
});

export default defineExtension({
  id: "greeter",
  version: "1.0.0",
  contractVersion: 1,
  label: "Greeter",
  description: "A fixture extension with one customer tool, for the client generator's tests.",
  permissions: {},
  objects: {
    note: {
      label: "Note",
      plural: "Notes",
      titleField: "text",
      fields: { text: { type: "text", label: "Text", required: true } },
    },
  },
  tools: { greet },
});
