// How this mobile app reaches the host: over HTTPS to the host's own address, with the same typed
// client the web app uses. The customer signs in with a code by email; the sign-in is exchanged at
// once for a device session (a short-lived access token and a rotating refresh token, kept in the
// phone's secure store), and every call after that carries the access token.
//
// No framework and no native module in here: App.tsx passes the secure store in, and the tests run
// this file against a local host.
import {
  CUSTOMER_AUTH_PATH,
  type FetchLike,
  type TokenStore,
  tokenSession,
} from "@composable-os/client";
import { createCustomerClient } from "./client/customer.ts";

export interface HostOptions {
  /** The host's public address, e.g. https://admin.example.com (app.json `extra.hostUrl`). */
  hostUrl: string;
  /** Where the tokens live: expo-secure-store in the app. */
  store: TokenStore;
  /** The device's name, shown in the customer's list of sessions. */
  deviceName: string;
  fetch?: FetchLike;
}

const json = { "content-type": "application/json" };

export function hostSession(options: HostOptions) {
  const base = options.hostUrl.replace(/\/+$/, "");
  const fetcher: FetchLike =
    options.fetch ??
    ((url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init));
  const session = tokenSession({ baseUrl: base, store: options.store, fetch: fetcher });
  const api = createCustomerClient({ baseUrl: base, fetch: fetcher, headers: session.headers });

  return {
    api,
    /** Asks the host to email a sign-in code. The answer is the same whoever the address is. */
    async requestCode(email: string): Promise<boolean> {
      const response = await fetcher(
        `${base}${CUSTOMER_AUTH_PATH}/email-otp/send-verification-otp`,
        {
          method: "POST",
          headers: json,
          body: JSON.stringify({ email, type: "sign-in" }),
        },
      );
      return response.status === 200;
    },
    /**
     * Signs in with the emailed code and exchanges the sign-in for this device's tokens. The
     * sign-in's cookie is used once, for the exchange, and never kept.
     */
    async signIn(email: string, code: string): Promise<boolean> {
      const response = await fetcher(`${base}${CUSTOMER_AUTH_PATH}/sign-in/email-otp`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ email, otp: code }),
      });
      if (response.status !== 200) return false;
      const cookie = (response.headers.get("set-cookie") ?? "")
        .split(/,(?=\s*[^;,]+=)/)
        .map((c) => c.split(";")[0]?.trim() ?? "")
        .filter((c) => /cos-customer\./.test(c))
        .join("; ");
      if (!cookie) return false;
      await session.exchange(options.deviceName, { cookie });
      return true;
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
//
// A staff member with a pack role (a coach at the door, ADR 0436) signs in at the host in the
// system browser, with whatever sign-in the deployment uses, and the app exchanges that sign-in
// for a staff device session. Its tokens are kept in their own slot of the secure store, apart
// from a customer's: a device holds at most one of each. Staff calls go only to the host's own
// address, through a role client (`./client/roles/<pack>.<role>.ts`, from `cos client generate`):
// a staff token is never sent to the company's own server.

export interface StaffOptions {
  /** The host's public address (the staff admin's), e.g. https://admin.example.com. */
  hostUrl: string;
  /** The staff session's own slot (`staffSecureStore` in the app), never the customer's. */
  store: TokenStore;
  /** The device's name, shown in the staff member's list of sessions. */
  deviceName: string;
  /** The app's redirect the host sends the sign-in back to: `<scheme>://staff-sign-in`. */
  redirectUri: string;
  /**
   * Opens `url` in the system browser and resolves with the URL the host redirected to (expo-web-
   * browser's `openAuthSessionAsync(url, redirectUri)`), or null when the person cancelled.
   */
  openBrowser: (url: string, redirectUri: string) => Promise<string | null>;
  fetch?: FetchLike;
  /** Random bytes, for the PKCE verifier and the state (crypto.getRandomValues by default). */
  random?: (bytes: number) => Uint8Array;
}

const b64url = (bytes: Uint8Array) => {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function staffSession(options: StaffOptions) {
  const base = options.hostUrl.replace(/\/+$/, "");
  const fetcher: FetchLike =
    options.fetch ??
    ((url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init));
  const random =
    options.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)) as Uint8Array);
  const session = tokenSession({ baseUrl: base, store: options.store, fetch: fetcher });

  return {
    /**
     * Signs a staff member in through the system browser. False when they cancelled or the host
     * refused. A staff session already on this device is ended first: one at a time.
     */
    async signIn(): Promise<boolean> {
      if ((await options.store.load()) !== null) await this.signOut();
      const verifier = b64url(random(32));
      const state = b64url(random(16));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const link = new URL(`${base}/api/v1/auth/app-link`);
      link.searchParams.set("redirect_uri", options.redirectUri);
      link.searchParams.set("state", state);
      link.searchParams.set("code_challenge", b64url(new Uint8Array(digest)));
      link.searchParams.set("code_challenge_method", "S256");
      link.searchParams.set("device_name", options.deviceName);
      const back = await options.openBrowser(link.toString(), options.redirectUri);
      if (!back) return false;
      const answer = new URL(back);
      const code = answer.searchParams.get("code");
      if (!code || answer.searchParams.get("state") !== state) return false;
      await session.exchangeCode({
        code,
        codeVerifier: verifier,
        redirectUri: options.redirectUri,
      });
      return true;
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
      }) => T,
    ): T {
      return create({ baseUrl: base, fetch: fetcher, headers: session.headers });
    },
    /** Ends this device's staff session on the host, then forgets its tokens. */
    async signOut(): Promise<void> {
      try {
        // Not an operation: a pack role may call nothing else, and still signs out.
        const tokens = await options.store.load();
        if (tokens) {
          await fetcher(`${base}/api/v1/auth/sign-out`, {
            method: "POST",
            headers: json,
            body: JSON.stringify({ refreshToken: tokens.refreshToken }),
          });
        }
      } finally {
        await session.signOut();
      }
    },
  };
}

export type StaffSession = ReturnType<typeof staffSession>;
