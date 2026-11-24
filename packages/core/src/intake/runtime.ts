// What the public-write door needs from the Worker it runs in (stage 29 step 2, ADR 0722): the
// Turnstile check and the shown-time token. The adapter (cos-runner, where a pack's tool and so
// `intake.submit` run) builds it from TURNSTILE_SECRET_KEY, an env-only secret: the secret stays in
// this closure and never reaches an operation's input, output, the database or the audit log. It
// is given only to the `intake.*` operations' handlers.
//
// The shown-time token is how `intake.submit` knows a form was shown at least 3 seconds before it
// was sent: `intake.open` gives one with the form, an HMAC (SHA-256) over the form's id and the
// moment, keyed by a key derived from the secret (HKDF, its own label), so no caller can make one
// up. A host with no secret takes no public answers at all, so it needs no key.

/** Cloudflare's server-side check of a Turnstile token. */
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** What the Turnstile check said. `unavailable`: Cloudflare could not be asked or answered oddly. */
export type TurnstileOutcome = "ok" | "bad" | "unavailable";

export interface IntakeRuntime {
  /** Whether TURNSTILE_SECRET_KEY is set: without it the public answers nothing. */
  readonly turnstile: boolean;
  /** Asks Cloudflare whether `token` is a good, unused Turnstile token for this site. */
  verifyTurnstile(token: string): Promise<TurnstileOutcome>;
  /** A token saying `form` was shown at `at` (an instant), or null with no secret. */
  signShown(form: string, at: string): Promise<string | null>;
  /** When the token says `form` was shown, or null when it is not one the host made for it. */
  readShown(form: string, token: string): Promise<string | null>;
}

/** The runtime with no secret: Turnstile not configured, no shown-time token. */
export const NO_INTAKE_RUNTIME: IntakeRuntime = {
  turnstile: false,
  verifyTurnstile: async () => "unavailable",
  signShown: async () => null,
  readShown: async () => null,
};

const SHOWN_TOKEN = /^v1\.(\d{13})\.([A-Za-z0-9_-]{43})$/;
const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Equal strings, compared in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The door's runtime for a Worker with `secret` (TURNSTILE_SECRET_KEY, possibly unset). `fetcher`
 * is the Worker's own fetch; a test passes a stand-in for Cloudflare.
 */
export function intakeRuntime(
  secret: string | undefined,
  fetcher: typeof fetch = fetch,
): IntakeRuntime {
  const key = secret?.trim();
  if (!key) return NO_INTAKE_RUNTIME;
  let hmac: Promise<CryptoKey> | null = null;
  const shownKey = () => {
    hmac ??= crypto.subtle
      .importKey("raw", encoder.encode(key), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(0),
            info: encoder.encode("cos intake shown-at v1"),
          },
          base,
          { name: "HMAC", hash: "SHA-256", length: 256 },
          false,
          ["sign"],
        ),
      );
    return hmac;
  };
  const mac = async (form: string, ms: string) =>
    base64url(await crypto.subtle.sign("HMAC", await shownKey(), encoder.encode(`${form}.${ms}`)));
  return {
    turnstile: true,
    async verifyTurnstile(token) {
      const body = new FormData();
      body.set("secret", key);
      body.set("response", token);
      try {
        const response = await fetcher(TURNSTILE_VERIFY_URL, {
          method: "POST",
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return "unavailable";
        const answer = (await response.json()) as { success?: unknown };
        if (typeof answer?.success !== "boolean") return "unavailable";
        return answer.success ? "ok" : "bad";
      } catch {
        return "unavailable";
      }
    },
    async signShown(form, at) {
      const ms = String(Date.parse(at)).padStart(13, "0");
      return `v1.${ms}.${await mac(form, ms)}`;
    },
    async readShown(form, token) {
      const match = SHOWN_TOKEN.exec(token);
      if (!match) return null;
      const [, ms, given] = match as unknown as [string, string, string];
      if (!sameText(await mac(form, ms), given)) return null;
      return new Date(Number(ms)).toISOString();
    },
  };
}
