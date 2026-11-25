// My account's dummy data: one gym member, Hannah Okafor, with her two children linked to her, a
// membership, a class pack, a few orders and the places she is signed in. Shared by the web and
// native account blocks, so every picture shows the same person.
import {
  ACCOUNT_HOOKS_CALL,
  type AccountFamily,
  type AccountMe,
  type AccountOperations,
  type AccountPortal,
  type AccountSession,
  type AccountSubscription,
  AGREEMENTS_HOOKS_CALL,
  type AgreementsOperations,
  type AgreementVersion,
  createAccountHooks,
  createAgreementsHooks,
  type MyRecord,
} from "@composable-os/client";
import {
  MEMBERSHIPS_HOOKS_CALL,
  type MembershipsOperations,
} from "@composable-os/pack-memberships/client";
import { at, dayAfter, fakeClient, react } from "../../src/fake.ts";

type Out<N extends keyof AccountOperations> = AccountOperations[N]["output"];
type AgreementsOut<N extends keyof AgreementsOperations> = AgreementsOperations[N]["output"];
type MembershipsOut<N extends keyof MembershipsOperations> = MembershipsOperations[N]["output"];

const HANNAH = "per_hannah";
const LEO = "per_leo";

export const me: AccountMe = {
  id: HANNAH,
  displayName: "Hannah Okafor",
  givenName: "Hannah",
  familyName: "Okafor",
  primaryEmail: "hannah.okafor@example.com",
  primaryPhone: "07700 900481",
  signInEmail: "hannah.okafor@example.com",
  signInEmailVerified: true,
};

export const birthday: Out<"me.birthday.get"> = { birthday: { day: 14, month: 7 } };

export const family: AccountFamily = {
  self: { personId: HANNAH, name: "Hannah Okafor" },
  dependants: [
    { personId: LEO, name: "Leo Okafor" },
    { personId: "per_maya", name: "Maya Okafor" },
  ],
  guardians: [],
};

/** Where she is signed in; `current` says which one the picture is taken from. */
export function sessions(current: "browser" | "device"): Out<"me.sessions.list"> {
  const items: AccountSession[] = [
    {
      id: "ses_laptop",
      kind: "browser",
      deviceName: null,
      createdAt: at("08:12", "2026-02-16"),
      lastActiveAt: at("09:28"),
      expiresAt: at("08:12", "2026-03-18"),
      current: current === "browser",
    },
    {
      id: "ses_phone",
      kind: "device",
      deviceName: "Hannah's iPhone",
      createdAt: at("19:40", "2026-01-05"),
      lastActiveAt: at("07:05"),
      expiresAt: null,
      current: current === "device",
    },
    {
      id: "ses_ipad",
      kind: "device",
      deviceName: "Family iPad",
      createdAt: at("17:22", "2025-12-27"),
      lastActiveAt: at("20:14", "2026-02-22"),
      expiresAt: null,
      current: false,
    },
    {
      id: "ses_work",
      kind: "browser",
      deviceName: null,
      createdAt: at("12:31", "2026-02-03"),
      lastActiveAt: at("12:48", "2026-02-11"),
      expiresAt: at("12:31", "2026-03-05"),
      current: false,
    },
  ];
  return { items };
}

/** The base sections she has, and the Memberships pack's, as the host lists them. */
export const portal: AccountPortal = {
  paysSubscription: true,
  sections: [
    {
      key: "memberships.memberships",
      pack: "memberships",
      label: "Memberships and passes",
      order: 20,
      web: { block: "memberships-mine", export: "MyMemberships" },
      native: { block: "memberships-native-mine", export: "MyMembershipsScreen" },
    },
    { key: "orders", pack: null, label: "Orders", order: 60, web: null, native: null },
    { key: "agreements", pack: null, label: "Agreements", order: 70, web: null, native: null },
    { key: "family", pack: null, label: "Family", order: 80, web: null, native: null },
    { key: "payment", pack: null, label: "Payment method", order: 85, web: null, native: null },
    { key: "details", pack: null, label: "Your details", order: 90, web: null, native: null },
    {
      key: "devices",
      pack: null,
      label: "Sign-in and devices",
      order: 95,
      web: null,
      native: null,
    },
  ],
};

// --- Orders: `my.list` on order and orderLine, as the seam answers it ----------------------------

const order = (id: string, values: Record<string, unknown>): MyRecord => ({
  object: "order",
  id,
  values: {
    currency: "GBP",
    paid: 0,
    balance: 0,
    refunded: 0,
    pay: "full",
    deposit: null,
    balanceDueAt: null,
    expiresAt: null,
    paidAt: null,
    taxRefunded: 0,
    subscriptionId: null,
    ...values,
  },
});

const line = (
  id: string,
  orderId: string,
  position: number,
  title: string,
  quantity: number,
  unitPrice: number,
): MyRecord => {
  const total = quantity * unitPrice;
  return {
    object: "orderLine",
    id,
    values: {
      orderId,
      position,
      title,
      quantity,
      unitPrice,
      total,
      taxAmount: Math.round(total / 6),
    },
  };
};

const orders: MyRecord[] = [
  order("ord_1046", {
    state: "pending",
    total: 4500,
    balance: 4500,
    taxAmount: 750,
    createdAt: at("09:12"),
    expiresAt: at("09:42"),
  }),
  order("ord_1041", {
    state: "paid",
    total: 8500,
    paid: 8500,
    taxAmount: 1417,
    createdAt: at("18:03", "2026-02-27"),
    paidAt: at("18:04", "2026-02-27"),
  }),
  order("ord_1037", {
    state: "part_paid",
    pay: "deposit",
    total: 32000,
    deposit: 8000,
    paid: 8000,
    balance: 24000,
    balanceDueAt: "2026-06-01T00:00:00.000Z",
    taxAmount: 5333,
    createdAt: at("20:41", "2026-02-19"),
    paidAt: at("20:42", "2026-02-19"),
  }),
  order("ord_1029", {
    state: "paid",
    total: 3400,
    paid: 3400,
    refunded: 1200,
    taxAmount: 567,
    taxRefunded: 200,
    createdAt: at("10:15", "2026-02-07"),
    paidAt: at("10:16", "2026-02-07"),
  }),
  order("ord_1018", {
    state: "expired",
    total: 1200,
    balance: 1200,
    taxAmount: 200,
    createdAt: at("16:50", "2026-01-24"),
    expiresAt: at("17:20", "2026-01-24"),
  }),
];

const lines: MyRecord[] = [
  line("oln_1", "ord_1046", 1, "Intro to Olympic lifting workshop", 1, 4500),
  line("oln_2", "ord_1041", 1, "10-class pack", 1, 8500),
  line("oln_3", "ord_1037", 1, "Summer strength camp, Leo Okafor", 1, 16000),
  line("oln_4", "ord_1037", 2, "Summer strength camp, Maya Okafor", 1, 16000),
  line("oln_5", "ord_1029", 1, "Gym towel", 2, 1100),
  line("oln_6", "ord_1029", 2, "Water bottle", 1, 1200),
  line("oln_7", "ord_1018", 1, "Drop-in class", 1, 1200),
];

/** `my.list`: her orders newest first, or the lines of the orders asked for. */
export function myList(input: AccountOperations["my.list"]["input"]): Out<"my.list"> {
  if (input.object === "orderLine") {
    const ids = Array.isArray(input.filter?.value) ? (input.filter.value as string[]) : [];
    return {
      items: lines.filter((l) => ids.includes(String(l.values.orderId))),
      nextCursor: null,
    };
  }
  return { items: orders, nextCursor: null, currency: "GBP" };
}

// --- Subscriptions ---------------------------------------------------------------------------------

const subscription = (
  values: Pick<AccountSubscription, "id" | "state" | "planObject" | "planId" | "planTitle"> &
    Partial<AccountSubscription>,
): AccountSubscription => ({
  amount: 6500,
  currency: "GBP",
  interval: "month",
  trialEnd: null,
  currentPeriodEnd: "2026-03-28T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  cancelAt: null,
  endedAt: null,
  actionUrl: null,
  createdAt: "2025-09-28T10:00:00.000Z",
  holderPersonId: HANNAH,
  ...values,
});

export const unlimited = subscription({
  id: "sub_unlimited",
  state: "active",
  planObject: "memberships.plan",
  planId: "pln_unlimited",
  planTitle: "Unlimited membership",
});

export const subscriptions: Out<"subscription.list"> = {
  nextCursor: null,
  items: [
    unlimited,
    subscription({
      id: "sub_mobility",
      state: "trialing",
      planObject: "courses.plan",
      planId: "cpl_mobility",
      planTitle: "Mobility at home, online course",
      amount: 1200,
      trialEnd: `${dayAfter(7)}T00:00:00.000Z`,
      currentPeriodEnd: `${dayAfter(7)}T00:00:00.000Z`,
      createdAt: at("19:30", "2026-02-23"),
    }),
    subscription({
      id: "sub_juniors",
      state: "active",
      planObject: "memberships.plan",
      planId: "pln_juniors",
      planTitle: "Juniors membership, Leo Okafor",
      amount: 3000,
      currentPeriodEnd: "2026-03-15T00:00:00.000Z",
      cancelAtPeriodEnd: true,
      holderPersonId: LEO,
    }),
    subscription({
      id: "sub_maya",
      state: "past_due",
      planObject: "memberships.plan",
      planId: "pln_juniors",
      planTitle: "Juniors membership, Maya Okafor",
      amount: 3000,
      currentPeriodEnd: "2026-03-01T00:00:00.000Z",
      actionUrl: "https://pay.example.com/confirm/sub_maya",
      holderPersonId: "per_maya",
    }),
    subscription({
      id: "sub_yoga",
      state: "ended",
      planObject: "memberships.plan",
      planId: "pln_yoga",
      planTitle: "Yoga twice a week",
      amount: 4000,
      endedAt: "2025-09-27T00:00:00.000Z",
      createdAt: "2025-03-27T10:00:00.000Z",
    }),
  ],
};

// --- Agreements ------------------------------------------------------------------------------------

const version = (
  id: string,
  documentId: string,
  number: number,
  kind: string,
  title: string,
): AgreementVersion => ({
  id,
  documentId,
  number,
  kind,
  title,
  body: { type: "doc", content: [] },
  tickLabel: "I have read and agree",
  questions: null,
  how: "typed",
  effectiveFrom: "2026-02-01T00:00:00.000Z",
  hash: `sha256-${id}`,
});

export const agreementsDue: AgreementsOut<"me.agreements.due"> = {
  people: [
    {
      personId: HANNAH,
      name: "Hannah Okafor",
      self: true,
      canAgree: true,
      due: [
        {
          documentId: "doc_terms",
          kind: "terms",
          title: "Membership terms",
          reason: "agree_again",
          version: version("ver_terms_4", "doc_terms", 4, "terms", "Membership terms"),
        },
      ],
    },
    {
      personId: LEO,
      name: "Leo Okafor",
      self: false,
      canAgree: true,
      due: [
        {
          documentId: "doc_health",
          kind: "health",
          title: "Health questionnaire",
          reason: "ask_again",
          version: version("ver_health_2", "doc_health", 2, "health", "Health questionnaire"),
        },
      ],
    },
  ],
};

export const agreementsMine: AgreementsOut<"me.agreements.list"> = {
  items: [
    {
      id: "acc_waiver",
      documentId: "doc_waiver",
      title: "Liability waiver",
      kind: "waiver",
      versionId: "ver_waiver_2",
      versionNumber: 2,
      personId: HANNAH,
      by: "self",
      how: "typed",
      channel: "web",
      acceptedAt: at("18:20", "2025-09-28"),
      agentPersonId: null,
      recordedBy: null,
      signedOn: null,
      counts: true,
    },
    {
      id: "acc_terms",
      documentId: "doc_terms",
      title: "Membership terms",
      kind: "terms",
      versionId: "ver_terms_3",
      versionNumber: 3,
      personId: HANNAH,
      by: "self",
      how: "typed",
      channel: "web",
      acceptedAt: at("18:21", "2025-09-28"),
      agentPersonId: null,
      recordedBy: null,
      signedOn: null,
      counts: true,
    },
    {
      id: "acc_leo_waiver",
      documentId: "doc_junior_waiver",
      title: "Junior liability waiver",
      kind: "waiver",
      versionId: "ver_junior_1",
      versionNumber: 1,
      personId: LEO,
      by: "guardian",
      how: "drawn",
      channel: "app",
      acceptedAt: at("07:48", "2025-10-04"),
      agentPersonId: HANNAH,
      recordedBy: null,
      signedOn: null,
      counts: true,
    },
  ],
};

// --- The Memberships pack's section ------------------------------------------------------------------

export const memberships: {
  mine: MembershipsOut<"x.memberships.mine">;
  plans: MembershipsOut<"x.memberships.plans">;
  subscriptions: MembershipsOut<"subscription.list">;
  coolingOff: MembershipsOut<"subscription.coolingOff">;
} = {
  mine: {
    holdings: [
      {
        id: "mem_unlimited",
        kind: "membership",
        title: "Unlimited membership",
        status: "active",
        uses: null,
        per: "month",
        from: "2025-09-28T00:00:00.000Z",
        until: null,
        live: true,
        period: {
          key: "2026-02-28",
          startsAt: "2026-02-28T00:00:00.000Z",
          endsAt: "2026-03-28T00:00:00.000Z",
          used: 2,
          left: null,
        },
        classTypes: [],
        weekdays: [],
        fromMinute: null,
        untilMinute: null,
      },
      {
        id: "pas_10",
        kind: "pass",
        title: "10-class pack",
        status: "active",
        uses: 10,
        per: "total",
        from: "2026-02-27T00:00:00.000Z",
        until: "2026-05-28T00:00:00.000Z",
        live: true,
        period: {
          key: "total",
          startsAt: "2026-02-27T00:00:00.000Z",
          endsAt: "2026-05-28T00:00:00.000Z",
          used: 3,
          left: 7,
        },
        classTypes: [],
        weekdays: [],
        fromMinute: null,
        untilMinute: null,
      },
    ],
  },
  plans: {
    currency: "GBP",
    plans: [
      {
        id: "pln_offpeak",
        title: "Off-peak",
        summary: "Weekdays before 4pm",
        description: null,
        price: 45,
        uses: null,
        per: null,
        trialDays: 7,
        classTypes: [],
        weekdays: ["1", "2", "3", "4", "5"],
        fromMinute: null,
        untilMinute: 960,
      },
      {
        id: "pln_unlimited",
        title: "Unlimited membership",
        summary: "Every class, every day",
        description: null,
        price: 65,
        uses: null,
        per: null,
        trialDays: 7,
        classTypes: [],
        weekdays: [],
        fromMinute: null,
        untilMinute: null,
      },
    ],
  },
  subscriptions: { items: [unlimited], nextCursor: null },
  coolingOff: {
    items: [
      {
        subscriptionId: "sub_unlimited",
        offered: false,
        why: "window_passed",
        days: 14,
        until: "2025-10-12",
        endsAt: null,
        refund: 0,
        currency: "GBP",
        coolOff: null,
      },
    ],
  },
};

// --- The hooks, as a client app makes them -----------------------------------------------------------

/** The account hooks over a fake client answering every base section's call. */
export function accountHooks(current: "browser" | "device") {
  return createAccountHooks(
    react,
    fakeClient<AccountOperations>(ACCOUNT_HOOKS_CALL, {
      "me.portal": portal,
      "me.get": me,
      "me.birthday.get": birthday,
      "me.sessions.list": sessions(current),
      "me.family": family,
      "my.list": myList,
      "subscription.list": subscriptions,
    }),
  );
}

/** The agreements hooks, for the Agreements section. */
export function agreementsHooks() {
  return createAgreementsHooks(
    react,
    fakeClient<AgreementsOperations>(AGREEMENTS_HOOKS_CALL, {
      "me.agreements.due": agreementsDue,
      "me.agreements.list": agreementsMine,
    }),
  );
}

/** The client the Memberships pack's section is given (its hooks are made by `usePackSections`). */
export const membershipsClient = fakeClient<MembershipsOperations>(MEMBERSHIPS_HOOKS_CALL, {
  "x.memberships.mine": memberships.mine,
  "x.memberships.plans": memberships.plans,
  "subscription.list": memberships.subscriptions,
  "subscription.coolingOff": memberships.coolingOff,
});
