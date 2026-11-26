/**
 * What a gatekeeper may say about an upstream failure: the HTTP status, the provider's error code
 * and its error description, scrubbed of everything the gatekeeper sent (its access token, refresh
 * token, client secret, authorization code), and never the raw response body. A provider or a
 * proxy in front of it may echo a request back, and a gatekeeper's error text reaches the host's
 * logs, the assistant's model and its stored conversation.
 *
 * The host's own redactor (packages/core `ai/redact.ts`) only knows the host's env; a gatekeeper's
 * OAuth tokens live in its own storage, so the gatekeeper scrubs them here, where it knows them.
 */

/** A secret shorter than this is not scrubbed (it would cut ordinary words). */
export const MIN_SCRUBBED_SECRET = 8;
/** The longest provider description quoted. */
export const MAX_QUOTED_DESCRIPTION = 200;
/** A provider error code is quoted only when it is a plain identifier of at most this length. */
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

const MASK = "[redacted]";

function base64(text: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(text)) out += String.fromCharCode(b);
  return btoa(out);
}

/** Each spelling of a secret a provider might echo: plain, URL-encoded, JSON-escaped, base64. */
function spellingsOf(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  return [
    secret,
    encodeURIComponent(secret),
    json,
    json.replace(/\//g, "\\/"),
    base64(secret),
    base64(secret).replace(/=+$/, ""),
  ];
}

/**
 * `text` with every spelling of each of `sent` cut out, any 12-character piece of one too, and any
 * bearer or basic token-shaped value.
 */
export function scrubSent(text: string, sent: readonly (string | null | undefined)[]): string {
  let out = text;
  const secrets = sent.filter(
    (s): s is string => typeof s === "string" && s.length >= MIN_SCRUBBED_SECRET,
  );
  const spellings = secrets.flatMap(spellingsOf).sort((a, b) => b.length - a.length);
  for (const spelling of spellings) out = out.split(spelling).join(MASK);
  // A cut-short or split echo: any 12 characters of a secret.
  for (const secret of secrets) {
    for (let at = 0; at + 12 <= secret.length; at++) {
      const piece = secret.slice(at, at + 12);
      if (out.includes(piece)) out = out.split(piece).join(MASK);
    }
  }
  return out.replace(
    /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    (all, scheme: string, space: string, value: string) =>
      /^[A-Za-z]+=/.test(value) || !(/\d/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)))
        ? all
        : `${scheme}${space}${MASK}`,
  );
}

/** One line, control characters gone, at most `max` characters. */
function oneLine(text: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters (log forging).
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** The provider's error code and description from the shapes providers use, or nothing. */
export function providerErrorOf(body: unknown): { code?: string; description?: string } {
  if (!body || typeof body !== "object") return {};
  const doc = body as Record<string, unknown>;
  const nested =
    doc.error && typeof doc.error === "object" ? (doc.error as Record<string, unknown>) : null;
  const first =
    Array.isArray(doc.errors) && doc.errors[0] && typeof doc.errors[0] === "object"
      ? (doc.errors[0] as Record<string, unknown>)
      : null;
  const code = [
    typeof doc.error === "string" ? doc.error : undefined,
    nested?.status,
    nested?.code,
    first?.code,
    doc.code,
  ].find((c): c is string => typeof c === "string" && ERROR_CODE.test(c));
  const description = [
    doc.error_description,
    nested?.message,
    first?.message,
    first?.detail,
    doc.detail,
    doc.message,
  ].find((d): d is string => typeof d === "string" && d.trim().length > 0);
  return { ...(code ? { code } : {}), ...(description ? { description } : {}) };
}

/**
 * The message for an upstream failure: `<label> failed: <status>[ <code>][ - <description>]`,
 * the description scrubbed of `sent` and capped. The status comes right after `failed: ` (some
 * callers read it back from there). Built from a parsed body (or nothing); the raw
 * body is never part of it.
 */
export function upstreamErrorMessage(
  label: string,
  status: number,
  body: unknown,
  sent: readonly (string | null | undefined)[],
): string {
  const { code, description } = providerErrorOf(body);
  const said = description
    ? ` - ${oneLine(scrubSent(description, sent), MAX_QUOTED_DESCRIPTION)}`
    : "";
  return `${label} failed: ${status}${code ? ` ${scrubSent(code, sent)}` : ""}${said}`;
}

/**
 * The message for a token-endpoint failure: `<label> failed (HTTP <status>)[ <code>][ - <description>]`.
 * The status is kept out of the `failed: <status>` position on purpose: a caller that reads an
 * API's status back from a message (Google's `httpStatusFromError`) must never take the token
 * endpoint's 401 (a wrong client secret) for the API's own "no access", which would turn a broken
 * connection into a quiet denial.
 */
export function tokenEndpointErrorMessage(
  label: string,
  status: number,
  body: unknown,
  sent: readonly (string | null | undefined)[],
): string {
  return upstreamErrorMessage(label, status, body, sent).replace(
    `${label} failed: ${status}`,
    `${label} failed (HTTP ${status})`,
  );
}

/**
 * `upstreamErrorMessage` for a response: reads at most 16 KiB of it, parses it as JSON when it is,
 * and quotes only the provider's code and description.
 */
export async function upstreamFailure(
  label: string,
  response: Response,
  sent: readonly (string | null | undefined)[],
): Promise<string> {
  let body: unknown;
  try {
    const text = (await response.text()).slice(0, 16_384);
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return upstreamErrorMessage(label, response.status, body, sent);
}
