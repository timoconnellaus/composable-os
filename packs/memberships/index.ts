// Memberships (stage 32b): what a gym sells its members. A membership plan is paid every month
// (unlimited classes, or N a week or a month); a pass type is bought once (a class pack of N that
// expires, a drop-in as a pass of one, an intro offer once per person). What a member holds, a
// membership or a pass, is an allowance a booking spends (stage 31's Bookings pack).
//
// Everything that is a rule is the host's, declared here as behaviours (ADR 0404):
//   - a plan is `sellable` with `recurring` (ADR 0485): the provider charges it every month, and the
//     host's subscription to it grants a membership to its holder (`recurring.grants`, ADR 0510),
//     made and moved by the host in each verified event's batch, its state and its end following the
//     subscription (on trial, active, past due for at most 30 days, paused, ended). One free trial
//     per person per plan object is the host's (ADR 0489);
//   - a pass type is `sellable` (ADR 0435): a paid order line grants a pass with the type's uses and
//     an expiry the host writes (`grants.valid`, ADR 0511); a full refund voids it, uses already
//     spent stay spent; an intro offer is `onePerPerson` (ADR 0512): one per Person across every
//     intro type, held from the order's start, refused to a guest who only typed an address;
//   - a membership and a pass hold an `allowance` (ADRs 0493, 0494): uses per week, month or in
//     all, the class types, weekdays and times of day they pay for, spent by a booking of their own
//     Person, refused past the limit by the database for every actor;
//   - a member changes plan on the web (an upgrade now, prorated, applied once paid; a downgrade from
//     the next period) and staff pause a membership for a set time within the plan's bounds
//     (`recurring.pause`): the host's `subscription.change` and `subscription.pause`, asked of the
//     provider, followed from its verified events (ADRs 0530, 0531). The membership's terms follow
//     the plan when the change takes effect; while paused it gives and spends nothing;
//   - every term of a membership or a pass is read-only: only the host (and this pack's own staff
//     tools, which a person calls) writes it, never a caller of the generic record operations.
// The tools in tools.ts compose the host's operations and hold no rule of their own.
import { defineExtension } from "@composable-os/sdk";
import { membershipsDashboards } from "./dashboards.ts";
import { buy, givePass, holdings, mine, passTypes, plans, voidPass } from "./tools.ts";

/** Weekdays as the host's local time numbers them (ISO: 1 is Monday), for an off-peak limit. */
const WEEKDAYS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "7", label: "Sunday" },
];

const ON_SALE = [
  { value: "draft", label: "Draft" },
  { value: "on_sale", label: "On sale" },
  { value: "retired", label: "No longer sold" },
];

/**
 * What a plan or a pass type allows, copied onto the membership or the pass it grants: class
 * types (empty: every one), weekdays (empty: every day) and a time of day, in minutes after local
 * midnight (empty: no bound).
 */
const limits = (readOnly: boolean) =>
  ({
    classTypes: {
      type: "relation",
      label: "Class types",
      to: "programs.classtype",
      many: true,
      description: "Empty: every class type.",
      ...(readOnly ? { readOnly: true } : {}),
    },
    weekdays: {
      type: "multiSelect",
      label: "Days",
      options: WEEKDAYS,
      description: "Empty: every day.",
      ...(readOnly ? { readOnly: true } : {}),
    },
    fromMinute: {
      type: "number",
      label: "Classes from (minutes after midnight)",
      min: 0,
      max: 1440,
      step: 1,
      description: "A class must start at or after this time of day: 540 is 09:00. Empty: any.",
      ...(readOnly ? { readOnly: true } : {}),
    },
    untilMinute: {
      type: "number",
      label: "Classes before (minutes after midnight)",
      min: 0,
      max: 1440,
      step: 1,
      description: "A class must start before this time of day: 960 is 16:00. Empty: any.",
      ...(readOnly ? { readOnly: true } : {}),
    },
  }) as const;

/**
 * What a holder pays for: stage 31's bookings (`bookings.booking`, whose `paidBy` lists this pack),
 * by the class type, the local weekday and the local minute the host copies onto the booking.
 */
const SPENDS_ON = {
  object: "bookings.booking",
  when: [
    { field: "classType", in: "classTypes" },
    { field: "weekday", in: "weekdays" },
    { field: "minute", atLeast: "fromMinute" },
    { field: "minute", below: "untilMinute" },
  ],
};

const RUNNING = ["trialing", "active", "past_due", "unpaid", "paused"] as const;

/** A membership follows its subscription: the host moves it from any running state to another. */
const followMoves = [
  ...RUNNING.map((to) => ({
    from: RUNNING.filter((s) => s !== to),
    to,
    by: ["host" as const],
  })),
  { from: [...RUNNING], to: "ended", by: ["host" as const], final: true },
];

export default defineExtension({
  id: "memberships",
  version: "0.1.0",
  contractVersion: 1,
  label: "Memberships",
  description:
    "Membership plans paid every month and class passes bought once, with what each allows " +
    "and what a member has left.",
  // A plan and a pass name the class types they pay for: Programs' (stage 31 extends them).
  requires: ["programs"],
  permissions: {
    read: ["person", "programs.classtype"],
    operations: [
      "public.list",
      "public.get",
      "my.list",
      "my.get",
      "record.create",
      "record.update",
      "record.get",
      "record.list",
      "allowance.get",
      "allowance.list",
      "order.start",
      // The member's own id and the children staff linked to them (ADR 0540).
      "me.family",
    ],
    modules: ["ops"],
  },
  objects: {
    plan: {
      label: "Membership plan",
      plural: "Membership plans",
      icon: "repeat",
      titleField: "title",
      description:
        "A membership paid every month: unlimited classes, or a number a week or a month, of " +
        "the class types and times it allows. One free trial per person per plan.",
      navigation: "main",
      navigationOrder: 30,
      fields: {
        title: { type: "text", label: "Title", required: true },
        summary: {
          type: "text",
          label: "What it gives, in a line",
          description: 'Shown with the plan: "3 classes a week, off-peak".',
        },
        description: { type: "text", label: "Description" },
        price: { type: "currency", label: "Price per month", required: true },
        uses: {
          type: "number",
          label: "Classes per period",
          min: 1,
          max: 1000,
          step: 1,
          description: "Empty: unlimited.",
        },
        per: {
          type: "select",
          label: "Per",
          required: true,
          default: "week",
          options: [
            { value: "week", label: "A week" },
            { value: "month", label: "A month" },
          ],
        },
        ...limits(false),
        trialDays: {
          type: "number",
          label: "Free trial (days)",
          min: 0,
          max: 90,
          step: 1,
          description: "Empty or 0: charged from the start. A person gets one trial on any plan.",
        },
        pauseMinDays: {
          type: "number",
          label: "Shortest pause (days)",
          min: 1,
          max: 366,
          step: 1,
          description: "Staff pause a membership for at least this long. Empty: 1 day.",
        },
        pauseMaxDays: {
          type: "number",
          label: "Longest pause (days)",
          min: 1,
          max: 366,
          step: 1,
          description: "And at most this long. Empty: a year.",
        },
        status: { type: "select", label: "Status", default: "draft", options: ON_SALE },
      },
      public: {
        read: [
          "title",
          "summary",
          "description",
          "price",
          "uses",
          "per",
          "classTypes",
          "weekdays",
          "fromMinute",
          "untilMinute",
          "trialDays",
        ],
        when: { field: "status", in: ["on_sale"] },
      },
      sellable: {
        price: "price",
        // Gym dues (the provider's "Fitness Centers - Dues and Membership Fees"): taxed only once
        // a human admin turns tax on (ADR 0479). Whether the provider needs the gym's address as
        // the place is an open check of the test-mode runbook.
        tax: { code: "txcd_50021001" },
        recurring: {
          interval: "month",
          trialDays: "trialDays",
          // Staff pause a membership for a set time (decision 10, ADR 0531): nothing charged, no
          // classes, until the provider resumes it on its date.
          pause: { minDays: "pauseMinDays", maxDays: "pauseMaxDays" },
          // What a subscription to it gives its holder, kept in step by the host (ADR 0510).
          grants: {
            object: "membership",
            set: {
              person: "subscription.holder",
              payer: "subscription.payer",
              plan: "item",
              subscription: "subscription",
              title: "item.title",
              uses: "item.uses",
              per: "item.per",
              classTypes: "item.classTypes",
              weekdays: "item.weekdays",
              fromMinute: "item.fromMinute",
              untilMinute: "item.untilMinute",
            },
            from: "from",
            until: "until",
            states: {
              trialing: "trialing",
              active: "active",
              past_due: "past_due",
              unpaid: "unpaid",
              paused: "paused",
              ended: "ended",
            },
          },
        },
      },
      // Where agreement may be needed (stage 44, ADR 0641): the business attaches its documents
      // (its terms, a waiver) to "membership"; nothing is needed until it does. The host asks
      // when a subscription to a plan or an order for a pass type starts (ADR 0644).
      agreements: {
        point: "membership",
        label: "Buying a membership or a pass",
        suggests: ["terms", "waiver", "health", "guardian"],
        // The plans and passes blocks show what is due and let a person agree (stage 44 step 5).
        inlineStep: true,
      },
    },
    membership: {
      label: "Membership",
      plural: "Memberships",
      icon: "id-card",
      titleField: "title",
      description:
        "A member's membership: granted by the host when their subscription to a plan starts, " +
        "and moved with it (on trial, active, past due, paused, ended). What it allows is the " +
        "plan's as it was at the start.",
      navigation: "main",
      navigationOrder: 31,
      fields: {
        title: { type: "text", label: "Plan", readOnly: true },
        person: { type: "relation", label: "Member", to: "person", readOnly: true },
        payer: {
          type: "relation",
          label: "Paid by",
          to: "person",
          readOnly: true,
          description: "Who pays: the member, or someone paying for them (a parent).",
        },
        plan: { type: "relation", label: "Plan", to: "memberships.plan", readOnly: true },
        subscription: { type: "text", label: "Subscription", readOnly: true },
        uses: { type: "number", label: "Classes per period", readOnly: true },
        per: {
          type: "select",
          label: "Per",
          readOnly: true,
          options: [
            { value: "week", label: "A week" },
            { value: "month", label: "A month" },
          ],
        },
        ...limits(true),
        from: { type: "datetime", label: "From", readOnly: true },
        until: {
          type: "datetime",
          label: "Until",
          readOnly: true,
          description: "When it stops: set when it is ending, has ended, or a payment is failing.",
        },
        status: {
          type: "select",
          label: "Status",
          track: "timeline",
          options: [
            { value: "trialing", label: "On trial" },
            { value: "active", label: "Active" },
            { value: "past_due", label: "Past due" },
            { value: "unpaid", label: "Unpaid" },
            { value: "paused", label: "Paused" },
            { value: "ended", label: "Ended" },
          ],
        },
      },
      states: { field: "status", initial: "active", moves: followMoves },
      // A member reads their own; a parent or guardian staff linked to a child reads the child's
      // too, read only (ADR 0540): what the child has left to book with.
      customer: {
        field: "person",
        guardians: {},
        read: [
          "person",
          "title",
          "plan",
          "uses",
          "per",
          "classTypes",
          "weekdays",
          "fromMinute",
          "untilMinute",
          "from",
          "until",
          "status",
        ],
        write: [],
      },
      allowance: {
        holds: {
          person: "person",
          uses: "uses",
          per: { field: "per" },
          from: "from",
          until: "until",
          // Past due keeps everything while the provider retries (decision 4), up to `until`.
          live: ["trialing", "active", "past_due"],
          // An unlimited plan: empty uses is unlimited here, and only here.
          emptyIsUnlimited: true,
          spendsOn: SPENDS_ON,
        },
      },
      timelineLinks: ["person"],
      indexes: [["person"], ["plan"], ["subscription"], ["status"]],
    },
    passtype: {
      label: "Pass type",
      plural: "Pass types",
      icon: "ticket",
      titleField: "title",
      description:
        "A pass bought once: a class pack of N that expires, a drop-in (a pass of one), or an " +
        "intro offer, one per person.",
      navigation: "main",
      navigationOrder: 32,
      fields: {
        title: { type: "text", label: "Title", required: true },
        summary: { type: "text", label: "What it gives, in a line" },
        description: { type: "text", label: "Description" },
        price: { type: "currency", label: "Price", required: true },
        uses: {
          type: "number",
          label: "Classes",
          required: true,
          min: 1,
          max: 1000,
          step: 1,
        },
        validDays: {
          type: "number",
          label: "Valid for (days)",
          min: 1,
          max: 3650,
          step: 1,
          description: "From the day it is bought. Empty: it does not expire.",
        },
        ...limits(false),
        onePerPerson: {
          type: "boolean",
          label: "Intro offer: one per person",
          description:
            "A person buys one of these once, across every pass type marked so, signed in.",
        },
        status: { type: "select", label: "Status", default: "draft", options: ON_SALE },
      },
      public: {
        read: [
          "title",
          "summary",
          "description",
          "price",
          "uses",
          "validDays",
          "classTypes",
          "weekdays",
          "fromMinute",
          "untilMinute",
          "onePerPerson",
        ],
        when: { field: "status", in: ["on_sale"] },
      },
      sellable: {
        price: "price",
        tax: { code: "txcd_50021001" },
        grants: {
          object: "pass",
          set: {
            person: "order.person",
            passtype: "item",
            title: "line.title",
            order: "order",
            uses: "item.uses",
            classTypes: "item.classTypes",
            weekdays: "item.weekdays",
            fromMinute: "item.fromMinute",
            untilMinute: "item.untilMinute",
          },
          void: "void",
          valid: { from: "from", until: "until", days: "item.validDays" },
        },
        onePerPerson: "onePerPerson",
      },
      // Where agreement may be needed (stage 44, ADR 0641): the business attaches its documents
      // (its terms, a waiver) to "membership"; nothing is needed until it does. The host asks
      // when a subscription to a plan or an order for a pass type starts (ADR 0644).
      agreements: {
        point: "membership",
        label: "Buying a membership or a pass",
        suggests: ["terms", "waiver", "health", "guardian"],
        inlineStep: true,
      },
    },
    pass: {
      label: "Pass",
      plural: "Passes",
      icon: "ticket-check",
      titleField: "title",
      description:
        "A member's pass: granted by a paid order (or given by staff), with its classes and its " +
        "expiry. Voided when its order is refunded in full; classes already taken stay taken.",
      navigation: "main",
      navigationOrder: 33,
      fields: {
        title: { type: "text", label: "Pass", readOnly: true },
        person: { type: "relation", label: "Member", to: "person", readOnly: true },
        passtype: {
          type: "relation",
          label: "Pass type",
          to: "memberships.passtype",
          readOnly: true,
        },
        order: { type: "text", label: "Order", readOnly: true },
        uses: { type: "number", label: "Classes", readOnly: true },
        ...limits(true),
        from: { type: "datetime", label: "From", readOnly: true },
        until: { type: "datetime", label: "Expires", readOnly: true },
        source: {
          type: "select",
          label: "Where it came from",
          readOnly: true,
          default: "purchase",
          options: [
            { value: "purchase", label: "Bought" },
            { value: "staff", label: "Given by staff" },
          ],
        },
        reason: { type: "text", label: "Why it was given or voided", readOnly: true },
        status: {
          type: "select",
          label: "Status",
          track: "timeline",
          options: [
            { value: "active", label: "Active" },
            { value: "void", label: "Void" },
          ],
        },
      },
      states: {
        field: "status",
        initial: "active",
        moves: [
          // A full refund of its order (the host), or a person on the staff with this pack's
          // permission (`voidPass`, a person only); never a customer.
          { from: "active", to: "void", by: ["host"], tools: ["voidPass"], final: true },
        ],
      },
      // A pass given by staff by hand (givePass) starts a pass as buying one does: the same point,
      // asked by the engine when a caller makes one (stage 44, ADR 0644). A pass a paid order
      // grants is the host's, asked when the order started.
      agreements: {
        point: "membership",
        label: "Buying a membership or a pass",
        suggests: ["terms", "waiver", "health", "guardian"],
        enter: ["active"],
        person: "person",
        inlineStep: true,
      },
      // As a membership: their own, and a linked child's for a guardian, read only (ADR 0540).
      customer: {
        field: "person",
        guardians: {},
        read: [
          "person",
          "title",
          "passtype",
          "uses",
          "classTypes",
          "weekdays",
          "fromMinute",
          "untilMinute",
          "from",
          "until",
          "source",
          "status",
        ],
        write: [],
      },
      allowance: {
        holds: {
          person: "person",
          uses: "uses",
          per: "total",
          from: "from",
          until: "until",
          live: ["active"],
          spendsOn: SPENDS_ON,
        },
      },
      timelineLinks: ["person"],
      indexes: [["person"], ["passtype"], ["order"], ["status"]],
    },
  },
  views: {
    activeMembers: {
      label: "Active members",
      object: "memberships.membership",
      filter: { field: "status", op: "eq", value: "active" },
      sort: { field: "from", direction: "desc" },
      columns: ["person", "title", "uses", "per", "from", "until"],
    },
    onTrial: {
      label: "On trial",
      object: "memberships.membership",
      filter: { field: "status", op: "eq", value: "trialing" },
      sort: { field: "from", direction: "desc" },
      columns: ["person", "title", "from", "until"],
    },
    pastDue: {
      label: "Past due",
      object: "memberships.membership",
      filter: { field: "status", op: "eq", value: "past_due" },
      sort: { field: "until", direction: "asc" },
      columns: ["person", "title", "payer", "until"],
    },
    paused: {
      label: "Paused",
      object: "memberships.membership",
      filter: { field: "status", op: "eq", value: "paused" },
      sort: { field: "from", direction: "desc" },
      columns: ["person", "title", "payer", "from"],
    },
    endingThisMonth: {
      label: "Ending this month",
      object: "memberships.membership",
      filter: {
        and: [
          { field: "until", op: "gte", value: { $relative: "now" } },
          { field: "until", op: "lt", value: { $relative: "startOfNextMonth" } },
        ],
      },
      sort: { field: "until", direction: "asc" },
      columns: ["person", "title", "status", "until"],
    },
    passesExpiringThisWeek: {
      label: "Passes expiring this week",
      object: "memberships.pass",
      filter: {
        and: [
          { field: "status", op: "eq", value: "active" },
          { field: "until", op: "gte", value: { $relative: "now" } },
          { field: "until", op: "lt", value: { $relative: "startOfNextWeek" } },
        ],
      },
      sort: { field: "until", direction: "asc" },
      columns: ["person", "title", "uses", "until"],
    },
    passesExpiringThisMonth: {
      label: "Passes expiring this month",
      object: "memberships.pass",
      filter: {
        and: [
          { field: "status", op: "eq", value: "active" },
          { field: "until", op: "gte", value: { $relative: "now" } },
          { field: "until", op: "lt", value: { $relative: "startOfNextMonth" } },
        ],
      },
      sort: { field: "until", direction: "asc" },
      columns: ["person", "title", "uses", "until"],
    },
  },
  recordTabs: {
    personMemberships: {
      label: "Memberships",
      on: "person",
      view: {
        type: "table",
        object: "memberships.membership",
        relation: "person",
        columns: ["title", "status", "uses", "per", "from", "until"],
        sort: { field: "from", direction: "desc" },
      },
      order: 37,
    },
    personPasses: {
      label: "Passes",
      on: "person",
      view: {
        type: "table",
        object: "memberships.pass",
        relation: "person",
        columns: ["title", "status", "uses", "source", "from", "until"],
        sort: { field: "from", direction: "desc" },
      },
      order: 38,
    },
  },
  // Giving or voiding a pass by hand: a person on the staff, with this permission, which admins
  // and members hold and a human admin may grant to anyone else (ADR 0449).
  grantable: ["memberships:passes"],
  tools: { plans, passTypes, buy, mine, holdings, givePass, voidPass },
  dashboards: membershipsDashboards,
  // Staff screens in the product's admin (stage 47, ADR 0660): a person's memberships and passes,
  // a tab on the Person, for whoever may read them and give and void a pass by hand (any member
  // of staff; a viewer reads no further than the record page).
  screens: {
    holdings: {
      label: "Memberships",
      block: "memberships-staff-holdings",
      export: "PersonMemberships",
      opens: ["holdings", "givePass"],
      record: { object: "person", as: "personId" },
    },
  },
});
