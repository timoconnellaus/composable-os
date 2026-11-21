// Sessions for native apps (stage 23, ADR 0419; signing in for tokens, ADR 0455). A phone signs
// in with a code emailed to the person and gets a short-lived access token and a refresh token in
// the answer's body (no cookie is ever set), keeps both in its secure store, and refreshes before
// the access token runs out. Every refresh rotates the refresh token; the host ends the session
// when an old one is used again, so two copies of one session cannot both live.
//
//   const session = tokenSession({ baseUrl, store: secureStore });
//   await session.requestCode(email);
//   await session.signInWithCode(email, code, "Ada's phone");
//   const api = createCustomerClient({ baseUrl, headers: session.headers });
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
  const parsed = JSON.parse(await response.text()) as {
    data?: T;
    error?: { code: string; message: string; details?: unknown };
  };
  if (response.status === 200 && parsed.data) return parsed.data;
  throw new ApiError(
    parsed.error?.code ?? "internal",
    parsed.error?.message ?? `The host answered ${response.status}`,
    response.status,
    parsed.error?.details,
  );
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
      // The session ended (signed out, unused too long, a reused token): forget it.
      if (error instanceof ApiError) await options.store.save(null);
      throw error;
    }
  }

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
     */
    async signInWithCode(
      email: string,
      code: string,
      deviceName: string,
      audience: SignInAudience = "customer",
    ): Promise<SignedIn> {
      const signedIn = await post<SignedIn>(fetcher, `${base}/api/v1/auth/${audience}/sign-in`, {
        email,
        code,
        deviceName,
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
    /** The headers for a call: a current access token, refreshed first when it is about to end. */
    async headers(): Promise<Record<string, string>> {
      let tokens = await options.store.load();
      if (!tokens) return {};
      if (Date.parse(tokens.accessExpiresAt) - early <= now()) {
        refreshing ??= refresh(tokens).finally(() => {
          refreshing = null;
        });
        tokens = await refreshing;
        if (!tokens) return {};
      }
      return { authorization: `Bearer ${tokens.accessToken}` };
    },
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
