// The browser build's ScreenHost (stage 75 step 2, ADR 0960): no server of its own, so the screens
// call the host's HTTP surface (/api/v1) with the typed client, signed in with a device session
// as the mobile app is (ADRs 0451, 0455): an emailed code answered with a short-lived access token
// and a rotating refresh token, never a cookie. Every request here is sent with
// `credentials: "omit"`, so no cookie the browser holds for the host (a staff member's, say)
// rides along, and none is ever set.
//
// Where the tokens are kept is the store's (`sessionTokenStore` by default): in memory, mirrored
// to this tab's sessionStorage so a reload keeps the tab signed in. Each tab signs in on its own,
// with its own device session: two tabs sharing one refresh token would refresh it at once, and
// the host ends a session whose refresh token is used twice. Closing the tab forgets it. A token
// is never put in an address. Script that runs in the page could read the store, as it could use
// a token held only in memory: what keeps it out is serving the files with a strict Content
// Security Policy and loading no script from anywhere else (step 5's serving).
//
// A desktop wrapper that keeps the tokens in its own process (stage 76) gives the screens its own
// ScreenHost instead, or this one with its `store` and a `fetch` that adds the token itself.
import {
  agreementPdfPath,
  type FetchLike,
  type TokenStore,
  type Tokens,
  tokenSession,
  type UpgradeRequiredError,
} from "@composable-os/client";
import { signedOut } from "../agreements.ts";
import { createCustomerClient } from "../client/customer.ts";
import { type ScreenHost, saveResponse } from "./index.ts";

/** What sessionStorage offers that the store uses (a test passes its own). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where a tab keeps its device session in sessionStorage. */
export const SESSION_KEY = "cos.customer.session";

function isTokens(value: unknown): value is Tokens {
  const v = value as Record<string, unknown> | null;
  return (
    typeof v?.accessToken === "string" &&
    typeof v.refreshToken === "string" &&
    typeof v.accessExpiresAt === "string" &&
    typeof v.sessionId === "string"
  );
}

/**
 * The browser build's token store: memory first, mirrored to `storage` (this tab's
 * sessionStorage) so a reload keeps the tab signed in. With no storage, or one that refuses (a
 * private window, blocked site data), it keeps the session in memory only, for as long as the
 * page is open.
 */
export function sessionTokenStore(storage: StorageLike | null = defaultStorage()): TokenStore {
  let held: Tokens | null | undefined;
  return {
    async load() {
      if (held !== undefined) return held;
      held = null;
      try {
        const parsed: unknown = JSON.parse(storage?.getItem(SESSION_KEY) ?? "null");
        if (isTokens(parsed)) held = parsed;
      } catch {}
      return held;
    },
    async save(tokens) {
      held = tokens;
      try {
        if (tokens) storage?.setItem(SESSION_KEY, JSON.stringify(tokens));
        else storage?.removeItem(SESSION_KEY);
      } catch {}
    },
  };
}

function defaultStorage(): StorageLike | null {
  try {
    return (globalThis as { sessionStorage?: StorageLike }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The page's own fetch, never with a cookie: the browser build sends tokens only. */
export function withoutCookies(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
  return (url: string, init: RequestInit = {}) => fetcher(url, { ...init, credentials: "omit" });
}

export interface TokenScreenHostOptions {
  /** The host's address, e.g. https://admin.example.com: where /api/v1 is. */
  hostUrl: string;
  /** Where the device session lives: `sessionTokenStore()` unless a wrapper keeps it. */
  store?: TokenStore;
  /** The name the customer sees in their list of sessions. */
  deviceName?: string;
  /** The page's fetch; default the browser's, without cookies. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** The host no longer serves the contract these screens were built for (ADR 0417). */
  onUpgradeRequired?: (error: UpgradeRequiredError) => void;
}

export function tokenScreenHost(options: TokenScreenHostOptions): ScreenHost {
  const base = options.hostUrl.replace(/\/+$/, "");
  const store = options.store ?? sessionTokenStore();
  const deviceName = options.deviceName ?? "Web browser";
  const page = options.fetch ?? withoutCookies();
  const fetcher = page as unknown as FetchLike;
  const session = tokenSession({ baseUrl: base, store, fetch: fetcher });
  const api = createCustomerClient({
    baseUrl: base,
    fetch: fetcher,
    headers: session.headers,
    ...(options.onUpgradeRequired ? { onUpgradeRequired: options.onUpgradeRequired } : {}),
  });
  return {
    build: "browser",
    api,
    async me() {
      if (!(await store.load())) return null;
      try {
        const me = await api.call("me.get", {});
        return { displayName: me.displayName, primaryEmail: me.primaryEmail };
      } catch (error) {
        // The session ended on the host (signed out elsewhere, the account closed): forget it.
        if (signedOut(error)) {
          await store.save(null);
          return null;
        }
        throw error;
      }
    },
    async requestCode(email) {
      try {
        await session.requestCode(email, "customer");
        return true;
      } catch {
        return false;
      }
    },
    async signIn(email, code) {
      try {
        await session.signInWithCode(email, code.trim(), deviceName, "customer");
        return true;
      } catch {
        return false;
      }
    },
    signOut: () => session.signOut(),
    forget: () => store.save(null),
    async downloadAgreementPdf(id) {
      // Same origin as the host only: the PDF route sends no CORS headers (stage 75 step 2's PR).
      const response = await page(`${base}${agreementPdfPath(id)}`, {
        headers: await session.headers(),
      });
      await saveResponse(response, `agreement-${id}.pdf`);
    },
  };
}
