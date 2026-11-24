// A person's check-in code and PIN (stage 51 step 3, ADR 0783).
//
// The member's own, open to customers (reviewed in open-operations.json):
// - `me.code`: the rotating code for this sign-in, and one for each live dependant, made the first
//   time it is asked for on a sign-in. A native app's sign-in is also given the secret, so it can
//   show the code offline; a browser's is given only the current value.
// - `me.pin.set` and `me.pin.clear`: the 4-digit PIN for name-and-PIN check-in, the member's
//   own only (never a guardian's for a child, never staff's).
// These are account bookkeeping, not records, so they are `hostInternal`: they touch only the
// caller's own Person (from the principal) and the sign-in the call came with.
//
// Staff, a person with `people:cards` (admins and members, grantable, ADR 0600 amended):
// - `personCode.issueCard`, `personCode.revokeCard` and `personCode.list`: the cards and key tags
//   the business gives members. A card's code is never stored, shown, listed or audited.
//
// None is open to an AI, MCP or code (`actors: ["human"]`, or the customer audience). A code
// identifies a Person only inside a device tool (people-codes/identify.ts), never here.
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  APP_CODE_DIGITS,
  APP_CODE_STEP_SECONDS,
  appCodePayload,
  appCodeStep,
  appCodeValue,
  base32,
  cardCodeProblem,
  newAppSecret,
  newPinSalt,
  normaliseCardCode,
  type PersonCodeKeys,
  PIN_ITERATIONS,
  pinHash,
  pinProblem,
} from "../people-codes/keys.ts";
import type { CustomerPrincipal } from "../principals.ts";
import { base64url } from "../records/stream.ts";

/** A Person's id: a real one only, never a provisional `per_pending_…` (which would queue the call). */
const personId = z.string().regex(/^per_[0-9A-HJKMNP-TV-Z]{26}$/, "a Person's id (per_…)");

function customerOf(ctx: HandlerContext): CustomerPrincipal {
  const principal = ctx.principal;
  if (principal.kind !== "customer") {
    throw new OperationError("internal", `${ctx.operation} is for a customer's call`);
  }
  return principal;
}

function keysOf(ctx: HandlerContext): PersonCodeKeys {
  if (!ctx.personCodes) {
    throw new OperationError("config", "Check-in codes need the host's auth secret");
  }
  return ctx.personCodes;
}

// --- me.code -----------------------------------------------------------------------------------

const codeSchema = z.object({
  /** Whose code: the caller's own, or a dependant's given name. */
  givenName: z.string().nullable(),
  own: z.boolean(),
  /** What the QR carries now: `<code id>.<8 digits>`. */
  payload: z.string(),
  /**
   * A native app's sign-in only: the secret, base32, to make the code offline (RFC 6238, SHA-1,
   * 30 seconds, 8 digits). Null on a browser, which asks again.
   */
  secret: z.string().nullable(),
});

const meCodeOutput = z.object({
  codes: z.array(codeSchema),
  /** When the payloads change: ask again then (a browser). */
  refreshAt: z.string(),
  /** How the code is made, for the native app. */
  algorithm: z.object({
    kind: z.literal("totp"),
    hash: z.literal("SHA-1"),
    periodSeconds: z.number(),
    digits: z.number(),
  }),
});

/** The sign-in the call came with: a native app's device session or a browser's session. */
function signInOf(ctx: HandlerContext): { device: string } | { browser: string } {
  const sessionId = ctx.origin.sessionId;
  if (!sessionId) {
    throw new ValidationError("A check-in code is shown on a signed-in app or browser only");
  }
  return sessionId.startsWith("dvs_") ? { device: sessionId } : { browser: sessionId };
}

export const meCode = defineOperation({
  name: "me.code",
  description:
    "Your check-in code, as a signed-in customer: the code to hold up at the gym's check-in " +
    "tablet, and one for each child linked to you (by their given name), each changing every " +
    "30 seconds. It works only while this sign-in lasts. In the native app it also carries the " +
    "secret the app makes the code from offline. Made the first time it is asked for on a sign-in.",
  input: z.object({}).strict(),
  output: meCodeOutput,
  permission: "records:read",
  // It makes this sign-in's code the first time; after that it writes nothing.
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  redactResult: ["codes"],
  auditSummary: (output) => ({ codes: output.codes.length }),
  async handler(_input, ctx) {
    const keys = keysOf(ctx);
    const { personId: me } = customerOf(ctx);
    const signIn = signInOf(ctx);
    const column = "device" in signIn ? "device_session_id" : "customer_session_id";
    const sessionId = "device" in signIn ? signIn.device : signIn.browser;
    // The sign-in must be the caller's own and still live; its row is what the code is tied to.
    const own =
      "device" in signIn
        ? await ctx.db
            .selectFrom("core_device_session")
            .select("id")
            .where("id", "=", sessionId)
            .where("customer_id", "=", customerOf(ctx).customerId)
            .executeTakeFirst()
        : await ctx.db
            .selectFrom("core_customer_session")
            .select("id")
            .where("id", "=", sessionId)
            .where("customer_id", "=", customerOf(ctx).customerId)
            .executeTakeFirst();
    if (!own) throw new ValidationError("This sign-in has ended: sign in again");

    const family = await ctx.records.family();
    const people = [
      { personId: me, own: true },
      ...family.dependants.map((d) => ({ personId: d.personId, own: false })),
    ];
    const names = await ctx.db
      .selectFrom("core_person")
      .select(["id", "given_name", "display_name"])
      .where(
        "id",
        "in",
        sql<string>`(SELECT value FROM json_each(${JSON.stringify(people.map((p) => p.personId))}))`,
      )
      .execute();
    // A given name only, never a family name: the display name's first word when none is set.
    const nameOf = new Map(
      names.map((n) => [
        n.id,
        n.given_name?.trim() || n.display_name.trim().split(/\s+/)[0] || null,
      ]),
    );
    const readCodes = () =>
      ctx.db
        .selectFrom("core_person_code")
        .select(["id", "person_id", "secret_enc"])
        .where(column, "=", sessionId)
        .where("kind", "=", "app")
        .where("revoked_at", "is", null)
        .execute();
    const step = appCodeStep(new Date(ctx.now));
    const answer = async (rows: Awaited<ReturnType<typeof readCodes>>) => {
      const byPerson = new Map(rows.map((row) => [row.person_id, row]));
      const codes: z.input<typeof codeSchema>[] = [];
      for (const person of people) {
        const row = byPerson.get(person.personId);
        if (!row?.secret_enc) continue;
        const secret = await keys.decrypt(row.secret_enc);
        codes.push({
          givenName: person.own ? null : (nameOf.get(person.personId) ?? null),
          own: person.own,
          payload: appCodePayload(row.id, await appCodeValue(secret, step)),
          secret: "device" in signIn ? base32(secret) : null,
        });
      }
      return {
        codes,
        refreshAt: new Date((step + 1) * APP_CODE_STEP_SECONDS * 1000).toISOString(),
        algorithm: {
          kind: "totp" as const,
          hash: "SHA-1" as const,
          periodSeconds: APP_CODE_STEP_SECONDS,
          digits: APP_CODE_DIGITS,
        },
      };
    };

    const existing = await readCodes();
    const have = new Set(existing.map((row) => row.person_id));
    const missing = people.filter((person) => !have.has(person.personId));
    if (!missing.length) return answer(existing);
    for (const person of missing) {
      // Two first calls at once on one sign-in (the review of PR #382): the one-per-sign-in
      // index keeps the first insert and the other does nothing; both answer what was kept.
      ctx.write(
        ctx.db
          .insertInto("core_person_code")
          .values({
            id: newId("personCode"),
            person_id: person.personId,
            kind: "app",
            secret_enc: await keys.encrypt(newAppSecret()),
            device_session_id: "device" in signIn ? sessionId : null,
            customer_session_id: "browser" in signIn ? sessionId : null,
            guardian_id: person.own ? null : me,
            created_at: ctx.now,
          })
          .onConflict((oc) => oc.doNothing()),
      );
    }
    return ctx.afterCommit(async () => answer(await readCodes()));
  },
});

// --- me.pin.* ----------------------------------------------------------------------------------

export const mePinSet = defineOperation({
  name: "me.pin.set",
  description:
    "Choose your 4-digit PIN, as a signed-in customer, to check in at the gym's tablet by typing " +
    "your full name and the PIN when you do not have your phone. The most common PINs (1234, " +
    "0000 and the like) are refused. Setting it again replaces it, and turns it back on after " +
    "too many wrong tries turned it off.",
  input: z.object({ pin: z.string().max(16).describe("4 digits") }).strict(),
  output: z.object({ set: z.literal(true) }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  redact: ["pin"],
  auditSummary: () => ({ set: true }),
  async handler(input, ctx) {
    const keys = keysOf(ctx);
    const { personId: me } = customerOf(ctx);
    const problem = pinProblem(input.pin);
    if (problem) throw new ValidationError(problem, { field: "pin" });
    const salt = newPinSalt();
    const hash = await pinHash(keys, input.pin, salt, PIN_ITERATIONS);
    const values = {
      hash,
      salt: base64url(salt),
      iterations: PIN_ITERATIONS,
      set_at: ctx.now,
      failed_count: 0,
      failed_since: null,
      disabled_at: null,
    };
    ctx.write(
      ctx.db
        .insertInto("core_person_pin")
        .values({ person_id: me, ...values })
        .onConflict((oc) => oc.column("person_id").doUpdateSet(values)),
    );
    return { set: true as const };
  },
});

export const mePinClear = defineOperation({
  name: "me.pin.clear",
  description:
    "Remove your PIN, as a signed-in customer: nobody can then check in as you by name and PIN. " +
    "Your check-in code and cards still work. Clearing when there is none changes nothing.",
  input: z.object({}).strict(),
  output: z.object({ cleared: z.boolean() }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    const { personId: me } = customerOf(ctx);
    const row = await ctx.db
      .selectFrom("core_person_pin")
      .select("person_id")
      .where("person_id", "=", me)
      .executeTakeFirst();
    if (row) ctx.write(ctx.db.deleteFrom("core_person_pin").where("person_id", "=", me));
    return { cleared: Boolean(row) };
  },
});

// --- Cards (staff) -----------------------------------------------------------------------------

const cardSchema = z.object({
  id: z.string(),
  kind: z.enum(["app", "card"]),
  /** A card's label ("blue key tag"); null for an app code. */
  label: z.string().nullable(),
  /** Who issued a card (usr_…); null for an app code. */
  issuedBy: z.string().nullable(),
  /** For a dependant's app code: shown on a guardian's app. */
  onGuardiansApp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

async function requireLivePerson(ctx: HandlerContext, id: string): Promise<void> {
  const row = await ctx.db
    .selectFrom("core_person")
    .select("id")
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("person", id);
}

export const personCodeIssueCard = defineOperation({
  name: "personCode.issueCard",
  description:
    "Give a person a check-in card or key tag: scan or type the card's code (at least 8 " +
    "characters; a tag numbered in sequence can be guessed from its neighbour, so use cards " +
    "with random codes) and a label to tell it apart. The card then checks them in at the check-in " +
    "tablet until it is revoked. The code is never stored or shown again (only a keyed hash), " +
    "and a code already on someone's live card is refused. Only a person on the staff with " +
    "people:cards can do this: never the assistant, an MCP client or code. Audited.",
  input: z
    .object({
      personId: personId.describe("Who the card is for (per_…)"),
      code: z.string().min(1).max(200).describe("The card's code, as scanned or printed"),
      label: z.string().trim().min(1).max(100).describe('To tell it apart, e.g. "blue key tag"'),
    })
    .strict(),
  output: cardSchema,
  permission: "people:cards",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  redact: ["code"],
  // Never queued for review (the review of PR #382): a pending action keeps its input whole, and
  // the card's code must never be stored. A floor's or policy's deny still applies; a review
  // floor lets a person issue it, as for a token's revoke. A provisional Person id is refused by
  // the input, so nothing routes it to review either.
  bookkeeping: true,
  async handler(input, ctx) {
    const keys = keysOf(ctx);
    const normalised = normaliseCardCode(input.code);
    const problem = cardCodeProblem(normalised);
    if (problem) throw new ValidationError(problem, { field: "code" });
    await requireLivePerson(ctx, input.personId);
    const hmac = await keys.cardHmac(normalised);
    const taken = await ctx.db
      .selectFrom("core_person_code")
      .select("id")
      .where("kind", "=", "card")
      .where("code_hmac", "=", hmac)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (taken) {
      throw new ConflictError("That card is already someone's: revoke it first", {
        rule: "card_taken",
      });
    }
    const id = newId("personCode");
    ctx.write(
      ctx.db.insertInto("core_person_code").values({
        id,
        person_id: input.personId,
        kind: "card",
        code_hmac: hmac,
        label: input.label,
        issued_by: ctx.user.id,
        created_at: ctx.now,
      }),
    );
    ctx.postActivity({
      subject: "Check-in card issued",
      payload: { kind: "person_code", action: "issued", codeId: id, label: input.label },
      links: [{ object: "person", id: input.personId }],
    });
    return {
      id,
      kind: "card" as const,
      label: input.label,
      issuedBy: ctx.user.id,
      onGuardiansApp: false,
      createdAt: ctx.now,
      lastUsedAt: null,
      revokedAt: null,
    };
  },
});

export const personCodeRevokeCard = defineOperation({
  name: "personCode.revokeCard",
  description:
    "Revoke a person's check-in card (lost, or handed back), by its id from personCode.list: " +
    "from now on it checks no one in. Revoking one already revoked changes nothing. Only a " +
    "person on the staff with people:cards can do this. Audited.",
  input: z.object({ codeId: z.string().min(1).max(64).describe("The card's id (pc_…)") }).strict(),
  output: z.object({ id: z.string(), revokedAt: z.string() }),
  permission: "people:cards",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_person_code")
      .select(["id", "person_id", "revoked_at"])
      .where("id", "=", input.codeId)
      .where("kind", "=", "card")
      .executeTakeFirst();
    if (!row) throw new NotFoundError("card", input.codeId);
    if (row.revoked_at) return { id: row.id, revokedAt: row.revoked_at };
    ctx.write(
      ctx.db
        .updateTable("core_person_code")
        .set({ revoked_at: ctx.now, revoked_by: ctx.user.id })
        .where("id", "=", row.id)
        .where("revoked_at", "is", null),
    );
    ctx.postActivity({
      subject: "Check-in card revoked",
      payload: { kind: "person_code", action: "revoked", codeId: row.id },
      links: [{ object: "person", id: row.person_id }],
    });
    return { id: row.id, revokedAt: ctx.now };
  },
});

export const personCodeList = defineOperation({
  name: "personCode.list",
  description:
    "A person's check-in cards and app codes: each card's label, who issued it, when it was " +
    "issued, last used and revoked, and each app sign-in showing a code. Never a code. Read-only.",
  input: z.object({ personId: personId.describe("The person (per_…)") }).strict(),
  output: z.object({ items: z.array(cardSchema) }),
  permission: "people:cards",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    await requireLivePerson(ctx, input.personId);
    const rows = await ctx.db
      .selectFrom("core_person_code")
      .select([
        "id",
        "kind",
        "label",
        "issued_by",
        "guardian_id",
        "created_at",
        "last_used_at",
        "revoked_at",
      ])
      .where("person_id", "=", input.personId)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .limit(200)
      .execute();
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        issuedBy: row.issued_by,
        onGuardiansApp: row.guardian_id !== null,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
      })),
    };
  },
});

export const personCodeOperations = [
  meCode,
  mePinSet,
  mePinClear,
  personCodeIssueCard,
  personCodeRevokeCard,
  personCodeList,
] as const;
