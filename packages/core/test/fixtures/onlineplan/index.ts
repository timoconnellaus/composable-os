// A plan sold every month: the fixture extension for subscriptions (stage 32a, ADR 0485) until the
// Courses pack declares `courses.plan` (build step 3). Used by apps/runner/test/subscriptions.test.ts;
// not shipped. Tests install it under a fresh id by rewriting `onlineplan.`.
import { defineExtension } from "@composable-os/sdk";

export default defineExtension({
  id: "onlineplan",
  version: "1.0.0",
  contractVersion: 1,
  label: "Online plan",
  description: "A fixture: a plan paid for every month, with a free trial.",
  permissions: {},
  objects: {
    plan: {
      label: "Plan",
      plural: "Plans",
      icon: "book",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        price: { type: "currency", label: "Price per month" },
        trialDays: { type: "number", label: "Trial days" },
      },
      public: { read: ["name", "price", "trialDays"] },
      sellable: {
        price: "price",
        tax: { code: "txcd_20060158" },
        recurring: { interval: "month", trialDays: "trialDays" },
      },
    },
  },
});
