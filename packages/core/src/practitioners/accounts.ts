// Practitioner accounts (stage 43 step 3, ADR 0581): an outside person the business invited (a
// physiotherapist, a dietitian), with their own sign-in. Who may be sent a sign-in code, what a
// first sign-in does, and which principal a session resolves to. Sign-in itself is not an
// operation: it is the practitioner Better Auth configuration in packages/auth, which calls these
// functions. Inviting, listing and ending are operations (operations/practitioner.ts).
//
// - A code goes to an address whose practitioner account is `invited` or `active`, and to nobody
//   else; the answer to a code request is the same either way (packages/auth).
// - A session resolves to a practitioner only while the account is `active`. An ended account's
//   sessions are deleted in the batch that ends it; one left anyway resolves to no one.
// - Nothing here reads the same human's staff account (core_user) or customer account
//   (core_customer): each sign-in is one hat (decision 16).
import type { CoreDatabase, PractitionerStatus } from "@composable-os/db";
import type { Compilable, Kysely } from "kysely";
import { normaliseStaffEmail } from "../invites.ts";
import type { PractitionerPrincipal } from "../principals.ts";

/** The address as practitioner accounts store it (lower-cased, trimmed), or null. */
export function normalisePractitionerEmail(email: string): string | null {
  return normaliseStaffEmail(email);
}

export interface PractitionerAccount {
  id: string;
  personId: string;
  email: string;
  name: string;
  discipline: string;
  practiceId: string | null;
  status: PractitionerStatus;
}

const COLUMNS = [
  "id",
  "person_id",
  "email",
  "name",
  "discipline",
  "practice_id",
  "status",
] as const;

function toAccount(row: {
  id: string;
  person_id: string;
  email: string;
  name: string;
  discipline: string;
  practice_id: string | null;
  status: PractitionerStatus;
}): PractitionerAccount {
  return {
    id: row.id,
    personId: row.person_id,
    email: row.email,
    name: row.name,
    discipline: row.discipline,
    practiceId: row.practice_id,
    status: row.status,
  };
}

/** The practitioner account `id`, in any state, or null. */
export async function loadPractitioner(
  db: Kysely<CoreDatabase>,
  id: string,
): Promise<PractitionerAccount | null> {
  const row = await db
    .selectFrom("core_practitioner")
    .select(COLUMNS)
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? toAccount(row) : null;
}

/** The practitioner account with this sign-in address, in any state, or null. */
export async function loadPractitionerByEmail(
  db: Kysely<CoreDatabase>,
  email: string,
): Promise<PractitionerAccount | null> {
  const address = normalisePractitionerEmail(email);
  if (!address) return null;
  const row = await db
    .selectFrom("core_practitioner")
    .select(COLUMNS)
    .where("email", "=", address)
    .executeTakeFirst();
  return row ? toAccount(row) : null;
}

/**
 * Whether a practitioner sign-in code may be sent to `email`: an account that is `invited` (its
 * first sign-in) or `active`. Never an ended one, and never an address with no account: an
 * invite is the only way an account is made.
 */
export async function practitionerMayGetCode(
  db: Kysely<CoreDatabase>,
  email: string,
): Promise<boolean> {
  const account = await loadPractitionerByEmail(db, email);
  return account?.status === "invited" || account?.status === "active";
}

/**
 * What a sign-in records: the account becomes `active` at its first sign-in (from `invited`), and
 * when it signed in. Conditional on the account not being ended, so an end committed meanwhile is
 * never undone.
 */
export function practitionerSignedInStatement(
  db: Kysely<CoreDatabase>,
  id: string,
  now: string,
): Compilable {
  return db
    .updateTable("core_practitioner")
    .set((eb) => ({
      status: "active",
      activated_at: eb.fn.coalesce("activated_at", eb.val(now)),
      last_sign_in_at: now,
      updated_at: now,
    }))
    .where("id", "=", id)
    .where("status", "in", ["invited", "active"]);
}

/**
 * The principal a practitioner session is for: the account's, while it is `active`; else none.
 * Read at every request, never cached, so ending an account stops its next call.
 */
export async function practitionerPrincipalFor(
  db: Kysely<CoreDatabase>,
  practitionerId: string,
): Promise<PractitionerPrincipal | null> {
  const account = await loadPractitioner(db, practitionerId);
  if (account?.status !== "active") return null;
  return Object.freeze({
    kind: "practitioner",
    practitionerId: account.id,
    personId: account.personId,
  });
}

/**
 * The statements that end a practitioner's sessions and unused sign-in codes, for the batch that
 * ends the account (or anything else that must stop them at once).
 */
export function endPractitionerSessionsStatements(
  db: Kysely<CoreDatabase>,
  account: Pick<PractitionerAccount, "id" | "email">,
): Compilable[] {
  return [
    db.deleteFrom("core_practitioner_session").where("practitioner_id", "=", account.id),
    db
      .deleteFrom("core_practitioner_verification")
      .where("identifier", "=", `sign-in-otp-${account.email}`),
  ];
}
