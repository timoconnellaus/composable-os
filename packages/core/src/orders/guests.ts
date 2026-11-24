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
import { normaliseCustomerEmail } from "../customers/accounts.ts";
import { personForAddress } from "../customers/address-person.ts";
import { sha256Hex, toHex } from "../digest.ts";
import type { HandlerContext } from "../operation.ts";
import type { OrderRow } from "./orders.ts";

/** A new token for one order: 256 random bits, as 64 hex characters. */
export function newOrderToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export const ORDER_TOKEN = /^[0-9a-f]{64}$/;

export function hashOrderToken(token: string): Promise<string> {
  return sha256Hex(token);
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
 * Whose order a guest's is, from the address they gave (the shared matcher, ADR 0721). Queues, in
 * the calling operation's batch, the Person it creates (no match) or the notice to admins (several
 * matches). Refuses an address that is not one, and an erased person's address (the erased-address
 * list), with the same words for both.
 */
export async function resolveBuyer(ctx: HandlerContext, address: string): Promise<Buyer> {
  return personForAddress(ctx, address, {
    several: {
      title: "An order was placed with an address several people have",
      body: (count, email) =>
        `${count} people have ${email}. The order belongs to none of them yet: merge ` +
        "them, then set the order's person.",
      dedupeKey: `order.several_people:${normaliseCustomerEmail(address) ?? address}`,
    },
  });
}
