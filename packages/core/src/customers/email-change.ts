// Changing a customer account's sign-in address (stage 48, ADR 0712). The address is the identity
// the company links to (ADR 0421), so it changes only when the new mailbox is proved:
//
// 1. The member asks with the new address (`me.email.change`, after a sign-in within the last 15
//    minutes), or a staff admin starts the same change for them (`customer.changeEmail`). The
//    host emails a six-digit code to the new address, as its own sign-in mail (ADR 0456), and
//    keeps only its hash. The answer is the same whatever the address: in use at the business,
//    erased or free, nobody learns it by asking.
// 2. The member, signed in to the same account, enters the code (`me.email.confirm`). Only then,
//    and only if no other Person, no other account and the erased-address list holds the address
//    (said now, to the person who proved the mailbox), in one batch: the account's sign-in
//    address, the Person's primary email (the old sign-in address leaves the Person's addresses;
//    the change record keeps it, for erase), every other session of the account ended (web and
//    app), a timeline activity naming no address, and the audit row.
// 3. After the commit the old address is told (always, whoever started it), naming the new one
//    only in part, and the payment provider is given the new address for each provider customer
//    the member pays through (`payments.customer.email`, the host's own call).
//
// A staff member never sees the code and cannot finish a change: only the code at the new address
// does, entered by the account's own session. A code lasts 15 minutes and allows 5 tries; a newer
// request replaces an open one; staff may cancel one. Requests are limited per account and per
// mailbox, counted from these rows (D1), so the limit holds across isolates and is the same for
// every address.
import type { CoreDatabase } from "@composable-os/db";
import { productName } from "@composable-os/product";
import { product } from "@composable-os/products/active";
import type { Kysely } from "kysely";
import {
  ConfigError,
  ConflictError,
  OperationError,
  RateLimitedError,
  ValidationError,
} from "../errors.ts";
import { tokenHash } from "../http/tokens.ts";
import { newId } from "../ids.ts";
import { sendEmail } from "../notifications/channels.ts";
import { type HandlerContext, recordHostChange } from "../operation.ts";
import { erasedAddresses } from "../sync/ingest.ts";
import { normaliseCustomerEmail } from "./accounts.ts";
import { customerCodeTarget } from "./code-email.ts";
import { mailboxKey } from "./limits.ts";
import { signInMailCall, signInMailState } from "./sign-in-mail.ts";

/** How long a code works, and how many tries it allows. */
export const EMAIL_CHANGE_CODE_MINUTES = 15;
export const EMAIL_CHANGE_TRIES = 5;
/** Requests per account in a rolling hour, and per mailbox in a code's lifetime. */
export const EMAIL_CHANGE_ACCOUNT_LIMIT = 5;
export const EMAIL_CHANGE_MAILBOX_LIMIT = 3;
/** Provider customers given the new address at most (one per subscription a guest started). */
const PROVIDER_CUSTOMERS_MAX = 20;

/** The one answer for a code that does not work: wrong, expired, used up, or none waiting. */
const NOT_RIGHT = "That code is not right, or it has expired: ask for a new one";

/** `a•••@example.com`: the first character of the mailbox and the domain, nothing more. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${address.slice(0, 1)}•••@${address.slice(at + 1)}`;
}

/** The code to the new address. Plain text; the code is the only variable (ADR 0456's rule). */
export function emailChangeCodeEmail(code: string): { subject: string; text: string } {
  const name = productName(product);
  return {
    subject: `Confirm your new ${name} sign-in address`,
    text:
      `Your code to make this your sign-in address for ${name} is ${code}.\n\n` +
      `It works once and expires in ${EMAIL_CHANGE_CODE_MINUTES} minutes. If you did not ask ` +
      "for this, ignore this email: nothing changes.",
  };
}

/** The notice to the old address, naming the new one only in part. */
export function emailChangedEmail(newEmail: string): { subject: string; text: string } {
  const name = productName(product);
  return {
    subject: `Your ${name} sign-in address was changed`,
    text:
      `The address you sign in to ${name} with was changed to ${maskEmail(newEmail)}.\n\n` +
      "You can no longer sign in with this address. If you did not ask for this, contact us at once.",
  };
}

/** A uniformly random six-digit code. */
function newCode(): string {
  const buffer = new Uint32Array(1);
  // 4_294_000_000 is the largest multiple of 1_000_000 below 2^32: no digit is likelier.
  do crypto.getRandomValues(buffer);
  while ((buffer[0] as number) >= 4_294_000_000);
  return String((buffer[0] as number) % 1_000_000).padStart(6, "0");
}

/** The stored hash of a code: salted with its change's id, so equal codes never hash alike. */
function codeHash(changeId: string, code: string): Promise<string> {
  return tokenHash(`${changeId}:${code}`);
}

export interface EmailChange {
  id: string;
  customerId: string;
  newEmail: string;
  oldEmail: string;
  /** `customer`, or the staff user id of the admin who started it. */
  startedBy: string;
  expiresAt: string;
  triesLeft: number;
  createdAt: string;
}

/** The account's open change (not confirmed, not ended), expired or not. */
export async function openEmailChange(
  db: Kysely<CoreDatabase>,
  customerId: string,
): Promise<EmailChange | null> {
  const row = await db
    .selectFrom("core_customer_email_change")
    .select([
      "id",
      "customer_id",
      "new_email",
      "old_email",
      "started_by",
      "expires_at",
      "tries_left",
      "created_at",
    ])
    .where("customer_id", "=", customerId)
    .where("confirmed_at", "is", null)
    .where("ended_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    newEmail: row.new_email,
    oldEmail: row.old_email,
    startedBy: row.started_by,
    expiresAt: row.expires_at,
    triesLeft: row.tries_left,
    createdAt: row.created_at,
  };
}

/** The account a change is for: active and linked to a Person, or null. */
async function changeableAccount(db: Kysely<CoreDatabase>, customerId: string) {
  return db
    .selectFrom("core_customer")
    .select(["id", "email", "person_id", "status", "link_state"])
    .where("id", "=", customerId)
    .executeTakeFirst();
}

/**
 * Sends one message as the host's sign-in mail (ADR 0456), the kind that applies at once. Only
 * a send that went out counts: one queued for review would put a code where an approver reads it
 * (ADR 0455), so it is a failure, and the code it carries is never stored.
 */
async function sendHostMail(
  ctx: HandlerContext,
  message: { to: string; subject: string; text: string },
): Promise<void> {
  if (!ctx.integrations?.callAsHost) {
    throw new ConfigError("The host's mail is not reachable here (no integration host)");
  }
  const state = await signInMailState(ctx.db, ctx.floor);
  if (!state.ready) {
    throw new ConfigError(`Changing a sign-in address is not set up here: ${state.problem}`);
  }
  const target = await customerCodeTarget(ctx.db);
  if ("problem" in target) {
    throw new ConfigError(`Changing a sign-in address is not set up here: ${target.problem}`);
  }
  const outcome = await sendEmail(
    signInMailCall(ctx.integrations, "system.customer-mail"),
    target.target,
    message,
  );
  if (outcome.status !== "sent") {
    throw new OperationError("integration_error", "The code could not be sent: try again later");
  }
}

/** Refuses a request over the per-account or per-mailbox limit. The same for every address. */
async function checkRequestLimits(
  db: Kysely<CoreDatabase>,
  customerId: string,
  mailbox: string,
  now: string,
): Promise<void> {
  const at = Date.parse(now);
  const hourAgo = new Date(at - 3_600_000).toISOString();
  const windowAgo = new Date(at - EMAIL_CHANGE_CODE_MINUTES * 60_000).toISOString();
  const [account, box] = await Promise.all([
    db
      .selectFrom("core_customer_email_change")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("customer_id", "=", customerId)
      .where("created_at", ">", hourAgo)
      .executeTakeFirst(),
    db
      .selectFrom("core_customer_email_change")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("new_mailbox", "=", mailbox)
      .where("created_at", ">", windowAgo)
      .executeTakeFirst(),
  ]);
  if (Number(account?.n ?? 0) >= EMAIL_CHANGE_ACCOUNT_LIMIT) {
    throw new RateLimitedError("Too many address changes asked for: try again in an hour", {
      retryAfterSeconds: 3600,
    });
  }
  if (Number(box?.n ?? 0) >= EMAIL_CHANGE_MAILBOX_LIMIT) {
    throw new RateLimitedError("Too many codes asked for this address: try again shortly", {
      retryAfterSeconds: EMAIL_CHANGE_CODE_MINUTES * 60,
    });
  }
}

export interface StartedEmailChange {
  /** The address the code went to. */
  newEmail: string;
  /** When the code stops working. */
  expiresAt: string;
}

/**
 * Starts a change of account `customerId`'s sign-in address to `email`: the code is emailed to
 * it, and the open change (if any) is replaced, in the caller's batch. Whether the address is in
 * use is never looked at here. `startedBy` is `customer` or the staff user's id.
 */
export async function startEmailChange(
  ctx: HandlerContext,
  customerId: string,
  email: string,
  startedBy: string,
): Promise<StartedEmailChange> {
  const address = normaliseCustomerEmail(email);
  if (!address) throw new ValidationError("Not an email address", { field: "email" });
  const account = await changeableAccount(ctx.db, customerId);
  if (!account || account.link_state !== "linked" || !account.person_id) {
    throw new ConflictError("This account is not linked to a person yet", { rule: "not_linked" });
  }
  if (account.status !== "active") {
    throw new ConflictError("This account is disabled: enable it first", { rule: "disabled" });
  }
  if (address === account.email) {
    throw new ValidationError("This is already the sign-in address", { field: "email" });
  }
  const mailbox = mailboxKey(address);
  await checkRequestLimits(ctx.db, customerId, mailbox, ctx.now);

  const id = newId("emailChange");
  const code = newCode();
  const expiresAt = new Date(
    Date.parse(ctx.now) + EMAIL_CHANGE_CODE_MINUTES * 60_000,
  ).toISOString();
  // Sent before anything is written: a code that did not go out is never stored. One sent whose
  // batch then fails is a code that works for nothing.
  await sendHostMail(ctx, { to: address, ...emailChangeCodeEmail(code) });
  ctx.write(
    ctx.db
      .updateTable("core_customer_email_change")
      .set({ ended_at: ctx.now, end_reason: "replaced" })
      .where("customer_id", "=", customerId)
      .where("confirmed_at", "is", null)
      .where("ended_at", "is", null),
    ctx.db.insertInto("core_customer_email_change").values({
      id,
      customer_id: customerId,
      new_email: address,
      new_mailbox: mailbox,
      old_email: account.email,
      started_by: startedBy,
      code_hash: await codeHash(id, code),
      expires_at: expiresAt,
      tries_left: EMAIL_CHANGE_TRIES,
      created_at: ctx.now,
    }),
  );
  return { newEmail: address, expiresAt };
}

/** Ends the account's open change as `cancelled`, in the caller's batch. Null when none. */
export async function cancelEmailChange(
  ctx: HandlerContext,
  customerId: string,
): Promise<EmailChange | null> {
  const open = await openEmailChange(ctx.db, customerId);
  if (!open) return null;
  ctx.write(
    ctx.db
      .updateTable("core_customer_email_change")
      .set({ ended_at: ctx.now, end_reason: "cancelled" })
      .where("id", "=", open.id)
      .where("confirmed_at", "is", null)
      .where("ended_at", "is", null),
  );
  return open;
}

/** Whether another Person, another account or the erased-address list holds `address`. */
export async function addressInUse(
  db: Kysely<CoreDatabase>,
  address: string,
  own: { customerId: string; personId: string },
): Promise<boolean> {
  const person = await db
    .selectFrom("core_person_emails")
    .select("person_id")
    .where("email", "=", address)
    .where("live", "=", 1)
    .where("person_id", "!=", own.personId)
    .executeTakeFirst();
  if (person) return true;
  const account = await db
    .selectFrom("core_customer")
    .select("id")
    .where("email", "=", address)
    .where("id", "!=", own.customerId)
    .executeTakeFirst();
  if (account) return true;
  return (await erasedAddresses(db, [address])).size > 0;
}

export interface ConfirmedEmailChange {
  change: EmailChange;
  /** Other sessions ended (web and app). */
  sessionsEnded: number;
}

/**
 * Confirms the account's open change with `code`, for the account's own call (a customer's
 * `hostInternal` operation: `ctx.db` and the write queue are the host's). A try is spent first, at
 * once and on its own (a refusal commits nothing else), so racing guesses still count; the fifth
 * wrong one ends the change. A right code with an address in use ends it too and changes nothing.
 * Otherwise the change is queued in the caller's batch.
 */
export async function confirmEmailChange(
  ctx: HandlerContext,
  own: { customerId: string; personId: string },
  code: string,
): Promise<ConfirmedEmailChange> {
  const open = await openEmailChange(ctx.db, own.customerId);
  if (!open) throw new ValidationError(NOT_RIGHT, { rule: "code" });
  const spent = await ctx.db
    .updateTable("core_customer_email_change")
    .set((eb) => ({ tries_left: eb("tries_left", "-", 1) }))
    .where("id", "=", open.id)
    .where("tries_left", ">", 0)
    .where("confirmed_at", "is", null)
    .where("ended_at", "is", null)
    .where("expires_at", ">", ctx.now)
    .returning("tries_left")
    .executeTakeFirst();
  if (!spent) throw new ValidationError(NOT_RIGHT, { rule: "code" });
  const row = await ctx.db
    .selectFrom("core_customer_email_change")
    .select("code_hash")
    .where("id", "=", open.id)
    .executeTakeFirstOrThrow();
  if (!/^\d{6}$/.test(code) || (await codeHash(open.id, code)) !== row.code_hash) {
    if (spent.tries_left <= 0) {
      await ctx.db
        .updateTable("core_customer_email_change")
        .set({ ended_at: ctx.now, end_reason: "tries" })
        .where("id", "=", open.id)
        .where("ended_at", "is", null)
        .where("confirmed_at", "is", null)
        .execute();
    }
    throw new ValidationError(NOT_RIGHT, { rule: "code", triesLeft: spent.tries_left });
  }

  // The mailbox is proved: only now is its holder told the address is taken.
  const account = await changeableAccount(ctx.db, own.customerId);
  if (
    !account ||
    account.status !== "active" ||
    account.person_id !== own.personId ||
    account.email !== open.oldEmail ||
    (await addressInUse(ctx.db, open.newEmail, own))
  ) {
    await ctx.db
      .updateTable("core_customer_email_change")
      .set({ ended_at: ctx.now, end_reason: "in_use" })
      .where("id", "=", open.id)
      .where("ended_at", "is", null)
      .where("confirmed_at", "is", null)
      .execute();
    throw new ConflictError("This address is already in use at the business", {
      rule: "address_in_use",
    });
  }

  // The Person: the new address first and primary, the old sign-in address gone, the rest kept.
  const emails = await ctx.db
    .selectFrom("core_person_emails")
    .select(["email", "label"])
    .where("person_id", "=", own.personId)
    .orderBy("position")
    .execute();
  const kept = emails.filter((e) => e.email !== open.oldEmail && e.email !== open.newEmail);
  const label = emails.find((e) => e.email === open.oldEmail)?.label ?? null;
  // The Person writer is the host's here (ADR 0428): it reads org-wide, as the seam's own writes
  // do, and what it records is the host's own change, for the customer. Object.create, not a
  // spread: the context's staff-only getters must not be read.
  // Loaded lazily: the operations import this module, and the seam reaches it.
  const { updatePerson } = await import("../operations/person.ts");
  const { orgReader } = await import("../visibility/index.ts");
  const host = Object.create(ctx, {
    principal: { value: orgReader(ctx.db).principal },
    onBehalfOf: { value: ctx.principal },
    recordChange: {
      value: (change: Parameters<HandlerContext["recordChange"]>[0]) =>
        recordHostChange(ctx, change),
    },
  }) as HandlerContext;
  await updatePerson(host, own.personId, {
    emails: [
      { email: open.newEmail, label, primary: true },
      ...kept.map((e) => ({ email: e.email, label: e.label, primary: false })),
    ],
  });

  // Every other session ends; the one that entered the code stays.
  const current = ctx.origin.sessionId ?? "";
  const [browsers, devices] = await Promise.all([
    ctx.db
      .selectFrom("core_customer_session")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("customer_id", "=", own.customerId)
      .where("id", "!=", current)
      .executeTakeFirst(),
    ctx.db
      .selectFrom("core_device_session")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("customer_id", "=", own.customerId)
      .where("id", "!=", current)
      .executeTakeFirst(),
  ]);
  ctx.write(
    ctx.db
      .updateTable("core_customer")
      .set({ email: open.newEmail, email_verified: 1, updated_at: ctx.now })
      .where("id", "=", own.customerId)
      .where("email", "=", open.oldEmail),
    ctx.db
      .updateTable("core_customer_email_change")
      .set({ confirmed_at: ctx.now })
      .where("id", "=", open.id)
      .where("confirmed_at", "is", null)
      .where("ended_at", "is", null),
    ctx.db
      .deleteFrom("core_customer_session")
      .where("customer_id", "=", own.customerId)
      .where("id", "!=", current),
    ctx.db
      .deleteFrom("core_device_session")
      .where("customer_id", "=", own.customerId)
      .where("id", "!=", current),
    // A sign-in code still waiting for the old address signs nobody in to this account now.
    ctx.db
      .deleteFrom("core_customer_verification")
      .where("identifier", "=", `sign-in-otp-${open.oldEmail}`),
  );
  recordHostChange(ctx, {
    object: "customer",
    id: own.customerId,
    action: "update",
    before: { email: open.oldEmail },
    after: { email: open.newEmail },
  });
  // On the Person's timeline, naming no address: erase then has nothing of it to find there.
  ctx.postActivity({
    subject: "Sign-in address changed",
    payload: {
      kind: "sign_in_address",
      action: "changed",
      startedBy: open.startedBy === "customer" ? "customer" : "staff",
    },
    links: [{ object: "person", id: own.personId }],
  });
  return {
    change: open,
    sessionsEnded: Number(browsers?.n ?? 0) + Number(devices?.n ?? 0),
  };
}

/**
 * After the commit: the notice to the old address, and the provider given the new one. Neither
 * undoes the change when it fails; each failure is logged. Never throws.
 */
export async function afterEmailChanged(
  ctx: HandlerContext,
  personId: string,
  change: EmailChange,
): Promise<{ oldAddressTold: boolean; providerCustomers: number }> {
  let oldAddressTold = false;
  try {
    await sendHostMail(ctx, { to: change.oldEmail, ...emailChangedEmail(change.newEmail) });
    oldAddressTold = true;
  } catch (error) {
    console.error(
      "sign-in address changed, but the old address was not told",
      error instanceof Error ? error.message : error,
    );
  }
  let providerCustomers = 0;
  try {
    providerCustomers = await giveProviderNewEmail(ctx, personId, change);
  } catch (error) {
    console.error(
      "sign-in address changed, but the payment provider was not given it",
      error instanceof Error ? error.message : error,
    );
  }
  return { oldAddressTold, providerCustomers };
}

/**
 * Gives the payment provider the new address for every provider customer `personId` pays through
 * (one per subscription a guest started, ADR 0487). Returns how many were asked. Nothing to do,
 * and no payments connection needed, when they pay nothing.
 */
async function giveProviderNewEmail(
  ctx: HandlerContext,
  personId: string,
  change: EmailChange,
): Promise<number> {
  const rows = await ctx.db
    .selectFrom("core_subscription")
    .select(["provider", "customer_ref"])
    .distinct()
    .where("payer_person_id", "=", personId)
    .where("customer_ref", "is not", null)
    .limit(PROVIDER_CUSTOMERS_MAX)
    .execute();
  if (!rows.length) return 0;
  // Loaded lazily: the orders module reaches this one.
  const { callSubscriptionGatekeeper, paymentsTarget } = await import("../orders/gateway.ts");
  const target = await paymentsTarget(ctx.db);
  let asked = 0;
  for (const row of rows) {
    if (row.provider !== target.provider || !row.customer_ref) continue;
    await callSubscriptionGatekeeper(ctx.integrations, target, "updateCustomerEmail", {
      customerRef: row.customer_ref,
      email: change.newEmail,
      changeId: change.id,
    });
    asked += 1;
  }
  return asked;
}
