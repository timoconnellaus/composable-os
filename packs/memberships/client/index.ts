// The Memberships pack's headless entry (stage 32b; ADRs 0418 and 0453): functions and hooks over
// the typed client, no markup. A client app imports it as `@composable-os/pack-memberships/client`
// and hands it its generated client; the memberships blocks render what it returns.
//
// Nothing here decides a price, a trial, whether an intro offer may be bought, or how many classes
// are left: the host does (`sellable`, the one-trial rule, `onePerPerson`, `allowance.get`). The
// billing actions (subscribe, cancel, resume, change plan, the provider's portal, buying a pass)
// are the web's; a native block reads only (the block lint). Pausing is staff's (decision 10).
// Whether a member may cool off (stage 44 step 7) is the host's: a block asks, and never works
// the window out on the device.
// Whether a change is an upgrade (now, prorated) or a downgrade (next period) is the host's.
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
  /** A plan change or a pause asked for and not over, or the pause it is in (stage 32b). */
  change?: SubscriptionChange | null;
  holderPersonId?: string | null;
}

/** A plan change or a pause, as the host shows it on the subscription (ADRs 0530, 0531). */
export interface SubscriptionChange {
  id: string;
  kind: "upgrade" | "downgrade" | "pause";
  state: "requested" | "waiting" | "applied" | "lapsed" | "withdrawn";
  toPlanId: string | null;
  toPlanTitle: string | null;
  toAmount: number | null;
  pauseFrom: string | null;
  pauseUntil: string | null;
  effectiveAt: string | null;
  requestedAt: string;
  /** What came of asking the provider; `unknown`: its next event decides. */
  callOutcome?: "sent" | "pending" | "unknown" | "refused" | null;
  /** The provider's page to confirm an upgrade's charge (3D Secure), while it waits. */
  actionUrl?: string | null;
  /** What came of ending a pause early: refused or unknown, staff ask again. */
  endOutcome?: "sent" | "pending" | "unknown" | "refused" | null;
}

/** Why cooling off is not offered (`subscription.coolingOff`'s `why`). */
export type NotOffered =
  | "not_covered"
  | "off"
  | "continuation"
  | "ended"
  | "window_passed"
  | "used"
  | "nothing_paid";

/** Whether a subscription may be cooled off, as the host says (stage 44 step 7, ADR 0647). */
export interface CoolingOffStatus {
  subscriptionId: string;
  /** The host says the payer may end it now for a full refund: the only reason to show the button. */
  offered: boolean;
  why: NotOffered | null;
  days: number;
  /** The last day of the window, `YYYY-MM-DD` in the business's time zone. */
  until: string | null;
  endsAt: string | null;
  /** Paid and not refunded, in minor units. */
  refund: number;
  currency: string;
  coolOff: {
    state: "asked" | "refused" | "ended";
    asked: "sent" | "pending" | "unknown" | null;
    askedBy: "payer" | "staff";
    askedAt: string;
    endedAt: string | null;
    paid: number;
    refunded: number;
    refunds: "waiting" | "refunded" | "held" | null;
  } | null;
}

/** What subscription.coolOff answers. */
export interface CooledOff {
  id: string;
  state: "asked" | "ended";
  asked: "sent" | "pending" | "unknown" | null;
  refund: number;
  currency: string;
}

/** What subscription.change answers. */
export interface RequestedChange {
  id: string;
  changeId: string;
  kind: "upgrade" | "downgrade";
  effectiveAt: string | null;
  amount: number;
  currency: string;
  asked: "sent" | "pending" | "unknown" | "not_needed";
  requested: true;
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
      /**
       * A guest only: what they agreed to on the way (stage 44, ADR 0644), each
       * { versionId, typedName, signature?, answers? }, as the host's refusal asked.
       */
      agreements?: Record<string, unknown>[];
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
  // Stage 32b: another plan (a member's own, on the web; staff any) and a pause (staff only).
  "subscription.change": {
    kind: "mutation";
    input: { id: string; planId: string; reason?: string };
    output: RequestedChange;
  };
  // Stage 44 step 7 (ADR 0647): whether a payer may end their own in its cooling-off period, and
  // ending it (web only).
  "subscription.coolingOff": {
    kind: "query";
    input: { ids: string[] };
    output: { items: CoolingOffStatus[] };
  };
  "subscription.coolOff": {
    kind: "mutation";
    input: { id: string };
    output: CooledOff;
  };
  "subscription.pause": {
    kind: "mutation";
    input: { id: string; from?: string; until: string; reason: string };
    output: {
      id: string;
      changeId: string;
      from: string | null;
      until: string;
      asked: "sent" | "pending" | "unknown";
      requested: true;
    };
  };
  "subscription.unpause": {
    kind: "mutation";
    input: { id: string; reason?: string };
    output: { id: string; asked: "sent" | "pending" | "unknown"; requested: true };
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
  return h.uses !== null ? `${p.left} of ${h.uses} left${when}` : `${p.left} left${when}`;
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
      return sub.change?.kind === "pause" && sub.change.pauseUntil
        ? `Paused until ${day(sub.change.pauseUntil)}: nothing is charged meanwhile`
        : "Paused";
    case "incomplete":
      return "Waiting for its first payment";
    case "expired":
      return "Never started: its first payment did not go through";
    case "ended":
      return `Ended${sub.endedAt ? ` on ${day(sub.endedAt)}` : ""}`;
  }
}

/**
 * A plan change or a pause waiting, in words, from the host's record: `Changing to Unlimited once
 * its charge is paid`, `Changes to One a week on 3 Dec 2026`, `Paused from 1 Dec to 21 Dec`.
 * Display only: null when nothing waits.
 */
export function changeWords(sub: MembershipSubscription): string | null {
  const c = sub.change;
  if (!c) return null;
  if (c.kind === "pause") {
    if (c.endOutcome === "refused" || c.endOutcome === "unknown") {
      return "Ending the pause did not finish: ask again";
    }
    if (c.state === "applied") return null;
    return `Pause asked: ${c.pauseFrom ? `from ${day(c.pauseFrom)}` : "from now"} until ${day(c.pauseUntil)}`;
  }
  if (c.state === "lapsed")
    return `The change to ${c.toPlanTitle} was not paid, so it did not happen`;
  if (c.endOutcome === "refused" || c.endOutcome === "unknown") {
    return `Withdrawing the change to ${c.toPlanTitle} did not finish: staff are asking again`;
  }
  if (c.kind === "upgrade") {
    return c.actionUrl
      ? `Changing to ${c.toPlanTitle}: confirm its payment to finish`
      : `Changing to ${c.toPlanTitle} once its charge is paid`;
  }
  return `Changes to ${c.toPlanTitle} on ${day(c.effectiveAt)}`;
}

/** Whether the payer may ask for a plan change now: active, not ending, nothing else waiting. */
export const canChangePlan = (sub: MembershipSubscription) =>
  sub.state === "active" &&
  !sub.cancelAtPeriodEnd &&
  sub.cancelAt === null &&
  (!sub.change || sub.change.state === "lapsed" || sub.change.state === "applied");

/** What a member is told when the host refuses a plan change (its `rule`). Display only. */
export function changeRefusalWords(details: { rule?: unknown } | undefined): string {
  switch (details?.rule) {
    case "change_open":
      return "A change is already waiting on your membership.";
    case "ending":
      return "Your membership is set to end: keep it going first.";
    case "state":
      return "Your membership cannot be changed just now.";
    case "same_plan":
      return "That is the plan you are on.";
    default:
      return "We could not change your plan.";
  }
}

/** A price in minor units as the host gave it (`1999` AUD is `$19.99`). Display only. */
export function formatMinor(amount: number, currency: string): string {
  try {
    const digits =
      new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    return formatPrice(amount / 10 ** digits, currency);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** A `YYYY-MM-DD` day as a reader sees it (`3 Dec 2026`), never shifted by the reader's zone. */
export function localDay(date: string | null | undefined): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const at = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
}

/**
 * The words beside the cancel button while the host offers cooling off: "You can cancel for a
 * full refund until 3 Dec 2026". Null when it is not offered. Display only: the window is the
 * host's (`subscription.coolingOff`), never worked out here.
 */
export function coolingOffWords(status: CoolingOffStatus | undefined): string | null {
  if (!status?.offered) return null;
  return `You can cancel for a full refund until the end of ${localDay(status.until)}.`;
}

/**
 * Why a member who might have expected it cannot cool off, in words: the period has passed, or
 * they cooled off before. Null otherwise (no cooling off on the plan or for them, or a free trial,
 * where the ordinary cancel ends it at no charge). Display only, from the host's `why`.
 */
export function coolingOffClosedWords(status: CoolingOffStatus | undefined): string | null {
  if (!status || status.offered || status.coolOff) return null;
  if (status.why === "window_passed") {
    return `The cooling-off period ended at the end of ${localDay(status.until)}.`;
  }
  if (status.why === "used") {
    return "Cooling off has been used for this member before: it is once per member.";
  }
  return null;
}

/**
 * Where a cooling off asked for has got, in words, from the host's record. Null when none was
 * asked.
 */
export function coolOffProgressWords(
  status: CoolingOffStatus | undefined,
  /** Name the amounts (the web); the app, which shows no money, leaves them out. */
  { amounts = true }: { amounts?: boolean } = {},
): string | null {
  const c = status?.coolOff;
  if (!c || !status) return null;
  const sum = (n: number) => (amounts ? ` of ${formatMinor(n, status.currency)}` : "");
  const money = sum(c.state === "ended" ? c.paid - c.refunded : status.refund);
  if (c.state === "refused") {
    return "Ending it in the cooling-off period did not go through: ask again, or ask the business.";
  }
  if (c.state === "asked") {
    return c.asked === "unknown" || c.asked === null
      ? "You asked to end it in the cooling-off period. We have not heard back from the payment provider yet; the business has been told."
      : "You asked to end it in the cooling-off period. It shows as ended here once the payment provider confirms.";
  }
  switch (c.refunds) {
    case "refunded":
      return `Ended in the cooling-off period: refunded${amounts ? ` (${formatMinor(c.refunded, status.currency)})` : ""}.`;
    case "held":
      return `Ended in the cooling-off period. A refund${money} is owed; the business will contact you about it.`;
    default:
      return `Ended in the cooling-off period. A full refund${money} is owed: the business approves it, then it goes back to how you paid.`;
  }
}

/** What a payer is told when the host refuses cooling off (its `reason`). Display only. */
export function coolOffRefusalWords(
  details: { rule?: unknown; reason?: unknown } | undefined,
): string {
  if (details?.rule === "provider_refused") {
    return "The payment provider did not end your membership, so nothing changed. Try again.";
  }
  switch (details?.reason) {
    case "window_passed":
      return "The cooling-off period has ended. You can still cancel at the end of the period.";
    case "used":
      return "Cooling off has been used for this member before: it is once per member.";
    case "nothing_paid":
      return "Nothing has been paid yet: cancel instead, and it ends with the free time at no charge.";
    case "continuation":
      return "Cooling off is for new members: this membership was not started as a new one here.";
    case "off":
    case "not_covered":
      return "This membership has no cooling-off period.";
    case "ended":
      return "This membership has ended.";
    default:
      return "We could not end your membership just now. Try again.";
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
  gcTime?: number;
}) => {
  mutate(input: I): void;
  mutateAsync(input: I): Promise<O>;
  data: O | undefined;
  isPending: boolean;
  error: unknown;
  /** Forgets the call: its variables and its answer (TanStack Query's `reset`). */
  reset?: () => void;
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
  // Stage 32b (ADRs 0530, 0531): a member's plan change (web only); staff pause and end a pause,
  // and read a person's membership subscriptions.
  useChangePlan: ["subscription.change"],
  usePauseSubscription: ["subscription.pause"],
  useUnpauseSubscription: ["subscription.unpause"],
  useSubscriptionsOf: ["subscription.list"],
  // Stage 44 step 7 (ADR 0647): what the host says of cooling off (read anywhere), and ending a
  // membership in it (web only, like every billing action).
  useCoolingOff: ["subscription.coolingOff"],
  useCoolOff: ["subscription.coolOff"],
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
        // A visitor's agreements (a name typed, a signature, health answers) go in this call:
        // not kept in the app's cache once it is over (stage 44).
        start: useMutation({ ...api.mutation("x.memberships.buy"), gcTime: 0 }),
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
      // A guest's agreements go in this call: not kept in the app's cache after it (stage 44).
      return useMutation({ ...api.mutation("subscription.start"), gcTime: 0 });
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
    /**
     * Move their own membership to another plan (web only): the host decides an upgrade (now,
     * prorated, applied once paid) or a downgrade (from the next period).
     */
    useChangePlan() {
      return useMutation(api.mutation("subscription.change"));
    },
    /** Staff (a person): pause a membership from now or a date until a date, with a reason. */
    usePauseSubscription() {
      return useMutation(api.mutation("subscription.pause"));
    },
    /** Staff (a person): end a pause now, or withdraw one not yet started. */
    useUnpauseSubscription() {
      return useMutation(api.mutation("subscription.unpause"));
    },
    /**
     * Whether each of these subscriptions may be ended in its cooling-off period, and how far one
     * asked for has got. The host decides; a block shows the button only when `offered`.
     */
    useCoolingOff(ids: readonly string[]) {
      const list = [...ids].slice(0, 20);
      const query = api.query("subscription.coolingOff", { ids: list });
      return useQuery({ ...query, enabled: list.length > 0 });
    },
    /** End their own membership in its cooling-off period, for a full refund (web only). */
    useCoolOff() {
      return useMutation(api.mutation("subscription.coolOff"));
    },
    /** Staff: the membership subscriptions one person holds. */
    useSubscriptionsOf(personId: string) {
      return useQuery(
        api.query("subscription.list", {
          filter: {
            and: [
              { field: "planObject", op: "eq", value: PLAN },
              { field: "holderPersonId", op: "eq", value: personId },
            ],
          },
          limit: 20,
        }),
      );
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<MembershipsHooks, "useMine">`. */
export type MembershipsHooks = ReturnType<typeof allMembershipsHooks>;
