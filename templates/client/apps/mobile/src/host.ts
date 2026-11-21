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
