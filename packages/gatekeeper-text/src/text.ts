// What a text is to this gatekeeper (ADR 0672): a number in international form, plain words of at
// most two segments, and the business's name they begin with. Validated here from whatever a
// caller sent, before anything is queued. The segment count is the one the host counts with
// (packages/sdk's `textSegments`, the same alphabet): no imports, so the gatekeeper decides alone.

/** At most this many segments a text: what the host's declarations are checked to fit. */
export const MAX_SEGMENTS = 2;
/** The longest business name a text begins with (the host's `TEXT_SENDER_MAX`). */
export const BUSINESS_MAX = 30;

// The GSM 03.38 alphabet a text is sent in when it can be; the extension table's characters take
// two units. Anything else sends the whole text in the longer encoding (UCS-2).
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM_EXTENDED = new Set("^{}\\[~]|€\f");

/** The segments `value` is sent and billed as. */
export function segmentsOf(value: string): number {
  let units = 0;
  for (const ch of value) {
    if (GSM_BASIC.has(ch)) units += 1;
    else if (GSM_EXTENDED.has(ch)) units += 2;
    else return value.length <= 70 ? 1 : Math.ceil(value.length / 67);
  }
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

const NUMBER = /^\+[1-9]\d{7,14}$/;

/** A number in international form (`+61400000000`), or a TypeError. */
export function parseNumber(value: unknown, field = "to"): string {
  if (typeof value !== "string" || !NUMBER.test(value)) {
    throw new TypeError(`Invalid text: ${field} is a number in international form (+ and digits).`);
  }
  return value;
}

/** A number as an approver sees it: the country and the last three digits (`+614•••••123`). */
export function maskNumber(number: string): string {
  if (number.length <= 7) return "•".repeat(number.length);
  return `${number.slice(0, 4)}${"•".repeat(number.length - 7)}${number.slice(-3)}`;
}

// Control characters other than a line break: never in a text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;

export interface ParsedText {
  to: string;
  text: string;
  business: string | null;
  segments: number;
}

/** A send's message, checked: one number, plain words of at most two segments. */
export function parseText(input: unknown): ParsedText {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Invalid text: pass { to, text }.");
  }
  const { to, text, business, ...rest } = input as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) throw new TypeError(`Invalid text: unknown field ${extra[0]}.`);
  const number = parseNumber(to);
  if (typeof text !== "string" || !text.trim()) {
    throw new TypeError("Invalid text: text is the words, plain text.");
  }
  if (CONTROL.test(text)) throw new TypeError("Invalid text: text holds a control character.");
  const segments = segmentsOf(text);
  if (segments > MAX_SEGMENTS) {
    throw new TypeError(`Invalid text: it is ${segments} segments, at most ${MAX_SEGMENTS}.`);
  }
  let name: string | null = null;
  if (business !== undefined) {
    if (
      typeof business !== "string" ||
      !business.trim() ||
      business.length > BUSINESS_MAX ||
      CONTROL.test(business)
    ) {
      throw new TypeError(
        `Invalid text: business is a name of at most ${BUSINESS_MAX} characters.`,
      );
    }
    name = business.trim();
  }
  return { to: number, text, business: name, segments };
}

const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"]*/gi;
/** A bare domain (`example.com/x`), which a phone shows as a link too. */
const BARE_DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s]*)?/gi;

/**
 * Whether a text has routine shape for the business's `site` (`https://gym.example`): it begins
 * with the business's name, and every link in it is on the site. A text with no site set may hold
 * no link at all.
 */
export function isRoutineShaped(message: ParsedText, site: string | null): boolean {
  if (!message.business || !message.text.startsWith(`${message.business}: `)) return false;
  const host = site ? new URL(site).host : null;
  for (const match of message.text.matchAll(LINK)) {
    const link = match[0];
    if (!site || !(link === site || link.startsWith(`${site}/`) || link.startsWith(`${site}?`))) {
      return false;
    }
  }
  // A domain written without a scheme is a link a phone opens: only the site's own.
  const withoutLinks = message.text.replace(LINK, " ");
  for (const match of withoutLinks.matchAll(BARE_DOMAIN)) {
    const domain = match[0].split("/")[0]?.toLowerCase() ?? "";
    if (!host || domain !== host.toLowerCase()) return false;
  }
  return true;
}

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout"]);

/** STOP, START and HELP, with the usual synonyms; anything else is not a keyword. */
export function keywordOf(body: string): "stop" | "start" | "help" | null {
  const word = body
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  if (STOP_WORDS.has(word)) return "stop";
  if (["start", "unstop", "optin", "opt-in"].includes(word)) return "start";
  if (["help", "info"].includes(word)) return "help";
  return null;
}

/** HELP's fixed answer, with the business's name when the host has said it. */
export function helpAnswer(business: string | null): string {
  return `${business ? `${business}: ` : ""}texts about your bookings and account. Reply STOP to stop, START to start again.`;
}
