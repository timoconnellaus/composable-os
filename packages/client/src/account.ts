// My account for a client app (stage 48 step 1): the base headless entry the account blocks share,
// web and native. Functions and hooks over the typed client, no markup and no platform API: the
// shell (`web-account`, `native-account`) and its base sections (details, sign-in and devices,
// family, orders, the subscriptions part, payment method) draw with what is here.
//
// It holds no rules. What is the customer's, what a subscription or an order is in, what is owed
// and by when, who they act for and which sessions are theirs are the host's answers (me.*, my.*,
// subscription.*): this reads them and puts them in words. Amounts are shown as the host gave
// them, in the currency's minor unit; nothing here adds, subtracts or works out a price.
//
// Which sections a customer has is the host's (`me.portal`, `portalSections`). Step 7 adds what
// needs the customer's attention (`me.attention`: `attentionWords`, `attentionTarget`), changing
// the sign-in address (`emailChangeProblem`) and deleting the account (`deleteConfirmInput`,
// `deletePreviewWords`), and `sensitive`, which makes the host's `sign_in_again` its own outcome
// so a block signs the customer in again in place and carries on (ADR 0715).
import type { QueryName } from "./client.ts";
import type { ClientHolding, PackClient, UseMutation, UseQuery } from "./hooks.ts";
import { packHooks } from "./hooks.ts";

// --- What the host answers ------------------------------------------------------------------------

/** The signed-in customer's own Person and their sign-in address (`me.get`). */
export interface AccountMe {
  id: string;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  /** The address they sign in with: the one the emailed code verified. */
  signInEmail: string;
  signInEmailVerified: boolean;
}

/** What `me.update` changes: only the fields passed; null clears one. */
export interface AccountDetailsInput {
  displayName?: string;
  givenName?: string | null;
  familyName?: string | null;
  primaryPhone?: string | null;
}

/** A birthday: day and month only, never a year (`me.birthday.get`, stage 53). */
export interface AccountBirthday {
  day: number;
  month: number;
}

/** One place the customer is signed in (`me.sessions.list`). */
export interface AccountSession {
  id: string;
  kind: "browser" | "device";
  deviceName: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string | null;
  /** The session this call was made with. */
  current: boolean;
}

/** Who the customer acts for and who acts for them (`me.family`, ADR 0540). */
export interface AccountFamily {
  self: { personId: string; name: string };
  dependants: { personId: string; name: string }[];
  guardians: { personId: string; name: string }[];
}

/** A record as `my.list` answers it: only the fields the object lets its customer read. */
export interface MyRecord {
  object: string;
  id: string;
  values: Record<string, unknown>;
}

export type OrderState = "pending" | "part_paid" | "paid" | "cancelled" | "expired" | "refunded";

/** One line of an order, as its customer reads it. Amounts in the currency's minor unit. */
export interface AccountOrderLine {
  id: string;
  position: number;
  title: string;
  quantity: number;
  unitPrice: number;
  total: number;
  taxAmount: number;
}

/** One of the customer's orders with its lines. Amounts in the currency's minor unit. */
export interface AccountOrder {
  id: string;
  state: OrderState;
  currency: string;
  total: number;
  paid: number;
  balance: number;
  refunded: number;
  pay: "full" | "deposit";
  deposit: number | null;
  balanceDueAt: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
  taxAmount: number;
  taxRefunded: number;
  /** Set on an order that paid one period of a subscription. */
  subscriptionId: string | null;
  lines: AccountOrderLine[];
  /**
   * A receipt document for the order: the seam stage 35 (Invoices) fills. Until then null, and
   * the row says the payment provider emailed the receipt.
   */
  receiptUrl: string | null;
}

export type SubscriptionState =
  | "incomplete"
  | "expired"
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "paused"
  | "ended";

/** A subscription as its payer reads it (`subscription.list`: a customer sees the ones they pay). */
export interface AccountSubscription {
  id: string;
  state: SubscriptionState;
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
  /** The provider's page to confirm a payment on (3D Secure), while one waits. */
  actionUrl: string | null;
  createdAt: string;
  /** Whom it is for, where the host says (a pack's own subscription read may leave it out). */
  holderPersonId?: string | null;
}

/**
 * What the subscriptions part reads and does (`web-account-subscriptions`,
 * `native-account-subscriptions`): the account's own hooks, or a pack's hooks over the same
 * operations (`subscription.list`, `.cancel`, `.resume`) for its own plans, so Memberships and
 * Courses show their subscriptions with the one part.
 */
export interface SubscriptionsPartHooks<S extends AccountSubscription = AccountSubscription> {
  useSubscriptions(): {
    data: { items: S[] } | undefined;
    isPending: boolean;
    error: unknown;
    refetch?: () => unknown;
  };
  useCancelSubscription(): {
    mutateAsync(input: { id: string; reason?: string }): Promise<unknown>;
    isPending: boolean;
  };
  useResumeSubscription(): {
    mutateAsync(input: { id: string }): Promise<unknown>;
    isPending: boolean;
  };
}

/** A section of My account as the host lists it (`me.portal`, ADR 0710). */
export interface AccountPortalSection {
  /** A base section's key (`orders`), or a pack's as `<pack>.<key>` (`memberships.memberships`). */
  key: string;
  /** The pack it is from; null for a base section. */
  pack: string | null;
  label: string;
  order: number;
  /** The blocks that draw a pack's section; null for a base one. */
  web: { block: string; export: string } | null;
  native: { block: string; export: string } | null;
}

/** Which sections of My account the customer has, in order (`me.portal`). */
export interface AccountPortal {
  sections: AccountPortalSection[];
  /** Whether they pay a subscription that has not ended: Payment method shows then. */
  paysSubscription: boolean;
}

/**
 * What can need a customer's attention (`me.attention`, ADR 0711): a fixed vocabulary in core.
 * A newer host may answer a kind this entry does not know yet; it is shown by its record's title.
 */
export const ATTENTION_KINDS = [
  "agree",
  "card_failing",
  "confirm_payment",
  "balance_due",
  "finish_paying",
  "pass_expiring",
  "pass_used_up",
  "trial_ending",
  "form_to_fill",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** One thing that needs the customer, or a child they act for (`me.attention`). */
export interface AttentionItem {
  /** Stable for the same cause. */
  key: string;
  kind: AttentionKind;
  /** Whose it is: the customer themselves, or a child they act for, by name. */
  person: { id: string; name: string; self: boolean };
  /** The record it is about: `agreement`, `subscription`, `order`, or a pack's object. */
  record: { object: string; id: string; title: string };
  /** The moment it is about: when it is due, ends or expires (the host's). */
  at: string | null;
  /** Money in the currency's minor unit, where there is some. */
  amount: number | null;
  currency: string | null;
  /** A pass's uses left. */
  usesLeft: number | null;
  /** The personal link to answer a form by (form_to_fill): its id, never a token. */
  link: string | null;
}

/** What needs the customer's attention, soonest first, and how far ahead it looks. */
export interface AccountAttention {
  days: number;
  items: AttentionItem[];
}

/** A subscription deleting the account ends, as the preview says (`me.deleteAccount`). */
export interface DeleteEnding {
  id: string;
  title: string;
  amount: number;
  currency: string;
  interval: string;
  endsAt: string | null;
  /** Asked to end at the period's end now, already set to end, or ending with a cooling off. */
  ending: "period_end" | "already" | "cooling_off";
}

/** What deleting the account will do, before anything is done (`me.deleteAccount` with `{}`). */
export interface DeletePreview {
  deleted: false;
  subscriptions: DeleteEnding[];
  /** Their unpaid orders, cancelled. */
  orders: { id: string; total: number; currency: string; createdAt: string; lines: string[] }[];
  /** What stays for the business to decide when it erases their data. */
  leftForStaff: {
    records: { object: string; label: string; count: number }[];
    partPaidOrders: number;
    moreUnpaidOrders: number;
    subscriptions: {
      id: string;
      title: string;
      state: string;
      why: "end_date_later" | "state" | "more";
    }[];
    dependantsWithoutGuardian: number;
  };
  /** By when the business erases their data, or says why some must be kept. */
  eraseDueAt: string;
  /** The preview's fingerprint, sent back to confirm exactly this. */
  expect: string;
}

/** The account deleted (`me.deleteAccount` with `confirm`). */
export interface DeleteDone {
  deleted: true;
  disabled: true;
  sessionsEnded: number;
  subscriptionsEnding: number;
  ordersCancelled: number;
  eraseRequest: { requestedAt: string; dueAt: string };
}

/** The operations this entry calls, as the generated client types them. */
export type AccountOperations = {
  "me.portal": { kind: "query"; input: Record<string, never>; output: AccountPortal };
  "me.attention": { kind: "query"; input: Record<string, never>; output: AccountAttention };
  "me.email.change": {
    kind: "mutation";
    input: { email: string };
    output: { newEmail: string; expiresAt: string };
  };
  "me.email.confirm": {
    kind: "mutation";
    input: { code: string };
    output: { signInEmail: string; sessionsEnded: number };
  };
  "me.deleteAccount": {
    kind: "mutation";
    input: { confirm?: boolean; expect?: string };
    output: DeletePreview | DeleteDone;
  };
  "me.get": { kind: "query"; input: Record<string, never>; output: AccountMe };
  "me.update": {
    kind: "mutation";
    input: AccountDetailsInput;
    output: Omit<AccountMe, "signInEmail" | "signInEmailVerified">;
  };
  "me.birthday.get": {
    kind: "query";
    input: Record<string, never>;
    output: { birthday: AccountBirthday | null };
  };
  "me.birthday.set": {
    kind: "mutation";
    input: { birthday: AccountBirthday | null };
    output: { birthday: AccountBirthday | null };
  };
  "me.sessions.list": {
    kind: "query";
    input: Record<string, never>;
    output: { items: AccountSession[] };
  };
  "me.sessions.revoke": {
    kind: "mutation";
    input: { id: string };
    output: { id: string; revoked: true };
  };
  "me.family": { kind: "query"; input: Record<string, never>; output: AccountFamily };
  "my.list": {
    kind: "query";
    input: {
      object: string;
      filter?: { field: string; op: string; value?: unknown };
      sort?: { field: string; direction?: "asc" | "desc" };
      cursor?: string;
      limit?: number;
    };
    output: { items: MyRecord[]; nextCursor: string | null; currency?: string | null };
  };
  "subscription.list": {
    kind: "query";
    input: { limit?: number; cursor?: string };
    output: { items: AccountSubscription[]; nextCursor: string | null };
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
  // Paying the customer's own order on the provider's page: the web's Orders only (ADR 0714).
  "order.checkout": {
    kind: "mutation";
    input: { id: string; returnUrl: string };
    output: {
      url: string;
      amount: number;
      currency: string;
      kind: "full" | "deposit" | "balance" | "part";
      expiresAt: string | null;
    };
  };
  // A read at the host; opening the provider's page is an action here, as in Courses' hooks.
  "subscription.portal": {
    kind: "mutation";
    input: { returnUrl: string };
    output: { url: string };
  };
  "me.contact.choices": {
    kind: "query";
    input: Record<string, never>;
    output: { people: ContactPerson[] };
  };
  "me.contact.setChoices": {
    kind: "mutation";
    input: ContactChoicesInput;
    output: { changed: number };
  };
};

// --- Contact preferences (stage 30, ADR 0675) ------------------------------------------------------

/** A channel a message may reach someone on. */
export type ContactChannel = "email" | "text" | "push";
/** On or off; for news and offers, yes or no. */
export type ContactValue = "on" | "off" | "yes" | "no";

/** One channel of a kind of message, as the host says it is now (`me.contact.choices`). */
export interface ContactLineChannel {
  channel: ContactChannel;
  value: ContactValue;
  /** Cannot be changed: an essential kind's email always goes. */
  fixed: boolean;
  /** Stopped by a stop link or a STOP reply (the person may turn it back on here). */
  stopped: boolean;
  since: string | null;
}

/** One kind of message a person may get, with each channel it goes by. */
export interface ContactLine {
  /** A routine message kind (`bookings.reminder`), `follow_up` or `news_and_offers`. */
  scope: string;
  label: string;
  description: string;
  purpose: "account" | "follow_up" | "news_and_offers";
  /** Its email always goes. */
  essential: boolean;
  channels: ContactLineChannel[];
}

/** The caller's own choices, or a child's they act for. */
export interface ContactPerson {
  personId: string;
  name: string;
  self: boolean;
  child: boolean;
  lines: ContactLine[];
}

/** What `me.contact.setChoices` takes. */
export interface ContactChoicesInput {
  /** A child they act for; default themselves. */
  personId?: string;
  choices: { scope: string; channel: ContactChannel; value: ContactValue }[];
  /** For a yes to news and offers: the words they were shown (`newsAndOffersWords`). */
  wording?: string;
}

/** A channel's name, as a person reads it. */
export const CONTACT_CHANNEL_WORDS: Readonly<Record<ContactChannel, string>> = {
  email: "Email",
  text: "Text message",
  push: "App notification",
};

/** Whether a channel's value lets messages go. */
export function contactAllows(value: ContactValue): boolean {
  return value === "on" || value === "yes";
}

/** The words a person is shown when they say yes to news and offers on a channel (kept by the host). */
export function newsAndOffersWords(channel: ContactChannel): string {
  return `Yes, send me news and offers by ${CONTACT_CHANNEL_WORDS[channel].toLowerCase()}. I can stop at any time.`;
}

/**
 * The change that turns one channel of a line the other way: on and off, or for news and offers
 * yes and no (with the words shown). Null for a channel that cannot change (an essential email).
 */
export function contactToggle(
  personId: string,
  line: ContactLine,
  channel: ContactLineChannel,
): ContactChoicesInput | null {
  if (channel.fixed) return null;
  const yesNo = line.scope === "news_and_offers";
  const on = contactAllows(channel.value);
  const value: ContactValue = yesNo ? (on ? "no" : "yes") : on ? "off" : "on";
  return {
    personId,
    choices: [{ scope: line.scope, channel: channel.channel, value }],
    ...(value === "yes" ? { wording: newsAndOffersWords(channel.channel) } : {}),
  };
}

/** A line's channel in words: "Email: on", "Email: always (about something you booked)". */
export function contactChannelWords(channel: ContactLineChannel): string {
  const name = CONTACT_CHANNEL_WORDS[channel.channel];
  if (channel.fixed) return `${name}: always`;
  if (channel.stopped) return `${name}: stopped`;
  return `${name}: ${contactAllows(channel.value) ? "on" : "off"}`;
}

export type AccountClient = PackClient<AccountOperations>;

// --- Sections --------------------------------------------------------------------------------------

/**
 * A section of My account: a base one, or a pack's (its `portal` declaration, ADR 0710, keyed
 * `<pack>.<key>`). Lower `order` first.
 */
export interface AccountSection {
  key: string;
  label: string;
  order: number;
}

/**
 * A pack's section as the client app's generated `account-sections.gen.ts` lists it (`cos add
 * web-account`, ADR 0710): the copied block's component and the pack's hooks factory. The shell
 * renders `component` with the hooks under the pack's id (`{ memberships: hooks }`) and the page's
 * `returnUrl`; `Component` is the app's component type.
 */
export interface AccountSectionEntry<Component = unknown> {
  /** `<pack>.<key>`, as `me.portal` names it. */
  key: string;
  pack: string;
  label: string;
  order: number;
  component: Component;
  /**
   * The pack's hooks factory (`createMembershipsHooks`), called once with the app's React
   * functions and its generated client. Typed loosely: each pack's factory takes its own types.
   */
  hooks: (react: never, client: never) => unknown;
}

/**
 * The base sections, in the order they show after the packs' (a pack declares 10 to 50): what is
 * the customer's to see and do, then their details and where they are signed in. Deleting the
 * account joins them in a later step.
 */
export const BASE_SECTIONS = [
  { key: "orders", label: "Orders", order: 60 },
  { key: "agreements", label: "Agreements", order: 70 },
  { key: "family", label: "Family", order: 80 },
  { key: "payment", label: "Payment method", order: 85 },
  { key: "details", label: "Your details", order: 90 },
  { key: "contact", label: "Contact preferences", order: 92 },
  { key: "devices", label: "Sign-in and devices", order: 95 },
  { key: "delete", label: "Delete my account", order: 99 },
] as const satisfies readonly AccountSection[];

export type BaseSectionKey = (typeof BASE_SECTIONS)[number]["key"];

/**
 * The sections to show, in order: the base ones and the packs' given, less those `hide` names
 * (`payment` for a customer who pays no subscription: `showsPayment`). A pack section whose key
 * is a base one's is left out: the base section is the one the host's reads stand behind.
 */
export function accountSections(
  packs: readonly AccountSection[] = [],
  hide: readonly string[] = [],
): AccountSection[] {
  const base = new Set<string>(BASE_SECTIONS.map((s) => s.key));
  return [...BASE_SECTIONS, ...packs.filter((s) => !base.has(s.key))]
    .filter((s) => !hide.includes(s.key))
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/**
 * The sections to show, as the host listed them (`me.portal`): every base section it lists, and a
 * pack's only when the app has its block (`packs`, from `account-sections.gen.ts`), so a pack
 * installed at the host before the app copied its block shows nothing rather than an empty
 * section. Until the host answers, the base sections without Payment method.
 *
 * A shell passes `base`, the base sections it draws: a base section a newer host lists that the
 * shell has no part for (one added to the platform after the shell was copied, as Contact
 * preferences and Delete my account were) is left out too, rather than shown as a heading with
 * nothing under it. Without `base`, every base section the host lists is kept.
 */
export function portalSections(
  portal: AccountPortal | undefined,
  packs: readonly AccountSection[] = [],
  base?: readonly string[],
): AccountSection[] {
  const drawn = (key: string) => !base || base.includes(key);
  if (!portal) return accountSections([], ["payment"]).filter((s) => drawn(s.key));
  const copied = new Set(packs.map((s) => s.key));
  return portal.sections
    .filter((s) => (s.pack === null ? drawn(s.key) : copied.has(s.key)))
    .map((s) => ({ key: s.key, label: s.label, order: s.order }));
}

/** The base sections a shell hides for this customer, from what the host answered. */
export function hiddenSections(
  subscriptions: readonly AccountSubscription[] | undefined,
): string[] {
  return showsPayment(subscriptions) ? [] : ["payment"];
}

// --- Words (display only) ----------------------------------------------------------------------------

/**
 * An amount the host gave in the currency's minor unit, in that currency: `$29.00`. Display only:
 * the minor unit's digits are the currency's own.
 */
export function formatMinor(minor: number, currency: string, locale?: string): string {
  try {
    const format = new Intl.NumberFormat(locale, { style: "currency", currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  } catch {
    return `${minor} ${currency}`;
  }
}

/** The host's ISO timestamp as a reader sees it, or "" for none or one that does not parse. */
function localWhen(
  iso: string | null | undefined,
  locale: string | undefined,
  format: Intl.DateTimeFormatOptions,
): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString(locale, format);
}

/** A date as a reader sees it (`3 Dec 2026`), from the host's ISO timestamp. Display only. */
export function accountDay(iso: string | null | undefined, locale?: string): string {
  return localWhen(iso, locale, { day: "numeric", month: "short", year: "numeric" });
}

/** A moment as a reader sees it (`3 Dec 2026, 09:30`). Display only. */
export function accountTime(iso: string | null | undefined, locale?: string): string {
  return localWhen(iso, locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A session in words: what it is, and when it began and was last used. */
export function sessionWords(session: AccountSession): { title: string; detail: string } {
  const what =
    session.kind === "device" ? (session.deviceName ?? "The app on a device") : "A web browser";
  const title = session.current
    ? `${session.kind === "device" ? "This device" : "This browser"} (${what})`
    : what;
  return {
    title,
    detail: `Signed in ${accountTime(session.createdAt)} · last used ${accountTime(session.lastActiveAt)}`,
  };
}

/** The customer's sessions, this one first, then the most recently used. */
export function orderedSessions(items: readonly AccountSession[]): AccountSession[] {
  return [...items].sort(
    (a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt.localeCompare(a.lastActiveAt),
  );
}

/** An order's state in words, from what the host reports. */
export function orderStateWords(order: AccountOrder): string {
  switch (order.state) {
    case "pending":
      return order.expiresAt
        ? `Waiting for payment until ${accountTime(order.expiresAt)}`
        : "Waiting for payment";
    case "part_paid":
      return order.balanceDueAt
        ? `Deposit paid: the rest is due by ${accountDay(order.balanceDueAt)}`
        : "Deposit paid: the rest is still to pay";
    case "paid":
      return order.refunded > 0 ? "Paid, part refunded" : "Paid";
    case "refunded":
      return "Refunded";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Not paid in time: nothing was charged";
  }
}

/**
 * The money lines of an order to show, each the host's own figure: the total and its tax, then
 * what was paid, what is still to pay (by when), the deposit and what was refunded. A figure the
 * order does not have (no deposit, nothing refunded) is left out.
 */
export function orderMoney(
  order: AccountOrder,
  locale?: string,
): { key: string; label: string; value: string }[] {
  const money = (minor: number) => formatMinor(minor, order.currency, locale);
  const out = [{ key: "total", label: "Total", value: money(order.total) }];
  if (order.taxAmount > 0)
    out.push({ key: "tax", label: "Tax included", value: money(order.taxAmount) });
  if (order.pay === "deposit" && order.deposit !== null) {
    out.push({ key: "deposit", label: "Deposit", value: money(order.deposit) });
  }
  if (order.paid > 0) out.push({ key: "paid", label: "Paid", value: money(order.paid) });
  if (order.balance > 0 && order.state !== "cancelled" && order.state !== "expired") {
    out.push({
      key: "balance",
      label: order.balanceDueAt ? `To pay by ${accountDay(order.balanceDueAt, locale)}` : "To pay",
      value: money(order.balance),
    });
  }
  if (order.refunded > 0)
    out.push({ key: "refunded", label: "Refunded", value: money(order.refunded) });
  if (order.taxRefunded > 0) {
    out.push({ key: "taxRefunded", label: "Tax refunded", value: money(order.taxRefunded) });
  }
  return out;
}

/**
 * Whether an order's row offers to pay: it waits for payment, or has the rest of a deposit still
 * to pay. Display only: what is charged, and whether it may be paid at all, is the host's
 * (`order.checkout` refuses otherwise and says so).
 */
export function showsPay(order: AccountOrder): boolean {
  return order.state === "pending" || (order.state === "part_paid" && order.balance > 0);
}

/** What an order's pay button says: the rest of a deposit, or the whole order. */
export function payWords(order: AccountOrder): string {
  return order.state === "part_paid" ? "Pay the rest" : "Pay now";
}

/** What an order's row in the app says instead: paying is on the website (ADR 0714). */
export const PAY_ON_WEBSITE_WORDS = "Pay on the website";

/**
 * Whether an address the host gave (a provider's page to confirm a payment, a checkout) may be
 * followed: an `https:` address, a path on this site, or a loopback `http:` one (a local
 * development host). Anything else (`javascript:`, `data:`, another `http:`, `//elsewhere`) is
 * not followed.
 */
export function followableUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (/\s/.test(url)) return false;
  // A loopback `http:` address is a local development host's (its fake provider's page).
  const loopback = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
  return /^\/(?![/\\])/.test(url) || /^https:\/\/[^/\\?#@]/i.test(url) || loopback.test(url);
}

/** What a paid order's row says about its receipt until the host has a receipt document. */
export const RECEIPT_EMAILED_WORDS = "The payment provider emailed you the receipt.";

/** Whether the order's row says where its receipt is: a paid order, part or whole. */
export function showsReceiptNote(order: AccountOrder): boolean {
  return order.paid > 0 || order.state === "paid" || order.state === "refunded";
}

/** Whether a subscription is still the payer's to cancel, resume or pay (not ended). */
export function isLive(sub: AccountSubscription): boolean {
  return sub.state !== "ended" && sub.state !== "expired";
}

/**
 * Whether the Payment method section shows: the customer pays a subscription that has not ended
 * (`subscription.list` lists a customer only the ones they pay). The shells take the host's own
 * answer (`me.portal`'s `paysSubscription`, `portalSections`); a plain page may use this.
 */
export function showsPayment(subscriptions: readonly AccountSubscription[] | undefined): boolean {
  return !!subscriptions?.some(isLive);
}

/** Whether the payer may still cancel it (it does not already end), as the host reported it. */
export function canCancel(sub: AccountSubscription): boolean {
  return isLive(sub) && !sub.cancelAtPeriodEnd && sub.cancelAt === null;
}

/** Whether the payer may keep it going: cancelled at the period's end, which has not come. */
export function canResume(sub: AccountSubscription): boolean {
  return isLive(sub) && sub.cancelAtPeriodEnd;
}

/**
 * What a subscription's state means to its payer, in words, from what the host reports. Display
 * only: whether it gives access is the host's (the seam), never worked out from this.
 */
export function subscriptionStatus(sub: AccountSubscription, locale?: string): string {
  const day = (iso: string | null) => accountDay(iso, locale);
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
      return "Unpaid: update your card to keep it going";
    case "paused":
      return "Paused";
    case "incomplete":
      return sub.actionUrl
        ? "Waiting for you to confirm its first payment with your bank"
        : "Waiting for its first payment";
    case "expired":
      return "Never started: its first payment did not go through";
    case "ended":
      return `Ended${sub.endedAt ? ` on ${day(sub.endedAt)}` : ""}`;
  }
}

/** One period's price in words (`$29.00 a month`), as the host gave it. */
export function subscriptionPrice(sub: AccountSubscription, locale?: string): string {
  return `${formatMinor(sub.amount, sub.currency, locale)} a ${sub.interval}`;
}

/** What a native shell says where money is managed on the website (ADR 0714). */
export const MANAGE_ON_WEBSITE_WORDS = "Manage on the website";

/** What to tell a customer whose account call did not go through, in plain words. */
export function accountErrorWords(error: unknown): string {
  const e = error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
  if (e?.name === "NetworkError") {
    return "We could not reach the business just now. Check your connection and try again.";
  }
  if (e?.code === "invalid_input" && typeof e.message === "string") return e.message;
  if (e?.code === "not_found") return "That is no longer there. Refresh and try again.";
  return "That did not go through. Please try again.";
}

// --- Your details ------------------------------------------------------------------------------------

/** The details form, in memory until saved. */
export interface DetailsForm {
  displayName: string;
  givenName: string;
  familyName: string;
  primaryPhone: string;
}

/** The longest values the host takes (it checks again). */
export const DETAILS_MAX = { displayName: 200, givenName: 100, familyName: 100, primaryPhone: 50 };

export function detailsForm(me: Pick<AccountMe, keyof DetailsForm>): DetailsForm {
  return {
    displayName: me.displayName,
    givenName: me.givenName ?? "",
    familyName: me.familyName ?? "",
    primaryPhone: me.primaryPhone ?? "",
  };
}

/** What is wrong before saving, field by field (the host checks again). */
export function detailsProblems(
  form: DetailsForm,
): { field: keyof DetailsForm; message: string }[] {
  const problems: { field: keyof DetailsForm; message: string }[] = [];
  if (!form.displayName.trim()) problems.push({ field: "displayName", message: "Enter your name" });
  for (const field of Object.keys(DETAILS_MAX) as (keyof DetailsForm)[]) {
    if (form[field].trim().length > DETAILS_MAX[field]) {
      problems.push({ field, message: `At most ${DETAILS_MAX[field]} characters` });
    }
  }
  return problems;
}

/** The `me.update` input: only what changed, an emptied field as null. Null when nothing did. */
export function detailsInput(
  me: Pick<AccountMe, keyof DetailsForm>,
  form: DetailsForm,
): AccountDetailsInput | null {
  const input: AccountDetailsInput = {};
  const name = form.displayName.trim();
  if (name !== me.displayName) input.displayName = name;
  for (const field of ["givenName", "familyName", "primaryPhone"] as const) {
    const value = form[field].trim() || null;
    if (value !== (me[field] ?? null)) input[field] = value;
  }
  return Object.keys(input).length ? input : null;
}

// --- Birthday ----------------------------------------------------------------------------------------

/** The birthday form: a day and a month as chosen, "" for none. */
export interface BirthdayForm {
  day: string;
  month: string;
}

/** The most days each month has (29 for February). The host checks again. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The days a month can have, for a day picker: 1 to 31 until a month is chosen. */
export function birthdayDays(month: string): number[] {
  const most = DAYS_IN_MONTH[Number(month) - 1] ?? 31;
  return Array.from({ length: most }, (_, i) => i + 1);
}

/** The twelve months' names in `locale`, January first, with their numbers. */
export function birthdayMonths(locale?: string): { value: string; label: string }[] {
  const format = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  return DAYS_IN_MONTH.map((_, i) => ({
    value: String(i + 1),
    label: format.format(Date.UTC(2000, i, 1)),
  }));
}

export function birthdayForm(birthday: AccountBirthday | null): BirthdayForm {
  return birthday
    ? { day: String(birthday.day), month: String(birthday.month) }
    : { day: "", month: "" };
}

/** What is wrong before saving (the host checks again): both or neither, a day the month has. */
export function birthdayProblem(form: BirthdayForm): string | null {
  if (!form.day && !form.month) return null;
  if (!form.day || !form.month) return "Choose a day and a month, or neither";
  if (!birthdayDays(form.month).includes(Number(form.day))) return "That month has no such day";
  return null;
}

/** The `me.birthday.set` input when the form changed it (none chosen clears it), else null. */
export function birthdayInput(
  current: AccountBirthday | null,
  form: BirthdayForm,
): { birthday: AccountBirthday | null } | null {
  const next = form.day && form.month ? { day: Number(form.day), month: Number(form.month) } : null;
  const same = next?.day === current?.day && next?.month === current?.month;
  return same ? null : { birthday: next };
}

// --- Orders ------------------------------------------------------------------------------------------

/**
 * Orders a page holds. The page's lines are read in one `my.list` whose filter names every order
 * of the page, each a bound variable: kept well under D1's 100 per statement.
 */
export const ORDERS_PAGE = 20;
/** Lines read per call, and the most calls for one page's lines. */
const LINES_PAGE = 200;
const LINES_CALLS = 5;

/** One page of the customer's orders, newest first, with their lines. */
export interface OrdersPage {
  orders: AccountOrder[];
  nextCursor: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

function toLine(record: MyRecord): AccountOrderLine {
  const v = record.values;
  return {
    id: record.id,
    position: num(v.position),
    title: str(v.title) ?? "",
    quantity: num(v.quantity),
    unitPrice: num(v.unitPrice),
    total: num(v.total),
    taxAmount: num(v.taxAmount),
  };
}

function toOrder(record: MyRecord, lines: AccountOrderLine[], currency: string): AccountOrder {
  const v = record.values;
  return {
    id: record.id,
    state: (str(v.state) ?? "pending") as OrderState,
    currency: str(v.currency) ?? currency,
    total: num(v.total),
    paid: num(v.paid),
    balance: num(v.balance),
    refunded: num(v.refunded),
    pay: v.pay === "deposit" ? "deposit" : "full",
    deposit: typeof v.deposit === "number" ? v.deposit : null,
    balanceDueAt: str(v.balanceDueAt),
    expiresAt: str(v.expiresAt),
    paidAt: str(v.paidAt),
    createdAt: str(v.createdAt) ?? "",
    taxAmount: num(v.taxAmount),
    taxRefunded: num(v.taxRefunded),
    subscriptionId: str(v.subscriptionId),
    lines: lines.sort((a, b) => a.position - b.position),
    receiptUrl: null,
  };
}

/** Reads through the client the entry was given: `query(...).queryFn()` is the client's call. */
function read<N extends QueryName<AccountOperations>>(
  api: AccountClient,
  name: N,
  input: AccountOperations[N]["input"],
): Promise<AccountOperations[N]["output"]> {
  return api.query(name, input).queryFn();
}

/**
 * The customer's generated client as this entry's own reads take it (`loadOrders`), for code that
 * does not use the hooks: a plain page, a server function. It must hold `my.list`.
 */
export function accountClient(
  client: ClientHolding & { readonly operations: { readonly "my.list": unknown } },
): AccountClient {
  // The generated client's `query` is typed over all its operations; the entry reads only these.
  return client as unknown as AccountClient;
}

/**
 * One page of the signed-in customer's orders, newest first, each with its lines: their own
 * only (the seam's `my.list` on `order` and `orderLine`; a child's orders are the child's). Two
 * reads for a page, and a few more only for a page of very many lines.
 */
export async function loadOrders(api: AccountClient, cursor?: string): Promise<OrdersPage> {
  const page = await read(api, "my.list", {
    object: "order",
    sort: { field: "createdAt", direction: "desc" },
    limit: ORDERS_PAGE,
    ...(cursor ? { cursor } : {}),
  });
  const currency = page.currency ?? "";
  const ids = page.items.map((o) => o.id);
  const lines = new Map<string, AccountOrderLine[]>(ids.map((id) => [id, []]));
  let next: string | null = null;
  for (let calls = 0; ids.length && calls < LINES_CALLS; calls += 1) {
    const found: AccountOperations["my.list"]["output"] = await read(api, "my.list", {
      object: "orderLine",
      filter: { field: "orderId", op: "in", value: ids },
      limit: LINES_PAGE,
      ...(next ? { cursor: next } : {}),
    });
    for (const record of found.items)
      lines.get(str(record.values.orderId) ?? "")?.push(toLine(record));
    next = found.nextCursor;
    if (!next) break;
  }
  return {
    orders: page.items.map((o) => toOrder(o, lines.get(o.id) ?? [], currency)),
    nextCursor: page.nextCursor,
  };
}

// --- A recent sign-in (ADR 0712) ---------------------------------------------------------------------

/** Whether the host refused because the customer must sign in again first (`sign_in_again`). */
export function isSignInAgain(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "sign_in_again"
  );
}

/** What a block says when the host asks for a fresh sign-in before going on. */
export const SIGN_IN_AGAIN_WORDS =
  "For your safety, sign in again first: we email a code to the address you sign in with. Then you carry on here.";

/**
 * How a block signs the customer in again in place, as the app's sign-in does it: ask the host
 * for a code to their own sign-in address, then sign in with it (the web template's `/auth/code`
 * and `/auth/sign-in`, the mobile app's session). `confirm` answers falsy for a code that did not
 * work.
 */
export interface AccountSignIn {
  requestCode(email: string): Promise<boolean>;
  confirm(email: string, code: string): Promise<unknown>;
}

/** What a sensitive act came to: done, refused until a fresh sign-in, or failed. */
export type SensitiveOutcome<T> =
  | { kind: "done"; value: T }
  | { kind: "sign_in_again" }
  | { kind: "failed"; error: unknown };

/**
 * Runs an act the host keeps to a recent sign-in (changing the sign-in address, deleting the
 * account). A `sign_in_again` refusal is its own outcome, never a failure and never done: the block
 * shows the sign-in step, keeps what the customer was doing, and runs the act again after it.
 */
export async function sensitive<T>(act: () => Promise<T>): Promise<SensitiveOutcome<T>> {
  try {
    return { kind: "done", value: await act() };
  } catch (error) {
    return isSignInAgain(error) ? { kind: "sign_in_again" } : { kind: "failed", error };
  }
}

/** The host's `details.rule` on a refusal, wherever the client put it. */
function refusalRule(error: unknown): string | null {
  const details = (error as { details?: unknown } | null)?.details as
    | { rule?: unknown; details?: { rule?: unknown } }
    | undefined;
  const rule = details?.rule ?? details?.details?.rule;
  return typeof rule === "string" ? rule : null;
}

// --- Changing the sign-in address (ADR 0712) -----------------------------------------------------------

/** The longest address the host takes (it checks again). */
export const EMAIL_MAX = 320;

/**
 * What is wrong with a new sign-in address before asking (the host checks again), or null. Whether
 * the address can be used is never known here: the host says so only once its code is entered.
 */
export function emailChangeProblem(email: string, current: string): string | null {
  const address = email.trim();
  if (!address) return "Enter the new address";
  if (address.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return "Enter an email address, like name@example.com";
  }
  if (address.toLowerCase() === current.trim().toLowerCase()) {
    return "That is the address you sign in with now";
  }
  return null;
}

/** A six-digit code, as typed: spaces taken out (the host checks it). */
export function codeInput(typed: string): string {
  return typed.replace(/\s+/g, "");
}

/** What to tell a customer whose address change was refused: the host's own words where it gave some. */
export function emailChangeErrorWords(error: unknown): string {
  const e = error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
  if (e?.code === "rate_limited") {
    return "Too many requests just now. Wait a few minutes and try again.";
  }
  if ((e?.code === "conflict" || e?.code === "invalid_input") && typeof e.message === "string") {
    return e.message;
  }
  if (e?.code === "config") return "Changing your sign-in address is not available just now.";
  return accountErrorWords(error);
}

// --- Deleting the account (ADR 0713) -----------------------------------------------------------------

/** What a customer types to confirm deleting their account. */
export const DELETE_WORD = "DELETE";

/** Whether the host answered the preview (nothing deleted yet). */
export function isDeletePreview(
  answer: DeletePreview | DeleteDone | undefined,
): answer is DeletePreview {
  return answer?.deleted === false;
}

/**
 * The confirming call's input: only from a preview the host gave (its `expect`), and only once the
 * customer has typed the word. Null otherwise, and the block does not call: nothing is deleted
 * without the customer having been shown, in full, what it will do.
 */
export function deleteConfirmInput(
  preview: DeletePreview | null | undefined,
  typed: string,
): { confirm: true; expect: string } | null {
  if (preview?.deleted !== false || !preview.expect) return null;
  if (typed.trim().toUpperCase() !== DELETE_WORD) return null;
  return { confirm: true, expect: preview.expect };
}

/**
 * Confirms the deletion (`act`: the confirming call) as a sensitive act, and once the host has
 * deleted the account runs `forget` before answering: in the app, ending this device's session
 * and forgetting its stored tokens (`session.signOut`), so a relaunch finds no session even if
 * the person never leaves the screen. A `forget` that fails (offline) is not the deletion's
 * failure: the host has already ended every session.
 */
export async function confirmDelete(
  act: () => Promise<DeletePreview | DeleteDone>,
  forget?: () => Promise<unknown>,
): Promise<SensitiveOutcome<DeletePreview | DeleteDone>> {
  const outcome = await sensitive(act);
  if (outcome.kind === "done" && outcome.value.deleted && forget) {
    await forget().catch(() => {});
  }
  return outcome;
}

/** Whether a confirm was refused because what deleting does changed since the preview. */
export function isPreviewChanged(error: unknown): boolean {
  return (
    (error as { code?: unknown } | null)?.code === "conflict" &&
    refusalRule(error) === "preview_changed"
  );
}

/** The preview in words, every part of it, as the host answered it. Display only. */
export function deletePreviewWords(
  preview: DeletePreview,
  locale?: string,
): { ends: string[]; cancelled: string[]; left: string[]; erase: string } {
  const money = (minor: number, currency: string) => formatMinor(minor, currency, locale);
  const ends = preview.subscriptions.map((sub) => {
    const what = `${sub.title} (${money(sub.amount, sub.currency)} a ${sub.interval})`;
    const when = sub.endsAt ? ` on ${accountDay(sub.endsAt, locale)}` : "";
    switch (sub.ending) {
      case "period_end":
        return `${what} ends${when}, at the end of the period already paid for. Nothing is refunded and nothing more is charged.`;
      case "already":
        return `${what} is already set to end${when}. Nothing is refunded.`;
      default:
        return `${what} ends with the cooling off you asked for, and its refund.`;
    }
  });
  const cancelled = preview.orders.map(
    (order) =>
      `Your unpaid order of ${accountDay(order.createdAt, locale)} (${order.lines.join(", ") || "an order"}, ${money(order.total, order.currency)}) is cancelled. You were not charged for it.`,
  );
  const left: string[] = [];
  const staff = preview.leftForStaff;
  for (const record of staff.records) left.push(`${record.label}: ${record.count}`);
  if (staff.partPaidOrders) {
    left.push(
      `${staff.partPaidOrders} part-paid ${staff.partPaidOrders === 1 ? "order" : "orders"}`,
    );
  }
  if (staff.moreUnpaidOrders) {
    left.push(
      `${staff.moreUnpaidOrders} more unpaid ${staff.moreUnpaidOrders === 1 ? "order" : "orders"}`,
    );
  }
  for (const sub of staff.subscriptions) {
    left.push(
      sub.why === "end_date_later"
        ? `${sub.title}: it has an end date set later, and may charge until the business ends it`
        : sub.why === "state"
          ? `${sub.title}: it cannot be ended this way now, and may charge until the business ends it`
          : `${sub.title}: the business ends it, and it may charge until then`,
    );
  }
  if (staff.dependantsWithoutGuardian) {
    left.push(
      `${staff.dependantsWithoutGuardian} ${staff.dependantsWithoutGuardian === 1 ? "child" : "children"} linked to you will have no other parent or guardian on the account`,
    );
  }
  return {
    ends,
    cancelled,
    left,
    erase: `You are signed out everywhere at once and cannot sign in again. The business erases your personal data, or tells you by email why some of it must be kept, by ${accountDay(preview.eraseDueAt, locale)}.`,
  };
}

/** What a customer is told once the account is deleted. */
export function deletedWords(done: DeleteDone, locale?: string): string {
  return `Your account is deleted and you are signed out. The business erases your data by ${accountDay(done.eraseRequest.dueAt, locale)}.`;
}

// --- Needs your attention (ADR 0711) -------------------------------------------------------------------

/** An attention item in words: what it is, the detail, and what the button says. Display only. */
export function attentionWords(
  item: AttentionItem,
  locale?: string,
): { title: string; detail: string; action: string | null; whose: string | null } {
  const day = accountDay(item.at, locale);
  const money =
    item.amount !== null && item.currency ? formatMinor(item.amount, item.currency, locale) : "";
  const left =
    item.usesLeft === null ? "" : item.usesLeft === 1 ? "1 left" : `${item.usesLeft} left`;
  const title = item.record.title;
  const whose = item.person.self ? null : `For ${item.person.name}`;
  const words = (t: string, detail: string, action: string | null) => ({
    title: t,
    detail,
    action,
    whose,
  });
  switch (item.kind) {
    case "agree":
      return words(
        `Agree to ${title}`,
        "Read it and agree before the next booking.",
        "Read and agree",
      );
    case "card_failing":
      return words(
        `A payment for ${title} failed`,
        "Update your card so it keeps going.",
        "Update your card",
      );
    case "confirm_payment":
      return words(
        `Confirm a payment for ${title}`,
        "Your bank is waiting for you to confirm it.",
        "Confirm with your bank",
      );
    case "balance_due":
      return words(
        `The rest to pay for ${title}`,
        [money, day ? `due by ${day}` : ""].filter(Boolean).join(", "),
        "Pay the rest",
      );
    case "finish_paying":
      return words(
        `Finish paying for ${title}`,
        item.at ? `Held for you until ${accountTime(item.at, locale)}` : "Held for you for now",
        "Finish paying",
      );
    case "pass_expiring":
      return words(
        `${title} expires on ${day}`,
        left ? `${left} on it` : "Use it before then",
        "See your passes",
      );
    case "pass_used_up":
      return words(
        `${title} has none left`,
        day ? `It would have lasted until ${day}` : "Buy another to keep booking",
        "See your passes",
      );
    case "trial_ending":
      return words(
        `Your free trial of ${title} ends on ${day}`,
        money ? `Then it is ${money} each time it renews, unless you cancel` : "Then it renews",
        "See it",
      );
    case "form_to_fill":
      return words(
        `Fill in ${title}`,
        day ? `Open until ${day}` : "The business asked you to fill it in",
        "Fill it in",
      );
    default:
      return words(title, "", null);
  }
}

/**
 * Where an attention item is dealt with: a section of My account (for money owed on an order, the
 * order in Orders, `order`: the web pays it there, the app opens the website), a page, or a form
 * to open.
 */
export type AttentionTarget =
  | { kind: "section"; key: string; order?: string }
  | { kind: "page"; url: string }
  | { kind: "form"; link: string };

/** The pack an object belongs to (`memberships.pass` → `memberships`), or null for a core one. */
const packOf = (object: string): string | null =>
  object.includes(".") ? (object.split(".")[0] ?? null) : null;

/**
 * Where to send the customer for an item, among the sections shown (`shown`, the host's sections
 * the app has): agreements for a document, Payment method for a failed card, the order itself in
 * Orders for money owed on it (where the web pays it), the pack's section for its pass or its plan's trial, the provider's page for a payment
 * the bank waits on (from the subscription the host listed), the form by its link. Null where
 * nothing shown deals with it: the item is still listed. A lookup, never a rule.
 */
export function attentionTarget(
  item: AttentionItem,
  shown: readonly { key: string }[],
  subscriptions: readonly Pick<AccountSubscription, "id" | "planObject" | "actionUrl">[] = [],
): AttentionTarget | null {
  const has = (key: string) => shown.some((s) => s.key === key);
  const section = (key: string): AttentionTarget | null =>
    has(key) ? { kind: "section", key } : null;
  const packSection = (pack: string | null): AttentionTarget | null => {
    const found = pack ? shown.find((s) => s.key.startsWith(`${pack}.`)) : undefined;
    return found ? { kind: "section", key: found.key } : null;
  };
  const sub = subscriptions.find((s) => s.id === item.record.id);
  switch (item.kind) {
    case "agree":
      return section("agreements");
    case "card_failing":
      return section("payment");
    case "confirm_payment":
      // The provider's page only at an address that may be followed (`followableUrl`).
      return sub?.actionUrl && followableUrl(sub.actionUrl)
        ? { kind: "page", url: sub.actionUrl }
        : section("payment");
    case "balance_due":
    case "finish_paying":
      return has("orders") ? { kind: "section", key: "orders", order: item.record.id } : null;
    case "pass_expiring":
    case "pass_used_up":
      return packSection(packOf(item.record.object));
    case "trial_ending":
      return packSection(sub ? packOf(sub.planObject) : null) ?? section("payment");
    case "form_to_fill":
      return item.link ? { kind: "form", link: item.link } : null;
    default:
      return null;
  }
}

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery` and `useMutation`, as far as these hooks use them. */
export type AccountUseQuery = UseQuery;
export type AccountUseMutation = UseMutation;

/** The operations each hook calls (ADR 0453). */
export const ACCOUNT_HOOKS_CALL = {
  usePortal: ["me.portal"],
  useAttention: ["me.attention"],
  useChangeEmail: ["me.email.change"],
  useConfirmEmail: ["me.email.confirm"],
  useDeleteAccount: ["me.deleteAccount"],
  useMe: ["me.get"],
  useUpdateMe: ["me.update"],
  useBirthday: ["me.birthday.get"],
  useSetBirthday: ["me.birthday.set"],
  useSessions: ["me.sessions.list"],
  useRevokeSession: ["me.sessions.revoke"],
  useFamily: ["me.family"],
  useOrders: ["my.list"],
  useSubscriptions: ["subscription.list"],
  useCancelSubscription: ["subscription.cancel"],
  useResumeSubscription: ["subscription.resume"],
  useBillingPortal: ["subscription.portal"],
  useCheckoutOrder: ["order.checkout"],
  useContactChoices: ["me.contact.choices"],
  useSetContactChoices: ["me.contact.setChoices"],
} as const;

/**
 * The app's React functions, as far as these hooks use them. `useQueryClient` (TanStack Query's)
 * lets a deletion forget what the app's cache holds of the account at once (`useDeleteAccount`).
 */
export interface AccountReact {
  useQuery: AccountUseQuery;
  useMutation: AccountUseMutation;
  useQueryClient?: () => { removeQueries(): unknown };
}

/**
 * Hooks for a React or React Native app:
 * `const account = createAccountHooks({ useQuery, useMutation, useQueryClient }, api)`, with the
 * customer's generated client. The hooks it cannot back are not there.
 */
export function createAccountHooks<C extends ClientHolding>(react: AccountReact, client: C) {
  return packHooks(client, ACCOUNT_HOOKS_CALL, (api: AccountClient) => allAccountHooks(react, api));
}

function allAccountHooks(react: AccountReact, api: AccountClient) {
  const { useQuery, useMutation } = react;
  return {
    /** Which sections of My account they have, in order, and whether they pay a subscription. */
    usePortal() {
      return useQuery(api.query("me.portal", {}));
    },
    /** What needs their attention, or a child's they act for, soonest first. */
    useAttention() {
      return useQuery(api.query("me.attention", {}));
    },
    /**
     * Ask for a code at a new sign-in address (after a recent sign-in, else `sign_in_again`). The
     * address is not kept in the app's cache once the call is over.
     */
    useChangeEmail() {
      return useMutation({ ...api.mutation("me.email.change"), gcTime: 0 });
    },
    /** Finish the change with the code from the new address; the code is not kept either. */
    useConfirmEmail() {
      return useMutation({ ...api.mutation("me.email.confirm"), gcTime: 0 });
    },
    /**
     * Delete the account: with `{}` the host says what it will do; with `deleteConfirmInput`
     * (the preview's `expect`) it does that. After a recent sign-in, else `sign_in_again`. Once
     * the host has deleted it, every query the app's cache holds is forgotten at once (with the
     * app's `useQueryClient` given): nothing of the account stays in memory until the app leaves.
     */
    useDeleteAccount() {
      const cache = react.useQueryClient?.();
      const call = api.mutation("me.deleteAccount");
      return useMutation({
        ...call,
        mutationFn: async (input: AccountOperations["me.deleteAccount"]["input"]) => {
          const answer = await call.mutationFn(input);
          if (answer.deleted) cache?.removeQueries();
          return answer;
        },
        gcTime: 0,
      });
    },
    /** The signed-in customer's own Person and sign-in address. */
    useMe() {
      return useQuery(api.query("me.get", {}));
    },
    /** Change their name or phone: pass only what changed (`detailsInput`). */
    useUpdateMe() {
      return useMutation(api.mutation("me.update"));
    },
    /** Their birthday, day and month, or null (stage 53). */
    useBirthday() {
      return useQuery(api.query("me.birthday.get", {}));
    },
    /** Give, change or remove their birthday (`birthdayInput`). */
    useSetBirthday() {
      return useMutation(api.mutation("me.birthday.set"));
    },
    /** The places they are signed in. */
    useSessions() {
      return useQuery(api.query("me.sessions.list", {}));
    },
    /** Sign out one of their sessions, by its id. */
    useRevokeSession() {
      return useMutation(api.mutation("me.sessions.revoke"));
    },
    /** Who they act for and who acts for them. */
    useFamily() {
      return useQuery(api.query("me.family", {}));
    },
    /** One page of their orders with lines, newest first: pass a page's `nextCursor` for the next. */
    useOrders(cursor?: string) {
      // Keyed under my.list, so a mutation that makes my.list stale refreshes it too.
      return useQuery({
        queryKey: ["my.list", { object: "order", account: true, cursor: cursor ?? null }],
        queryFn: () => loadOrders(api, cursor),
      });
    },
    /** The subscriptions they pay, newest first (the host lists a customer only those). */
    useSubscriptions() {
      return useQuery(api.query("subscription.list", { limit: 50 }));
    },
    /** End one they pay when its period ends (web only). */
    useCancelSubscription() {
      return useMutation(api.mutation("subscription.cancel"));
    },
    /** Keep going one cancelled at the period's end, before it ends (web only). */
    useResumeSubscription() {
      return useMutation(api.mutation("subscription.resume"));
    },
    /** The provider's page for their card and past invoices (web only, never in a frame). */
    useBillingPortal() {
      return useMutation(api.mutation("subscription.portal"));
    },
    /**
     * Pay one of their own orders on the provider's page (web only, ADR 0714): the host says what
     * is charged (the order, its deposit or the rest) and answers the page's address.
     */
    useCheckoutOrder() {
      return useMutation(api.mutation("order.checkout"));
    },
    /** Their contact preferences, and each child's they act for (stage 30). */
    useContactChoices() {
      return useQuery(api.query("me.contact.choices", {}));
    },
    /** Change one or more of them (`contactToggle` makes the change for one channel). */
    useSetContactChoices() {
      return useMutation(api.mutation("me.contact.setChoices"));
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<AccountHooks, "useMe">`. */
export type AccountHooks = ReturnType<typeof allAccountHooks>;
