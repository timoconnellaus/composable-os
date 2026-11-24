// me.portal (stage 48 step 5, ADR 0710): which sections of My account the signed-in customer
// has, in order. The base sections, and each installed shipped pack's section (its `portal`
// declaration) when the caller, or a child linked to them where the object opens to guardians,
// holds one of the records it names; and whether Payment method shows. Worked out in core
// (customers/portal.ts); the client renders it and decides nothing. Open to customers only,
// outside MCP and the assistant. `hostInternal`: it reads the installed packs' declarations and
// the subscriptions the caller pays (taken from the principal, never from input); records only
// through the seam.
import { z } from "zod";
import { portalOf } from "../customers/portal.ts";
import { defineOperation } from "../operation.ts";

const blockOut = z
  .object({ block: z.string(), export: z.string() })
  .nullable()
  .describe("The block of the client app that draws a pack's section, and its component");

const section = z.object({
  key: z
    .string()
    .describe(
      "A base section's key (orders, agreements, family, payment, details, devices), or a pack's as <pack>.<key>",
    ),
  pack: z.string().nullable().describe("The pack the section is from; null for a base section"),
  label: z.string(),
  order: z.number().describe("Lower first: a pack's sections come before the base ones"),
  web: blockOut,
  native: blockOut,
});

export const mePortal = defineOperation({
  name: "me.portal",
  description:
    "The sections of your account, as a signed-in customer, in the order they show: your " +
    "orders, agreements, family, payment method (only when you pay a subscription), details " +
    "and where you are signed in, and each installed pack's section (bookings, memberships and " +
    "passes, courses, tickets, training) when you, or a child linked to you, have something " +
    "there. `paysSubscription` says whether you pay a subscription. Read-only.",
  input: z.object({}),
  output: z.object({
    sections: z.array(section),
    paysSubscription: z.boolean().describe("Whether you pay a subscription that has not ended"),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  handler: (_input, ctx) => portalOf(ctx),
});

export const mePortalOperations = [mePortal] as const;
