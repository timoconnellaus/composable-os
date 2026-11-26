// The one redactor for text that came back from a model provider or a tool (an error message, an
// error body), applied before that text is returned, logged, stored or sent to a model again. A
// provider, or a proxy in front of it, may echo the key it was sent: in plain text, URL-encoded,
// JSON-escaped, base64 (a Basic `user:key` header), cut short at either end, or split across a
// line break. Every credential the Worker holds is cut out in each of those forms, and any bearer
// or basic token besides.
//
// `credentialsOf(env)` finds the credentials: every env value whose name says it is one
// (`AI_KEY_*`, `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`, `*_JWK`, `*_PRIVATE_KEY`, ...; never
// `*_PUBLIC_KEY`, `*_SITE_KEY` or `*_KEY_ID`), every string inside a JSON credential value, and,
// of `AI_CUSTOMER_GATEWAY`, only its `token` (its account and gateway ids are names, not secrets).
//
// `redactorFor(credentials)` makes the redactor. It cuts:
// - each credential whole, in each of its forms (plain, URL-encoded, JSON-escaped, base64);
// - any run of at least `MIN_RUN_CHARS` (12) characters that occurs anywhere in one of those forms,
//   at its start, in its middle or at its end, extended as far as it matches, and the rest of the
//   credential after a line break or a space when it goes on there; only a piece shorter than 12
//   (the last 4 characters a provider shows, `sk-...abcd`) may stay. A 12-character piece that is
//   word-like (letters of one case with punctuation, no digit) or the head of a URL is not looked
//   for on its own, so a credential holding an ordinary word or `https://` never blanks ordinary
//   text; it is still cut as part of a longer run that matches;
// - a `Bearer` or `Basic` scheme only when a token-shaped value (8 or more token characters)
//   follows it, so "Basic auth is disabled" is left as it is.
// A credential shorter than `MIN_SECRET_CHARS` (8) is not redacted at all: so short a value would
// cut ordinary words, and no provider key is that short.

/** A credential shorter than this is never redacted (it would cut ordinary text). */
export const MIN_SECRET_CHARS = 8;
/** Any piece of a credential at least this long is cut too (a truncated or split echo). */
export const MIN_RUN_CHARS = 12;
/** The old name of `MIN_RUN_CHARS` (it was a prefix rule). */
export const MIN_PREFIX_CHARS = MIN_RUN_CHARS;

const MASK = "…";

/** Env names whose values are credentials (or JSON holding them). */
const CREDENTIAL_NAME =
  /^(?:AI_KEY_[A-Z0-9_]+|AI_CUSTOMER_GATEWAY|[A-Z0-9_]*_(?:TOKEN|SECRET|SECRET_KEY|API_KEY|KEY|KEY_PREVIOUS|PASSWORD|PRIVATE_KEY|PRIVATE_KEY_PREVIOUS|JWK|CREDENTIALS?))$/;
/** Names that match the credential shape but name public values. */
const NOT_A_CREDENTIAL = /(?:^|_)(?:PUBLIC_KEY|SITE_KEY)(?:_PREVIOUS)?$/;

/** Whether an env name is one whose value `credentialsOf` collects. */
export function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name) && !NOT_A_CREDENTIAL.test(name);
}

/** Every string inside a JSON value. */
function stringsIn(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) stringsIn(item, out);
  }
}

/** The credentials an env holds, by name, and those nested in its JSON credential values. */
export function credentialsOf(env: object): string[] {
  const out = new Set<string>();
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (!isCredentialName(name) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      if (trimmed.length >= MIN_SECRET_CHARS) out.add(trimmed);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not JSON: the whole value stands.
      if (trimmed.length >= MIN_SECRET_CHARS) out.add(trimmed);
      continue;
    }
    const nested: string[] = [];
    if (name === "AI_CUSTOMER_GATEWAY") {
      // Only the token is a secret; the account and gateway ids are names that occur in text.
      const token = (parsed as { token?: unknown } | null)?.token;
      if (typeof token === "string") nested.push(token);
    } else {
      out.add(trimmed);
      stringsIn(parsed, nested);
    }
    for (const item of nested) if (item.length >= MIN_SECRET_CHARS) out.add(item);
  }
  return [...out];
}

const utf8 = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

/**
 * The pieces of base64 that appear in any base64 text containing `secret`, at any of the three
 * alignments (`user:secret` puts it at an offset the encoder decides): each alignment's encoding
 * without the four characters at each end that depend on the neighbouring bytes.
 */
function base64Cores(secret: string): string[] {
  const bytes = utf8.encode(secret);
  const out: string[] = [];
  for (let pad = 0; pad < 3; pad++) {
    const padded = new Uint8Array(pad + bytes.length);
    padded.set(bytes, pad);
    const encoded = base64(padded).replace(/=+$/, "");
    const core = encoded.slice(4, -4);
    if (core.length >= MIN_RUN_CHARS) {
      out.push(core, core.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return out;
}

/** The forms a credential can come back in: plain, URL-encoded, JSON-escaped, base64(url). */
function formsOf(secret: string): string[] {
  const forms = new Set<string>([secret]);
  forms.add(encodeURIComponent(secret));
  forms.add(encodeURI(secret));
  const json = JSON.stringify(secret).slice(1, -1);
  forms.add(json);
  forms.add(json.replace(/\//g, "\\/"));
  for (const core of base64Cores(secret)) forms.add(core);
  return [...forms].filter((f) => f.length >= MIN_SECRET_CHARS);
}

/**
 * A piece that is not looked for on its own: letters of one case with punctuation and no digit
 * (an ordinary word), or the head of a URL. It is still cut inside a longer matching run.
 */
function isWordLike(piece: string): boolean {
  if (/^(?:[a-z]+:\/\/|[a-z]+:\/|[a-z]+:$)/i.test(piece) || piece.includes("://")) return true;
  return /^[a-z\s._:/-]+$/.test(piece) || /^[A-Z\s._:/-]+$/.test(piece);
}

/**
 * A value after `Bearer` or `Basic` that looks like a credential: no auth parameter
 * (`realm=...`), and a digit or both cases in it (a word such as "tokens" is not one).
 */
function isTokenShaped(value: string): boolean {
  if (/^[A-Za-z]+=/.test(value)) return false;
  return /\d/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value));
}

/**
 * The anchor every run is found by: any run of `MIN_RUN_CHARS` (12) characters holds a whole
 * `ANCHOR`-character piece starting at a multiple of `ANCHOR` (6), so the text is read at every
 * sixth position only and a hit is then grown into the run it belongs to.
 */
const ANCHOR = MIN_RUN_CHARS / 2;

/** One form of a credential, and which of its 12-character pieces may be cut on their own. */
interface Form {
  text: string;
  /** `good[at]`: the 12-character piece starting at `at` is not word-like. */
  good: boolean[];
}

/** Where an anchor occurs: in which form, at which offset. */
type Place = { form: Form; at: number };

const WHITESPACE = /\s/;

/** Whether `form`'s characters `[from, to)` hold a 12-character piece that is not word-like. */
function holdsGoodPiece(form: Form, from: number, to: number): boolean {
  for (let at = from; at + MIN_RUN_CHARS <= to; at++) if (form.good[at]) return true;
  return false;
}

/** The ranges of `text` to cut: every run of a form at least `MIN_RUN_CHARS` long. */
function runsIn(text: string, anchors: Map<string, Place[]>): [number, number][] {
  const ranges: [number, number][] = [];
  let covered = 0;
  for (let i = 0; i + ANCHOR <= text.length; i += ANCHOR) {
    if (i < covered) continue;
    const places = anchors.get(text.slice(i, i + ANCHOR));
    if (!places) continue;
    let start = -1;
    let end = -1;
    for (const { form, at } of places) {
      const f = form.text;
      // Grow the hit backwards and forwards for as long as the text goes on as this form does.
      let s = i;
      let a = at;
      while (s > covered && a > 0 && text[s - 1] === f[a - 1]) {
        s--;
        a--;
      }
      let e = i + ANCHOR;
      let b = at + ANCHOR;
      while (e < text.length && b < f.length && text[e] === f[b]) {
        e++;
        b++;
      }
      if (e - s < MIN_RUN_CHARS || !holdsGoodPiece(form, a, b)) continue;
      // The rest of the credential after a line break or a space (a key split in two).
      if (b < f.length) {
        let w = e;
        while (w < text.length && w - e < 8 && WHITESPACE.test(text[w] as string)) w++;
        if (w > e) {
          let c = w;
          let d = b;
          while (c < text.length && d < f.length && text[c] === f[d]) {
            c++;
            d++;
          }
          // Only the last 4 characters alone may stay.
          if (c - w >= 5) e = c;
        }
      }
      if (start < 0 || s < start) start = s;
      if (e > end) end = e;
    }
    if (start < 0) continue;
    const previous = ranges.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
    covered = end;
  }
  return ranges;
}

/** A redactor for `credentials`: every form of each, any long piece of one, and bearer tokens. */
export function redactorFor(credentials: readonly string[]): (text: string) => string {
  const secrets = credentials.filter((c) => typeof c === "string" && c.length >= MIN_SECRET_CHARS);
  const texts = [...new Set(secrets.flatMap(formsOf))].sort((a, b) => b.length - a.length);
  const anchors = new Map<string, Place[]>();
  for (const text of texts) {
    if (text.length < MIN_RUN_CHARS) continue;
    const good: boolean[] = [];
    for (let at = 0; at + MIN_RUN_CHARS <= text.length; at++) {
      good[at] = !isWordLike(text.slice(at, at + MIN_RUN_CHARS));
    }
    if (!good.includes(true)) continue;
    const form: Form = { text, good };
    for (let at = 0; at + ANCHOR <= text.length; at++) {
      const anchor = text.slice(at, at + ANCHOR);
      const list = anchors.get(anchor);
      if (list) list.push({ form, at });
      else anchors.set(anchor, [{ form, at }]);
    }
  }
  return (text) => {
    let out = String(text);
    // Whole forms first (a credential of 8 to 11 characters has no 12-character piece).
    for (const form of texts) if (out.includes(form)) out = out.split(form).join(MASK);
    if (anchors.size > 0) {
      const ranges = runsIn(out, anchors);
      if (ranges.length > 0) {
        let cut = "";
        let from = 0;
        for (const [start, end] of ranges) {
          cut += `${out.slice(from, start)}${MASK}`;
          from = end;
        }
        out = cut + out.slice(from);
      }
    }
    return out
      .replace(/\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi, (all, scheme, space, value) =>
        isTokenShaped(value) ? `${scheme}${space}${MASK}` : all,
      )
      .replace(
        /\b(x-api-key|x-goog-api-key|api[_-]?key|cf-aig-authorization)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
        `$1$2${MASK}`,
      );
  };
}

/** The redactor of an env's credentials. */
export function redactorForEnv(env: object): (text: string) => string {
  return redactorFor(credentialsOf(env));
}

/**
 * An error with its message redacted (`redactorFor`). Its class and name are kept where nothing
 * was cut; otherwise a new Error of the same name.
 */
export function redactError(error: unknown, redact: (text: string) => string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const out = redact(message);
  if (out === message && error instanceof Error) return error;
  const clean = new Error(out);
  clean.name = error instanceof Error ? error.name : "Error";
  return clean;
}
