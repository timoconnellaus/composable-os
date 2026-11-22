// Field registry for Subscription (stage 32a, ADR 0485): a base record in core, beside Order. The
// payment provider runs the schedule; this record mirrors what its verified events say.
//
// Every move is `host`: only the code that applies a verified provider event moves a
// subscription (subscriptions/events.ts). No person, MCP client, extension or import can, whatever
// they send. `ended` and `expired` are final: a person who comes back starts a new subscription.
//
// The customer declaration names the payer: the subscription is the billing record, and its
// payer reads it, opens the portal for it, cancels and resumes it. Its holder (who what it grants
// is for, ADR 0487) is the payer in 32a; access reads the holder directly.
import { defineObject, type StatesDefinition } from "./types.ts";

export const SUBSCRIPTION_STATES = [
  "incomplete",
  "expired",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
  "ended",
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

const STATE_LABELS: Record<SubscriptionState, string> = {
  incomplete: "Incomplete",
  expired: "Expired",
  trialing: "Trial",
  active: "Active",
  past_due: "Past due",
  unpaid: "Unpaid",
  paused: "Paused",
  ended: "Ended",
};

const LIVE = ["incomplete", "trialing", "active", "past_due", "unpaid", "paused"] as const;
const others = (state: SubscriptionState) => LIVE.filter((s) => s !== state);

/**
 * The subscription's state machine: the provider's statuses, every move the host's. A
 * subscription can move between any two live states, as the provider's can (a trial extended on
 * an active one, a failing one paid); it ends once.
 */
export const SUBSCRIPTION_MACHINE: StatesDefinition = {
  field: "state",
  initial: "incomplete",
  moves: [
    { from: others("trialing"), to: "trialing", by: ["host"] },
    { from: others("active"), to: "active", by: ["host"] },
    { from: others("past_due"), to: "past_due", by: ["host"] },
    { from: others("unpaid"), to: "unpaid", by: ["host"] },
    { from: others("paused"), to: "paused", by: ["host"] },
    // The first payment never succeeded within the provider's 23 hours.
    { from: "incomplete", to: "expired", by: ["host"], final: true },
    { from: [...LIVE], to: "ended", by: ["host"], final: true },
  ],
};

const id = { type: "id", filterable: true, sortable: false } as const;
const amount = { type: "number", filterable: true, sortable: true } as const;
const when = { type: "datetime", filterable: true, sortable: true } as const;
const text = (name: string, label: string, column: string) =>
  ({ name, label, type: "text", column, filterable: true, sortable: false }) as const;

export const subscriptionObject = defineObject({
  name: "subscription",
  label: "Subscription",
  plural: "Subscriptions",
  source: "rec_subscription",
  titleField: "planTitle",
  defaultSort: { field: "createdAt", direction: "desc" },
  states: SUBSCRIPTION_MACHINE,
  customer: {
    field: "payerPersonId",
    read: [
      "holderPersonId",
      "planObject",
      "planId",
      "planTitle",
      "amount",
      "currency",
      "interval",
      "taxed",
      "state",
      "trialEnd",
      "currentPeriodStart",
      "currentPeriodEnd",
      "cancelAtPeriodEnd",
      "cancelAt",
      "canceledAt",
      "endedAt",
      "actionUrl",
      "createdAt",
    ],
    write: [],
  },
  fields: [
    { name: "id", label: "ID", type: "id", column: "id", filterable: true, sortable: true },
    {
      ...id,
      name: "payerPersonId",
      label: "Payer",
      column: "payer_person_id",
      fieldType: "relation",
      options: { to: "person" },
    },
    {
      ...id,
      name: "holderPersonId",
      label: "Holder",
      column: "holder_person_id",
      fieldType: "relation",
      options: { to: "person" },
    },
    text("email", "Email", "email"),
    {
      name: "placedAs",
      label: "Started by",
      type: "enum",
      enumValues: ["customer", "public", "staff"],
      column: "placed_as",
      filterable: true,
      sortable: false,
    },
    text("planObject", "Plan's object", "plan_object"),
    { ...id, name: "planId", label: "Plan", column: "plan_id" },
    text("planTitle", "Plan", "plan_title"),
    { ...amount, name: "amount", label: "Price per period", column: "amount" },
    text("currency", "Currency", "currency"),
    {
      name: "interval",
      label: "Every",
      type: "enum",
      enumValues: ["week", "month", "year"],
      column: "interval",
      filterable: true,
      sortable: false,
    },
    {
      name: "taxed",
      label: "Taxed",
      type: "boolean",
      column: "taxed",
      filterable: true,
      sortable: false,
    },
    {
      name: "state",
      label: "State",
      type: "enum",
      enumValues: SUBSCRIPTION_STATES,
      column: "state",
      filterable: true,
      sortable: true,
      options: {
        choices: SUBSCRIPTION_STATES.map((value) => ({ value, label: STATE_LABELS[value] })),
      },
    },
    text("provider", "Provider", "provider"),
    text("providerRef", "Provider's reference", "provider_ref"),
    { ...when, name: "trialEnd", label: "Trial ends", column: "trial_end" },
    { ...when, name: "currentPeriodStart", label: "Period from", column: "current_period_start" },
    { ...when, name: "currentPeriodEnd", label: "Period to", column: "current_period_end" },
    {
      name: "cancelAtPeriodEnd",
      label: "Ends at period end",
      type: "boolean",
      column: "cancel_at_period_end",
      filterable: true,
      sortable: false,
    },
    // A date set at the provider another way (its dashboard): the host's resume cannot undo it.
    { ...when, name: "cancelAt", label: "Ends on", column: "cancel_at" },
    { ...when, name: "canceledAt", label: "Cancelled on", column: "canceled_at" },
    { ...when, name: "endedAt", label: "Ended on", column: "ended_at" },
    text("endReason", "Why it ended", "end_reason"),
    text("actionUrl", "Confirm payment at", "action_url"),
    { ...when, name: "failingSince", label: "Failing since", column: "failing_since" },
    { ...when, name: "createdAt", label: "Started", column: "created_at" },
    { ...when, name: "updatedAt", label: "Updated", column: "updated_at" },
  ],
});
