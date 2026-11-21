// Buying without an account (stage 25, ADR 0428): whose order a guest's is, and the guest's way
// back to that one order.
//
// The address a guest gives is matched to a Person by the same-email rule stage 22 uses at
// sign-in (ADR 0247): one match is that Person, none creates one, several link to no one and
// staff are told to merge. A guest never reads a Person: nothing here returns one to the caller.
//
// A guest reaches their order with a token: 32 random bytes, given once (in the answer to
// order.start, and in the confirmation email). Only its SHA-256 is stored, on the order. It opens
// that order and nothing else, while the order is open and for a while after it closes.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { creatorFor, normaliseCustomerEmail, sameEmailPeople } from "../customers/accounts.ts";
import { ConfigError, ValidationError } from "../errors.ts";
import { notifyStatements } from "../notifications/send.ts";
import { type HandlerContext, type RecordChange, recordHostChange } from "../operation.ts";
import { staffPrincipal } from "../principals.ts";
import { erasedAddresses } from "../sync/ingest.ts";
import type { OrderRow } from "./orders.ts";

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A new token for one order: 256 random bits, as 64 hex characters. */
export function newOrderToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
}

export const ORDER_TOKEN = /^[0-9a-f]{64}$/;

export async function hashOrderToken(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

/**
 * The order `token` opens, or null: the id and the token must both be this order's, and the
 * order open or closed less than the access window ago. A wrong id, a wrong token and an old
 * link are one answer.
 */
export async function orderForToken(
  db: Kysely<CoreDatabase>,
  id: string,
  token: string,
  now: string,
): Promise<OrderRow | null> {
  if (!ORDER_TOKEN.test(token)) return null;
  const hash = await hashOrderToken(token);
  const row = await db
    .selectFrom("core_order")
    .selectAll()
    // A guest's token from the start, or the confirmation email's (migration 0422).
    .where((eb) => eb.or([eb("access_hash", "=", hash), eb("email_link_hash", "=", hash)]))
    .executeTakeFirst();
  if (!row || row.id !== id) return null;
  if (row.access_until !== null && row.access_until <= now) return null;
  return row;
}

export interface Buyer {
  /** The address, normalised. */
  email: string;
  /** Whose order it will be; null when the address matches several people. */
  personId: string | null;
  /** True when no Person had the address and one is being created in this batch. */
  created: boolean;
}

/**
 * Whose order a guest's is, from the address they gave. Queues, in the calling operation's
 * batch, the Person it creates (no match) or the notice to admins (several matches). Refuses an
 * address that is not one, and an erased person's address (the erased-address list), with the
 * same words for both.
 */
export async function resolveBuyer(ctx: HandlerContext, address: string): Promise<Buyer> {
  const email = normaliseCustomerEmail(address);
  const refused = () =>
    new ValidationError("That email address cannot be used", { field: "email" });
  if (!email) throw refused();
  if ((await erasedAddresses(ctx.db, [email])).size > 0) throw refused();

  const matches = await sameEmailPeople(ctx.db, email);
  if (matches.length === 1) return { email, personId: matches[0] as string, created: false };
  if (matches.length > 1) {
    const plan = await notifyStatements(
      ctx.db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title: "An order was placed with an address several people have",
        body:
          `${matches.length} people have ${email}. The order belongs to none of them yet: merge ` +
          "them, then set the order's person.",
        link: { kind: "record", object: "person", id: matches[0] as string },
        dedupeKey: `order.several_people:${email}`,
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
  if (!creator) throw new ConfigError("There is no admin to create the buyer's Person for");
  // Loaded lazily: operations/person.ts is reachable from the modules that import this one.
  const { personCreate } = await import("../operations/person.ts");
  // A view of the context with a staff author. Not a spread: on a guest's call the context has
  // members that throw when read.
  const asCreator = Object.create(ctx, {
    user: { value: creator },
    actor: { value: "automation" },
    principal: { value: staffPrincipal(creator) },
    // The Person is the host's to create for the order: not the guest's write.
    recordChange: { value: (change: RecordChange) => recordHostChange(ctx, change) },
  }) as HandlerContext;
  const input = personCreate.input.parse({ emails: [{ email, primary: true }] });
  const person = (await personCreate.handler(input, asCreator)) as { id: string };
  return { email, personId: person.id, created: true };
}
