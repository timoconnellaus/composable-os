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
import {
  ApiError,
  type FetchLike,
  startBrowserSignIn,
  type TokenStore,
  tokenSession,
} from "@composable-os/client";
import { createCustomerClient } from "./client/customer.ts";

/** The app's secure random source: `expo-crypto` in the app (src/secure-random.ts). */
export interface SecureRandom {
  /** `n` random bytes (expo-crypto's getRandomBytes). */
  bytes(n: number): Uint8Array;
  /** SHA-256 of `text`, as bytes (expo-crypto's digest). */
  sha256(text: string): Promise<Uint8Array>;
}

export interface HostOptions {
  /** The host's address, e.g. https://admin.example.com (`extra.hostUrl`, from app.config.ts). */
  hostUrl: string;
  /** Where the customer's tokens live: `secureStore` from secure-store.ts. */
  store: TokenStore;
  /** The device's name, shown in the customer's list of sessions. */
  deviceName: string;
  /** Required: every write carries a random idempotency key, and Hermes has no `crypto`. */
  random: SecureRandom;
  fetch?: FetchLike;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

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

/** A wrong, used or expired code: the one refusal a sign-in answers (ADR 0455). */
const wrongCode = (error: unknown) =>
  error instanceof ApiError &&
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
      await session.requestCode(email, "customer");
      return true;
    },
    /**
     * Signs in with the emailed code: the host answers with this device's tokens, no cookie.
     * False for a wrong, used or expired code.
     */
    async signIn(email: string, code: string): Promise<boolean> {
      try {
        await session.signInWithCode(email, code, options.deviceName, "customer");
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
    /** Ends this device's session on the host, then forgets its tokens (even if offline). */
    signOut: () => session.signOut(),
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
   * For browser-based sign-in (Google, Cloudflare Access): the app's redirect,
   * `<scheme>://staff-sign-in`, which the host lists (cos deploy sets NATIVE_REDIRECT_URIS from
   * product.ts), and a way to open the system browser and get the URL it came back to
   * (expo-web-browser's `openAuthSessionAsync(url, redirectUri)`), or null when cancelled.
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
  const randomKey = () => hex(random.bytes(16));
  // One staff session on this device at a time: the one a new sign-in replaces is ended first.
  const endPrevious = async () => {
    if ((await options.store.load()) !== null) await session.signOut();
  };

  return {
    /** Asks the host to email a staff sign-in code (an invited or verified staff address). */
    async requestCode(email: string): Promise<boolean> {
      await session.requestCode(email, "staff");
      return true;
    },
    /** Signs a staff member in with the emailed code. False for a wrong one. */
    async signIn(email: string, code: string): Promise<boolean> {
      await endPrevious();
      try {
        await session.signInWithCode(email, code, options.deviceName, "staff");
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
      const started = await startBrowserSignIn({
        hostUrl: base,
        redirectUri,
        randomKey,
        sha256: (text) => random.sha256(text),
      });
      const callbackUrl = await openBrowser(started.url, redirectUri);
      if (!callbackUrl) return false;
      await endPrevious();
      try {
        await session.finishBrowserSignIn({
          callbackUrl,
          state: started.state,
          verifier: started.verifier,
          redirectUri,
          deviceName: options.deviceName,
        });
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
      return create({ baseUrl: base, fetch: fetcher, headers: session.headers, randomKey });
    },
    /**
     * Ends this device's staff session on the host and forgets its tokens. No operation: a pack
     * role may call nothing but its own, and still signs out (`/api/v1/auth/sign-out`).
     */
    signOut: () => session.signOut(),
  };
}

export type StaffSession = ReturnType<typeof staffSession>;

/**
 * Where the app asks for a picture of the host's media library (stage 28, issue #181): the host's
 * public media route beside the HTTP surface, `<hostUrl>/api/v1/media/<id>?w=<width>`, which
 * Cloudflare Access lets through with the rest of /api/v1. The host serves a picture that
 * published content shows; anything else is not found. Pass it as a native block's `mediaUrl`.
 */
export function mediaUrlFor(options: Pick<HostOptions, "hostUrl">) {
  const host = options.hostUrl.replace(/\/+$/, "");
  return (id: string, width: number): string =>
    `${host}/api/v1/media/${encodeURIComponent(id)}${width ? `?w=${Math.round(width)}` : ""}`;
}
