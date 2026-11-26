// The one redactor for text that came back from a model provider (an error message, an error
// body), applied before that text is returned, logged, stored or sent to a model again. A
// provider, or a proxy in front of it, may echo the key it was sent: in plain text, URL-encoded,
// JSON-escaped, base64 (a Basic `user:key` header), or cut short. Every credential the Worker
// holds is cut out in each of those forms, and any bearer or basic token besides.
//
// `credentialsOf(env)` finds the credentials: every env value whose name says it is one
// (`AI_KEY_*`, `*_TOKEN`, `*_SECRET`, `*_API_KEY`, `*_PRIVATE_KEY`, `AI_CUSTOMER_GATEWAY`), and,
// for a value that is JSON, every string inside it (the hosted customer gateway's `token`).
// `redactorFor(credentials)` makes the redactor. A credential shorter than `MIN_SECRET_CHARS`
// (8) is not redacted: so short a value would cut ordinary words, and no provider key is that
// short. A cut-short echo is caught from `MIN_PREFIX_CHARS` (12) characters of a credential's
// start: a random key's first 12 characters do not occur in ordinary text.

/** A credential shorter than this is never redacted (it would cut ordinary text). */
export const MIN_SECRET_CHARS = 8;
/** A leading piece of a credential at least this long is cut too (a truncated echo). */
export const MIN_PREFIX_CHARS = 12;

const MASK = "…";

/** Env names whose values are credentials (or JSON holding them). */
const CREDENTIAL_NAME =
  /^(?:AI_KEY_[A-Z0-9_]+|AI_CUSTOMER_GATEWAY|[A-Z0-9_]*_(?:TOKEN|SECRET|SECRET_KEY|API_KEY|PRIVATE_KEY|PRIVATE_KEY_PREVIOUS|JWK))$/;

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
    if (!CREDENTIAL_NAME.test(name) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_SECRET_CHARS) out.add(trimmed);
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const nested: string[] = [];
        stringsIn(JSON.parse(trimmed), nested);
        for (const item of nested) if (item.length >= MIN_SECRET_CHARS) out.add(item);
      } catch {
        // Not JSON: the whole value stands.
      }
    }
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
    if (core.length >= MIN_PREFIX_CHARS) {
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
  return [...forms].filter((f) => f.length >= MIN_SECRET_CHARS).sort((a, b) => b.length - a.length);
}

/** Cuts every run of `text` that starts like `secret` (at least MIN_PREFIX_CHARS of it). */
function cutPrefixes(text: string, secret: string): string {
  if (secret.length < MIN_PREFIX_CHARS) return text;
  const head = secret.slice(0, MIN_PREFIX_CHARS);
  let out = "";
  let from = 0;
  for (;;) {
    const at = text.indexOf(head, from);
    if (at < 0) return out + text.slice(from);
    let end = at + MIN_PREFIX_CHARS;
    while (end < text.length && end - at < secret.length && text[end] === secret[end - at]) end++;
    out += `${text.slice(from, at)}${MASK}`;
    from = end;
  }
}

/** A redactor for `credentials`: every form of each, and bearer and basic tokens, cut out. */
export function redactorFor(credentials: readonly string[]): (text: string) => string {
  const secrets = credentials.filter((c) => typeof c === "string" && c.length >= MIN_SECRET_CHARS);
  const forms = secrets.flatMap(formsOf).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const form of forms) out = out.split(form).join(MASK);
    for (const secret of secrets) out = cutPrefixes(out, secret);
    return out
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`)
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
