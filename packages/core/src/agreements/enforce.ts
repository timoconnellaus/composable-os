// Enforcement (stage 44 step 3, ADR 0644): nobody pays, starts a membership or books without the
// agreements they need. Three places ask, all the host's, all before the write's batch is planned,
// and every batch that relied on the answer carries the `agreements` guard (migration 0851), so a
// document published with "agree again", attached, retired, or anything else that bumps the
// counter (a minor mark, a family link, the Trash, a merge, an erase) between the read and the
// commit fails the batch (`conflict`, rule `agreements_changed`):
//
//   purchase  `createOrder` (every order: order.start, order.startHeld) and `startSubscription`
//             (a continuation offer included) ask at the points the bought objects declare;
//   entry     the transition engine asks when a caller's record enters a state its point lists
//             (`enter`: a booking made booked or waiting, a waiter taking a free place), for the
//             Person its `person` relation names. The host's own moves are never asked
//             (promotion, a paid drop-in booked, timed moves): "agree again" is not retroactive;
//   guests    a visitor buying without an account carries their acceptances in the buying call.
//             They are checked here against every document attached for everyone (no Person is
//             read), and recorded in the order's (or the checkout's) batch with no Person; the
//             verified payment gives them their Person (migration 0853's triggers), and an order
//             that closes unpaid deletes them.
//
// Staff never agree for anyone: a caller who is not a guest carries no acceptances, and is refused
// with the list of what is due (send a link, sign at the desk, or record paper).
import type { Compilable, CompiledQuery } from "kysely";
import { sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import type { Mover } from "../records/transitions.ts";
import { planAcceptance } from "./accept.ts";
import { answersSchema, signatureSchema, typedNameSchema } from "./capture.ts";
import {
  agreementsDueAt,
  agreementsGuard,
  dueRefusal,
  guestDue,
  isMinor,
  minorPayerDocuments,
  minorPayerRefusal,
  personFacts,
} from "./due.ts";

/** The most acceptances one buying call carries. */
export const GUEST_ACCEPTANCES_MAX = 20;

/** A visitor's acceptance of one version, carried in the buying call. */
export const guestAcceptanceSchema = z
  .object({
    versionId: z.string().min(1).max(64).describe("The version's id (agv_…) the visitor read"),
    typedName: typedNameSchema,
    signature: signatureSchema.optional(),
    answers: answersSchema.optional(),
  })
  .strict();
export type GuestAcceptance = z.infer<typeof guestAcceptanceSchema>;

export const guestAcceptancesSchema = z
  .array(guestAcceptanceSchema)
  .max(GUEST_ACCEPTANCES_MAX)
  .describe(
    "A visitor without an account only: what they agreed to on the way to paying, one entry per " +
      "document the host says is due (each document's current version, the name they typed, a " +
      "signature for a document agreed to by drawing, every answer for a health form). A " +
      "signed-in customer agrees first (me.agreements.accept); staff never agree for anyone.",
  );

/** The agreement point an object declares, or null. */
export function pointOf(object: ObjectDefinition | undefined): string | null {
  return object?.agreements?.point ?? null;
}

/** The points of these bought objects (a sellable's own, and a drop-in booking's), each once. */
export function pointsOfObjects(objects: readonly string[]): string[] {
  const points = new Set<string>();
  for (const name of objects) {
    const object = getObject(name);
    if (!object?.sellable) continue;
    const point = pointOf(object);
    if (point) points.add(point);
  }
  return [...points];
}

/** Who a purchase is for and who pays, as the host established them. */
export interface PurchaseParties {
  /** A visitor (the public): only their own acceptances in the call count. */
  guest: boolean;
  /** The Person it is for (the holder, the booking's Person); null when the address is unclear. */
  participant: string | null;
  /** The Person who pays; null when the address is unclear. */
  payer: string | null;
}

/** What a purchase writes for the agreements: the guards now, a guest's rows once its order exists. */
export interface PurchaseAgreements {
  /** The `agreements` guards: queue them in the batch. */
  guards: CompiledQuery[];
  /**
   * A guest's acceptances, planned (every check made) for what they are taken with. Queue them
   * after the order or the checkout itself: the insert trigger needs it to exist.
   */
  guestRows(link: {
    orderId?: string;
    subscriptionCheckout?: string;
    email: string;
  }): Promise<(Compilable | CompiledQuery)[]>;
}

const NOTHING: PurchaseAgreements = { guards: [], guestRows: async () => [] };

/**
 * Refuses a purchase at `points` while anything is due, or returns what its batch must carry.
 *
 * - A guest's acceptances must cover every document due for a guest, one each, of its current
 *   version; anything else in the call is refused (`agreement_not_asked`). What is missing is
 *   refused with `agreements_due` and the documents only (never whether the address agreed).
 * - Anyone else carries no acceptances (`agreements` is a guest's), and is refused with
 *   `agreements_due` and the documents for the Person, or, when the address belongs to several
 *   People (no Person known), every document due for a guest, until staff say whose it is.
 */
export async function enforcePurchase(
  ctx: HandlerContext,
  points: readonly string[],
  parties: PurchaseParties,
  acceptances: readonly GuestAcceptance[] | undefined,
): Promise<PurchaseAgreements> {
  if (!parties.guest && acceptances?.length) {
    throw new ValidationError(
      "Only a visitor buying without an account agrees in the buying call: a signed-in customer " +
        "agrees first, and staff never agree for anyone (send a link, sign at the desk, or record " +
        "a paper form)",
      { field: "agreements", rule: "agreement_not_asked" },
    );
  }
  if (!points.length) {
    if (acceptances?.length) {
      throw new ValidationError("Nothing here needs agreeing to", {
        field: "agreements",
        rule: "agreement_not_asked",
      });
    }
    return NOTHING;
  }
  if (!parties.guest) {
    if (!parties.participant || !parties.payer) {
      // The address matched several People: nobody's standing can be read until staff merge them.
      const { rev, due } = await guestDue(ctx.db, points);
      if (due.length) {
        throw dueRefusal(
          due,
          "That address belongs to more than one person, and something must be agreed to first: " +
            "merge them, then start it for the Person",
        );
      }
      return { guards: [agreementsGuard(rev)], guestRows: NOTHING.guestRows };
    }
    const { rev, due } = await agreementsDueAt(ctx.db, points, {
      participant: parties.participant,
      payer: parties.payer,
      now: ctx.now,
    });
    // A minor never pays where the payer must agree: a parent or guardian buys it for them
    // (the review of PR #280; read after the counter, so a mark set meanwhile fails the guard).
    const minorPays = await minorPayerDocuments(ctx.db, points, parties.payer);
    if (minorPays.length) throw minorPayerRefusal(minorPays);
    if (due.length) throw dueRefusal(due);
    return { guards: [agreementsGuard(rev)], guestRows: NOTHING.guestRows };
  }

  const { rev, due } = await guestDue(ctx.db, points);
  const given = acceptances ?? [];
  const byVersion = new Map(due.map((d) => [d.version.id, d]));
  const seen = new Set<string>();
  for (const [index, acceptance] of given.entries()) {
    const doc = byVersion.get(acceptance.versionId);
    if (!doc || seen.has(doc.documentId)) {
      throw new ValidationError(
        "One of these agreements is not asked for here, or not the version in effect: read what " +
          "is due again",
        { field: "agreements", rule: "agreement_not_asked", index },
      );
    }
    seen.add(doc.documentId);
  }
  const missing = due.filter((d) => !seen.has(d.documentId));
  if (missing.length) throw dueRefusal(missing);
  return {
    guards: [agreementsGuard(rev)],
    async guestRows(link) {
      const statements: (Compilable | CompiledQuery)[] = [];
      for (const acceptance of given) {
        const planned = await planAcceptance(
          ctx.db,
          {
            versionId: acceptance.versionId,
            personId: null,
            by: "guest",
            guest: {
              orderId: link.orderId ?? null,
              subscriptionCheckout: link.subscriptionCheckout ?? null,
            },
            email: link.email,
            channel: "web",
            typedName: acceptance.typedName,
            signature: acceptance.signature,
            answers: acceptance.answers,
          },
          ctx.now,
        );
        statements.push(...planned.statements);
      }
      return statements;
    },
  };
}

/**
 * The engine's check (stage 44 step 3, ADR 0644, amending ADR 0503): a caller's write that makes a
 * record count at its point, judged for the Person its `person` relation names, with the guard
 * queued in the write's batch. A state counts when the point lists it (`enter`: booked, waiting)
 * or, for an object with `claims`, when it holds the place (attended, a no-show): a record made
 * straight into one of those is a booking too. The write is asked when the record:
 *   - is created in a state that counts (a booking made booked or waiting, or made attended);
 *   - moves into one the point lists from any other state (a waiter taking a free place: waiting
 *     to booked), except, for an object with `claims`, a move between two states that both hold
 *     the place (a coach unticking a name: attended to booked), which is the same booking;
 *   - is in a state that counts while its Person changes (staff giving a booking to someone else).
 * The host's own moves (`by: "host"`: promotion, a paid drop-in booked, timed moves, a series'
 * records) are never asked: "agree again" is not retroactive.
 */
export async function enforceEntry(
  ctx: HandlerContext,
  object: ObjectDefinition,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  by: Mover,
): Promise<void> {
  const spec = object.agreements;
  const states = object.states;
  if (!spec?.enter?.length || !spec.person || !states || by === "host") return;
  const field = states.field;
  const value = after[field];
  const to = typeof value === "string" && value !== "" ? value : null;
  const stored = before?.[field];
  const from = typeof stored === "string" && stored !== "" ? stored : null;
  const claims = object.claims;
  const holds = (state: string | null) =>
    state !== null && !!claims && (claims.held.includes(state) || claims.confirmed.includes(state));
  const listed = (state: string | null) => state !== null && spec.enter?.includes(state) === true;
  const counts = (state: string | null) => listed(state) || holds(state);
  if (!counts(to)) return;
  const personOf = (values: Record<string, unknown> | null) => {
    const raw = values?.[spec.person as string];
    if (typeof raw === "string") return raw || null;
    if (raw && typeof raw === "object" && "id" in raw) {
      return String((raw as { id: unknown }).id) || null;
    }
    return null;
  };
  const participant = personOf(after);
  if (!participant) return;
  const created = before === null;
  const entered = !created && from !== to && listed(to) && !(holds(from) && holds(to));
  const changedPerson = !created && personOf(before) !== participant;
  if (!created && !entered && !changedPerson) return;
  const { rev, due } = await agreementsDueAt(ctx.db, [spec.point], {
    participant,
    payer: null,
    now: ctx.now,
  });
  if (due.length) throw dueRefusal(due);
  ctx.write(agreementsGuard(rev));
}

/** Staff who may act on agreements: admins, and anyone granted agreements:manage. */
async function agreementManagers(ctx: HandlerContext): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`SELECT id FROM core_user
    WHERE kind = 'human' AND deactivated_at IS NULL AND pack_role IS NULL
      AND (role = 'admin' OR EXISTS (SELECT 1 FROM json_each(coalesce(granted_permissions, '[]'))
        WHERE value = 'agreements:manage'))
    ORDER BY id`.execute(ctx.db);
  return rows.map((r) => r.id);
}

/**
 * A guest's purchase whose address matched a Person who is a minor (the owner's decision of
 * 2026-11-24, on the review of PR #280; ADR 0644). Checkout cannot refuse it
 * without saying the address is a child's, so the purchase stands; the guest's acceptances count
 * for nothing after it (a guest's never do, and a minor's own never do), so the child stays due
 * (reason `guardian`) until a parent, a guardian or a paper form agrees. Staff who may act on it
 * are told, in the batch that settles it: a notice for the person only, naming the order or the
 * checkout and nothing of the documents or the answers. Queued only while the purchase still has
 * guest acceptances with no Person (so once).
 */
export async function guestMinorNotice(
  ctx: HandlerContext,
  link: { orderId?: string; subscriptionCheckout?: string },
  personId: string | null,
): Promise<void> {
  if (!personId || (!link.orderId && !link.subscriptionCheckout)) return;
  const pending = await ctx.db
    .selectFrom("core_agreement_acceptance")
    .select("id")
    .where("by", "=", "guest")
    .where("person_id", "is", null)
    .where(
      link.orderId ? "order_id" : "subscription_checkout",
      "=",
      (link.orderId ?? link.subscriptionCheckout) as string,
    )
    .executeTakeFirst();
  if (!pending) return;
  if (!isMinor(await personFacts(ctx.db, personId))) return;
  const to = await agreementManagers(ctx);
  if (!to.length) return;
  const what = link.orderId
    ? `Order ${link.orderId}`
    : `Subscription checkout ${link.subscriptionCheckout}`;
  const plan = await notifyStatements(
    ctx.db,
    {
      to: to.map((userId) => ({ userId })),
      type: "system.message",
      title: "A guest's purchase was for someone marked as a minor",
      body:
        `${what} was paid as a guest with the address of a Person who is a minor. What it ` +
        "bought stands; the agreements typed with it do not count for them. A parent or " +
        "guardian agrees for them, or staff record a paper form, before they book or buy again.",
      link: { kind: "record", object: "person", id: personId },
      dedupeKey: `agreement-guest-minor:${link.orderId ?? link.subscriptionCheckout}`,
      humanOnly: true,
      source: { actor: "system" },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
}
