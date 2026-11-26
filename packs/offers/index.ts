// Offers (stage 34, step 5): money off, as records. A **discount** says what is off (a percentage,
// an amount, or a set price), on what (drop-in classes, event tickets, passes, courses, shop
// goods), for whom (anyone, signed-in customers, members, new customers, an organisation, a tag),
// when, and how often; it applies by a **promo code** the buyer types (one shared word, or a batch
// of single-use codes) or **by itself** (a member's price, a customer rate). The pack's records are
// discounts and codes; the word "offer" alone is not used for them (CONTEXT.md).
//
// Everything that is a rule is the host's, declared here as the `discount` behaviour (ADR 0693):
//   - the host reads a live discount when it prices an order (`priceOrder`), works out the order's
//     one deal (the better of the code and every price that applies by itself, a tie to the
//     automatic one), keeps the limits in the order's batch, and gives a buyer one answer for every
//     code that does not apply. Nothing here computes a price, a percentage or who qualifies;
//   - a discount is made in `draft` and moved live only through this pack's tools, which a person
//     calls or approves (`activateDiscount`, `personApproves`, `offers:manage`); pausing and ending
//     it likewise. Any change to a live discount by an assistant, an MCP client, an automation or
//     extension code waits for a person (the host's, ADR 0693);
//   - single-use codes are kept as their hash (`codes.hashed`, ADR 0699): the host hashes what a
//     buyer types and looks it up by its index; nobody who reads a record, the audit log or a
//     query over the views can see a code. A batch's codes are shown once, to the person who makes
//     them (`generateCodes`, `humanOnly`); any other write of a code waits for a person (the host's);
//   - discounts and codes are staff records: nothing of them is public or a customer's. A buyer
//     learns of a discount only through the host's `discount.check`, `order.quote` and the order's
//     deal.
// The tools in tools.ts compose the host's operations and hold no rule of their own.
import { defineExtension } from "@composable-os/sdk";
import { offersDashboards } from "./dashboards.ts";
import {
  activateDiscount,
  changeDiscount,
  codeBatches,
  DISCOUNT_STATES,
  DISCOUNT_WHO_OPTIONS,
  discounts,
  draftDiscount,
  endDiscount,
  generateCodes,
  pauseDiscount,
  SOLD_OBJECTS,
  voidBatch,
  voidCodes,
} from "./tools.ts";

export default defineExtension({
  id: "offers",
  version: "0.1.0",
  contractVersion: 1,
  label: "Offers",
  description:
    "Discounts the host applies when it prices an order: promo codes for a campaign, batches of " +
    "single-use codes, members' prices and customer rates, each with its dates, limits and who " +
    "it is for, made live by a person.",
  permissions: {
    // query.sql: the discounts' uses and what they gave (rec_discount_use, rec_order_adjustment)
    // for the staff lists and the dashboard.
    operations: ["query.sql"],
    modules: ["ops"],
  },
  objects: {
    discount: {
      label: "Discount",
      plural: "Discounts",
      icon: "percent",
      titleField: "name",
      description:
        "Money off: a percentage, an amount or a set price, on what it covers, for whom, when " +
        "and how often. Applied by a promo code or by itself (a member's price). Made as a draft " +
        "and made live by a person.",
      navigation: "main",
      navigationOrder: 30,
      fields: {
        name: {
          type: "text",
          label: "Name",
          required: true,
          description: "What staff and the buyer's order call it (January sale, Members' drop-in).",
        },
        note: { type: "longText", label: "Note", description: "Why it exists, for staff." },
        kind: {
          type: "select",
          label: "What is off",
          required: true,
          default: "percent",
          options: [
            { value: "percent", label: "A percentage off" },
            { value: "amount", label: "An amount off the order" },
            { value: "price", label: "A set price for each" },
          ],
        },
        percent: {
          type: "number",
          label: "Percentage off",
          description: "For a percentage: 1 to 100. Rounded down on each line by the host.",
          min: 1,
          max: 100,
        },
        amount: {
          type: "currency",
          label: "Amount",
          description:
            "For an amount off: the money off the order, spread over what it covers. For a set " +
            "price: what each one costs (never more than its own price).",
          min: 0,
        },
        automatic: {
          type: "boolean",
          label: "Applies by itself",
          default: false,
          description:
            "On: it applies with no code to everyone it is for (a member's price, a customer " +
            "rate). Off: only with a code.",
        },
        code: {
          type: "text",
          label: "Promo code",
          description:
            "One word anyone may type (JANUARY26), at least 6 letters or digits. Kept in capitals " +
            "without spaces; no two discounts share one. For single-use codes, make a batch.",
        },
        who: {
          type: "select",
          label: "Who it is for",
          default: "anyone",
          options: DISCOUNT_WHO_OPTIONS,
          description:
            "Anyone includes a guest. Every other choice needs a buyer who signed in (or staff " +
            "buying for a person): a guest never gets it.",
        },
        organisations: {
          type: "relation",
          label: "Organisations",
          to: "organisation",
          many: true,
          description: "For an organisation's people: a customer rate.",
        },
        tag: { type: "text", label: "Tag", description: "For people with this tag." },
        appliesTo: {
          type: "multiSelect",
          label: "Applies to",
          options: SOLD_OBJECTS,
          description: "What it takes money off. Empty: everything but postage.",
        },
        from: { type: "date", label: "From", description: "From the start of this day (UTC)." },
        until: { type: "date", label: "Until", description: "To the end of this day (UTC)." },
        totalUses: {
          type: "number",
          label: "Uses in total",
          description: "The most orders it may be used on, across everyone. Empty: no limit.",
          min: 1,
          step: 1,
        },
        perPerson: {
          type: "number",
          label: "Uses per person",
          description:
            "The most orders one person may use it on (addresses with a +tag count as one). A " +
            "guest never gets a discount with this limit. Empty: no limit.",
          min: 1,
          step: 1,
        },
        minSpend: {
          type: "currency",
          label: "Minimum spend",
          description: "The least what it covers must cost on the order. Empty: none.",
          min: 0,
        },
        state: {
          type: "select",
          label: "State",
          default: "draft",
          track: "timeline",
          options: DISCOUNT_STATES,
        },
      },
      states: {
        field: "state",
        initial: "draft",
        // Every move is a person's, through a tool a person calls or approves (ADR 0693): an
        // assistant's request waits. Paused and back changes nothing a buyer is charged but is
        // the same person's decision.
        moves: [
          {
            from: ["draft", "paused"],
            to: "active",
            by: ["host"],
            tools: ["activateDiscount"],
          },
          { from: "active", to: "paused", by: ["host"], tools: ["pauseDiscount"] },
          {
            from: ["draft", "active", "paused"],
            to: "ended",
            by: ["host"],
            tools: ["endDiscount"],
            final: true,
          },
        ],
      },
      discount: {
        kind: "kind",
        percent: "percent",
        amount: "amount",
        live: ["active"],
        automatic: "automatic",
        code: "code",
        codes: {
          object: "code",
          discount: "discount",
          word: "word",
          uses: "uses",
          active: "active",
          hashed: true,
        },
        who: "who",
        organisations: "organisations",
        tag: "tag",
        objects: "appliesTo",
        from: "from",
        until: "until",
        totalUses: "totalUses",
        perPerson: "perPerson",
        minSpend: "minSpend",
      },
      indexes: [["state"], ["automatic", "state"]],
    },
    code: {
      label: "Single-use code",
      plural: "Single-use codes",
      icon: "ticket",
      titleField: "label",
      description:
        "One of a batch of codes made for a discount, each good for a set number of orders (one, " +
        "by default). Kept as its hash: the codes are shown once, to the person who makes them.",
      navigation: "none",
      fields: {
        label: {
          type: "text",
          label: "Label",
          readOnly: true,
          description: "The batch and the code's number in it.",
        },
        discount: {
          type: "relation",
          label: "Discount",
          to: "offers.discount",
          readOnly: true,
        },
        batch: { type: "text", label: "Batch", readOnly: true },
        word: {
          type: "text",
          label: "Code (its hash)",
          readOnly: true,
          description: "What the host keeps of the code: its hash, never the code.",
        },
        uses: {
          type: "number",
          label: "Orders per code",
          readOnly: true,
          min: 1,
          step: 1,
          description: "The most orders this code may be used on.",
        },
        active: {
          type: "boolean",
          label: "Works",
          default: true,
          description: "Off: the code is void. Switched off by voidBatch, voidCodes or a person.",
        },
        madeBy: { type: "text", label: "Made by", readOnly: true },
      },
      indexes: [["discount", "batch"]],
    },
  },
  views: {
    liveDiscounts: {
      label: "Live",
      object: "offers.discount",
      filter: { field: "state", op: "eq", value: "active" },
      sort: { field: "name", direction: "asc" },
      columns: ["name", "kind", "percent", "amount", "code", "automatic", "who", "until"],
    },
    draftDiscounts: {
      label: "Drafts",
      object: "offers.discount",
      filter: { field: "state", op: "eq", value: "draft" },
      sort: { field: "createdAt", direction: "desc" },
      columns: ["name", "kind", "percent", "amount", "code", "automatic", "who", "createdAt"],
    },
    memberPrices: {
      label: "Members' prices and customer rates",
      object: "offers.discount",
      filter: {
        and: [
          { field: "automatic", op: "eq", value: true },
          { field: "state", op: "in", value: ["draft", "active", "paused"] },
        ],
      },
      sort: { field: "name", direction: "asc" },
      columns: ["name", "who", "kind", "percent", "amount", "appliesTo", "state"],
    },
    promoCodes: {
      label: "Promo codes",
      object: "offers.discount",
      filter: {
        and: [
          { field: "code", op: "is_not_null" },
          { field: "state", op: "in", value: ["draft", "active", "paused"] },
        ],
      },
      sort: { field: "name", direction: "asc" },
      columns: ["name", "code", "kind", "percent", "amount", "from", "until", "state"],
    },
  },
  dashboards: offersDashboards,
  recordTabs: {
    discountCodes: {
      label: "Single-use codes",
      on: "offers.discount",
      view: {
        type: "table",
        object: "offers.code",
        relation: "discount",
        columns: ["label", "batch", "uses", "active", "madeBy", "createdAt"],
        sort: { field: "createdAt", direction: "desc" },
      },
      order: 10,
    },
  },
  tools: {
    discounts,
    codeBatches,
    draftDiscount,
    changeDiscount,
    activateDiscount,
    pauseDiscount,
    endDiscount,
    generateCodes,
    voidBatch,
    voidCodes,
  },
});
