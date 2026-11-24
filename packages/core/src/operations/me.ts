// me.* operations (stage 22, ADR 0402, ADR 0413): a signed-in customer's own Person and their own
// sessions, and deleting their account. Open to customers only.
//
// `me.get` and `me.update` reach the Person through `ctx.records`, so the visibility seam decides
// which fields: the ones the Person object lists in its `customer` declaration (fields/person.ts).
// They take no id: the Person is always the caller's. `me.update` writes with the Person code
// person.update runs (the writer registered in operations/person.ts), so uniqueness, search, the
// audit diff and timeline tracking hold as for staff.
//
// The birthday operations (stage 53, ADR 0803) are `hostInternal` too: a birthday is kept beside
// the Person's row, in no `rec_*` view the seam reads, and they touch only the caller's own Person
// (the principal's, never an input's). What the member sets is marked theirs (`customer`).
//
// The session operations and me.deleteAccount are account bookkeeping, not records, so they are
// `hostInternal`: they keep `ctx.db` and touch only the caller's own account (taken from the
// principal, never from input), its sessions and its erase request. A session token never leaves
// them. me.deleteAccount also ends the subscriptions the caller pays at their period's end and
// cancels their unpaid orders, with the code their own subscription.cancel and order.cancel run
// (customers/account-delete.ts, ADR 0713).
import { z } from "zod";
import {
  applyDeletePreview,
  deletePreview,
  leftForStaffSentences,
} from "../customers/account-delete.ts";
import { revokeCustomerFeed } from "../customers/calendar-feed.ts";
import {
  createEraseRequestStatements,
  eraseRequestDueAt,
  openEraseRequest,
} from "../customers/erase-requests.ts";
import { loadEraseDueDays } from "../customers/settings.ts";
import { ConflictError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { personObject } from "../fields/person.ts";
import { endCustomerDeviceSessions } from "../http/tokens.ts";
import { birthdayOf, birthdaySchema, queueSetBirthday } from "../journeys/birthday.ts";
import { defineOperation, type HandlerContext, recordHostChange } from "../operation.ts";
import type { CustomerPrincipal } from "../principals.ts";

/** The caller, who is always a customer here (every operation in this file is customer-only). */
function customerOf(ctx: HandlerContext): CustomerPrincipal {
  const principal = ctx.principal;
  if (principal.kind !== "customer") {
    throw new OperationError("internal", `${ctx.operation} is for a customer's call`);
  }
  return principal;
}

const text = z.string().nullable();

/** The Person as its customer sees it: id and the fields `customer.read` lists, in staff shape. */
export const mePersonSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  givenName: text,
  familyName: text,
  primaryEmail: text,
  primaryPhone: text,
});
export type MePerson = z.infer<typeof mePersonSchema>;

const READABLE = personObject.customer?.read ?? [];

async function myPerson(ctx: HandlerContext): Promise<MePerson> {
  const { personId } = customerOf(ctx);
  const record = await ctx.records.get("person", personId);
  // Only what the seam returned, which is only what the declaration lists. Every listed field is
  // a scalar text column, so its value is already in the shape person.list returns.
  const values = Object.fromEntries(READABLE.map((name) => [name, record.values[name] ?? null]));
  return mePersonSchema.parse({ ...values, id: record.id });
}

const shortText = (max: number) => z.string().trim().max(max);

/**
 * me.get adds the account's own sign-in address to the Person. `primaryEmail` is the Person's
 * contact address, which staff can change; `signInEmail` is the address the emailed code was
 * sent to and verified on, which only signing in sets. Link a client's own records to a customer
 * by `signInEmail` alone.
 */
export const meGetSchema = mePersonSchema.extend({
  signInEmail: z
    .string()
    .describe(
      "The address you sign in with: the one the emailed code verified, lower-cased. Not the " +
        "Person's contact email (primaryEmail), which staff can change. The only address to " +
        "trust when linking records kept elsewhere to this customer.",
    ),
  signInEmailVerified: z
    .boolean()
    .describe(
      "Whether signInEmail was verified by an emailed code. True for every signed-in customer.",
    ),
});

export const meGet = defineOperation({
  name: "me.get",
  description:
    "Your own Person, as a signed-in customer: your name, primary email and primary phone, and " +
    "your account's sign-in address (signInEmail, the one the emailed code verified, with " +
    "signInEmailVerified). Link records kept elsewhere to a customer by signInEmail only: " +
    "primaryEmail is a contact address staff can change. Read-only.",
  input: z.object({}),
  output: meGetSchema,
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const person = await myPerson(ctx);
    // The host reads the caller's own account only (the verified principal's), never an input.
    const signIn = await ctx.signIn?.();
    if (!signIn) throw new NotFoundError("customer account", customerOf(ctx).customerId);
    return { ...person, signInEmail: signIn.email, signInEmailVerified: signIn.verified };
  },
});

export const meUpdate = defineOperation({
  name: "me.update",
  description:
    "Change your own name or primary phone, as a signed-in customer. Only the fields you pass " +
    "change; pass null to clear one. Your email cannot be changed here. Returns your Person.",
  input: z
    .object({
      displayName: shortText(200).min(1).optional(),
      givenName: shortText(100).nullish(),
      familyName: shortText(100).nullish(),
      primaryPhone: shortText(50).nullish(),
    })
    .strict(),
  output: mePersonSchema,
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const { personId } = customerOf(ctx);
    const values = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(values).length) await ctx.records.update("person", personId, values);
    return ctx.afterCommit(() => myPerson(ctx));
  },
});

// --- Birthday ---------------------------------------------------------------------------------

const meBirthdaySchema = z.object({
  birthday: birthdaySchema.nullable().describe("Day and month; null when none is recorded"),
});

/** The caller's own live Person's birthday. */
async function myBirthday(ctx: HandlerContext) {
  const { personId } = customerOf(ctx);
  const row = await ctx.db
    .selectFrom("core_person")
    .select(["birth_day", "birth_month"])
    .where("id", "=", personId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("person", personId);
  return birthdayOf(row);
}

export const meBirthdayGet = defineOperation({
  name: "me.birthday.get",
  description:
    "Your birthday as the business has it, as a signed-in customer: day and month only, or null " +
    "when none is recorded. Read-only.",
  input: z.object({}).strict(),
  output: meBirthdaySchema,
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    return { birthday: await myBirthday(ctx) };
  },
});

export const meBirthdaySet = defineOperation({
  name: "me.birthday.set",
  description:
    "Give your birthday, as a signed-in customer: day and month only, never a year; null " +
    "removes it. The business may send you a message on the day. Returns your birthday.",
  input: meBirthdaySchema.strict(),
  output: meBirthdaySchema,
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const { personId } = customerOf(ctx);
    const before = await myBirthday(ctx);
    // The host writes the caller's own Person, named by the principal: not judged against the
    // seam's customer fields, which hold no birthday (it is in no view).
    queueSetBirthday(ctx, (c) => recordHostChange(ctx, c), personId, before, input.birthday);
    return { birthday: input.birthday };
  },
});

// --- Sessions ---------------------------------------------------------------------------------

const sessionSchema = z.object({
  id: z.string(),
  /** `browser` (a sign-in cookie) or `device` (a native app's tokens, stage 23). */
  kind: z.enum(["browser", "device"]),
  /** What the app called the device, for a device session. */
  deviceName: z.string().nullable(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  /** When a browser session expires; a device session ends after a period without use. */
  expiresAt: z.string().nullable(),
  /** The session this call was made with, when the adapter says which (origin.sessionId). */
  current: z.boolean(),
});

/** The caller's own native-app sessions (stage 23). A token hash is never selected. */
function ownDevices(ctx: HandlerContext, customerId: string) {
  return ctx.db
    .selectFrom("core_device_session")
    .select(["id", "device_name", "created_at", "last_used_at"])
    .where("customer_id", "=", customerId);
}

/** Ends one of the caller's sessions of either kind. False when it is not theirs. */
async function endOwnSession(
  ctx: HandlerContext,
  customerId: string,
  id: string,
): Promise<boolean> {
  if (id.startsWith("dvs_")) {
    const device = await ownDevices(ctx, customerId).where("id", "=", id).executeTakeFirst();
    if (!device) return false;
    ctx.write(
      ctx.db
        .deleteFrom("core_device_session")
        .where("id", "=", id)
        .where("customer_id", "=", customerId),
    );
    return true;
  }
  const row = await ownSessions(ctx, customerId).where("id", "=", id).executeTakeFirst();
  if (!row) return false;
  ctx.write(
    ctx.db
      .deleteFrom("core_customer_session")
      .where("id", "=", id)
      .where("customer_id", "=", customerId),
  );
  return true;
}

/** The caller's own sessions only. A token is never selected. */
function ownSessions(ctx: HandlerContext, customerId: string) {
  return ctx.db
    .selectFrom("core_customer_session")
    .select(["id", "created_at", "updated_at", "expires_at"])
    .where("customer_id", "=", customerId);
}

export const meSessionsList = defineOperation({
  name: "me.sessions.list",
  description:
    "The places you are signed in, as a signed-in customer: each session's id, whether it is a " +
    "browser or an app on a device (with the device's name), when it began, when it was last " +
    "used and when it expires, and which one is this one. Read-only.",
  input: z.object({}),
  output: z.object({ items: z.array(sessionSchema) }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    const { customerId } = customerOf(ctx);
    const rows = await ownSessions(ctx, customerId)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
    const devices = await ownDevices(ctx, customerId)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
    return {
      items: [
        ...rows.map((row) => ({
          id: row.id,
          kind: "browser" as const,
          deviceName: null,
          createdAt: String(row.created_at),
          lastActiveAt: String(row.updated_at),
          expiresAt: String(row.expires_at),
          current: row.id === ctx.origin.sessionId,
        })),
        ...devices.map((row) => ({
          id: row.id,
          kind: "device" as const,
          deviceName: row.device_name,
          createdAt: row.created_at,
          lastActiveAt: row.last_used_at,
          expiresAt: null,
          current: row.id === ctx.origin.sessionId,
        })),
      ],
    };
  },
});

export const meSessionsRevoke = defineOperation({
  name: "me.sessions.revoke",
  description:
    "Sign out one of your sessions, as a signed-in customer, by its id from me.sessions.list. " +
    "A session that is not yours is not found.",
  input: z.object({ id: z.string().min(1).max(128).describe("Session id from me.sessions.list") }),
  output: z.object({ id: z.string(), revoked: z.literal(true) }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const { customerId } = customerOf(ctx);
    // Another customer's session answers exactly as one that does not exist.
    if (!(await endOwnSession(ctx, customerId, input.id))) {
      throw new NotFoundError("session", input.id);
    }
    return { id: input.id, revoked: true as const };
  },
});

export const meSignOut = defineOperation({
  name: "me.signOut",
  description:
    "Sign out of this session, as a signed-in customer. Your other sessions stay signed in " +
    "(end them with me.sessions.revoke).",
  input: z.object({}),
  output: z.object({ signedOut: z.boolean() }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    const { customerId } = customerOf(ctx);
    // The adapter names the session the call was made with; without one there is nothing to end.
    const sessionId = ctx.origin.sessionId;
    if (!sessionId) return { signedOut: false };
    return { signedOut: await endOwnSession(ctx, customerId, sessionId) };
  },
});

// --- Deleting the account ----------------------------------------------------------------------

const money = { amount: z.number().int(), currency: z.string() };

/** What deleting the account will do (ADR 0713): the preview, and what a confirm must echo. */
const deletePreviewSchema = z.object({
  subscriptions: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        ...money,
        interval: z.string(),
        endsAt: z
          .string()
          .nullable()
          .describe("When it stops: the end of the period paid for, or an earlier end already set"),
        ending: z
          .enum(["period_end", "already", "cooling_off"])
          .describe(
            "period_end: it will be set to end then. already: it already ends by then. " +
              "cooling_off: the cooling off you asked for ends it, with its refund",
          ),
      }),
    )
    .describe(
      "Subscriptions you pay that will end when the period already paid for ends. Nothing is " +
        "refunded and nothing more is charged",
    ),
  orders: z
    .array(
      z.object({
        id: z.string(),
        total: z.number().int(),
        currency: z.string(),
        createdAt: z.string(),
        lines: z.array(z.string()),
      }),
    )
    .describe("Your unpaid orders, which will be cancelled"),
  leftForStaff: z
    .object({
      records: z.array(z.object({ object: z.string(), label: z.string(), count: z.number() })),
      partPaidOrders: z.number(),
      moreUnpaidOrders: z.number(),
      subscriptions: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            state: z.string(),
            why: z.enum(["end_date_later", "state", "more"]),
          }),
        )
        .describe(
          "Subscriptions you pay that deleting does not end, which may still charge until staff " +
            "end them: an end date set after the period paid for (end_date_later), waiting for " +
            "a first payment, unpaid or paused (state), or more than one deletion ends (more)",
        ),
      dependantsWithoutGuardian: z.number(),
    })
    .describe(
      "What stays for staff to decide when they erase your data: your bookings, tickets and " +
        "other open records by kind, part-paid orders, and children with no other guardian",
    ),
  eraseDueAt: z.string().describe("When staff must have erased your data or said why not"),
  expect: z.string().describe("Pass back with confirm: true to do exactly this"),
});

export const meDeleteAccount = defineOperation({
  name: "me.deleteAccount",
  description:
    "Delete your customer account and ask for your personal data to be erased. Without " +
    "`confirm` it changes nothing and says what will happen: each subscription you pay ends when " +
    "the period already paid for ends (nothing refunded, nothing more charged), or with a " +
    "cooling off you asked for; one that cannot be ended that way (an end date set later, or " +
    "waiting for payment, unpaid or paused) is left for staff and may charge until they end it. " +
    "Your unpaid orders are cancelled, and your bookings, tickets and other records stay for " +
    "staff to decide when they erase your data. With `confirm: true` and the preview's `expect` " +
    "it does that: you are signed out everywhere at once and can no longer sign in, and staff " +
    "erase your data, or tell you by email why some of it must be kept, by the due date " +
    "returned. A preview that changed meanwhile is a conflict: ask for it again.",
  input: z
    .object({
      confirm: z.boolean().default(false).describe("Delete now, as the preview said"),
      expect: z
        .string()
        .max(64)
        .optional()
        .describe("The preview's `expect`; required with confirm: true"),
    })
    .strict(),
  output: z.discriminatedUnion("deleted", [
    deletePreviewSchema.extend({ deleted: z.literal(false) }),
    z.object({
      deleted: z.literal(true),
      disabled: z.literal(true),
      sessionsEnded: z.number(),
      subscriptionsEnding: z.number(),
      ordersCancelled: z.number(),
      eraseRequest: z.object({ requestedAt: z.string(), dueAt: z.string() }),
    }),
  ]),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  // It ends subscriptions, which subscription.cancel keeps to a person: never a pack's tool.
  actors: ["human"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const { customerId, personId } = customerOf(ctx);
    // Only the caller's own account, and only while it is linked to the caller's Person.
    const account = await ctx.db
      .selectFrom("core_customer")
      .select("id")
      .where("id", "=", customerId)
      .where("person_id", "=", personId)
      .executeTakeFirst();
    if (!account) throw new NotFoundError("customer account", customerId);
    const preview = await deletePreview(ctx, personId);
    const open = await openEraseRequest(ctx.db, personId);
    const dueAt = open?.dueAt ?? eraseRequestDueAt(ctx.now, await loadEraseDueDays(ctx.db));
    if (!input.confirm) return { deleted: false as const, ...preview, eraseDueAt: dueAt };
    if (input.expect === undefined) {
      throw new ValidationError("Confirm with the preview's expect", { field: "expect" });
    }
    if (input.expect !== preview.expect) {
      throw new ConflictError("What deleting your account will do has changed: look again", {
        rule: "preview_changed",
      });
    }
    const sessions = await ctx.db
      .selectFrom("core_customer_session")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("customer_id", "=", customerId)
      .executeTakeFirst();

    // The provider is asked first: a refusal there leaves the account as it was. Then one batch
    // (with the audit row): the orders cancelled, disabled, signed out everywhere, the calendar
    // link revoked, the request.
    await applyDeletePreview(ctx, preview);
    ctx.write(
      ctx.db
        .updateTable("core_customer")
        .set({ status: "disabled", updated_at: ctx.now })
        .where("id", "=", customerId),
      ctx.db.deleteFrom("core_customer_session").where("customer_id", "=", customerId),
      ...endCustomerDeviceSessions(ctx.db, [customerId]),
      // Their calendar link (ADR 0890): dead at once, and never back if the account is enabled.
      revokeCustomerFeed(ctx.db, customerId),
    );
    let request = open;
    if (!request) {
      const created = await createEraseRequestStatements(ctx.db, {
        personId,
        customerId,
        requestedAt: ctx.now,
        dueAt,
        left: leftForStaffSentences(preview),
      });
      ctx.write(...created.statements);
      request = created.request;
    }
    return {
      deleted: true as const,
      disabled: true as const,
      sessionsEnded: Number(sessions?.n ?? 0),
      subscriptionsEnding: preview.subscriptions.length,
      ordersCancelled: preview.orders.length,
      eraseRequest: { requestedAt: request.requestedAt, dueAt: request.dueAt },
    };
  },
});

export const meOperations = [
  meGet,
  meUpdate,
  meBirthdayGet,
  meBirthdaySet,
  meSessionsList,
  meSessionsRevoke,
  meSignOut,
  meDeleteAccount,
] as const;
