// How this mobile app reaches the host: over HTTPS to the host's own address, with the same typed
// client the web app uses. Sign-in answers with tokens, never a cookie (ADR 0455): the customer
// asks for a code by email and signs in with it; the host answers with a device session (a
// short-lived access token and a rotating refresh token, kept in the phone's secure store), and
// every call after that carries the access token.
//
// Staff with a pack role (a coach at the door, ADR 0436) sign in too, apart from customers (ADR
// 0451): by an emailed code, or in the system browser when the deployment signs staff in with
// Google or Cloudflare Access. Their session has its own slot in the secure store, and their calls
// go only to the host's address, through a role client (`./client/roles/<pack>.<role>.ts`).
//
// No framework and no native module in here: App.tsx passes in the secure store and the secure
// random source (expo-crypto: React Native has no `crypto`), and the tests run this file against
// a local host.
//
// The token routes are fixed by ADR 0455 (`/api/v1/auth/customer/*`, `/api/v1/auth/staff/*`,
// `/native/staff-sign-in`, `/api/v1/auth/sign-out`). Waiting on the identity branch
// (fix/staff-invites-and-native-sign-in): until it merges, a host does not serve them.
import {
  ApiError,
  type FetchLike,
  type TokenStore,
  type Tokens,
  tokenSession,
} from "@composable-os/client";
import { createCustomerClient } from "./client/customer.ts";

/** The app's secure random source: `expo-crypto` in the app. */
export interface SecureRandom {
  /** `n` random bytes (expo-crypto's getRandomBytes). */
  bytes(n: number): Uint8Array;
  /** SHA-256 of `text`, as bytes (expo-crypto's digest). */
  sha256(text: string): Promise<Uint8Array>;
}

export interface HostOptions {
  /** The host's public address, e.g. https://admin.example.com (app.json `extra.hostUrl`). */
  hostUrl: string;
  /** Where the customer's tokens live: `secureStore` from secure-store.ts. */
  store: TokenStore;
  /** The device's name, shown in the customer's list of sessions. */
  deviceName: string;
  /** Required: every write carries a random idempotency key, and Hermes has no `crypto`. */
  random: SecureRandom;
  fetch?: FetchLike;
}

const json = { "content-type": "application/json" };

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (bytes: Uint8Array) => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += chars.charAt((n >> 18) & 63) + chars.charAt((n >> 12) & 63);
    if (i + 1 < bytes.length) out += chars.charAt((n >> 6) & 63);
    if (i + 2 < bytes.length) out += chars.charAt(n & 63);
  }
  return out;
};

function checked(options: { random?: SecureRandom }): SecureRandom {
  // Said at start-up, not at the first write: without it every mutation would throw.
  if (!options.random?.bytes || !options.random.sha256) {
    throw new Error(
      "hostSession needs the app's secure random source: pass random (expo-crypto's getRandomBytes and digest). React Native has no crypto.",
    );
  }
  return options.random;
}

function fetcherOf(options: { fetch?: FetchLike }): FetchLike {
  return (
    options.fetch ??
    ((url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init))
  );
}

/** POST to a token route; the tokens, or false for the one refusal a wrong code gets. */
async function post(fetcher: FetchLike, url: string, body: unknown): Promise<unknown> {
  const response = await fetcher(url, {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });
  const parsed = JSON.parse(await response.text()) as {
    data?: unknown;
    error?: { code: string; message: string; details?: unknown };
  };
  if (response.status === 200) return parsed.data;
  throw new ApiError(
    parsed.error?.code ?? "internal",
    parsed.error?.message ?? `The host answered ${response.status}`,
    response.status,
    parsed.error?.details,
  );
}

const wrongCode = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 401 &&
  (error.details as { reason?: string } | undefined)?.reason === "invalid_code";

export function hostSession(options: HostOptions) {
  const random = checked(options);
  const base = options.hostUrl.replace(/\/+$/, "");
  const fetcher = fetcherOf(options);
  const session = tokenSession({ baseUrl: base, store: options.store, fetch: fetcher });
  const api = createCustomerClient({
    baseUrl: base,
    fetch: fetcher,
    headers: session.headers,
    randomKey: () => hex(random.bytes(16)),
  });

  return {
    api,
    /** Asks the host to email a sign-in code. The answer is the same whoever the address is. */
    async requestCode(email: string): Promise<boolean> {
      await post(fetcher, `${base}/api/v1/auth/customer/code`, { email });
      return true;
    },
    /** Signs in with the emailed code: the host answers with this device's tokens, no cookie. */
    async signIn(email: string, code: string): Promise<boolean> {
      try {
        const tokens = (await post(fetcher, `${base}/api/v1/auth/customer/sign-in`, {
          email,
          code,
          deviceName: options.deviceName,
        })) as Tokens & { account?: string };
        const { account: _account, ...kept } = tokens;
        await options.store.save(kept);
        return true;
      } catch (error) {
        if (wrongCode(error)) return false;
        throw error;
      }
    },
    /** True while this device has a session. */
    async signedIn(): Promise<boolean> {
      return (await options.store.load()) !== null;
    },
    /** Ends this device's session on the host, then forgets its tokens. */
    async signOut(): Promise<void> {
      try {
        await api.call("me.signOut", {});
      } finally {
        await session.signOut();
      }
    },
  };
}

export type HostSession = ReturnType<typeof hostSession>;

// ---- Staff on this device (ADR 0451) -------------------------------------------------------------

export interface StaffOptions {
  /** The host's public address (the staff admin's), e.g. https://admin.example.com. */
  hostUrl: string;
  /** The staff session's own slot (`staffSecureStore`), never the customer's. */
  store: TokenStore;
  /** The device's name, shown in the staff member's list of sessions. */
  deviceName: string;
  /** The app's secure random source (expo-crypto). */
  random: SecureRandom;
  /**
   * For browser-based sign-in (Google, Cloudflare Access): the app's redirect, `<scheme>://staff-sign-in`,
   * which the deployment lists (cos deploy sets NATIVE_REDIRECT_URIS from product.ts), and a way
   * to open the system browser and get the URL it came back to (expo-web-browser's
   * `openAuthSessionAsync(url, redirectUri)`), or null when the person cancelled.
   */
  redirectUri?: string;
  openBrowser?: (url: string, redirectUri: string) => Promise<string | null>;
  fetch?: FetchLike;
}

export function staffSession(options: StaffOptions) {
  const random = checked(options);
  const base = options.hostUrl.replace(/\/+$/, "");
  const fetcher = fetcherOf(options);
  const session = tokenSession({ baseUrl: base, store: options.store, fetch: fetcher });
  const save = async (tokens: Tokens) => {
    // One staff session on this device at a time: the one it replaces is ended first.
    if ((await options.store.load()) !== null) await signOut();
    await options.store.save(tokens);
  };
  async function signOut(): Promise<void> {
    // Not an operation: a pack role may call nothing but its own, and still signs out. The
    // runtime's signOut ends the session on the host (`POST /api/v1/auth/sign-out`) and forgets
    // the tokens even if that call fails. Waiting on the identity branch (ADR 0455): until it
    // merges, signOut only forgets the tokens here.
    await session.signOut();
  }

  return {
    /** Asks the host to email a staff sign-in code (an invited or verified staff address). */
    async requestCode(email: string): Promise<boolean> {
      await post(fetcher, `${base}/api/v1/auth/staff/code`, { email });
      return true;
    },
    /** Signs a staff member in with the emailed code. */
    async signIn(email: string, code: string): Promise<boolean> {
      try {
        const tokens = (await post(fetcher, `${base}/api/v1/auth/staff/sign-in`, {
          email,
          code,
          deviceName: options.deviceName,
        })) as Tokens;
        await save(tokens);
        return true;
      } catch (error) {
        if (wrongCode(error)) return false;
        throw error;
      }
    },
    /**
     * Signs a staff member in through the system browser, at the host, with whatever sign-in the
     * deployment uses. False when they cancelled or the host refused.
     */
    async signInWithBrowser(): Promise<boolean> {
      const { redirectUri, openBrowser } = options;
      if (!redirectUri || !openBrowser) {
        throw new Error("staffSession needs redirectUri and openBrowser for browser sign-in");
      }
      const verifier = b64url(random.bytes(32));
      const state = b64url(random.bytes(16));
      const link = new URL(`${base}/native/staff-sign-in`);
      link.searchParams.set("redirect_uri", redirectUri);
      link.searchParams.set("code_challenge", b64url(await random.sha256(verifier)));
      link.searchParams.set("code_challenge_method", "S256");
      link.searchParams.set("state", state);
      const back = await openBrowser(link.toString(), redirectUri);
      if (!back) return false;
      const answer = new URL(back);
      const code = answer.searchParams.get("code");
      if (!code || answer.searchParams.get("state") !== state) return false;
      try {
        const tokens = (await post(fetcher, `${base}/api/v1/auth/staff/exchange`, {
          code,
          codeVerifier: verifier,
          redirectUri,
          deviceName: options.deviceName,
        })) as Tokens;
        await save(tokens);
        return true;
      } catch (error) {
        if (wrongCode(error)) return false;
        throw error;
      }
    },
    /** True while this device has a staff session. */
    async signedIn(): Promise<boolean> {
      return (await options.store.load()) !== null;
    },
    /**
     * A role client over this session, to the host's address only:
     * `staff.client(createTicketingDoorClient)`.
     */
    client<T>(
      create: (o: {
        baseUrl: string;
        fetch: FetchLike;
        headers: () => Promise<Record<string, string>>;
        randomKey: () => string;
      }) => T,
    ): T {
      return create({
        baseUrl: base,
        fetch: fetcher,
        headers: session.headers,
        randomKey: () => hex(random.bytes(16)),
      });
    },
    /** Ends this device's staff session on the host, then forgets its tokens. */
    signOut,
  };
}

export type StaffSession = ReturnType<typeof staffSession>;
