// A staff member confirms their own email address (ADR 0457). Sign-in by an emailed code goes
// only to a verified address (`staffMayGetCode`), and the first admin's password sign-up leaves it
// unverified, so until they confirm it they cannot sign in by code (nor run `cos content import
// --email`). The address is always the account's own, read from the account, never an input: this
// cannot verify an address the person does not control (the code goes to it) or change one (a
// code sent to an address the account no longer has confirms nothing).
//
// - user.emailStatus: the caller's address, whether it is confirmed, and whether codes can go out.
// - user.sendEmailConfirmation: emails a six-digit code to that address as the host's sign-in mail
//   (needs it ready, ADR 0456). The code is stored as a hash, bound to the account and the
//   address, for five minutes and three tries.
// - user.confirmEmail { code }: the right code marks the address verified; a wrong one counts a
//   try. Audited as a change to the user.
// All three: the caller's own account only, a person only, not on MCP.
import { z } from "zod";
import { ConflictError, ForbiddenError, ValidationError } from "../errors.ts";
import { tokenHash } from "../http/tokens.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
export const CONFIRMATION_ATTEMPTS = 3;
/** A new code no sooner than this after the last, so a mistake cannot flood one's own inbox. */
export const CONFIRMATION_RESEND_MS = 30 * 1000;

const confirmationHash = (userId: string, code: string) => tokenHash(`${userId}\n${code}`);

/** The caller's own account row, refused for a support user (their access is the grant's). */
async function ownAccount(ctx: HandlerContext) {
  const row = await ctx.db
    .selectFrom("core_user")
    .select(["id", "email", "email_verified", "support_grant_id", "kind"])
    .where("id", "=", ctx.user.id)
    .executeTakeFirst();
  if (!row || row.kind !== "human" || row.support_grant_id) {
    throw new ForbiddenError("Only a staff member's own account confirms its address");
  }
  return { ...row, email: row.email.trim().toLowerCase(), verified: Boolean(row.email_verified) };
}

export const userEmailStatus = defineOperation({
  name: "user.emailStatus",
  description:
    "Your own email address, whether it is confirmed, and whether sign-in codes can be sent " +
    "now. Sign-in by an emailed code (and `cos content import --email`) works only for a " +
    "confirmed address. Read-only, your own account only.",
  input: z.object({}),
  output: z.object({
    email: z.string(),
    verified: z.boolean(),
    signInMail: z.object({ ready: z.boolean(), problem: z.string().nullable() }),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const account = await ownAccount(ctx);
    const problem = ctx.hostMail
      ? await ctx.hostMail.signInMailProblem()
      : "the host cannot send mail";
    return {
      email: account.email,
      verified: account.verified,
      signInMail: { ready: problem === null, problem },
    };
  },
});

export const userSendEmailConfirmation = defineOperation({
  name: "user.sendEmailConfirmation",
  description:
    "Email a six-digit code to your own address, to confirm it (user.confirmEmail). Sent as the " +
    "host's sign-in mail, so it needs that to be set up. Your own account only; a person only.",
  input: z.object({}),
  output: z.object({ sentTo: z.string(), expiresAt: z.string() }),
  permission: "records:read",
  risk: "write",
  // Account bookkeeping, not a record: never queued for review (a code that waits is no use).
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    if (ctx.simulation) throw new ConflictError("A confirmation code is never sent in a dry run");
    const account = await ownAccount(ctx);
    if (account.verified) {
      throw new ConflictError("Your address is already confirmed", { email: account.email });
    }
    const mail = ctx.hostMail;
    const problem = mail ? await mail.signInMailProblem() : "the host cannot send mail";
    if (!mail || problem) {
      throw new ConflictError(`A code cannot be sent yet: ${problem}`, { reason: "not_set_up" });
    }
    const previous = await ctx.db
      .selectFrom("core_email_confirmation")
      .select("created_at")
      .where("user_id", "=", account.id)
      .executeTakeFirst();
    if (
      previous &&
      Date.parse(ctx.now) - Date.parse(previous.created_at) < CONFIRMATION_RESEND_MS
    ) {
      throw new ConflictError("A code was just sent: wait a moment before asking for another", {
        reason: "too_soon",
      });
    }
    const digits = crypto.getRandomValues(new Uint32Array(1))[0] as number;
    const code = String(digits % 1_000_000).padStart(6, "0");
    const expiresAt = new Date(Date.parse(ctx.now) + CONFIRMATION_TTL_MS).toISOString();
    // Sent before the row is written: a code that did not go out is never stored, and one that
    // went out but was not stored confirms nothing.
    await mail.sendSignInCode({ to: account.email, code });
    const values = {
      user_id: account.id,
      email: account.email,
      code_hash: await confirmationHash(account.id, code),
      attempts: 0,
      created_at: ctx.now,
      expires_at: expiresAt,
    };
    ctx.write(
      ctx.db
        .insertInto("core_email_confirmation")
        .values(values)
        .onConflict((oc) =>
          oc.column("user_id").doUpdateSet({
            email: values.email,
            code_hash: values.code_hash,
            attempts: 0,
            created_at: values.created_at,
            expires_at: values.expires_at,
          }),
        ),
    );
    return { sentTo: account.email, expiresAt };
  },
});

export const userConfirmEmail = defineOperation({
  name: "user.confirmEmail",
  description:
    "Confirm your own email address with the code user.sendEmailConfirmation sent to it. A wrong " +
    "code counts one of three tries. Your own account only; a person only.",
  input: z.object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "six digits"),
  }),
  output: z.object({ confirmed: z.boolean(), email: z.string() }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const account = await ownAccount(ctx);
    if (account.verified) return { confirmed: true, email: account.email };
    const pending = await ctx.db
      .selectFrom("core_email_confirmation")
      .selectAll()
      .where("user_id", "=", account.id)
      .executeTakeFirst();
    const discard = () =>
      ctx.write(ctx.db.deleteFrom("core_email_confirmation").where("user_id", "=", account.id));
    if (!pending) throw new ValidationError("That code is not valid. Ask for a new one.");
    // Bound to the address it went to: the account's address changed since, so it proves nothing.
    if (pending.email !== account.email || Date.parse(pending.expires_at) <= Date.parse(ctx.now)) {
      discard();
      return { confirmed: false, email: account.email };
    }
    if (pending.code_hash !== (await confirmationHash(account.id, input.code))) {
      if (pending.attempts + 1 >= CONFIRMATION_ATTEMPTS) discard();
      else {
        ctx.write(
          ctx.db
            .updateTable("core_email_confirmation")
            .set({ attempts: pending.attempts + 1 })
            .where("user_id", "=", account.id),
        );
      }
      return { confirmed: false, email: account.email };
    }
    discard();
    ctx.write(
      ctx.db
        .updateTable("core_user")
        .set({ email_verified: 1, updated_at: ctx.now })
        .where("id", "=", account.id)
        // Never an address other than the one the code went to.
        .where((eb) => eb(eb.fn("lower", ["email"]), "=", pending.email)),
    );
    ctx.recordChange({
      object: "user",
      id: account.id,
      action: "update",
      before: { emailVerified: false },
      after: { emailVerified: true },
    });
    return { confirmed: true, email: account.email };
  },
});

export const userEmailOperations = [
  userEmailStatus,
  userSendEmailConfirmation,
  userConfirmEmail,
] as const;
