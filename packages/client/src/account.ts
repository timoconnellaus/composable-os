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
// Which sections a customer has is the host's (`me.portal`, `portalSections`). Later steps add to
// it: what needs the customer's attention (`me.attention`), changing the sign-in address and
// deleting the account.
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
  holderPersonId: string | null;
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

/** The operations this entry calls, as the generated client types them. */
export type AccountOperations = {
  "me.portal": { kind: "query"; input: Record<string, never>; output: AccountPortal };
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
  // A read at the host; opening the provider's page is an action here, as in Courses' hooks.
  "subscription.portal": {
    kind: "mutation";
    input: { returnUrl: string };
    output: { url: string };
  };
};

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
  { key: "devices", label: "Sign-in and devices", order: 95 },
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
 */
export function portalSections(
  portal: AccountPortal | undefined,
  packs: readonly AccountSection[] = [],
): AccountSection[] {
  if (!portal) return accountSections([], ["payment"]);
  const copied = new Set(packs.map((s) => s.key));
  return portal.sections
    .filter((s) => s.pack === null || copied.has(s.key))
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

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery` and `useMutation`, as far as these hooks use them. */
export type AccountUseQuery = UseQuery;
export type AccountUseMutation = UseMutation;

/** The operations each hook calls (ADR 0453). */
export const ACCOUNT_HOOKS_CALL = {
  usePortal: ["me.portal"],
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
} as const;

/**
 * Hooks for a React or React Native app:
 * `const account = createAccountHooks({ useQuery, useMutation }, api)`, with the customer's
 * generated client. The hooks it cannot back are not there.
 */
export function createAccountHooks<C extends ClientHolding>(
  react: { useQuery: AccountUseQuery; useMutation: AccountUseMutation },
  client: C,
) {
  return packHooks(client, ACCOUNT_HOOKS_CALL, (api: AccountClient) => allAccountHooks(react, api));
}

function allAccountHooks(
  react: { useQuery: AccountUseQuery; useMutation: AccountUseMutation },
  api: AccountClient,
) {
  const { useQuery, useMutation } = react;
  return {
    /** Which sections of My account they have, in order, and whether they pay a subscription. */
    usePortal() {
      return useQuery(api.query("me.portal", {}));
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
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<AccountHooks, "useMe">`. */
export type AccountHooks = ReturnType<typeof allAccountHooks>;
