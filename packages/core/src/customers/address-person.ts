// Whose an address someone outside the org typed is (ADR 0428, shared by ADR 0721): the address
// is matched by the same-email rule stage 22 uses at sign-in (ADR 0247). One live Person with it
// is theirs; none creates one, in the calling operation's batch; several link to no one and admins
// are told to merge them. An address that is not one, and an erased person's address, are refused
// with the same words. Nothing here returns a Person to the caller.
//
// A guest's order (`resolveBuyer`, orders/guests.ts) and the submitter of a form
// (`intake/person.ts`) both use it; neither copies it.
import { ConfigError, ValidationError } from "../errors.ts";
import { notifyStatements } from "../notifications/send.ts";
import { type HandlerContext, type RecordChange, recordHostChange } from "../operation.ts";
import { staffPrincipal } from "../principals.ts";
import { erasedAddresses } from "../sync/ingest.ts";
import { creatorFor, normaliseCustomerEmail, sameEmailPeople } from "./accounts.ts";

/** The words an address the host will not use is refused with, whatever the reason. */
export const ADDRESS_REFUSED = "That email address cannot be used";

export interface AddressPerson {
  /** The address, normalised. */
  email: string;
  /** Whose it is; null when the address matches several people. */
  personId: string | null;
  /** True when no Person had the address and one is being created in this batch. */
  created: boolean;
}

export interface AddressPersonOptions {
  /** The notice admins get when several People have the address (`{n}` and `{email}` filled). */
  several: { title: string; body: (count: number, email: string) => string; dedupeKey: string };
  /** What a Person created for the address starts with besides it (a name, a phone). */
  create?: { displayName?: string | undefined; phone?: string | undefined };
}

/** The address normalised, or the refusal: not an address, or an erased person's. */
export async function usableAddress(ctx: HandlerContext, address: string): Promise<string> {
  const email = normaliseCustomerEmail(address);
  const refused = () => new ValidationError(ADDRESS_REFUSED, { field: "email" });
  if (!email) throw refused();
  if ((await erasedAddresses(ctx.db, [email])).size > 0) throw refused();
  return email;
}

/**
 * Whose `address` is. Queues, in the calling operation's batch, the Person it creates (no match)
 * or the notice to admins (several matches). Refuses an address that is not one, and an erased
 * person's address, with the same words for both.
 */
export async function personForAddress(
  ctx: HandlerContext,
  address: string,
  options: AddressPersonOptions,
): Promise<AddressPerson> {
  const email = await usableAddress(ctx, address);
  const matches = await sameEmailPeople(ctx.db, email);
  if (matches.length === 1) return { email, personId: matches[0] as string, created: false };
  if (matches.length > 1) {
    const plan = await notifyStatements(
      ctx.db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title: options.several.title,
        body: options.several.body(matches.length, email),
        link: { kind: "record", object: "person", id: matches[0] as string },
        dedupeKey: options.several.dedupeKey,
        source: { actor: "system" },
      },
      ctx.now,
    );
    ctx.write(...plan.statements);
    return { email, personId: null, created: false };
  }

  // No one has the address: a Person is created with it, in this batch, by the code person.create
  // runs. `core_person.created_by` names a staff user, so it is created for the admin who invited
  // the address or the first active admin, as at a customer's first sign-in.
  const creator = await creatorFor(ctx.db, email);
  if (!creator) throw new ConfigError("There is no admin to create the Person for");
  // Loaded lazily: operations/person.ts is reachable from the modules that import this one.
  const { personCreate } = await import("../operations/person.ts");
  // A view of the context with a staff author. Not a spread: on an outside call the context has
  // members that throw when read.
  const asCreator = Object.create(ctx, {
    user: { value: creator },
    actor: { value: "automation" },
    principal: { value: staffPrincipal(creator) },
    // The Person is the host's to create for the caller: not the caller's write.
    recordChange: { value: (change: RecordChange) => recordHostChange(ctx, change) },
  }) as HandlerContext;
  const { displayName, phone } = options.create ?? {};
  const input = personCreate.input.parse({
    emails: [{ email, primary: true }],
    ...(displayName ? { displayName } : {}),
    ...(phone ? { phones: [{ number: phone, primary: true }] } : {}),
  });
  const person = (await personCreate.handler(input, asCreator)) as { id: string };
  return { email, personId: person.id, created: true };
}
