// The Memberships pack's headless entry (stage 32b; ADRs 0418 and 0453): functions and hooks over
// the typed client, no markup. A client app imports it as `@composable-os/pack-memberships/client`
// and hands it its generated client; the memberships blocks render what it returns.
//
// Nothing here decides a price, a trial, whether an intro offer may be bought, or how many classes
// are left: the host does (`sellable`, the one-trial rule, `onePerPerson`, `allowance.get`). The
// billing actions (subscribe, cancel, resume, the provider's portal, buying a pass) are the web's;
// a native block reads only (the block lint).
import { type ClientHolding, type PackClient, packHooks } from "@composable-os/client";
import type { z } from "@composable-os/sdk";
import type { buy, givePass, holdings, mine, passTypes, plans, voidPass } from "../tools.ts";

type Io<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.input<T["input"]>;
  output: z.output<T["output"]>;
};

export const PLAN = "memberships.plan";
export const MEMBERSHIP = "memberships.membership";
export const PASS = "memberships.pass";

/** A subscription as its payer reads it (`subscription.list`, stage 32a). */
export interface MembershipSubscription {
  id: string;
  state:
    | "incomplete"
    | "expired"
    | "trialing"
    | "active"
    | "past_due"
    | "unpaid"
    | "paused"
    | "ended";
  planObject: string;
  planId: string;
  planTitle: string;
  /** One period's price, in the currency's minor unit, tax included. */
  amount: number;
  currency: string;
  interval: "week" | "month" | "year";
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  endedAt: string | null;
  actionUrl: string | null;
  createdAt: string;
}

/** Why the host gave no free trial (subscription.start's `noTrial`). */
export type NoTrial = "sign_in" | "used" | "permission" | "held" | "unconfirmed" | "continuation";

/** What subscription.start answers. */
export interface StartedSubscription {
  subscriptionId: string;
  url: string;
  amount: number;
  currency: string;
  interval: "week" | "month" | "year";
  trialDays: number | null;
  freeUntil: string | null;
  noTrial: NoTrial | null;
  expiresAt: string | null;
}

/** The operations this entry calls, as the generated client types them. */
export type MembershipsOperations = {
  "x.memberships.plans": { kind: "query" } & Io<typeof plans>;
  "x.memberships.passTypes": { kind: "query" } & Io<typeof passTypes>;
  "x.memberships.buy": { kind: "mutation" } & Io<typeof buy>;
  "x.memberships.mine": { kind: "query" } & Io<typeof mine>;
  "x.memberships.holdings": { kind: "query" } & Io<typeof holdings>;
  "x.memberships.givePass": { kind: "mutation" } & Io<typeof givePass>;
  "x.memberships.voidPass": { kind: "mutation" } & Io<typeof voidPass>;
  "order.checkout": {
    kind: "mutation";
    input: { id: string; token?: string; returnUrl: string };
    output: { url: string };
  };
  // A membership is a subscription to a plan (stage 32a): the host's own operations, web only.
  "subscription.start": {
    kind: "mutation";
    input: {
      plan: { object: string; id: string };
      returnUrl: string;
      email?: string;
      offerId?: string;
    };
    output: StartedSubscription;
  };
  "subscription.list": {
    kind: "query";
    input: { filter?: unknown; limit?: number };
    output: { items: MembershipSubscription[]; nextCursor: string | null };
  };
  "subscription.cancel": {
    kind: "mutation";
    input: { id: string; reason?: string };
    output: { id: string; requested: true };
  };
  "subscription.resume": {
    kind: "mutation";
    input: { id: string };
    output: { id: string; requested: true };
  };
  "subscription.portal": {
    kind: "mutation";
    input: { returnUrl: string };
    output: { url: string };
  };
};

export type MembershipsClient = PackClient<MembershipsOperations>;
type Out<N extends keyof MembershipsOperations> = MembershipsOperations[N]["output"];

/** One membership or pass of the member's, as `mine` gives it. */
export type Holding = Out<"x.memberships.mine">["holdings"][number];
/** A plan on sale, as `plans` gives it. */
export type Plan = Out<"x.memberships.plans">["plans"][number];
/** A pass type on sale, as `passTypes` gives it. */
export type PassType = Out<"x.memberships.passTypes">["passTypes"][number];

// --- Display only ---------------------------------------------------------------------------------

/** A price as the host gave it, in its currency (`99.00 AUD`). Display only: never worked out. */
export function formatPrice(
  price: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (price === null || price === undefined) return "";
  try {
    return currency
      ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(price)
      : String(price);
  } catch {
    return `${price}${currency ? ` ${currency}` : ""}`;
  }
}

/** A date as a reader sees it (`3 Dec 2026`), from the host's ISO timestamp. Display only. */
export function day(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** What a plan or pass allows, in words: `3 classes a week · Mon, Wed · 09:00 to 16:00`. */
export function allowsWords(item: {
  uses: number | null;
  per?: "total" | "week" | "month" | null;
  weekdays: readonly string[];
  fromMinute: number | null;
  untilMinute: number | null;
}): string {
  const per = item.per === "month" ? " a month" : item.per === "week" ? " a week" : "";
  const count =
    item.uses === null
      ? "Unlimited classes"
      : `${item.uses} ${item.uses === 1 ? "class" : "classes"}${per}`;
  const days = item.weekdays.length
    ? item.weekdays.map((d) => DAY_NAMES[Number(d)] ?? d).join(", ")
    : "";
  const times =
    item.fromMinute !== null || item.untilMinute !== null
      ? `${item.fromMinute !== null ? `from ${clock(item.fromMinute)}` : ""}${item.fromMinute !== null && item.untilMinute !== null ? " " : ""}${item.untilMinute !== null ? `before ${clock(item.untilMinute)}` : ""}`
      : "";
  return [count, days, times].filter(Boolean).join(" · ");
}

/**
 * What is left of a holding, in words, from the host's count: `2 of 3 left this week`. Display
 * only: whether it can pay for a class is the host's, at booking.
 */
export function leftWords(h: Holding): string {
  if (!h.live) {
    if (h.status === "void") return "Void";
    if (h.until && Date.parse(h.until) <= Date.now()) return `Ended ${day(h.until)}`;
    if (h.status === "paused") return "Paused";
    if (h.status === "unpaid" || h.status === "ended") return "Not active";
    if (h.period && h.period.left === 0) return "None left";
    return "Not active";
  }
  const p = h.period;
  if (!p || p.left === null) return "Unlimited";
  const when = h.per === "week" ? " this week" : h.per === "month" ? " this month" : "";
  return h.uses !== null
    ? `${p.left} of ${h.uses} left${when}`
    : `${p.left} left${when}`;
}

/** What a membership's subscription means to its payer, in words. Display only. */
export function subscriptionStatus(sub: MembershipSubscription): string {
  const ends = sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : sub.cancelAt;
  switch (sub.state) {
    case "trialing":
      return ends
        ? `Free, ending on ${day(ends)}: nothing will be charged`
        : `Free until ${day(sub.trialEnd ?? sub.currentPeriodEnd)}, then charged each ${sub.interval}`;
    case "active":
      return ends
        ? `Active until ${day(ends)}, then it ends`
        : `Active: next charge on ${day(sub.currentPeriodEnd)}`;
    case "past_due":
      return sub.actionUrl
        ? "A payment needs you to confirm it"
        : "A payment failed: the payment provider will try again";
    case "unpaid":
      return "Unpaid: update your card to keep booking";
    case "paused":
      return "Paused";
    case "incomplete":
      return "Waiting for its first payment";
    case "expired":
      return "Never started: its first payment did not go through";
    case "ended":
      return `Ended${sub.endedAt ? ` on ${day(sub.endedAt)}` : ""}`;
  }
}

/** Whether a subscription is still the payer's to cancel, resume or pay (not ended). */
export const isLive = (sub: MembershipSubscription) =>
  sub.state !== "ended" && sub.state !== "expired";

/** What a member is told when the host refuses a pass (its `rule` and `reason`). Display only. */
export function refusalWords(details: { rule?: unknown; reason?: unknown } | undefined): string {
  if (details?.rule === "once_per_person") {
    switch (details.reason) {
      case "sign_in":
        return "This offer is one per person: sign in to buy it.";
      case "used":
        return "This offer is one per person, and you have had yours.";
      case "held":
        return "This offer is one per person, and an order for yours is waiting to be paid.";
      default:
        return "This offer is one per person.";
    }
  }
  if (details?.rule === "sale_window" || details?.rule === "not_for_sale") {
    return "This is not on sale just now.";
  }
  return "We could not start your order.";
}

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery`, as far as these hooks use it. */
export type UseQuery = <T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  enabled?: boolean;
}) => { data: T | undefined; isPending: boolean; error: unknown };

/** The app's `useMutation`, as far as these hooks use it. */
export type UseMutation = <I, O>(options: {
  mutationKey: readonly unknown[];
  mutationFn: (input: I) => Promise<O>;
}) => {
  mutate(input: I): void;
  mutateAsync(input: I): Promise<O>;
  data: O | undefined;
  isPending: boolean;
  error: unknown;
};

/**
 * The operations each hook calls (ADR 0453). The public's client gets the plans, the pass types,
 * buying and subscribing; a customer's client also what they hold and their subscriptions; the
 * staff client a person's holdings and giving or voiding a pass.
 */
export const MEMBERSHIPS_HOOKS_CALL = {
  usePlans: ["x.memberships.plans"],
  usePassTypes: ["x.memberships.passTypes"],
  useBuyPass: ["x.memberships.buy", "order.checkout"],
  useMine: ["x.memberships.mine"],
  useHoldings: ["x.memberships.holdings"],
  useGivePass: ["x.memberships.givePass"],
  useVoidPass: ["x.memberships.voidPass"],
  // A membership's billing (stage 32a's flows). Every action is the web's: a native block may
  // read the subscription only (the block lint).
  useSubscribe: ["subscription.start"],
  useMySubscriptions: ["subscription.list"],
  useCancelSubscription: ["subscription.cancel"],
  useResumeSubscription: ["subscription.resume"],
  useBillingPortal: ["subscription.portal"],
} as const;

/**
 * Hooks for a React or React Native app:
 * `const memberships = createMembershipsHooks({ useQuery, useMutation }, api)`. The hooks a client
 * cannot back are not there, and calling one does not compile.
 */
export function createMembershipsHooks<C extends ClientHolding>(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  client: C,
) {
  return packHooks(client, MEMBERSHIPS_HOOKS_CALL, (api: MembershipsClient) =>
    allMembershipsHooks(react, api),
  );
}

function allMembershipsHooks(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  api: MembershipsClient,
) {
  const { useQuery, useMutation } = react;
  return {
    /** The membership plans on sale, with the host's prices and trial days. */
    usePlans() {
      return useQuery(api.query("x.memberships.plans", {}));
    },
    /** The passes on sale, with the host's prices. */
    usePassTypes() {
      return useQuery(api.query("x.memberships.passTypes", {}));
    },
    /** Start an order for a pass; then `checkout` it on the provider's page (web only). */
    useBuyPass() {
      return {
        start: useMutation(api.mutation("x.memberships.buy")),
        checkout: useMutation(api.mutation("order.checkout")),
      };
    },
    /** The signed-in member's memberships and passes, with the host's count of what is left. */
    useMine() {
      return useQuery(api.query("x.memberships.mine", {}));
    },
    /** Staff: one person's memberships and passes. */
    useHoldings(personId: string) {
      return useQuery(api.query("x.memberships.holdings", { personId }));
    },
    /** Staff (a person): give a pass by hand, with a reason. */
    useGivePass() {
      return useMutation(api.mutation("x.memberships.givePass"));
    },
    /** Staff (a person): void a pass given by hand, with a reason. */
    useVoidPass() {
      return useMutation(api.mutation("x.memberships.voidPass"));
    },
    /** Start a membership: the host opens the provider's page (web only); the trial is the host's. */
    useSubscribe() {
      return useMutation(api.mutation("subscription.start"));
    },
    /** The signed-in payer's own membership subscriptions, newest first. */
    useMySubscriptions() {
      return useQuery(
        api.query("subscription.list", {
          filter: { field: "planObject", op: "eq", value: PLAN },
          limit: 20,
        }),
      );
    },
    /** End their own membership when its period ends (web only). */
    useCancelSubscription() {
      return useMutation(api.mutation("subscription.cancel"));
    },
    /** Undo that, before the period ends (web only). */
    useResumeSubscription() {
      return useMutation(api.mutation("subscription.resume"));
    },
    /** The provider's portal for their card and past invoices (web only, never in a frame). */
    useBillingPortal() {
      return useMutation(api.mutation("subscription.portal"));
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<MembershipsHooks, "useMine">`. */
export type MembershipsHooks = ReturnType<typeof allMembershipsHooks>;
