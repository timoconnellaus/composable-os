// Sessions for native apps (stage 23, ADR 0419). A phone exchanges its sign-in for a short-lived
// access token and a refresh token, keeps both in its secure store, and refreshes before the
// access token runs out. Every refresh rotates the refresh token; the host ends the session when
// an old one is used again, so two copies of one session cannot both live.
//
//   const session = tokenSession({ baseUrl, store: secureStore });
//   const api = createCustomerClient({ baseUrl, headers: session.headers });
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

export interface TokenSessionOptions {
  baseUrl: string;
  store: TokenStore;
  fetch?: FetchLike;
  /** Refresh this long before the access token runs out. Default 30 seconds. */
  refreshEarlyMs?: number;
  now?: () => number;
}

async function post(
  fetcher: FetchLike,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Tokens> {
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
    data?: Tokens;
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
    async signOut(): Promise<void> {
      await options.store.save(null);
    },
  };
}
