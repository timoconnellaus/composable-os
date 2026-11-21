// An online course for sale: the fixture extension for tax at checkout (stage 42 section 4, ADR
// 0479) until the Courses pack exists. It declares what `courses.course` will: Stripe's code for
// on-demand online courses (pre-recorded, streamed, not downloadable). Used by
// apps/runner/test/payments.test.ts; not shipped. Tests install it under a fresh id by rewriting
// `onlinecourse.`.
import { defineExtension } from "@composable-os/sdk";

export default defineExtension({
  id: "onlinecourse",
  version: "1.0.0",
  contractVersion: 1,
  label: "Online course",
  description: "A fixture: a course for sale that declares a product tax code.",
  permissions: {},
  objects: {
    course: {
      label: "Course",
      plural: "Courses",
      icon: "book",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        price: { type: "currency", label: "Price" },
      },
      public: { read: ["name", "price"] },
      sellable: { price: "price", tax: { code: "txcd_20060158" } },
    },
  },
});
