// Customer accounts (stage 22 step 4, ADR 0402): who may be sent a sign-in code, invites, and
// linking an account to its Person at first sign-in. Sign-in itself is not an operation: it is
// the customer Better Auth configuration in packages/auth, which calls these functions.
//
// Linking reads people only through the existing same-email rule (`checkPerson`, ADR 0247), and
// creates a Person only through `person.create`, so uniqueness, search, assignment and audit hold
// as for any Person.
import type { CoreDatabase, CrmDb, CustomerLinkState } from "@composable-os/db";
import type { Compilable, Kysely } from "kysely";
import { z } from "zod";
import { checkPerson } from "../duplicates/check.ts";
import { ConfigError, ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { ActingUser, Role } from "../principals.ts";
import { erasedAddresses } from "../sync/ingest.ts";
import { loadCustomerSignup } from "./settings.ts";

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(320));

/** The address as accounts, invites and people store it (lower-cased, trimmed), or null. */
export function normaliseCustomerEmail(email: string): string | null {
  const parsed = emailSchema.safeParse(email);
  return parsed.success ? parsed.data : null;
}

export interface CustomerAccount {
  id: string;
  personId: string | null;
  email: string;
  status: "active" | "disabled";
  linkState: CustomerLinkState;
}

function toAccount(row: {
  id: string;
  person_id: string | null;
  email: string;
  status: "active" | "disabled";
  link_state: CustomerLinkState;
}): CustomerAccount {
  return {
    id: row.id,
    personId: row.person_id,
    email: row.email,
    status: row.status,
    linkState: row.link_state,
  };
}

const ACCOUNT_COLUMNS = ["id", "person_id", "email", "status", "link_state"] as const;

export async function loadCustomer(
  db: Kysely<CoreDatabase>,
  id: string,
): Promise<CustomerAccount | null> {
  const row = await db
    .selectFrom("core_customer")
    .select(ACCOUNT_COLUMNS)
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? toAccount(row) : null;
}

/**
 * The address a customer signs in with: the one the emailed code went to and was verified on
 * (stage 22). Not the Person's contact email, which staff can change: this is the only address
 * a client may trust to be the customer's own, for linking records it keeps elsewhere.
 */
export interface CustomerSignIn {
  email: string;
  verified: boolean;
}

/** The sign-in address of the account `customerId`, while it is active and linked. */
export async function loadCustomerSignIn(
  db: Kysely<CoreDatabase>,
  customerId: string,
  personId: string,
): Promise<CustomerSignIn | null> {
  const row = await db
    .selectFrom("core_customer")
    .select(["email", "email_verified"])
    .where("id", "=", customerId)
    .where("person_id", "=", personId)
    .where("status", "=", "active")
    .executeTakeFirst();
  return row ? { email: row.email, verified: row.email_verified === 1 } : null;
}

export async function loadCustomerByEmail(
  db: Kysely<CoreDatabase>,
  email: string,
): Promise<CustomerAccount | null> {
  const address = normaliseCustomerEmail(email);
  if (!address) return null;
  const row = await db
    .selectFrom("core_customer")
    .select(ACCOUNT_COLUMNS)
    .where("email", "=", address)
    .executeTakeFirst();
  return row ? toAccount(row) : null;
}

async function isErased(db: Kysely<CoreDatabase>, address: string): Promise<boolean> {
  return (await erasedAddresses(db, [address])).size > 0;
}

/**
 * Whether a sign-in code may be sent to `email`, and so whether it may sign in or sign up. The
 * caller answers the same whatever this says, and sends nothing when it is false, so the form
 * cannot tell anyone who is a customer.
 *
 * - An erased person's address: never (checked as `sync.ingest` does).
 * - An address with an account: while the account is active.
 * - Any other address: when sign-up is `open`, or staff invited it, or, when sign-up is `buyers`
 *   (ADR 0458), it is the buyer's address of an order a verified payment was applied to.
 */
export async function customerMayGetCode(
  db: Kysely<CoreDatabase>,
  email: string,
): Promise<boolean> {
  const address = normaliseCustomerEmail(email);
  if (!address) return false;
  if (await isErased(db, address)) return false;
  const account = await loadCustomerByEmail(db, address);
  if (account) return account.status === "active";
  const signup = await loadCustomerSignup(db);
  if (signup === "open") return true;
  const invite = await db
    .selectFrom("core_customer_invite")
    .select("email")
    .where("email", "=", address)
    .executeTakeFirst();
  if (invite) return true;
  return signup === "buyers" && (await hasBought(db, address));
}

/**
 * Whether `address` is the buyer's address of an order a verified payment was applied to
 * (`paid > 0`, ADR 0458): paid and part-paid orders, and ones refunded or cancelled after a
 * payment. Never a checkout that was only started (pending, expired, cancelled unpaid): starting
 * one costs nothing, so it cannot make an address able to sign in.
 */
export async function hasBought(db: Kysely<CoreDatabase>, address: string): Promise<boolean> {
  const row = await db
    .selectFrom("core_order")
    .select("id")
    .where("email", "=", address)
    .where("paid", ">", 0)
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * The statement that invites `email` (or renews its invite), for a caller's batch. Throws a
 * ValidationError for an address that is not one or that belongs to an erased person: erasure
 * took the address out of the CRM, and an invite would put it back.
 */
export async function inviteCustomerStatement(
  db: Kysely<CoreDatabase>,
  email: string,
  invitedByUserId: string,
  now: string,
): Promise<{ email: string; statement: Compilable }> {
  const address = normaliseCustomerEmail(email);
  if (!address) throw new ValidationError("Not an email address", { field: "email" });
  if (await isErased(db, address)) {
    throw new ValidationError("This address belongs to an erased person", { field: "email" });
  }
  const statement = db
    .insertInto("core_customer_invite")
    .values({ email: address, invited_by: invitedByUserId, invited_at: now })
    .onConflict((oc) =>
      oc.column("email").doUpdateSet({ invited_by: invitedByUserId, invited_at: now }),
    );
  return { email: address, statement };
}

/** Invites `email` to sign up while sign-up is invite only (customer.invite wraps it). */
export async function inviteCustomer(
  db: CrmDb,
  email: string,
  invitedByUserId: string,
  now: string = new Date().toISOString(),
): Promise<{ email: string }> {
  const { email: address, statement } = await inviteCustomerStatement(
    db.query,
    email,
    invitedByUserId,
    now,
  );
  await db.batch([statement]);
  return { email: address };
}

// --- Linking at first sign-in -------------------------------------------------------------------

/** The operation name linking is audited under. It is not in the registry: nobody can call it. */
export const CUSTOMER_LINK_AUDIT = "customer.link";

export interface LinkResult {
  linkState: CustomerLinkState;
  personId: string | null;
  /** True when no Person had the address and one was created. */
  created: boolean;
  /** Why the account was not linked, when it was not. */
  reason?: "several_people" | "person_has_account";
}

/** The live people the same-email rule matches for `address` (ADR 0247), by id. */
export async function sameEmailPeople(
  db: Kysely<CoreDatabase>,
  address: string,
): Promise<string[]> {
  const { conflicts } = await checkPerson(db, { emails: [address] });
  return [...new Set(conflicts.map((c) => c.id))];
}

/**
 * The staff user a Person created at sign-in is created for. `core_person.created_by` names a
 * `core_user`, so the system user cannot create one: it is created for the admin who invited the
 * address, or, when sign-up is open or the inviter is gone, for the first active admin. The call
 * is made with actor `automation` and origin `customer.link`, as notification delivery acts for a
 * connection's owner.
 */
export async function creatorFor(
  db: Kysely<CoreDatabase>,
  address: string,
): Promise<ActingUser | null> {
  const active = db
    .selectFrom("core_user")
    .select(["id", "email", "name", "role"])
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null);
  const invite = await db
    .selectFrom("core_customer_invite")
    .select("invited_by")
    .where("email", "=", address)
    .executeTakeFirst();
  const row =
    (invite ? await active.where("id", "=", invite.invited_by).executeTakeFirst() : undefined) ??
    (await active.where("role", "=", "admin").orderBy("id").limit(1).executeTakeFirst());
  return row ? { id: row.id, email: row.email, name: row.name, role: row.role as Role } : null;
}

/** Creates a Person with only the address, through `person.create`. */
async function createPersonFor(db: CrmDb, address: string, customerId: string, now: Date) {
  const user = await creatorFor(db.query, address);
  if (!user) throw new ConfigError("There is no admin to create the customer's Person for");
  // Loaded lazily: invoke.ts imports every operation, and this module is reachable from one.
  const { invoke } = await import("../invoke.ts");
  const person = await invoke(
    "person.create",
    { emails: [{ email: address, primary: true }] },
    {
      actor: "automation",
      user,
      origin: { surface: "system", automationId: CUSTOMER_LINK_AUDIT, sessionId: customerId },
      db,
      clock: () => now,
    },
  );
  return person.id;
}

/**
 * Links a customer account to its Person, at sign-in. Does nothing for an account that is
 * already linked.
 *
 * The verified address is matched to people by the same-email rule:
 * - exactly one live Person: the account links to it;
 * - none: a Person is created with the address, and the account links to it;
 * - several, or one that already has another account: nothing links, the account is marked
 *   `needs_merge` (it resolves to no customer until staff sort it out and the person signs in
 *   again), and every admin is notified.
 *
 * The outcome is audited as actor `customer`, with the account in `user_id`.
 */
export async function linkCustomer(
  db: CrmDb,
  customerId: string,
  now: Date = new Date(),
): Promise<LinkResult> {
  const account = await loadCustomer(db.query, customerId);
  if (!account) throw new NotFoundError("customer", customerId);
  if (account.personId && account.linkState === "linked") {
    return { linkState: "linked", personId: account.personId, created: false };
  }
  if (await isErased(db.query, account.email)) {
    throw new ValidationError("This address belongs to an erased person");
  }

  let matches = await sameEmailPeople(db.query, account.email);
  let created = false;
  if (matches.length === 0) {
    try {
      matches = [await createPersonFor(db, account.email, account.id, now)];
      created = true;
    } catch (error) {
      // Someone created a Person with the address meanwhile (live emails are unique): use it.
      if (!(error instanceof ConflictError)) throw error;
      matches = await sameEmailPeople(db.query, account.email);
      if (!matches.length) throw error;
    }
  }

  let result: LinkResult;
  if (matches.length === 1) {
    const personId = matches[0] as string;
    const holder = await db.query
      .selectFrom("core_customer")
      .select("id")
      .where("person_id", "=", personId)
      .where("id", "!=", account.id)
      .executeTakeFirst();
    result = holder
      ? { linkState: "needs_merge", personId: null, created, reason: "person_has_account" }
      : { linkState: "linked", personId, created };
  } else {
    result = { linkState: "needs_merge", personId: null, created, reason: "several_people" };
  }

  const at = now.toISOString();
  const statements: Compilable[] = [
    db.query
      .updateTable("core_customer")
      .set({ person_id: result.personId, link_state: result.linkState, updated_at: at })
      .where("id", "=", account.id),
    db.query.insertInto("core_audit").values({
      id: newId("audit"),
      at,
      operation: CUSTOMER_LINK_AUDIT,
      risk: "write",
      actor: "customer",
      user_id: account.id,
      origin: JSON.stringify({ surface: "client" }),
      input: JSON.stringify({ customerId: account.id }),
      result: JSON.stringify({
        linkState: result.linkState,
        personId: result.personId,
        created: result.created,
        ...(result.reason ? { reason: result.reason, people: matches } : {}),
      }),
      gate_decision: "auto",
      outcome: "ok",
      error: null,
    }),
  ];
  if (result.linkState === "needs_merge") {
    const body =
      result.reason === "several_people"
        ? `${account.email} signed in to their customer account, and ${matches.length} people ` +
          "have this address. Merge them: the account links at the next sign-in."
        : `${account.email} signed in to a new customer account, and the person with this ` +
          "address already has another one. Disable one account, then ask them to sign in again.";
    const plan = await notifyStatements(
      db.query,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title: "A customer account needs a merge",
        body,
        link: matches[0] ? { kind: "record", object: "person", id: matches[0] } : null,
        dedupeKey: `customer.needs_merge:${account.id}`,
        source: { actor: "system" },
      },
      at,
    );
    statements.push(...plan.statements);
  }
  await db.batch(statements);
  return result;
}

/** Records a sign-in on the account. */
export function customerSignedInStatement(
  db: Kysely<CoreDatabase>,
  customerId: string,
  now: string,
): Compilable {
  return db
    .updateTable("core_customer")
    .set({ last_sign_in_at: now, updated_at: now })
    .where("id", "=", customerId);
}
