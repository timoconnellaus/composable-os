// Every sender asks (stage 30, ADR 0678): the host's check on an email or a text that is not one
// of its own routine messages, asked at the one place every such send passes, the integration
// host's approval queue (`contactCheck`, before a gatekeeper queues the send, and again for any
// send it submits), and again when a person approves one that waited. No caller can skip it:
// a gatekeeper holds the queue, never a pack, a tool, an extension or a model.
//
// Who is sending decides what is asked:
// - **A person on the staff** (actor `human`), with no purpose declared: their own message to
//   whoever they write to (a reply, a one-to-one email). Only what holds for the address or number
//   whatever the message: the suppression list (a STOP, a provider's unsubscribe or bounce), and
//   never a child's own address. Not the per-kind or per-purpose choices.
// - **Anyone else** (an automation, a tool, the assistant, MCP, extension code), or a person who
//   declares a purpose: a `follow_up` or `news_and_offers` message, asked in full for each Person
//   with the purpose it declares, and carrying each Person's own stop link (made here, by the
//   host, never seen by the sender). Without a purpose, a send to any address a Person holds is
//   refused (`purpose_required`).
//
// Who an address is: the live People holding an address of its folded form (ADR 0692,
// `peopleAtAddresses`, the seam's read). One holder: theirs. None: only the suppression list
// applies (and news and offers, which need a yes no one could have given, are refused). Several:
// a stoppable message is refused, since no one stop link would stop it for each of them; a staff
// member's own message goes unless any of them is a child.
//
// What the sender learns: only how many recipients were dropped, and when none is left the one
// plain refusal `recipient_stopped`, the same whatever the reason, so no caller (an AI least of
// all) can map a person's choices beyond "cannot be contacted this way".
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { foldAddress } from "../customers/accounts.ts";
import { ValidationError } from "../errors.ts";
import { loadRoutineMailSettings, siteOriginOf } from "../routine-mail/index.ts";
import { peopleAtAddresses } from "../visibility/guardians.ts";
import { choiceRefusal } from "./decide.ts";
import { choicesInForce } from "./register.ts";
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
/** A send that names a Person and declares no purpose. */
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

/**
 * The one check for a send that is not a routine message (ADR 0678). Reads, whatever the number
 * of recipients: the suppression list (one statement per 90), who holds each address (one per
 * 90) and the holders' choices (one per 90). Writes nothing.
 */
export async function checkSend(db: Db, q: SendQuestion): Promise<SendAnswer> {
  const named = [...new Set(q.recipients.map((r) => r.trim()).filter(Boolean))];
  if (q.channel === "text") return checkText(db, q, named);
  const purpose = q.purpose ?? null;
  const folded = new Map(named.map((to) => [to, foldAddress(to) ?? to.toLowerCase()]));
  const hashes = new Map(
    await Promise.all(named.map(async (to) => [to, await addressHash(db, to)] as const)),
  );
  const stopped = await suppressedAmong(db, "email", [...hashes.values()]);
  const holders = named.length ? await peopleAtAddresses(db, [...folded.values()]) : new Map();
  const people = [...holders.values()].flatMap((list: { id: string }[]) => list.map((h) => h.id));
  const choices = purpose && people.length ? await choicesInForce(db, people) : new Map();

  const allowed: SendRecipient[] = [];
  let purposeRequired = false;
  for (const to of named) {
    if (stopped.has(hashes.get(to) as string)) continue;
    const held: { id: string; child: boolean }[] = holders.get(folded.get(to) as string) ?? [];
    // Nothing but essential messages to a dependant's own address, whoever sends, and nothing
    // that reaches here is essential (sign-in codes, copies and receipts are the host's own mail).
    if (held.some((h) => h.child)) continue;
    const person = held.length === 1 ? (held[0]?.id ?? null) : null;
    if (!purpose) {
      // A person's own message: the address's suppression and a child only.
      if (q.sender === "staff") {
        allowed.push({ to, person });
        continue;
      }
      // Anyone else's names a Person: it must say what it is for, and carry their stop link.
      if (held.length) {
        purposeRequired = true;
        continue;
      }
      allowed.push({ to, person: null });
      continue;
    }
    if (held.length > 1) continue;
    if (!person) {
      // Nobody holds it: only the suppression list applies, but a yes nobody gave is no yes.
      if (purpose === "news_and_offers") continue;
      allowed.push({ to, person: null });
      continue;
    }
    if (choiceRefusal(choices.get(person), { channel: "email", purpose })) continue;
    allowed.push({ to, person });
  }
  return { allowed, dropped: named.length - allowed.length, purposeRequired };
}

/**
 * Texts: a STOP'd number is never texted, whoever sends. Only a person's own text may go at all
 * (there is no free text path for anyone else: the text gatekeeper refuses every caller's queue,
 * ADR 0672). One statement per 90 numbers.
 */
async function checkText(db: Db, q: SendQuestion, named: string[]): Promise<SendAnswer> {
  if (q.sender !== "staff" || q.purpose) {
    return { allowed: [], dropped: named.length, purposeRequired: false };
  }
  const hashes = new Map(
    await Promise.all(named.map(async (to) => [to, await saltedHash(db, to)] as const)),
  );
  const stopped = await suppressedAmong(db, "text", [...hashes.values()]);
  const allowed = named
    .filter((to) => !stopped.has(hashes.get(to) as string))
    .map((to) => ({ to, person: null }));
  return { allowed, dropped: named.length - allowed.length, purposeRequired: false };
}

/** An allowed recipient with the stop link its copy ends with (null: it needs none). */
export interface StoppableRecipient {
  to: string;
  stop: string | null;
}

/**
 * The stop links of a stoppable send's allowed recipients (ADR 0678): for each one a Person
 * holds, a new link naming them, the channel and the declared purpose, made by the host (one
 * statement per 18), with the business's site read once. A recipient nobody holds needs none
 * (there is nobody a stop could record). Refused when a link is needed and there is no site.
 */
export async function withStopLinks(
  db: Db,
  allowed: readonly SendRecipient[],
  purpose: SendPurpose | null,
  at: string,
): Promise<StoppableRecipient[]> {
  const needing = purpose ? allowed.filter((r) => r.person) : [];
  if (!needing.length) return allowed.map((r) => ({ to: r.to, stop: null }));
  const site = siteOriginOf((await loadRoutineMailSettings(db)).siteOrigin);
  if (!site) throw new ValidationError(STOP_LINK_NEEDS_SITE_MESSAGE);
  const tokens = await stopTokens(
    db,
    needing.map((r) => ({
      person: r.person as string,
      channel: "email",
      scope: purpose as string,
    })),
    at,
  );
  const links = new Map(needing.map((r, i) => [r.to, stopUrl(site, tokens[i] as string)]));
  return allowed.map((r) => ({ to: r.to, stop: links.get(r.to) ?? null }));
}

/** Labels of an outbound description's fields that name who a message goes to. */
const RECIPIENT_LABELS = new Set(["to", "cc", "bcc"]);
const ADDRESS = /[^\s<>(),;:"'[\]]+@[^\s<>(),;:"'[\]]+\.[^\s<>(),;:"'[\]]+/g;

/**
 * The addresses an outbound action's description says it goes to (its `To`, `Cc` and `Bcc`
 * fields, a list or a line): how the host reads any gatekeeper's send, its own or a vendored
 * one, without trusting a caller's word for it.
 */
export function recipientsOfFields(
  fields: readonly { label: string; value?: string | undefined; items?: unknown }[],
): string[] {
  const out = new Set<string>();
  for (const field of fields) {
    if (!RECIPIENT_LABELS.has(field.label.trim().toLowerCase())) continue;
    const text = [
      ...(Array.isArray(field.items) ? field.items.map(String) : []),
      field.value ?? "",
    ].join("\n");
    for (const match of text.matchAll(ADDRESS)) out.add(match[0].toLowerCase());
  }
  return [...out];
}
