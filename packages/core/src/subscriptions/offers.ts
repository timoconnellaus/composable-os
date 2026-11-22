// Continuation offers (stage 32a, build step 4, ADRs 0491 and 0492). A company moving its
// subscribers from another platform imports, for each one, an address and the date they have
// paid up to there. The person signs in as that address and subscribes again, free until the
// date, then charged by the provider; staff end exactly the old subscriptions the report says
// were taken.
//
// The rules, all the host's:
// - **Only the person it is for takes it.** A signed-in customer whose account address is the
//   offer's and whose Person is the offer's. Never a guest who typed the address, never staff for
//   someone, never another address of the same Person: an address proved by its sign-in code is
//   the one thing that says who the offer is for (ADR 0491).
// - **Used once.** The provider's verified event that makes the subscription marks the offer
//   taken, in its batch. While a page opened from it can be completed the offer holds that page;
//   migration 0532's trigger refuses a second, so two takes at once open one page.
// - **Expires on its date.** At the paid-up date nothing more is free, and it cannot be taken.
//   With under 48 hours left (the provider's floor for a free period until a date) it is taken
//   charged at once. Either way the plan's trial is never given instead (ADR 0492).
// - **Withdrawn by staff**, with a reason; a taken one cannot be.
// - **The import is a person's** (`subscription.offer.import`, `subscriptions:manage`, actor
//   `human`), on the import door's rules (ADR 0470): a key (the address, per plan object), a dry
//   run, a re-run changes nothing, and an offer taken or withdrawn since is a conflict, kept.
//   People come in first: an address is matched to the one live Person who has it, and an import
//   never creates one.
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import type { PaymentsTarget } from "../orders/gateway.ts";
import { holdsPermission } from "../principals.ts";
import { loadGeneralSettings } from "../settings.ts";
import { pageStatus, TRIAL_HOLD_AFTER_EXPIRY_MS } from "./trial.ts";

/**
 * The least free time an offer is taken with: Stripe's floor for `trial_end` (48 hours ahead),
 * plus a margin for the call to reach it. Less than this is charged at once.
 */
export const OFFER_MIN_FREE_MS = 48 * 3_600_000 + 15 * 60_000;

/** The most offers one import call writes. */
export const OFFER_IMPORT_MAX = 50;

export const OFFER_STATUSES = ["open", "taken", "expired", "withdrawn"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_IMPORT_OUTCOMES = [
  "created",
  "updated",
  "unchanged",
  "unmatched",
  "several_people",
  "invalid",
  "conflict",
] as const;
export type OfferImportOutcome = (typeof OFFER_IMPORT_OUTCOMES)[number];

type OfferRow = {
  id: string;
  plan_object: string;
  plan_id: string;
  email: string;
  person_id: string | null;
  free_until: string;
  reference: string | null;
  checkout_id: string | null;
  checkout_ref: string | null;
  checkout_url: string | null;
  held_until: string | null;
  subscription_id: string | null;
  taken_at: string | null;
  charged_from_start: number;
  withdrawn_at: string | null;
  withdraw_reason: string | null;
  created_at: string;
};

/** An offer's status at `now`. A page held open is still `open` (`held` says so). */
export function offerStatus(
  row: Pick<OfferRow, "subscription_id" | "withdrawn_at" | "free_until">,
  now: string,
): OfferStatus {
  if (row.subscription_id) return "taken";
  if (row.withdrawn_at) return "withdrawn";
  return row.free_until <= now ? "expired" : "open";
}

/** The report is for staff who manage subscriptions (its operations carry a read permission). */
export function requireManage(ctx: HandlerContext): void {
  if (!holdsPermission(ctx.user, ctx.permissionGrants, "subscriptions:manage")) {
    throw new ForbiddenError("The continuation offers report needs subscriptions:manage", {
      permission: "subscriptions:manage",
    });
  }
}

// --- Dates ---------------------------------------------------------------------------------------

/** The offset of `timeZone` from UTC at `at`, in milliseconds. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - at;
}

/**
 * The moment a paid-up date means: a date (`2026-12-15`) is the start of that day in the
 * organisation's time zone (the day the old platform would have charged again); a full moment
 * with its offset is itself. Null when it is neither.
 */
export function paidUpMoment(text: string, timeZone: string): string | null {
  const value = text.trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const wall = Date.UTC(y, m - 1, d);
    const check = new Date(wall);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
      return null;
    }
    // Two passes: the offset at the guess, then at the answer (a change of clocks that day).
    let at = wall - zoneOffset(wall, timeZone);
    at = wall - zoneOffset(at, timeZone);
    return new Date(at).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value))
    return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

// --- The import ----------------------------------------------------------------------------------

export interface OfferImportRow {
  email: string;
  freeUntil: string;
  reference?: string | undefined;
}

export interface OfferImportResult {
  email: string;
  outcome: OfferImportOutcome;
  offerId: string | null;
  personId: string | null;
  freeUntil: string | null;
  /**
   * What else to know: `past` (the date has passed: no free time, they subscribe charged at once
   * and get no trial), `under_48_hours` (taken now it is charged at once), `taken`, `withdrawn`,
   * `held` (a page from it is open), `another_person` (the address is now another Person's),
   * `twice` (the address is in this import twice).
   */
  note: string | null;
  /** The address's customer sign-in: `invited` now, `invited_before`, `has_account`, or null. */
  signIn: "invited" | "invited_before" | "has_account" | null;
}

const MAX_YEARS_AHEAD = 2;

/** Imports (or, with `dryRun`, checks) a batch of offers for one plan. */
export async function importOffers(
  ctx: HandlerContext,
  input: {
    plan: { object: string; id: string };
    rows: OfferImportRow[];
    dryRun: boolean;
    invite: boolean;
  },
): Promise<OfferImportResult[]> {
  const object = getObject(input.plan.object);
  if (!object?.sellable?.recurring) {
    throw new ValidationError(`${input.plan.object} is not a plan (an object sold every period)`, {
      field: "plan",
      rule: "not_a_plan",
    });
  }
  // A live record of it, as staff read it.
  await ctx.records.get(input.plan.object, input.plan.id);
  if (input.invite && !holdsPermission(ctx.user, ctx.permissionGrants, "users:manage")) {
    throw new ForbiddenError(
      "Inviting the addresses to sign in needs the users:manage permission (customer.invite's)",
      { field: "invite" },
    );
  }
  const { timezone } = await loadGeneralSettings(ctx.db);
  const { normaliseCustomerEmail, inviteCustomerStatement } = await import(
    "../customers/accounts.ts"
  );

  const addresses = input.rows.map((r) => normaliseCustomerEmail(r.email));
  const valid = [...new Set(addresses.filter((a): a is string => a !== null))];
  const owners = new Map<string, Set<string>>();
  const existing = new Map<string, OfferRow>();
  const accounts = new Set<string>();
  const invites = new Set<string>();
  if (valid.length) {
    const people = await ctx.db
      .selectFrom("core_person_emails as e")
      .innerJoin("core_person as p", "p.id", "e.person_id")
      .select(["e.email", "e.person_id"])
      .where("e.email", "in", valid)
      .where("e.live", "=", 1)
      .where("p.deleted_at", "is", null)
      .execute();
    for (const p of people) {
      owners.set(p.email, (owners.get(p.email) ?? new Set()).add(p.person_id));
    }
    for (const row of await ctx.db
      .selectFrom("core_subscription_offer")
      .selectAll()
      .where("plan_object", "=", input.plan.object)
      .where("email", "in", valid)
      .execute()) {
      existing.set(row.email, row);
    }
    for (const a of await ctx.db
      .selectFrom("core_customer")
      .select("email")
      .where("email", "in", valid)
      .execute()) {
      accounts.add(a.email);
    }
    for (const i of await ctx.db
      .selectFrom("core_customer_invite")
      .select("email")
      .where("email", "in", valid)
      .execute()) {
      invites.add(i.email);
    }
  }

  // The gatekeeper's own cap on free time is 730 days ahead.
  const latest = new Date(Date.parse(ctx.now) + MAX_YEARS_AHEAD * 365 * 86_400_000).toISOString();
  const seen = new Set<string>();
  const results: OfferImportResult[] = [];
  for (const [index, row] of input.rows.entries()) {
    const email = addresses[index] ?? null;
    const result = (
      outcome: OfferImportOutcome,
      extra: Partial<OfferImportResult> = {},
    ): OfferImportResult => ({
      email: email ?? row.email,
      outcome,
      offerId: null,
      personId: null,
      freeUntil: null,
      note: null,
      signIn: null,
      ...extra,
    });
    if (!email) {
      results.push(result("invalid", { note: "not an email address" }));
      continue;
    }
    if (seen.has(email)) {
      results.push(result("invalid", { note: "twice" }));
      continue;
    }
    seen.add(email);
    const freeUntil = paidUpMoment(row.freeUntil, timezone);
    if (!freeUntil) {
      results.push(
        result("invalid", { note: "the paid-up date is not a date (YYYY-MM-DD) or a moment" }),
      );
      continue;
    }
    if (freeUntil > latest) {
      results.push(
        result("invalid", {
          note: `the paid-up date is more than ${MAX_YEARS_AHEAD} years away`,
          freeUntil,
        }),
      );
      continue;
    }
    const reference = row.reference?.trim() ? row.reference.trim().slice(0, 200) : null;
    const people = [...(owners.get(email) ?? [])];
    if (people.length === 0) {
      results.push(result("unmatched", { freeUntil, note: "no person has this address" }));
      continue;
    }
    if (people.length > 1) {
      results.push(result("several_people", { freeUntil, note: "merge them first" }));
      continue;
    }
    const personId = people[0] as string;
    const timing =
      freeUntil <= ctx.now
        ? "past"
        : Date.parse(freeUntil) - Date.parse(ctx.now) < OFFER_MIN_FREE_MS
          ? "under_48_hours"
          : null;
    const before = existing.get(email);
    let outcome: OfferImportOutcome;
    let offerId: string;
    let note: string | null = timing;
    if (!before) {
      outcome = "created";
      offerId = newId("subscriptionOffer");
      if (!input.dryRun) {
        ctx.write(
          ctx.db.insertInto("core_subscription_offer").values({
            id: offerId,
            plan_object: input.plan.object,
            plan_id: input.plan.id,
            email,
            person_id: personId,
            free_until: freeUntil,
            reference,
            imported_by: ctx.user.id,
            created_at: ctx.now,
            updated_at: ctx.now,
          }),
        );
        ctx.recordChange({
          object: "subscription_offer",
          id: offerId,
          action: "create",
          after: { email, personId, plan: input.plan, freeUntil, reference },
        });
      }
    } else {
      offerId = before.id;
      const same =
        before.free_until === freeUntil &&
        (before.reference ?? null) === reference &&
        before.plan_id === input.plan.id &&
        before.person_id === personId;
      const status = offerStatus(before, ctx.now);
      const kept =
        status === "taken"
          ? "taken"
          : status === "withdrawn"
            ? "withdrawn"
            : before.checkout_id
              ? "held"
              : before.person_id !== personId
                ? "another_person"
                : null;
      if (same) {
        outcome = "unchanged";
        note = kept === "held" ? timing : (kept ?? timing);
      } else if (kept) {
        // Taken, withdrawn, a page open on the old terms, or the address now another Person's:
        // never overwritten, reported.
        outcome = "conflict";
        note = kept;
      } else {
        outcome = "updated";
        if (!input.dryRun) {
          ctx.write(
            ctx.db
              .updateTable("core_subscription_offer")
              .set({
                plan_id: input.plan.id,
                free_until: freeUntil,
                reference,
                updated_at: ctx.now,
              })
              .where("id", "=", before.id)
              .where("subscription_id", "is", null)
              .where("withdrawn_at", "is", null)
              .where("checkout_id", "is", null),
          );
          ctx.recordChange({
            object: "subscription_offer",
            id: before.id,
            action: "update",
            before: {
              planId: before.plan_id,
              freeUntil: before.free_until,
              reference: before.reference,
            },
            after: { planId: input.plan.id, freeUntil, reference },
          });
        }
      }
    }
    let signIn: OfferImportResult["signIn"] = accounts.has(email)
      ? "has_account"
      : invites.has(email)
        ? "invited_before"
        : null;
    const usable = outcome !== "conflict" && note !== "taken" && note !== "withdrawn";
    if (input.invite && signIn === null && usable && timing !== "past") {
      if (!input.dryRun) {
        const invite = await inviteCustomerStatement(ctx.db, email, ctx.user.id, ctx.now);
        ctx.write(invite.statement);
      }
      signIn = "invited";
    }
    results.push(result(outcome, { offerId, personId, freeUntil, note, signIn, email }));
  }
  return results;
}

// --- Taking one ----------------------------------------------------------------------------------

export type OfferTake =
  /** Open a page free until `trialEnd` (null: charged at once, under 48 hours left). */
  | { offerId: string; trialEnd: string | null; releaseCheckoutId: string | null }
  /** The caller's own page from this offer is still open: that page again. */
  | {
      open: {
        checkoutId: string;
        url: string;
        amount: number;
        freeUntil: string | null;
        expiresAt: string | null;
      };
    };

/**
 * Whether the signed-in customer (`personId`, signed in as `email`) may take offer `offerId` for
 * `plan` now, and on what terms. Throws when they may not; an offer that is not theirs is not
 * found, whatever it is.
 */
export async function prepareOfferTake(
  ctx: HandlerContext,
  take: {
    offerId: string;
    personId: string;
    email: string;
    plan: { object: string; id: string };
    target: PaymentsTarget;
  },
): Promise<OfferTake> {
  const offer = await ctx.db
    .selectFrom("core_subscription_offer")
    .selectAll()
    .where("id", "=", take.offerId)
    .executeTakeFirst();
  // Tied to an address: the account's (proved by its sign-in code) and its Person. Anyone else's
  // offer is not found, so a caller learns nothing of who has one.
  if (!offer || offer.email !== take.email || offer.person_id !== take.personId) {
    throw new NotFoundError("subscription_offer", take.offerId);
  }
  if (offer.plan_object !== take.plan.object || offer.plan_id !== take.plan.id) {
    throw new ValidationError("This offer is for another plan", {
      field: "plan",
      rule: "offer_plan",
    });
  }
  if (offer.subscription_id) {
    throw new ConflictError("You have taken this offer: your subscription is running", {
      rule: "offer_taken",
    });
  }
  if (offer.withdrawn_at) {
    throw new ConflictError("This offer was withdrawn", { rule: "offer_withdrawn" });
  }
  let release: string | null = null;
  if (offer.checkout_id && offer.checkout_ref) {
    const status = await pageStatus(ctx, take.target, offer.checkout_ref);
    if (status === "complete") {
      throw new ConflictError(
        "You have taken this offer: the payment provider is confirming your subscription",
        { rule: "offer_taken" },
      );
    }
    if (status === null) {
      throw new ConflictError(
        "We could not check your earlier checkout with the payment provider just now. Try again in a few minutes.",
        { rule: "offer_unconfirmed" },
      );
    }
    if (status === "open" && offer.checkout_url) {
      // Only its own person ever opens a page from an offer, so the page goes back to them, with
      // the terms it was opened with.
      const checkout = await ctx.db
        .selectFrom("core_subscription_checkout")
        .select(["amount", "trial_end"])
        .where("id", "=", offer.checkout_id)
        .executeTakeFirst();
      if (checkout) {
        return {
          open: {
            checkoutId: offer.checkout_id,
            url: offer.checkout_url,
            amount: checkout.amount,
            freeUntil: checkout.trial_end ?? null,
            expiresAt: offer.held_until
              ? new Date(Date.parse(offer.held_until) - TRIAL_HOLD_AFTER_EXPIRY_MS).toISOString()
              : null,
          },
        };
      }
    }
    // Expired uncompleted at the provider: released in the take's batch.
    release = offer.checkout_id;
  }
  if (offer.free_until <= ctx.now) {
    throw new ConflictError(
      `Your free time ended on ${offer.free_until.slice(0, 10)}: subscribe without the offer, charged from today`,
      { rule: "offer_expired" },
    );
  }
  const left = Date.parse(offer.free_until) - Date.parse(ctx.now);
  return {
    offerId: offer.id,
    trialEnd: left >= OFFER_MIN_FREE_MS ? offer.free_until : null,
    releaseCheckoutId: release,
  };
}

/** The statements that hold `offerId` for the page just opened (refused by 0532's trigger). */
export function holdOfferStatements(
  ctx: HandlerContext,
  hold: {
    offerId: string;
    releaseCheckoutId: string | null;
    checkoutId: string;
    checkoutRef: string;
    url: string;
    expiresAt: string | null;
  },
) {
  const expires = hold.expiresAt ?? new Date(Date.parse(ctx.now) + 24 * 3_600_000).toISOString();
  return [
    ...(hold.releaseCheckoutId
      ? [
          ctx.db
            .updateTable("core_subscription_offer")
            .set({ checkout_id: null, checkout_ref: null, checkout_url: null, held_until: null })
            .where("id", "=", hold.offerId)
            .where("checkout_id", "=", hold.releaseCheckoutId),
        ]
      : []),
    ctx.db
      .updateTable("core_subscription_offer")
      .set({
        checkout_id: hold.checkoutId,
        checkout_ref: hold.checkoutRef,
        checkout_url: hold.url,
        held_until: new Date(Date.parse(expires) + TRIAL_HOLD_AFTER_EXPIRY_MS).toISOString(),
        updated_at: ctx.now,
      })
      .where("id", "=", hold.offerId),
  ];
}

// --- Reading -------------------------------------------------------------------------------------

/** What a signed-in customer reads of their own open offers. */
export interface MyOffer {
  id: string;
  planObject: string;
  planId: string;
  /** Free until this moment, then charged. */
  freeUntil: string;
  /** Under 48 hours left: taking it now is charged at once. */
  chargedNow: boolean;
}

/** The signed-in customer's own offers they can still take (their address, their Person). */
export async function myOffers(ctx: HandlerContext): Promise<MyOffer[]> {
  const caller = ctx.principal;
  if (caller.kind !== "customer") {
    throw new ValidationError("A continuation offer is read by its own person, signed in", {
      rule: "customer",
    });
  }
  const account = await ctx.db
    .selectFrom("core_customer")
    .select("email")
    .where("id", "=", caller.customerId)
    .executeTakeFirst();
  if (!account) return [];
  const rows = await ctx.db
    .selectFrom("core_subscription_offer")
    .selectAll()
    .where("person_id", "=", caller.personId)
    .where("email", "=", account.email)
    .where("subscription_id", "is", null)
    .where("withdrawn_at", "is", null)
    .where("free_until", ">", ctx.now)
    .orderBy("free_until")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    planObject: r.plan_object,
    planId: r.plan_id,
    freeUntil: r.free_until,
    chargedNow: Date.parse(r.free_until) - Date.parse(ctx.now) < OFFER_MIN_FREE_MS,
  }));
}

/** One offer as staff read it in the report. */
export interface OfferReportItem {
  id: string;
  email: string;
  personId: string | null;
  personName: string | null;
  planObject: string;
  planId: string;
  reference: string | null;
  freeUntil: string;
  status: OfferStatus;
  /** A page opened from it is open at the provider (it may still be completed). */
  held: boolean;
  takenAt: string | null;
  subscriptionId: string | null;
  subscriptionState: string | null;
  /** When the new subscription starts charging: its free time's end, or its start if none. */
  chargesFrom: string | null;
  chargedFromStart: boolean;
  /** Not taken, but the person subscribed to the plan another way (charged, no free time). */
  subscribedWithout: { id: string; state: string; createdAt: string } | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
  createdAt: string;
}

const RUNNING_STATES = ["trialing", "active", "past_due"] as const;

/**
 * A page of offers for the report, by address. `status` filters: taken (the company ends these
 * old subscriptions), open (to chase before their date), expired, withdrawn.
 */
export async function listOffers(
  ctx: HandlerContext,
  input: {
    status?: OfferStatus | undefined;
    planObject?: string | undefined;
    cursor?: string;
    limit: number;
  },
): Promise<{
  items: OfferReportItem[];
  nextCursor: string | null;
  counts: Record<OfferStatus, number>;
}> {
  let after: { e: string; i: string } | null = null;
  if (input.cursor) {
    try {
      after = JSON.parse(atob(input.cursor)) as { e: string; i: string };
    } catch {
      throw new ValidationError("Not a cursor this list gave", { field: "cursor" });
    }
  }
  const base = () => {
    let q = ctx.db.selectFrom("core_subscription_offer as o");
    if (input.planObject) q = q.where("o.plan_object", "=", input.planObject);
    return q;
  };
  let q = base()
    .leftJoin("core_subscription as s", "s.id", "o.subscription_id")
    .leftJoin("core_person as p", "p.id", "o.person_id")
    .selectAll("o")
    .select([
      "s.state as s_state",
      "s.trial_end as s_trial_end",
      "s.created_at as s_created_at",
      "p.display_name as person_name",
    ]);
  switch (input.status) {
    case "taken":
      q = q.where("o.subscription_id", "is not", null);
      break;
    case "withdrawn":
      q = q.where("o.subscription_id", "is", null).where("o.withdrawn_at", "is not", null);
      break;
    case "expired":
      q = q
        .where("o.subscription_id", "is", null)
        .where("o.withdrawn_at", "is", null)
        .where("o.free_until", "<=", ctx.now);
      break;
    case "open":
      q = q
        .where("o.subscription_id", "is", null)
        .where("o.withdrawn_at", "is", null)
        .where("o.free_until", ">", ctx.now);
      break;
    default:
      break;
  }
  if (after) {
    const { e, i } = after;
    q = q.where((eb) =>
      eb.or([eb("o.email", ">", e), eb.and([eb("o.email", "=", e), eb("o.id", ">", i)])]),
    );
  }
  const rows = await q
    .orderBy("o.email")
    .orderBy("o.id")
    .limit(input.limit + 1)
    .execute();
  const page = rows.slice(0, input.limit);
  // For offers not taken: the person's own running subscription to the plan object, made another
  // way (after the date, or without the offer).
  const untaken = page.filter((r) => !r.subscription_id && r.person_id);
  const others = new Map<string, { id: string; state: string; createdAt: string }>();
  if (untaken.length) {
    const subs = await ctx.db
      .selectFrom("core_subscription")
      .select(["id", "state", "created_at", "holder_person_id", "plan_object"])
      .where(
        "holder_person_id",
        "in",
        untaken.map((r) => r.person_id as string),
      )
      .where("state", "in", [...RUNNING_STATES])
      .orderBy("created_at", "desc")
      .execute();
    for (const s of subs) {
      const key = `${s.holder_person_id}|${s.plan_object}`;
      if (!others.has(key)) others.set(key, { id: s.id, state: s.state, createdAt: s.created_at });
    }
  }
  const items: OfferReportItem[] = page.map((r) => {
    const status = offerStatus(r, ctx.now);
    const chargedFromStart = r.charged_from_start === 1;
    return {
      id: r.id,
      email: r.email,
      personId: r.person_id,
      personName: r.person_name ?? null,
      planObject: r.plan_object,
      planId: r.plan_id,
      reference: r.reference,
      freeUntil: r.free_until,
      status,
      held: status === "open" && r.checkout_id !== null,
      takenAt: r.taken_at,
      subscriptionId: r.subscription_id,
      subscriptionState: r.s_state ?? null,
      chargesFrom: r.subscription_id
        ? chargedFromStart
          ? (r.s_created_at ?? r.taken_at)
          : (r.s_trial_end ?? r.free_until)
        : null,
      chargedFromStart,
      subscribedWithout:
        !r.subscription_id && r.person_id
          ? (others.get(`${r.person_id}|${r.plan_object}`) ?? null)
          : null,
      withdrawnAt: r.withdrawn_at,
      withdrawReason: r.withdraw_reason,
      createdAt: r.created_at,
    };
  });
  const last = page.at(-1);
  const counts = Object.fromEntries(OFFER_STATUSES.map((s) => [s, 0])) as Record<
    OfferStatus,
    number
  >;
  for (const r of await base()
    .select(["o.subscription_id", "o.withdrawn_at", "o.free_until"])
    .execute()) {
    counts[offerStatus(r, ctx.now)] += 1;
  }
  return {
    items,
    nextCursor:
      rows.length > input.limit && last
        ? btoa(JSON.stringify({ e: last.email, i: last.id }))
        : null,
    counts,
  };
}

const CSV_COLUMNS = [
  "email",
  "name",
  "reference",
  "paid_up_to",
  "status",
  "taken_at",
  "charges_from",
  "charged_from_start",
  "subscription",
  "subscription_state",
  "subscribed_without_offer",
  "withdrawn_at",
  "withdraw_reason",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // A cell a spreadsheet would read as a formula is written as text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The report as CSV: every offer (or those of `status`), by address. */
export async function exportOffers(
  ctx: HandlerContext,
  input: { status?: OfferStatus | undefined; planObject?: string | undefined },
): Promise<{ filename: string; csv: string; rowCount: number }> {
  const lines = [CSV_COLUMNS.join(",")];
  let cursor: string | undefined;
  let rowCount = 0;
  do {
    const page = await listOffers(ctx, { ...input, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const o of page.items) {
      rowCount += 1;
      lines.push(
        [
          o.email,
          o.personName,
          o.reference,
          o.freeUntil,
          o.status,
          o.takenAt,
          o.chargesFrom,
          o.subscriptionId ? (o.chargedFromStart ? "yes" : "no") : "",
          o.subscriptionId,
          o.subscriptionState,
          o.subscribedWithout ? `${o.subscribedWithout.id} (${o.subscribedWithout.state})` : "",
          o.withdrawnAt,
          o.withdrawReason,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return {
    filename: `continuation-offers-${input.status ?? "all"}-${ctx.now.slice(0, 10)}.csv`,
    csv: `${lines.join("\n")}\n`,
    rowCount,
  };
}

// --- Withdrawing ---------------------------------------------------------------------------------

/** Withdraws an offer not yet taken. A page already open from it may still be completed. */
export async function withdrawOffer(
  ctx: HandlerContext,
  id: string,
  reason: string,
): Promise<{ id: string; pageOpen: boolean }> {
  const offer = await ctx.db
    .selectFrom("core_subscription_offer")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!offer) throw new NotFoundError("subscription_offer", id);
  if (offer.subscription_id) {
    throw new ConflictError(
      "This offer was taken: its subscription is running. End the subscription instead.",
      { rule: "offer_taken", subscription: offer.subscription_id },
    );
  }
  if (offer.withdrawn_at) {
    throw new ConflictError("This offer is already withdrawn", { rule: "offer_withdrawn" });
  }
  ctx.write(
    ctx.db
      .updateTable("core_subscription_offer")
      .set({
        withdrawn_at: ctx.now,
        withdrawn_by: ctx.user.id,
        withdraw_reason: reason,
        updated_at: ctx.now,
      })
      .where("id", "=", id)
      .where("subscription_id", "is", null),
  );
  ctx.recordChange({
    object: "subscription_offer",
    id,
    action: "update",
    before: { withdrawnAt: null },
    after: { withdrawnAt: ctx.now, reason },
  });
  return { id, pageOpen: offer.checkout_id !== null };
}
