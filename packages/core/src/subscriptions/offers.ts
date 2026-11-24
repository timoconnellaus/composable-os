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
// - **Every change is from a current read.** Each write sets the offer's `version` one above the
//   version it read; migration 0532's trigger refuses any other, so an import, a withdrawal or a
//   take that read the offer before another change commits nothing (`offer_changed`, try again).
// - **Expires on its date.** At the paid-up date nothing more is free, and it cannot be taken.
//   With under 48 hours left (the provider's floor for a free period until a date) it is taken
//   charged at once (ADR 0492).
// - **Withdrawn by staff**, with a reason; a taken one cannot be. A withdrawn offer stays as it
//   was; staff may reissue the address a fresh one, only by asking for it (`reissue`).
// - **The import is a person's** (`subscription.offer.import`, `subscriptions:manage`, actor
//   `human`), on the import door's rules (ADR 0470): a key (the address, per plan object), a dry
//   run, a re-run changes nothing, and an offer taken or withdrawn since is a conflict, kept.
//   People come in first: an address is matched to the one live Person who has it, and an import
//   never creates one.
// - **The offer follows its plan.** If its plan record is no longer live, and the plan object has
//   exactly one live record, the offer is shown and taken on that one; otherwise the member is
//   told to ask the company and staff are told (the minute cron, `sweepOffers`).
import type { CrmDb } from "@composable-os/db";
import { sql } from "kysely";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import { type PaymentsTarget, paymentsTarget } from "../orders/gateway.ts";
import { holdsPermission } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import { loadGeneralSettings } from "../settings.ts";
import { realWallClock, zoneOffset } from "../time/local.ts";
import { type RecordAccess, recordAccess } from "../visibility/records.ts";
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

/** What the provider says of a page an offer holds, as the report shows it. */
export const OFFER_PAGE_STATES = ["open", "completing", "unconfirmed"] as const;
export type OfferPage = (typeof OFFER_PAGE_STATES)[number];

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
  version: number;
};

/** An offer's status at `now`. A page held open is still `open` (`page` says so). */
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

/** The provider's word on the pages `rows` hold, by offer id (null: it could not be asked). */
async function heldPages(
  ctx: HandlerContext,
  rows: readonly Pick<OfferRow, "id" | "checkout_ref" | "subscription_id">[],
): Promise<Map<string, "open" | "complete" | "expired" | null>> {
  const out = new Map<string, "open" | "complete" | "expired" | null>();
  const held = rows.filter((r) => r.checkout_ref && !r.subscription_id);
  if (!held.length) return out;
  let target: PaymentsTarget | null = null;
  try {
    target = await paymentsTarget(ctx.db);
  } catch {
    target = null;
  }
  for (const r of held) {
    out.set(r.id, target ? await pageStatus(ctx, target, r.checkout_ref as string) : null);
  }
  return out;
}

/** The statement that releases `row`'s page (the provider said it expired), at `version`. */
function releaseStatement(
  ctx: Pick<HandlerContext, "db">,
  row: Pick<OfferRow, "id" | "checkout_id">,
  version: number,
) {
  return ctx.db
    .updateTable("core_subscription_offer")
    .set({
      checkout_id: null,
      checkout_ref: null,
      checkout_url: null,
      held_until: null,
      version,
    })
    .where("id", "=", row.id)
    .where("checkout_id", "=", row.checkout_id);
}

// --- The plan an offer is taken on ---------------------------------------------------------------

/**
 * The live plan record an offer is taken on, as `records` (the caller's view) sees it: its own,
 * or, when that is no longer live, the plan object's only live record. `askUs` when there is none
 * or more than one: the member is told to ask the company, and staff are told.
 */
export async function offerPlan(
  records: RecordAccess,
  planObject: string,
  planId: string,
): Promise<{ planId: string } | { askUs: true }> {
  try {
    await records.get(planObject, planId);
    return { planId };
  } catch (error) {
    if ((error as { code?: unknown }).code !== "not_found") throw error;
  }
  const live = await records.list(planObject, { limit: 2 });
  return live.items.length === 1
    ? { planId: (live.items[0] as { id: string }).id }
    : { askUs: true };
}

// --- Dates ---------------------------------------------------------------------------------------

const MOMENT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * The moment a paid-up date means: a date (`2026-12-15`) is the start of that day in the
 * organisation's time zone (the day the old platform would have charged again); a full moment
 * with its offset is itself. Null when it is neither, or names a day or time that does not exist
 * (`2026-02-30`, `T24:00`, an offset past 14 hours): never rolled forward into extra free days.
 */
export function paidUpMoment(text: string, timeZone: string): string | null {
  const value = text.trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    if (!realWallClock(y, m, d)) return null;
    const wall = Date.UTC(y, m - 1, d);
    // Two passes: the offset at the guess, then at the answer (a change of clocks that day).
    let at = wall - zoneOffset(wall, timeZone);
    at = wall - zoneOffset(at, timeZone);
    return new Date(at).toISOString();
  }
  const moment = MOMENT.exec(value);
  if (!moment) return null;
  const [y, m, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(moment[i]));
  const s = moment[6] ? Number(moment[6]) : 0;
  if (!realWallClock(y as number, m as number, d as number, h, mi, s)) return null;
  let offset = 0;
  if (moment[8] !== "Z") {
    const [oh, om] = [Number(moment[10]), Number(moment[11])];
    if (oh > 14 || om > 59) return null;
    offset = (moment[9] === "-" ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  const fraction = moment[7] ? Math.floor(Number(moment[7]) * 1000) : 0;
  const at = Date.UTC(y as number, (m as number) - 1, d as number, h, mi, s) + fraction - offset;
  return new Date(at).toISOString();
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
   * What else to know: `past` (the date has passed: it cannot be taken; they subscribe as anyone
   * does), `under_48_hours` (taken now it is charged at once), `taken`, `withdrawn` (run with
   * `reissue` for a fresh offer), `reissued` (a fresh offer beside a withdrawn one), `held` (a
   * page from it is open at the provider), `held_unconfirmed` (the provider could not say whether
   * its page is still open), `completing` (its page was completed; the subscription is being
   * confirmed), `another_person` (the address is now another Person's), `twice` (the address is
   * in this import twice).
   */
  note: string | null;
  /**
   * The address's customer sign-in: `invited` now, `invited_before`, `has_account`,
   * `invite_refused` (the address cannot be invited, an erased person's), or null.
   */
  signIn: "invited" | "invited_before" | "has_account" | "invite_refused" | null;
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
    reissue: boolean;
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
  // The address's offer that is not withdrawn, and its latest withdrawn one.
  const existing = new Map<string, OfferRow>();
  const withdrawn = new Map<string, OfferRow>();
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
      .orderBy("created_at")
      .execute()) {
      if (row.withdrawn_at) withdrawn.set(row.email, row);
      else existing.set(row.email, row);
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
  // A held page is held only while the provider says it can be completed: one it says expired is
  // released here, so an abandoned checkout never stops a correction.
  const pages = await heldPages(ctx, [...existing.values()]);

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
        result("invalid", {
          note: "the paid-up date is not a real date (YYYY-MM-DD) or moment with its offset",
        }),
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
    const prior = withdrawn.get(email);
    let outcome: OfferImportOutcome;
    let offerId: string;
    let note: string | null = timing;
    if (!before && prior && !input.reissue) {
      // Withdrawn stays final for that offer; a fresh one only when staff ask for it.
      outcome = "conflict";
      offerId = prior.id;
      note = "withdrawn";
    } else if (!before) {
      outcome = "created";
      offerId = newId("subscriptionOffer");
      if (prior) note = timing ?? "reissued";
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
        if (prior) {
          ctx.write(
            ctx.db
              .updateTable("core_subscription_offer")
              .set({ reissued_as: offerId, version: prior.version + 1 })
              .where("id", "=", prior.id),
          );
        }
        ctx.recordChange({
          object: "subscription_offer",
          id: offerId,
          action: "create",
          after: {
            email,
            personId,
            plan: input.plan,
            freeUntil,
            reference,
            ...(prior ? { reissuedFrom: prior.id } : {}),
          },
        });
      }
    } else {
      offerId = before.id;
      let version = before.version;
      const page = before.checkout_id ? pages.get(before.id) : undefined;
      if (page === "expired") {
        if (!input.dryRun) {
          version += 1;
          ctx.write(releaseStatement(ctx, before, version));
        }
      }
      const same =
        before.free_until === freeUntil &&
        (before.reference ?? null) === reference &&
        before.plan_id === input.plan.id &&
        before.person_id === personId;
      const status = offerStatus(before, ctx.now);
      const kept =
        status === "taken"
          ? "taken"
          : page === "complete"
            ? "completing"
            : page === "open"
              ? "held"
              : page === null
                ? "held_unconfirmed"
                : before.person_id !== personId
                  ? "another_person"
                  : null;
      if (same) {
        outcome = "unchanged";
        note = kept === "taken" || kept === "completing" ? kept : timing;
      } else if (kept) {
        // Taken, being confirmed, a page open (or not known to be closed) on the old terms, or
        // the address now another Person's: never overwritten, reported.
        outcome = "conflict";
        note = kept;
      } else {
        outcome = "updated";
        if (!input.dryRun) {
          // From this read: refused (the whole call) if the offer changed since.
          ctx.write(
            ctx.db
              .updateTable("core_subscription_offer")
              .set({
                plan_id: input.plan.id,
                free_until: freeUntil,
                reference,
                updated_at: ctx.now,
                version: version + 1,
              })
              .where("id", "=", before.id),
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
    const usable = outcome !== "conflict" && note !== "taken" && note !== "completing";
    if (input.invite && signIn === null && usable && timing !== "past") {
      // Checked in the dry run too, so a real run never fails on an address that cannot be
      // invited: that row is reported, and the rest go ahead.
      try {
        const invite = await inviteCustomerStatement(ctx.db, email, ctx.user.id, ctx.now);
        if (!input.dryRun) {
          ctx.write(invite.statement);
          ctx.recordChange({
            object: "customer_invite",
            id: invite.email,
            action: "create",
            after: { email: invite.email, invitedBy: ctx.user.id },
          });
        }
        signIn = "invited";
      } catch {
        signIn = "invite_refused";
      }
    }
    results.push(result(outcome, { offerId, personId, freeUntil, note, signIn, email }));
  }
  return results;
}

// --- Taking one ----------------------------------------------------------------------------------

export type OfferTake =
  /** Open a page free until `trialEnd` (null: charged at once, under 48 hours left). */
  | {
      offerId: string;
      trialEnd: string | null;
      releaseCheckoutId: string | null;
      /** The offer's version as read: the take commits only if it is still this. */
      version: number;
    }
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
  if (offer.plan_object !== take.plan.object) {
    throw new ValidationError("This offer is for another plan", {
      field: "plan",
      rule: "offer_plan",
    });
  }
  if (offer.plan_id !== take.plan.id) {
    // Its own plan record, or the one live record it follows to (the caller's view).
    const plan = await offerPlan(ctx.records, offer.plan_object, offer.plan_id);
    if (!("planId" in plan) || plan.planId !== take.plan.id) {
      throw new ValidationError("This offer is for another plan", {
        field: "plan",
        rule: "offer_plan",
      });
    }
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
    version: offer.version,
  };
}

/**
 * The statements that hold `offerId` for the page just opened. Refused by migration 0532's
 * triggers, and the whole take with them, if another page holds it, it was taken or withdrawn, or
 * it changed at all (its date, its plan) since the take read it at `version`.
 */
export function holdOfferStatements(
  ctx: HandlerContext,
  hold: {
    offerId: string;
    releaseCheckoutId: string | null;
    version: number;
    checkoutId: string;
    checkoutRef: string;
    url: string;
    expiresAt: string | null;
  },
) {
  const expires = hold.expiresAt ?? new Date(Date.parse(ctx.now) + 24 * 3_600_000).toISOString();
  let version = hold.version;
  const release = hold.releaseCheckoutId
    ? [releaseStatement(ctx, { id: hold.offerId, checkout_id: hold.releaseCheckoutId }, ++version)]
    : [];
  return [
    ...release,
    ctx.db
      .updateTable("core_subscription_offer")
      .set({
        checkout_id: hold.checkoutId,
        checkout_ref: hold.checkoutRef,
        checkout_url: hold.url,
        held_until: new Date(Date.parse(expires) + TRIAL_HOLD_AFTER_EXPIRY_MS).toISOString(),
        updated_at: ctx.now,
        version: version + 1,
      })
      .where("id", "=", hold.offerId),
  ];
}

// --- Reading -------------------------------------------------------------------------------------

/** What a signed-in customer reads of their own open offers. */
export interface MyOffer {
  id: string;
  planObject: string;
  /** The live plan record it is taken on (its own, or the one it follows to). */
  planId: string;
  /** Free until this moment, then charged. */
  freeUntil: string;
  /** Under 48 hours left: taking it now is charged at once. */
  chargedNow: boolean;
  /** No single live plan to take it on: the member asks the company (staff are told). */
  askUs: boolean;
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
  const out: MyOffer[] = [];
  for (const r of rows) {
    const plan = await offerPlan(ctx.records, r.plan_object, r.plan_id);
    out.push({
      id: r.id,
      planObject: r.plan_object,
      planId: "planId" in plan ? plan.planId : r.plan_id,
      freeUntil: r.free_until,
      chargedNow: Date.parse(r.free_until) - Date.parse(ctx.now) < OFFER_MIN_FREE_MS,
      askUs: !("planId" in plan),
    });
  }
  return out;
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
  /**
   * A page opened from it, as the provider says now: `open` (it may still be completed),
   * `completing` (completed; the subscription is being confirmed), `unconfirmed` (the provider
   * could not be asked). Null: none, or it expired.
   */
  page: OfferPage | null;
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
  /** A withdrawn offer staff reissued: the fresh offer's id. */
  reissuedAs: string | null;
  createdAt: string;
}

const RUNNING_STATES = ["trialing", "active", "past_due"] as const;

/** A cursor this list gave: the last row's address and id. */
function readCursor(cursor: string): { e: string; i: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(cursor));
  } catch {
    parsed = null;
  }
  const c = parsed as { e?: unknown; i?: unknown } | null;
  if (
    !c ||
    typeof c !== "object" ||
    typeof c.e !== "string" ||
    typeof c.i !== "string" ||
    Object.keys(c).length !== 2
  ) {
    throw new ValidationError("Not a cursor this list gave", { field: "cursor" });
  }
  return { e: c.e, i: c.i };
}

/** Every status's total, by one aggregate query. */
async function offerCounts(
  ctx: HandlerContext,
  planObject: string | undefined,
): Promise<Record<OfferStatus, number>> {
  let q = ctx.db
    .selectFrom("core_subscription_offer")
    .select([
      sql<number>`coalesce(sum(subscription_id IS NOT NULL), 0)`.as("taken"),
      sql<number>`coalesce(sum(subscription_id IS NULL AND withdrawn_at IS NOT NULL), 0)`.as(
        "withdrawn",
      ),
      sql<number>`coalesce(sum(subscription_id IS NULL AND withdrawn_at IS NULL AND free_until <= ${ctx.now}), 0)`.as(
        "expired",
      ),
      sql<number>`coalesce(sum(subscription_id IS NULL AND withdrawn_at IS NULL AND free_until > ${ctx.now}), 0)`.as(
        "open",
      ),
    ]);
  if (planObject) q = q.where("plan_object", "=", planObject);
  const row = await q.executeTakeFirst();
  return {
    open: Number(row?.open ?? 0),
    taken: Number(row?.taken ?? 0),
    expired: Number(row?.expired ?? 0),
    withdrawn: Number(row?.withdrawn ?? 0),
  };
}

/**
 * A page of offers for the report, by address. `status` filters: taken (the company ends these
 * old subscriptions), open (to chase before their date), expired, withdrawn. `counts: false`
 * leaves out the totals (the export's pages).
 */
export async function listOffers(
  ctx: HandlerContext,
  input: {
    status?: OfferStatus | undefined;
    planObject?: string | undefined;
    cursor?: string | undefined;
    limit: number;
    counts?: boolean;
    /** Ask the provider about held pages (the report); the export leaves it out. */
    pages?: boolean;
  },
): Promise<{
  items: OfferReportItem[];
  nextCursor: string | null;
  counts: Record<OfferStatus, number>;
}> {
  const after = input.cursor ? readCursor(input.cursor) : null;
  let q = ctx.db
    .selectFrom("core_subscription_offer as o")
    .leftJoin("core_subscription as s", "s.id", "o.subscription_id")
    .leftJoin("core_person as p", "p.id", "o.person_id")
    .selectAll("o")
    .select([
      "s.state as s_state",
      "s.trial_end as s_trial_end",
      "s.created_at as s_created_at",
      "p.display_name as person_name",
    ]);
  if (input.planObject) q = q.where("o.plan_object", "=", input.planObject);
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
      // One bound parameter: a page holds up to 200 offers, past D1's 100 a statement.
      .where("holder_person_id", "in", jsonList(untaken.map((r) => r.person_id as string)))
      .where("state", "in", [...RUNNING_STATES])
      .orderBy("created_at", "desc")
      .execute();
    for (const s of subs) {
      const key = `${s.holder_person_id}|${s.plan_object}`;
      if (!others.has(key)) others.set(key, { id: s.id, state: s.state, createdAt: s.created_at });
    }
  }
  const asked =
    input.pages === false
      ? new Map<string, "open" | "complete" | "expired" | null>()
      : await heldPages(
          ctx,
          page.filter((r) => offerStatus(r, ctx.now) === "open"),
        );
  const items: OfferReportItem[] = page.map((r) => {
    const status = offerStatus(r, ctx.now);
    const chargedFromStart = r.charged_from_start === 1;
    const said = r.checkout_id && status === "open" ? asked.get(r.id) : undefined;
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
      page:
        said === "open"
          ? "open"
          : said === "complete"
            ? "completing"
            : said === null
              ? "unconfirmed"
              : null,
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
      reissuedAs: r.reissued_as,
      createdAt: r.created_at,
    };
  });
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > input.limit && last
        ? btoa(JSON.stringify({ e: last.email, i: last.id }))
        : null,
    counts:
      input.counts === false
        ? { open: 0, taken: 0, expired: 0, withdrawn: 0 }
        : await offerCounts(ctx, input.planObject),
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
  "reissued_as",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // A cell a spreadsheet would read as a formula is written as text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The report as CSV: every offer (or those of `status`), by address, a page at a time. */
export async function exportOffers(
  ctx: HandlerContext,
  input: { status?: OfferStatus | undefined; planObject?: string | undefined },
): Promise<{ filename: string; csv: string; rowCount: number }> {
  const lines = [CSV_COLUMNS.join(",")];
  let cursor: string | undefined;
  let rowCount = 0;
  do {
    const page = await listOffers(ctx, {
      ...input,
      limit: 200,
      counts: false,
      pages: false,
      ...(cursor ? { cursor } : {}),
    });
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
          o.reissuedAs,
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

/**
 * Withdraws an offer not yet taken, from this read of it (refused, and nothing recorded, if it
 * changed since: `offer_changed`). A page the provider says is still open (or cannot say) may
 * still be completed; one it says expired is released.
 */
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
  const page = offer.checkout_id ? (await heldPages(ctx, [offer])).get(offer.id) : undefined;
  let version = offer.version;
  if (page === "expired") {
    version += 1;
    ctx.write(releaseStatement(ctx, offer, version));
  }
  ctx.write(
    ctx.db
      .updateTable("core_subscription_offer")
      .set({
        withdrawn_at: ctx.now,
        withdrawn_by: ctx.user.id,
        withdraw_reason: reason,
        updated_at: ctx.now,
        version: version + 1,
      })
      .where("id", "=", id),
  );
  ctx.recordChange({
    object: "subscription_offer",
    id,
    action: "update",
    before: { withdrawnAt: null },
    after: { withdrawnAt: ctx.now, reason },
  });
  return { id, pageOpen: page !== undefined && page !== "expired" };
}

// --- Offers with no plan to take them on ---------------------------------------------------------

/**
 * The minute cron's look at open offers whose plan record is no longer live and whose plan object
 * has no single live record to follow to: staff are told once per plan record, and the member
 * sees "ask us" (`myOffers`). Read as the public reads plans.
 */
export async function sweepOffers(crm: CrmDb, now: string): Promise<{ plansGone: number }> {
  const db = crm.query;
  const plans = await db
    .selectFrom("core_subscription_offer")
    .select(["plan_object", "plan_id", sql<number>`count(*)`.as("n")])
    .where("subscription_id", "is", null)
    .where("withdrawn_at", "is", null)
    .where("free_until", ">", now)
    .groupBy(["plan_object", "plan_id"])
    .limit(50)
    .execute();
  const records = recordAccess({ db, principal: { kind: "public" } });
  const statements = [];
  let gone = 0;
  for (const p of plans) {
    if (!getObject(p.plan_object)) continue;
    const plan = await offerPlan(records, p.plan_object, p.plan_id);
    if ("planId" in plan) continue;
    gone += 1;
    const told = await notifyStatements(
      db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title: "Continuation offers have no plan to be taken on",
        body:
          `${Number(p.n)} open continuation offer(s) are for plan ${p.plan_id} (${p.plan_object}), ` +
          "which is no longer on sale, and there is not exactly one other plan of it for them to " +
          "follow to. Their people are told to ask you. Publish the plan again, or leave one plan " +
          "on sale, or import their offers again for the new plan.",
        link: null,
        dedupeKey: `subscription.offer_plan_gone:${p.plan_object}:${p.plan_id}`,
        source: { actor: "system" },
      },
      now,
    );
    statements.push(...told.statements);
  }
  if (statements.length) await crm.batch(statements);
  return { plansGone: gone };
}
