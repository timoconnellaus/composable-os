// Broken on purpose: a pack's sections of My account whose blocks are wrong (stage 48, ADR 0710).
// `good` passes; `staff` names a block calling a staff-only tool, `skin` a block of the other skin,
// `foreign` a block whose block.json names another pack, `gone` a block that is not there, and
// `noExport` a component its block does not export. Read only by `cos ext check`, which has the
// files: not in expected.json, which the host's check shares.
import { defineExtension, defineTool, z } from "@composable-os/sdk";

const tool = (audiences: ("staff" | "customer")[]) =>
  defineTool({
    description: "Fixture: a read a section's block calls.",
    input: z.object({}),
    output: z.object({}),
    risk: "read",
    audiences,
    handler: () => ({}),
  });

const section = (key: string, web: string, exported = "Mine") => ({
  label: `Section ${key}`,
  web: { block: web, export: exported },
  order: 20,
  has: ["portalblocks.visit"],
});

export default defineExtension({
  id: "portalblocks",
  version: "1.0.0",
  contractVersion: 1,
  label: "Portal blocks",
  permissions: {},
  objects: {
    visit: {
      label: "Visit",
      plural: "Visits",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        person: { type: "relation", label: "Person", to: "person" },
      },
      customer: { field: "person", read: ["name"], write: [] },
    },
  },
  tools: { mine: tool(["customer"]), day: tool(["staff"]) },
  portal: {
    good: {
      ...section("good", "portalblocks-mine"),
      native: { block: "portalblocks-native-skin", export: "MineScreen" },
    },
    staff: section("staff", "portalblocks-desk"),
    foreign: section("foreign", "portalblocks-other"),
    gone: section("gone", "portalblocks-gone"),
    noExport: section("noExport", "portalblocks-mine", "Nowhere"),
  },
});
