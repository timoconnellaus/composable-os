// Dummy data the Memberships previews share: one studio's plans and passes, and one member's.
import type {
  CoolingOffStatus,
  MembershipSubscription,
  MembershipsOperations,
} from "@composable-os/pack-memberships/client";
import { at, dayAfter, TODAY } from "../../src/fake.ts";

type Out<K extends keyof MembershipsOperations> = MembershipsOperations[K]["output"];
type Holding = Out<"x.memberships.mine">["holdings"][number];

const anyDay = { classTypes: [], weekdays: [], fromMinute: null, untilMinute: null };

export const plans: Out<"x.memberships.plans"> = {
  currency: "GBP",
  plans: [
    {
      id: "plan_offpeak",
      title: "Off-peak",
      summary: "8 classes a month, weekdays 10:00 to 16:00",
      description: "For flexible days: any class that starts between ten and four on a weekday.",
      price: 39,
      uses: 8,
      per: "month",
      trialDays: null,
      classTypes: [],
      weekdays: ["1", "2", "3", "4", "5"],
      fromMinute: 600,
      untilMinute: 960,
    },
    {
      id: "plan_three",
      title: "Three a week",
      summary: null,
      description: "Three classes every week, any time, any class on the timetable.",
      price: 59,
      uses: 3,
      per: "week",
      trialDays: 7,
      ...anyDay,
    },
    {
      id: "plan_unlimited",
      title: "Unlimited",
      summary: "Every class, every day",
      description: "Book as many classes as you like, plus a free guest pass each month.",
      price: 85,
      uses: null,
      per: null,
      trialDays: 7,
      ...anyDay,
    },
  ],
};

export const passTypes: Out<"x.memberships.passTypes"> = {
  currency: "GBP",
  passTypes: [
    {
      id: "pt_intro",
      title: "Intro week",
      summary: "Unlimited classes for your first 7 days",
      description: "New to the studio? Try every class for a week.",
      price: 25,
      uses: null,
      validDays: 7,
      onePerPerson: true,
      ...anyDay,
    },
    {
      id: "pt_dropin",
      title: "Single class",
      summary: null,
      description: null,
      price: 14,
      uses: 1,
      validDays: 30,
      onePerPerson: false,
      ...anyDay,
    },
    {
      id: "pt_ten",
      title: "10-class pack",
      summary: null,
      description: "Ten classes to use within three months. Works out at £12 a class.",
      price: 120,
      uses: 10,
      validDays: 90,
      onePerPerson: false,
      ...anyDay,
    },
  ],
};

const membership: Holding = {
  id: "mem_1",
  kind: "membership",
  title: "Three a week",
  status: "active",
  uses: 3,
  per: "week",
  from: at("00:00", "2026-02-18"),
  until: null,
  live: true,
  period: {
    key: "2026-W10",
    startsAt: at("00:00"),
    endsAt: at("00:00", dayAfter(7)),
    used: 1,
    left: 2,
  },
  ...anyDay,
};

const tenPack: Holding = {
  id: "pass_1",
  kind: "pass",
  title: "10-class pack",
  status: "active",
  uses: 10,
  per: "total",
  from: at("00:00", "2026-01-12"),
  until: at("00:00", "2026-04-12"),
  live: true,
  period: {
    key: "total",
    startsAt: at("00:00", "2026-01-12"),
    endsAt: at("00:00", "2026-04-12"),
    used: 6,
    left: 4,
  },
  ...anyDay,
};

const introWeek: Holding = {
  id: "pass_2",
  kind: "pass",
  title: "Intro week",
  status: "expired",
  uses: null,
  per: "total",
  from: at("00:00", "2026-01-05"),
  until: at("00:00", "2026-01-12"),
  live: false,
  period: null,
  ...anyDay,
};

const guestPass: Holding = {
  id: "pass_3",
  kind: "pass",
  title: "Single class",
  status: "active",
  uses: 1,
  per: "total",
  from: at("09:12"),
  until: at("00:00", dayAfter(30)),
  live: true,
  period: {
    key: "total",
    startsAt: at("09:12"),
    endsAt: at("00:00", dayAfter(30)),
    used: 0,
    left: 1,
  },
  ...anyDay,
};

export const mine: Out<"x.memberships.mine"> = { holdings: [membership, tenPack] };

/** The member and the child the gym linked to them (`me.family`, stage 48). */
export const family: Out<"me.family"> = {
  self: { personId: "p_10", name: "Rachel Moore" },
  dependants: [{ personId: "p_11", name: "Leo Moore" }],
  guardians: [],
};

/** What the member holds, or (with the child's id) what the child holds: a pass. */
export function mineFor(input: { personId?: string }): Out<"x.memberships.mine"> {
  return input.personId === "p_11" ? { holdings: [{ ...tenPack, id: "pas_leo" }] } : mine;
}

export const staffHoldings: Out<"x.memberships.holdings"> = {
  holdings: [membership, guestPass, tenPack, introWeek],
};

export const subscription: MembershipSubscription = {
  id: "sub_1",
  state: "active",
  planObject: "memberships.plan",
  planId: "plan_three",
  planTitle: "Three a week",
  amount: 5900,
  currency: "GBP",
  interval: "month",
  trialEnd: null,
  currentPeriodEnd: at("00:00", "2026-03-18"),
  cancelAtPeriodEnd: false,
  cancelAt: null,
  endedAt: null,
  actionUrl: null,
  createdAt: at("10:04", "2026-02-18"),
  change: null,
  holderPersonId: "p_10",
};

export const subscriptions: Out<"subscription.list"> = { items: [subscription], nextCursor: null };

/** A new member, still inside the cooling-off period the host offers. */
export const coolingOff: Out<"subscription.coolingOff"> = {
  items: [
    {
      subscriptionId: "sub_1",
      offered: true,
      why: null,
      days: 14,
      until: dayAfter(2, TODAY),
      endsAt: at("23:59", dayAfter(2, TODAY)),
      refund: 5900,
      currency: "GBP",
      coolOff: null,
    } satisfies CoolingOffStatus,
  ],
};

/** The pass types staff may give, as the staff client's record list answers (by title). */
export const staffPassTypes: Out<"record.list"> = {
  items: passTypes.passTypes
    .map((t) => ({ id: t.id, values: { title: t.title } }))
    .sort((a, b) => String(a.values.title).localeCompare(String(b.values.title))),
  nextCursor: null,
};
