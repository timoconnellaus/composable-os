// Sessions for native apps (stage 23, ADR 0419; signing in for tokens, ADR 0455). A phone signs
// in with a code emailed to the person and gets a short-lived access token and a refresh token in
// the answer's body (no cookie is ever set), keeps both in its secure store, and refreshes before
// the access token runs out. Every refresh rotates the refresh token; the host ends the session
// when an old one is used again, so two copies of one session cannot both live.
//
//   const session = tokenSession({ baseUrl, store: secureStore });
//   await session.requestCode(email);
//   await session.signInWithCode(email, code, "Ada's phone");
//   const api = createCustomerClient({ baseUrl, fetch: session.fetch });
//
// `session.fetch` adds the access token to each call and, when the host says it has expired
// (this device's clock behind the host's), refreshes once and sends the call again. A refresh
// the host refuses forgets the session; one that fails for any other reason keeps it.
//
// Staff whose sign-in is browser-based (Google, Cloudflare Access) use `startBrowserSignIn` and
// `finishBrowserSignIn` instead: the system browser signs them in, never a web view.
import { ApiError, NetworkError } from "./errors.ts";
import type { FetchLike } from "./types.ts";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working (ISO time). */
  accessExpiresAt: string;
  sessionId: string;
}

/** Where the tokens live between launches: expo-secure-store, the keychain, a test's memory. */
export interface TokenStore {
  load(): Promise<Tokens | null>;
  save(tokens: Tokens | null): Promise<void>;
}

/** Whose sign-in: a customer's (the default) or a staff member's. */
export type SignInAudience = "customer" | "staff";

/** A customer's tokens also say whether the account is ready or waits for staff to merge people. */
export interface SignedIn extends Tokens {
  account?: "ready" | "needs_attention";
}

export interface TokenSessionOptions {
  baseUrl: string;
  store: TokenStore;
  fetch?: FetchLike;
  /** Refresh this long before the access token runs out. Default 30 seconds. */
  refreshEarlyMs?: number;
  now?: () => number;
}

async function post<T = Tokens>(
  fetcher: FetchLike,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new NetworkError("Could not reach the host to sign in", error);
  }
  // Something in front of the host (a proxy, a gateway) can answer with a page, not JSON: the
  // status still says what happened.
  let parsed: { data?: T; error?: { code: string; message: string; details?: unknown } } = {};
  try {
    parsed = JSON.parse(await response.text()) as typeof parsed;
  } catch {}
  if (response.status === 200 && parsed.data) return parsed.data;
  throw new ApiError(
    parsed.error?.code ?? "internal",
    parsed.error?.message ?? `The host answered ${response.status}`,
    response.status,
    parsed.error?.details,
  );
}

/** Which part of a sign-in by code failed: asking for the code, or signing in with it. */
export type SignInStep = "code" | "sign-in";

/**
 * What to tell someone whose sign-in on a device failed, in plain words with what to do next
 * (ADR 0455's refusals): sign-in not switched on (503), too many tries (429), no answer (offline),
 * an address or code the host does not take. A screen shows it and keeps its button, so they can
 * try again.
 */
export function signInErrorWords(error: unknown, step: SignInStep = "code"): string {
  const e = error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
  if (error instanceof NetworkError || e?.name === "NetworkError") {
    return "We could not reach the business just now. Check your connection and try again.";
  }
  const reason = (e?.details as { reason?: unknown } | undefined)?.reason;
  if (e?.status === 503 || reason === "sign_in_not_set_up") {
    return "Signing in is not switched on here yet. Try again later, or ask the business.";
  }
  if (e?.status === 429 || e?.code === "rate_limited") {
    const seconds = (e?.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    const minutes = typeof seconds === "number" && seconds > 0 ? Math.ceil(seconds / 60) : null;
    return minutes
      ? `Too many tries. Wait ${minutes} minute${minutes === 1 ? "" : "s"}, then try again.`
      : "Too many tries. Wait a few minutes, then try again.";
  }
  if (reason === "invalid_code") return "That code did not work. Check it, or ask for a new one.";
  if (e?.status === 400 || e?.code === "invalid_input") {
    return step === "code"
      ? "That does not look like an email address. Check it and try again."
      : "Check the email address and the code, then try again.";
  }
  return step === "code"
    ? "We could not send a code just now. Try again in a moment."
    : "We could not sign you in just now. Try again in a moment.";
}

/**
 * Whether a refresh's failure means the session is over: the host refused the token (401, 403, or
 * 400 for one that is not a token). A 5xx, a 429 or no answer at all does not.
 */
function sessionRefused(error: unknown): boolean {
  return error instanceof ApiError && [400, 401, 403].includes(error.status);
}

/** The `details.reason` of a refusal's envelope, or null. */
function refusalReason(text: string): string | null {
  try {
    const reason = (JSON.parse(text) as { error?: { details?: { reason?: unknown } } }).error
      ?.details?.reason;
    return typeof reason === "string" ? reason : null;
  } catch {
    return null;
  }
}

export function tokenSession(options: TokenSessionOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const fetcher =
    options.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch?.bind(globalThis) as FetchLike);
  const early = options.refreshEarlyMs ?? 30_000;
  const now = options.now ?? (() => Date.now());
  // One refresh at a time: two at once would present one refresh token twice and end the session.
  let refreshing: Promise<Tokens | null> | null = null;

  async function refresh(tokens: Tokens): Promise<Tokens | null> {
    try {
      const next = await post(fetcher, `${base}/api/v1/auth/refresh`, {
        refreshToken: tokens.refreshToken,
      });
      await options.store.save(next);
      return next;
    } catch (error) {
      // The host refused the token (signed out, unused too long, reused, not a token): the session
      // is over, so forget it. A 5xx, a 429, a proxy's page or no answer says nothing about the
      // session: the tokens are kept for the next try.
      if (sessionRefused(error)) await options.store.save(null);
      throw error;
    }
  }

  /** One refresh at a time, shared by every call waiting on it. */
  function refreshOnce(tokens: Tokens): Promise<Tokens | null> {
    refreshing ??= refresh(tokens).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /**
   * The tokens to use after `used` was refused as expired (a clock behind the host's): those a
   * refresh already in flight, or just finished, gives; else one refresh, shared.
   */
  async function renewedAfter(used: Tokens): Promise<Tokens | null> {
    if (refreshing) return refreshing;
    const now = await options.store.load();
    if (!now) return null;
    if (now.accessToken !== used.accessToken) return now;
    return refreshOnce(now);
  }

  /** The stored tokens, refreshed first when the access token is about to end. */
  async function current(): Promise<Tokens | null> {
    const tokens = await options.store.load();
    if (!tokens) return null;
    if (Date.parse(tokens.accessExpiresAt) - early <= now()) return refreshOnce(tokens);
    return tokens;
  }

  const bearer = (tokens: Tokens | null): Record<string, string> =>
    tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {};

  return {
    /**
     * Exchanges a sign-in for tokens. `credentials` are the headers that carry it, such as the
     * cookie the sign-in answered with.
     */
    async exchange(deviceName: string, credentials: Record<string, string>): Promise<Tokens> {
      const tokens = await post(fetcher, `${base}/api/v1/auth/token`, { deviceName }, credentials);
      await options.store.save(tokens);
      return tokens;
    },
    /**
     * Asks the host to email a sign-in code (ADR 0455). The answer is the same whoever the
     * address is; it throws only when the host refuses to send any (`rate_limited`, or sign-in
     * not set up).
     */
    async requestCode(email: string, audience: SignInAudience = "customer"): Promise<void> {
      await post<{ ok: true }>(fetcher, `${base}/api/v1/auth/${audience}/code`, { email });
    },
    /**
     * Signs in with the emailed code and keeps the device session the host answers with. A wrong,
     * used or expired code throws `forbidden` (`invalid_code`). No cookie is involved.
     *
     * A customer signing in again in place (a sensitive act asked for a recent sign-in) names the
     * device session it replaces by its refresh token (`replaces`): once the new sign-in has
     * worked, the host ends that one, so it does not live on beside it. A wrong code ends nothing.
     */
    async signInWithCode(
      email: string,
      code: string,
      deviceName: string,
      audience: SignInAudience = "customer",
    ): Promise<SignedIn> {
      const previous = audience === "customer" ? await options.store.load() : null;
      const signedIn = await post<SignedIn>(fetcher, `${base}/api/v1/auth/${audience}/sign-in`, {
        email,
        code,
        deviceName,
        ...(previous?.refreshToken ? { replaces: previous.refreshToken } : {}),
      });
      const { account: _account, ...tokens } = signedIn;
      await options.store.save(tokens);
      return signedIn;
    },
    /**
     * Finishes a staff sign-in in the system browser (`startBrowserSignIn`): checks the state it
     * was sent back with and exchanges the code, with the verifier, for a device session.
     */
    async finishBrowserSignIn(input: {
      callbackUrl: string;
      state: string;
      verifier: string;
      redirectUri: string;
      deviceName: string;
    }): Promise<Tokens> {
      const query = input.callbackUrl.includes("?") ? (input.callbackUrl.split("?")[1] ?? "") : "";
      const params = new Map(
        query
          .split("&")
          .filter(Boolean)
          .map((pair) => {
            const [key = "", value = ""] = pair.split("=");
            return [decodeURIComponent(key), decodeURIComponent(value.replace(/\+/g, " "))];
          }),
      );
      const code = params.get("code");
      if (!code || params.get("state") !== input.state) {
        throw new ApiError(
          "forbidden",
          "The sign-in did not come back from this app's request",
          401,
          {
            reason: "invalid_code",
          },
        );
      }
      const tokens = await post(fetcher, `${base}/api/v1/auth/staff/exchange`, {
        code,
        codeVerifier: input.verifier,
        redirectUri: input.redirectUri,
        deviceName: input.deviceName,
      });
      await options.store.save(tokens);
      return tokens;
    },
    /**
     * The headers for a call: a current access token, refreshed first when it is about to end by
     * this device's clock. Prefer `fetch`, which also refreshes when the host says it has ended.
     */
    async headers(): Promise<Record<string, string>> {
      return bearer(await current());
    },
    /**
     * A fetch that carries the session (pass it as the typed client's `fetch`): each call with a
     * current access token; when the host refuses it as expired (`token_expired`: this device's
     * clock behind the host's), one refresh, shared by every call refused at once, and the call
     * sent once more. Any other answer is passed back as it came.
     */
    fetch: (async (url, init) => {
      const used = await current();
      const send = (tokens: Tokens | null) =>
        fetcher(url, { ...init, headers: { ...init.headers, ...bearer(tokens) } });
      const first = await send(used);
      if (!used || first.status !== 401) return first;
      const text = await first.text();
      const again = { status: first.status, headers: first.headers, text: async () => text };
      if (refusalReason(text) !== "token_expired") return again;
      let next: Tokens | null;
      try {
        next = await renewedAfter(used);
      } catch (error) {
        // Refused: the session is over and forgotten; the call's own refusal says so.
        if (!(await options.store.load())) return again;
        throw error;
      }
      return next ? send(next) : again;
    }) as FetchLike,
    /**
     * Ends this device's session on the host (ADR 0455) with its refresh token, which any account
     * may do whatever it may call, then forgets the tokens, even when the host could not be
     * reached.
     */
    async signOut(): Promise<void> {
      const tokens = await options.store.load();
      try {
        if (tokens) {
          await post<{ ok: true }>(fetcher, `${base}/api/v1/auth/sign-out`, {
            refreshToken: tokens.refreshToken,
          });
        }
      } catch {
        // Forgotten here either way; the host ends an unused session after the idle setting.
      } finally {
        await options.store.save(null);
      }
    },
  };
}

function base64url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += alphabet[c & 63];
  }
  return out;
}

export interface BrowserSignInOptions {
  /** The host's address. */
  hostUrl: string;
  /** The app's own address the host sends the code to, listed in the host's NATIVE_REDIRECT_URIS. */
  redirectUri: string;
  /** Random characters (React Native has no `crypto`: the app passes expo-crypto's). */
  randomKey: () => string;
  /** SHA-256 of a string, as bytes (expo-crypto's digest). */
  sha256: (text: string) => Promise<Uint8Array>;
}

/**
 * Starts a staff sign-in in the system browser (ADR 0455): the URL to open in an ephemeral
 * `ASWebAuthenticationSession` or Custom Tab (never a web view), and the state and verifier to
 * keep until `finishBrowserSignIn`. The verifier never leaves the app.
 */
export async function startBrowserSignIn(
  options: BrowserSignInOptions,
): Promise<{ url: string; state: string; verifier: string }> {
  const verifier = `${options.randomKey()}${options.randomKey()}`
    .replace(/[^A-Za-z0-9._~-]/g, "")
    .slice(0, 128);
  if (verifier.length < 43) throw new Error("randomKey must give at least 22 characters");
  const state = options.randomKey().replace(/[^A-Za-z0-9._~-]/g, "");
  const challenge = base64url(await options.sha256(verifier));
  const query = [
    ["redirect_uri", options.redirectUri],
    ["code_challenge", challenge],
    ["code_challenge_method", "S256"],
    ["state", state],
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join("&");
  return {
    url: `${options.hostUrl.replace(/\/+$/, "")}/native/staff-sign-in?${query}`,
    state,
    verifier,
  };
}
