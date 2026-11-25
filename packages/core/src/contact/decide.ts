// The one question (stage 30 step 5, ADR 0675): may this message go to this Person on this
// channel now, and where? Every sender asks it at the moment of sending: routine messages here
// (and through them Reviews' ask), Journeys' engine for each step, the inbox's campaigns. Nobody
// else reads the register or the suppression list to decide.
//
// The answer reads, in a bounded number of statements:
// - the register: the latest choice for the kind and the purpose on the channel (one statement,
//   or none when the caller read a batch with `choicesInForce`);
// - for news and offers, whether the Person is a child (a live guardian link: never to them);
// - where it goes: an address (and the suppression list), the textable number (`textReach`, which
//   reads the suppression list), the registered devices;
// - its moment, and quiet hours for a text or a push.
//
// A refusal is final for that message: the sender skips and logs it, and never holds it for a
// person, because nobody may approve around a missing consent or a stop.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { mailboxKey } from "../customers/limits.ts";
import { loadRoutineMailSettings, type RoutineMailSettings } from "../routine-mail/index.ts";
import { quietDecision } from "../routine-mail/quiet.ts";
import { type ChannelReach, HOST_REACH } from "../routine-mail/reach.ts";
import { isTimezone } from "../settings.ts";
import { hasLiveGuardian } from "../visibility/guardians.ts";
import {
  allows,
  type ChoicesInForce,
  type ContactChannel,
  type ContactChoice,
  type ContactPurpose,
  choiceKey,
  choicesInForce,
  STOP_HOWS,
} from "./register.ts";
import { addressHash, suppressed } from "./suppression.ts";

type Db = Kysely<CoreDatabase>;

/** Why a message may not go. */
export const CONTACT_REFUSALS = [
  "no_address",
  "not_textable",
  "no_device",
  "off",
  "no_consent",
  "stopped",
  "suppressed",
  "child",
  "expired",
] as const;
export type ContactRefusal = (typeof CONTACT_REFUSALS)[number];

export interface ContactQuestion {
  /** The Person it would go to. */
  person: string;
  channel: ContactChannel;
  purpose: ContactPurpose;
  /** A routine kind (`bookings.reminder`): its own choice is read too. */
  kind?: string | undefined;
  /**
   * An essential kind's email always goes (decision 9): no choice turns it off. Ignored for any
   * other channel or purpose (a follow-up is never essential).
   */
  essential?: boolean | undefined;
  /** When it stops being worth sending (an instant): past it, `expired`. */
  moment?: number | string | null | undefined;
  /** May go during quiet hours when waiting would make it late (ADR 0676). */
  urgent?: boolean | undefined;
  /** Now (an instant). */
  at: string;
  /** For an email: the address it goes to, as the sender chose it (without one: `no_address`). */
  address?: string | undefined;
}

export type ContactDecision =
  | {
      send: true;
      /** The address, number or device it goes to. */
      to: string;
      /** The caps' key for it (a mailbox, a number's hash, a device). */
      key: string;
      /** A text or push inside quiet hours: when they end. */
      waitUntil?: string;
    }
  | { send: false; reason: ContactRefusal; detail: string };

export interface ContactOptions {
  /** The register for a batch of recipients, read once (`choicesInForce`): no statement here. */
  choices?: ChoicesInForce | undefined;
  /** The routine settings, read once by the caller (quiet hours, countries). */
  settings?: RoutineMailSettings | undefined;
  /** How a Person is reached by text and push (a test's stand-in; default the host's). */
  reach?: ChannelReach | undefined;
}

/** A refusal and why, in words staff read in the log. */
const refuse = (reason: ContactRefusal, detail: string): ContactDecision => ({
  send: false,
  reason,
  detail,
});

/** A choice that does not allow it: `stopped` when it was a stop (a link, a reply), else `off`. */
function refusedBy(choice: ContactChoice, what: string): ContactDecision {
  return STOP_HOWS.has(choice.how)
    ? refuse("stopped", `they stopped ${what} by ${choice.channel}`)
    : refuse("off", `they turned ${what} off by ${choice.channel}`);
}

/**
 * What the register says, before where it goes: null when it may go, else the refusal. Reads the
 * Person's choices for the kind and the purpose on the channel (none when `choices` holds them),
 * and for news and offers whether they are a child.
 */
export async function registerRefusal(
  db: Db,
  q: Pick<ContactQuestion, "person" | "channel" | "purpose" | "kind" | "essential">,
  choices?: ChoicesInForce,
): Promise<ContactDecision | null> {
  if (q.purpose === "news_and_offers" && (await hasLiveGuardian(db, q.person))) {
    return refuse("child", "news and offers never go to a child");
  }
  const mine = (choices ?? (await choicesInForce(db, [q.person]))).get(q.person);
  return choiceRefusal(mine, q);
}

/**
 * What a Person's choices in force say, with no statement: null when it may go, else the refusal.
 * `registerRefusal` without its child check, for a caller that read the batch's choices and its
 * recipients' guardians itself (ADR 0678).
 */
export function choiceRefusal(
  mine: ReadonlyMap<string, ContactChoice> | undefined,
  q: Pick<ContactQuestion, "channel" | "purpose" | "kind" | "essential">,
): ContactDecision | null {
  const kindChoice = q.kind ? mine?.get(choiceKey(q.channel, q.kind)) : undefined;
  if (q.purpose === "account") {
    // An essential kind's email is never turned off; its text and push may be.
    const fixed = q.essential === true && q.channel === "email";
    if (!fixed && kindChoice && !allows(kindChoice.value)) return refusedBy(kindChoice, "these");
    return null;
  }
  if (q.purpose === "follow_up") {
    const purpose = mine?.get(choiceKey(q.channel, "follow_up"));
    if (purpose && !allows(purpose.value)) return refusedBy(purpose, "follow-up messages");
    if (kindChoice && !allows(kindChoice.value)) return refusedBy(kindChoice, "these");
    return null;
  }
  // News and offers: a recorded yes on this channel, the latest.
  const consent = mine?.get(choiceKey(q.channel, "news_and_offers"));
  if (!consent) return refuse("no_consent", `no yes to news and offers by ${q.channel}`);
  if (!allows(consent.value)) {
    return STOP_HOWS.has(consent.how)
      ? refuse("stopped", `they stopped news and offers by ${q.channel}`)
      : refuse("no_consent", `they said no to news and offers by ${q.channel}`);
  }
  return null;
}

/** Whether an address is on the suppression list (one statement). */
export async function addressSuppressed(db: Db, address: string): Promise<boolean> {
  return suppressed(db, "email", await addressHash(db, address));
}

/**
 * The one question: may this message go to `q.person` on `q.channel` now, and where. Ask it at
 * the moment of sending. `{ send: true, to, key, waitUntil? }` or `{ send: false, reason,
 * detail }`, with reasons `no_address`, `not_textable`, `no_device`, `off`, `no_consent`,
 * `stopped`, `suppressed`, `child` and `expired`. A refusal is final: skip and log it, never hold
 * it for a person.
 */
export async function contactDecision(
  db: Db,
  q: ContactQuestion,
  options: ContactOptions = {},
): Promise<ContactDecision> {
  const refused = await registerRefusal(db, q, options.choices);
  if (refused) return refused;
  const at = Date.parse(q.at);
  const moment =
    q.moment === null || q.moment === undefined
      ? null
      : typeof q.moment === "number"
        ? q.moment
        : Date.parse(q.moment);
  let to: string;
  let key: string;
  if (q.channel === "email") {
    // The sender names the address (it chose the recipient: the Person's own, a guardian's).
    const address = q.address;
    if (!address) return refuse("no_address", "no email address to send to");
    if (await addressSuppressed(db, address)) {
      return refuse("suppressed", "the address asked not to be sent to");
    }
    to = address;
    key = mailboxKey(address);
  } else {
    const reach = options.reach ?? HOST_REACH;
    const reached = await reach[q.channel](db, q.person);
    if ("reason" in reached) {
      if (reached.stopped) return refuse("suppressed", reached.reason);
      return refuse(q.channel === "text" ? "not_textable" : "no_device", reached.reason);
    }
    to = reached.to;
    key = reached.key;
  }
  if (moment !== null && Number.isFinite(moment) && moment <= at) {
    return refuse("expired", "its moment passed");
  }
  if (q.channel === "email") return { send: true, to, key };
  // Quiet hours hold a text or a push (never an email) until they end, in the zone a human admin
  // set; with none set nothing is held here (the sender refuses to text or push without one).
  const settings = options.settings ?? (await loadRoutineMailSettings(db));
  const zone = settings.quietZone && isTimezone(settings.quietZone) ? settings.quietZone : null;
  if (!zone) return { send: true, to, key };
  const { waitUntil } = quietDecision(at, zone, settings.quietHours, {
    urgent: q.urgent === true,
    until: moment !== null && Number.isFinite(moment) ? moment : null,
  });
  return waitUntil ? { send: true, to, key, waitUntil } : { send: true, to, key };
}
