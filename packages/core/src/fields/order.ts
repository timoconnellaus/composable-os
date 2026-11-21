// Field registry for Order and Order line (stage 25, ADR 0426): base records in core, used by
// every pack that sells. Names match the keys of the order.* operations.
//
// An order's lifecycle is declared here, in code, and held by the transition engine (ADR 0425).
// `paid`, `part_paid`, `refunded` and `expired` are moves only platform code makes (`host`): a
// verified payment, the expiry sweep, a confirmed refund. No person, MCP client, extension or
// import can make them, whatever they send.
//
// Both objects declare a customer: a signed-in customer reads their own orders and those orders'
// lines through the visibility seam, and nobody else's. Nothing is writable by a customer.
import { mediaObject } from "./media.ts";
import { subscriptionObject } from "./subscription.ts";
import { defineObject, type ObjectDefinition, type StatesDefinition } from "./types.ts";

export const ORDER_STATES = [
  "pending",
  "part_paid",
  "paid",
  "cancelled",
  "expired",
  "refunded",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

const STATE_LABELS: Record<OrderState, string> = {
  pending: "Pending",
  part_paid: "Part paid",
  paid: "Paid",
  cancelled: "Cancelled",
  expired: "Expired",
  refunded: "Refunded",
};

/** The order's fixed state machine. */
export const ORDER_MACHINE: StatesDefinition = {
  field: "state",
  initial: "pending",
  moves: [
    // Only a verified payment marks an order paid, in part or in full.
    { from: ["pending", "part_paid", "expired"], to: "paid", by: ["host"] },
    // A late deposit staff honour (ADR 0429) makes an expired order part paid.
    { from: ["pending", "expired"], to: "part_paid", by: ["host"] },
    // A buyer may give up an order they have paid nothing on. Once money is on it, staff cancel.
    { from: "pending", to: "cancelled", by: ["staff", "customer"], final: true },
    { from: "part_paid", to: "cancelled", by: ["staff"], final: true },
    // Not final: a late payment staff choose to honour makes it paid.
    { from: "pending", to: "expired", by: ["host"] },
    { from: "paid", to: "refunded", by: ["host"], final: true },
  ],
};

const id = { type: "id", filterable: true, sortable: false } as const;
const amount = { type: "number", filterable: true, sortable: true } as const;
const when = { type: "datetime", filterable: true, sortable: true } as const;

export const orderObject = defineObject({
  name: "order",
  label: "Order",
  plural: "Orders",
  source: "rec_order",
  defaultSort: { field: "createdAt", direction: "desc" },
  states: ORDER_MACHINE,
  customer: {
    field: "personId",
    read: [
      "state",
      "currency",
      "total",
      "paid",
      "balance",
      "refunded",
      "pay",
      "deposit",
      "balanceDueAt",
      "expiresAt",
      "paidAt",
      "createdAt",
      "taxAmount",
      "taxRefunded",
      "taxCountry",
      "subscriptionId",
      "periodStart",
      "periodEnd",
    ],
    write: [],
  },
  fields: [
    { name: "id", label: "ID", type: "id", column: "id", filterable: true, sortable: true },
    {
      ...id,
      name: "personId",
      label: "Person",
      column: "person_id",
      // What the customer declaration needs to know: this is whose order it is.
      fieldType: "relation",
      options: { to: "person" },
    },
    {
      name: "email",
      label: "Email",
      type: "text",
      column: "email",
      filterable: true,
      sortable: false,
    },
    {
      name: "state",
      label: "State",
      type: "enum",
      enumValues: ORDER_STATES,
      column: "state",
      filterable: true,
      sortable: true,
      options: {
        choices: ORDER_STATES.map((value) => ({ value, label: STATE_LABELS[value] })),
      },
    },
    {
      name: "currency",
      label: "Currency",
      type: "text",
      column: "currency",
      filterable: true,
      sortable: false,
    },
    { ...amount, name: "total", label: "Total", column: "total" },
    { ...amount, name: "paid", label: "Paid", column: "paid" },
    { ...amount, name: "balance", label: "Balance", column: "balance" },
    { ...amount, name: "refunded", label: "Refunded", column: "refunded" },
    {
      name: "pay",
      label: "Paying",
      type: "enum",
      enumValues: ["full", "deposit"],
      column: "pay",
      filterable: true,
      sortable: false,
    },
    { ...amount, name: "deposit", label: "Deposit", column: "deposit" },
    { ...when, name: "balanceDueAt", label: "Balance due", column: "balance_due_at" },
    { ...when, name: "expiresAt", label: "Expires", column: "expires_at" },
    {
      name: "placedAs",
      label: "Placed by",
      type: "enum",
      enumValues: ["customer", "public", "staff"],
      column: "placed_as",
      filterable: true,
      sortable: false,
    },
    { ...when, name: "paidAt", label: "Paid on", column: "paid_at" },
    { ...when, name: "cancelledAt", label: "Cancelled on", column: "cancelled_at" },
    { ...when, name: "refundedAt", label: "Refunded on", column: "refunded_at" },
    { ...when, name: "createdAt", label: "Created", column: "created_at" },
    { ...when, name: "updatedAt", label: "Updated", column: "updated_at" },
    // Tax at checkout (ADR 0479): the provider's figures, inside the amounts above.
    { ...amount, name: "taxAmount", label: "Tax", column: "tax_amount" },
    { ...amount, name: "taxRefunded", label: "Tax refunded", column: "tax_refunded" },
    {
      name: "taxCountry",
      label: "Tax country",
      type: "text",
      column: "tax_country",
      filterable: true,
      sortable: false,
    },
    { ...amount, name: "net", label: "Net of tax", column: "net" },
    // A subscription period's order (ADR 0486).
    { ...id, name: "subscriptionId", label: "Subscription", column: "subscription_id" },
    { ...when, name: "periodStart", label: "Period from", column: "period_start" },
    { ...when, name: "periodEnd", label: "Period to", column: "period_end" },
  ],
});

export const orderLineObject = defineObject({
  name: "orderLine",
  label: "Order line",
  plural: "Order lines",
  source: "rec_order_line",
  defaultSort: { field: "position", direction: "asc" },
  customer: {
    field: "personId",
    read: [
      "orderId",
      "position",
      "object",
      "recordId",
      "title",
      "quantity",
      "unitPrice",
      "total",
      "taxAmount",
    ],
    write: [],
  },
  fields: [
    { name: "id", label: "ID", type: "id", column: "id", filterable: true, sortable: true },
    { ...id, name: "orderId", label: "Order", column: "order_id" },
    {
      ...id,
      name: "personId",
      label: "Person",
      column: "person_id",
      fieldType: "relation",
      options: { to: "person" },
    },
    { ...amount, name: "position", label: "Position", column: "position" },
    {
      name: "object",
      label: "What is bought",
      type: "text",
      column: "object_type",
      filterable: true,
      sortable: false,
    },
    { ...id, name: "recordId", label: "Record", column: "record_id" },
    {
      name: "title",
      label: "Title",
      type: "text",
      column: "title",
      filterable: true,
      sortable: false,
    },
    { ...amount, name: "quantity", label: "Quantity", column: "quantity" },
    { ...amount, name: "unitPrice", label: "Unit price", column: "unit_price" },
    { ...amount, name: "total", label: "Line total", column: "line_total" },
    { ...when, name: "createdAt", label: "Created", column: "created_at" },
    { ...amount, name: "taxAmount", label: "Tax", column: "tax_amount" },
    {
      name: "taxCode",
      label: "Tax code",
      type: "text",
      column: "tax_code",
      filterable: true,
      sortable: false,
    },
  ],
});

/**
 * Base records that are not one of the four core objects of the CRM: they are in the registry
 * (so the seam, the audit log and the transition engine know them) and have their own
 * operations, but the generic machinery that walks every object (search, embeddings, summaries,
 * extension fields, views) does not pick them up (ADR 0426).
 */
export const BASE_OBJECTS = {
  order: orderObject,
  orderLine: orderLineObject,
  // Stage 28 (ADR 0444): the media library.
  media: mediaObject,
  // Stage 32a (ADR 0485): a subscription the payment provider runs.
  subscription: subscriptionObject,
} as const satisfies Record<string, ObjectDefinition>;

export type BaseObjectName = keyof typeof BASE_OBJECTS;

/** The table behind each base object, for the seam's staff-only table door. */
export const BASE_TABLES = {
  order: "core_order",
  orderLine: "core_order_line",
  media: "core_media",
  subscription: "core_subscription",
} as const satisfies Record<BaseObjectName, string>;
