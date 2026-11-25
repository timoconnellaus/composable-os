// Every sender asks (stage 30, ADR 0678): the host's check on an email or a text that is not one
// of its own routine messages, asked at the integration host's approval queue (`contactCheck`,
// before a gatekeeper queues the send; again as any gatekeeper's send is submitted, for the kinds
// in integrations/sends.ts; and again when a person approves one that waited). No caller can skip
// it: a gatekeeper holds the queue, never a pack, a tool, an extension or a model.
//
// Who is sending decides what is asked:
// - **A person on the staff** (actor `human`), with no purpose declared: their own message to
//   whoever they write to (a reply, a one-to-one email). Only what holds for the address or number
//   whatever the message: the suppression list (a STOP, a provider's unsubscribe or bounce). A
//   child's own address only one to one (a coach's reply), never in a message to several.
// - **Anyone else** (an automation, a tool, the assistant, MCP, extension code), or a person who
//   declares a purpose: a `follow_up` or `news_and_offers` message, asked in full for each Person
//   with the purpose it declares, and carrying each Person's own stop link (made by the host when
//   the message goes, never seen by the sender). Without a purpose, a send to any address or
//   number a Person holds is refused (`purpose_required`). Never to a child's own address.
//
// Who an address is: the live People holding an address reaching the same mailbox (`mailboxKey`:
// the key the suppression list uses, `+tag` and Gmail's dots folded; `peopleAtAddresses`, the
// seam's read). A number: the People holding it (`peopleAtNumbers`). One holder: theirs. None:
// only the suppression list applies (and news and offers, which need a yes no one could have
// given, are refused). Several: a stoppable message is refused, since no one stop link would stop
// it for each of them; a staff member's own message goes.
//
// What the sender learns: only how many recipients were dropped, and when none is left the one
// plain refusal `recipient_stopped`, the same whatever the reason.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { mailboxKey } from "../customers/limits.ts";
import { ValidationError } from "../errors.ts";
import { loadRoutineMailSettings, siteOriginOf } from "../routine-mail/index.ts";
import { type AddressHolder, peopleAtAddresses, peopleAtNumbers } from "../visibility/guardians.ts";
import { choiceRefusal } from "./decide.ts";
import { type ChoicesInForce, choicesInForce } from "./register.ts";
import { stopTokens, stopUrl } from "./stop.ts";
import { addressHash, saltedHash, suppressedAmong } from "./suppression.ts";

type Db = Kysely<CoreDatabase>;

/** The purposes a sender that is not a person's own message declares (ADR 0675's vocabulary). */
export const SEND_PURPOSES = ["follow_up", "news_and_offers"] as const;
export type SendPurpose = (typeof SEND_PURPOSES)[number];

export function isSendPurpose(value: unknown): value is SendPurpose {
  return (SEND_PURPOSES as readonly unknown[]).includes(value);
}

/** The one plain refusal: whatever the reason, the same words. */
export const RECIPIENT_STOPPED = "recipient_stopped";
export const RECIPIENT_STOPPED_MESSAGE =
  "Refused: recipient_stopped. The recipient cannot be contacted this way; nothing was sent or queued.";
/** A send that names a Person and declares no purpose, through a gatekeeper that can take one. */
export const PURPOSE_REQUIRED = "purpose_required";
export const PURPOSE_REQUIRED_MESSAGE =
  "Refused: purpose_required. An email to a person from an automation, a tool, the assistant, MCP " +
  'or an extension declares its purpose: `purpose: "follow_up"` (an automatic message that is not ' +
  'an offer) or `purpose: "news_and_offers"` (promotional). The host adds each recipient\'s stop ' +
  "link. A fixed message about a record the person has (a booking, an order) is routine mail " +
  "(`ctx.routineMail.send`). Nothing was sent or queued.";
/** A stoppable send with nowhere for its stop link to point. */
export const STOP_LINK_NEEDS_SITE_MESSAGE =
  "Refused: a follow-up or news and offers email carries a stop link on the business's site, and " +
  "no site is set (Settings → Routine email). Nothing was sent or queued.";

/** Who is sending, for consent: a person's own message, or anyone else's. */
export type SenderStanding = "staff" | "other";

export interface SendQuestion {
  channel: "email" | "text";
  /** The addresses or numbers it would go to, as the sender named them. */
  recipients: readonly string[];
  sender: SenderStanding;
  /** What it is for, declared by the sender (never by the host for it). */
  purpose?: SendPurpose | null | undefined;
  /**
   * The message goes to these and no one else (null: unknown, as an MCP tool's arguments): a
   * person's own message to one address reaches a child's own address; one to several does not.
   */
  oneToOne?: boolean | undefined;
  /** Now (an instant). */
  at: string;
}

export interface SendRecipient {
  /** As the sender named it. */
  to: string;
  /** The one live Person who holds it, when one does. */
  person: string | null;
}

export interface SendAnswer {
  /** Who it may go to, in the order named, each once. */
  allowed: SendRecipient[];
  /** How many were not: nothing about why. */
  dropped: number;
  /** A sender that is not a person's own named a Person without declaring a purpose. */
  purposeRequired: boolean;
}

/** How the host keys a recipient: the mailbox an address reaches, a number's digits. */
export function recipientKey(channel: "email" | "text", to: string): string {
  return channel === "email"
    ? mailboxKey(to.trim().toLowerCase())
    : (to.trim().startsWith("+") ? "+" : "") + to.replace(/\D/g, "");
}

/**
 * The one check for a send that is not a routine message (ADR 0678). Reads, whatever the number
 * of recipients: the suppression list, who holds each address or number and the holders'
 * choices, each in one statement per 90. Writes nothing.
 */
export async function checkSend(db: Db, q: SendQuestion): Promise<SendAnswer> {
  return (await checkSends(db, [q]))[0] as SendAnswer;
}

/**
 * `checkSend` for several sends at once (the approvals inbox's page, an MCP call naming addresses
 * and numbers): every recipient of every send read together, in the same statements.
 */
export async function checkSends(db: Db, qs: readonly SendQuestion[]): Promise<SendAnswer[]> {
  const named = qs.map((q) => [...new Set(q.recipients.map((r) => r.trim()).filter(Boolean))]);
  const emails = new Set<string>();
  const numbers = new Set<string>();
  qs.forEach((q, i) => {
    for (const to of named[i] ?? []) {
      (q.channel === "email" ? emails : numbers).add(recipientKey(q.channel, to));
    }
  });
  const hash = new Map<string, string>();
  for (const key of emails) hash.set(`email:${key}`, await addressHash(db, key));
  for (const key of numbers) hash.set(`text:${key}`, await saltedHash(db, key));
  const stoppedEmail = emails.size
    ? await suppressedAmong(
        db,
        "email",
        [...emails].map((k) => hash.get(`email:${k}`) as string),
      )
    : new Set<string>();
  const stoppedText = numbers.size
    ? await suppressedAmong(
        db,
        "text",
        [...numbers].map((k) => hash.get(`text:${k}`) as string),
      )
    : new Set<string>();
  const byMailbox = emails.size ? await peopleAtAddresses(db, [...emails]) : new Map();
  const byNumber = numbers.size ? await peopleAtNumbers(db, [...numbers]) : new Map();
  const people = new Set<string>();
  if (qs.some((q) => q.purpose)) {
    for (const list of [...byMailbox.values(), ...byNumber.values()] as AddressHolder[][]) {
      for (const h of list) people.add(h.id);
    }
  }
  const choices: ChoicesInForce = people.size ? await choicesInForce(db, [...people]) : new Map();

  return qs.map((q, i) => {
    const list = named[i] ?? [];
    const allowed: SendRecipient[] = [];
    let purposeRequired = false;
    for (const to of list) {
      const key = recipientKey(q.channel, to);
      const suppressed =
        q.channel === "email"
          ? stoppedEmail.has(hash.get(`email:${key}`) as string)
          : stoppedText.has(hash.get(`text:${key}`) as string);
      if (suppressed) continue;
      const held: AddressHolder[] =
        (q.channel === "email" ? byMailbox.get(key) : byNumber.get(key)) ?? [];
      const verdict = decide(q, held, list.length, choices);
      if (verdict === "purpose") purposeRequired = true;
      else if (verdict !== "drop") allowed.push({ to, person: verdict.person });
    }
    return { allowed, dropped: list.length - allowed.length, purposeRequired };
  });
}

/** One recipient not on the suppression list: may it go, and whose is it. */
function decide(
  q: SendQuestion,
  held: readonly AddressHolder[],
  count: number,
  choices: ChoicesInForce,
): { person: string | null } | "drop" | "purpose" {
  const purpose = q.purpose ?? null;
  const person = held.length === 1 ? (held[0]?.id ?? null) : null;
  const child = held.some((h) => h.child);
  if (!purpose) {
    if (q.sender === "staff") {
      // A person's own message reaches a child's own address one to one (a coach's reply), never
      // in a message to several.
      if (child && !(q.oneToOne !== false && count === 1)) return "drop";
      return { person };
    }
    // Anyone else's names a Person: it must say what it is for, and carry their stop link.
    if (held.length) return "purpose";
    return { person: null };
  }
  // A text carries no stop link: nothing with a purpose is texted but routine messages.
  if (q.channel === "text") return "drop";
  // Nothing stoppable to a child's own address, whoever sends; news and offers never.
  if (child) return "drop";
  if (held.length > 1) return "drop";
  if (!person) {
    // Nobody holds it: only the suppression list applies, but a yes nobody gave is no yes.
    return purpose === "news_and_offers" ? "drop" : { person: null };
  }
  if (choiceRefusal(choices.get(person), { channel: "email", purpose })) return "drop";
  return { person };
}

/** The recipients of a stoppable message that get a stop link, and what it names. */
export interface Stoppable {
  purpose: SendPurpose;
  recipients: { to: string; person: string }[];
}

/**
 * A stoppable message's stop links (ADR 0678), made when it goes: for each recipient a Person
 * holds, a new link naming them, email and the declared purpose, on the business's site (one
 * statement per 18 for the tokens). The links by address, and the tokens, to drop with
 * `dropStopTokens` when the send then fails. Refused with no site set.
 */
export async function mintStopLinks(
  db: Db,
  stoppable: Stoppable,
  at = new Date().toISOString(),
): Promise<{ links: Record<string, string>; tokens: string[] }> {
  if (!stoppable.recipients.length) return { links: {}, tokens: [] };
  const site = siteOriginOf((await loadRoutineMailSettings(db)).siteOrigin);
  if (!site) throw new ValidationError(STOP_LINK_NEEDS_SITE_MESSAGE);
  const tokens = await stopTokens(
    db,
    stoppable.recipients.map((r) => ({
      person: r.person,
      channel: "email" as const,
      scope: stoppable.purpose,
    })),
    at,
  );
  const links: Record<string, string> = {};
  stoppable.recipients.forEach((r, i) => {
    links[r.to.toLowerCase()] = stopUrl(site, tokens[i] as string);
  });
  return { links, tokens };
}

/** Whether a stoppable send can have its links at all (a site is set): asked before queueing. */
export async function stopLinksPossible(db: Db): Promise<boolean> {
  return siteOriginOf((await loadRoutineMailSettings(db)).siteOrigin) !== null;
}
