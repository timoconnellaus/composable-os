// The browser build's ScreenHost (stage 75 step 2, ADR 0960): no server of its own, so the screens
// call the host's HTTP surface (/api/v1) with the typed client, signed in with a device session
// as the mobile app is (ADRs 0451, 0455): an emailed code answered with a short-lived access token
// and a rotating refresh token, never a cookie. Every request here is sent with
// `credentials: "omit"`, a fetch a wrapper passes in included, so no cookie the browser holds for
// the host (a staff member's, say) rides along, and none is ever set.
//
// Where the tokens are kept is the store's (`sessionTokenStore` by default): in memory, mirrored
// to this tab's sessionStorage so a reload keeps the tab signed in, and forgotten when the tab
// closes. One device session belongs to one tab: a browser copies a tab's sessionStorage into a
// tab duplicated from it (Duplicate Tab, a link opened with its opener), and two tabs refreshing
// one refresh token would end the session (the host ends one whose refresh token is used twice).
// So the store marks its tab as live while it is open, and a tab that starts with a live mark in
// its storage is a copy: it starts signed out, and signs in on its own (issue #540). A token is
// never put in an address. Script that runs in the page could read the store, as it could use a
// token held only in memory: what keeps it out is serving the files with a strict Content
// Security Policy, on an origin of their own, loading no script from anywhere else (step 5).
//
// A call refused because the access token has expired (this device's clock behind the host's) is
// refreshed once and sent again (`tokenSession`'s fetch); a session the host has ended is signed
// out on the host where it still can be, so it leaves the customer's list of devices.
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

/** The page's events the store listens to (`window`; a test passes its own). */
export interface PageLike {
  addEventListener(type: "pagehide" | "pageshow", listener: () => void): void;
}

/** Where a tab keeps its device session in sessionStorage. */
export const SESSION_KEY = "cos.customer.session";
/** The mark a tab keeps in its sessionStorage while it is open: found at start, it is a copy. */
export const LIVE_KEY = "cos.customer.session.live";

function isTokens(value: unknown): value is Tokens {
  const v = value as Record<string, unknown> | null;
  return (
    typeof v?.accessToken === "string" &&
    typeof v.refreshToken === "string" &&
    typeof v.accessExpiresAt === "string" &&
    typeof v.sessionId === "string"
  );
}

/** Runs a storage call; a storage that refuses (a private window, blocked site data) is none. */
function quietly<T>(act: () => T): T | null {
  try {
    return act();
  } catch {
    return null;
  }
}

/**
 * The browser build's token store: memory first, mirrored to `storage` (this tab's
 * sessionStorage) so a reload keeps the tab signed in. A tab that starts as a copy of a live one
 * (its storage holds the live mark: the original has not gone) drops the copied session and
 * starts signed out. A reload is not a copy: the page that goes takes its mark with it
 * (`pagehide`), and a page put back from the back-forward cache sets it again (`pageshow`). With
 * no storage, or one that refuses, the session is kept in memory only, while the page is open.
 */
export function sessionTokenStore(
  storage: StorageLike | null = defaultStorage(),
  page: PageLike | null = defaultPage(),
): TokenStore {
  let held: Tokens | null | undefined;
  if (storage) {
    if (quietly(() => storage.getItem(LIVE_KEY)) !== null) {
      // A copy of a tab that is still open: its session is that tab's, never this one's.
      quietly(() => storage.removeItem(SESSION_KEY));
    }
    const mark = () => quietly(() => storage.setItem(LIVE_KEY, "1"));
    mark();
    page?.addEventListener("pagehide", () => quietly(() => storage.removeItem(LIVE_KEY)));
    page?.addEventListener("pageshow", mark);
  }
  return {
    async load() {
      if (held !== undefined) return held;
      held = null;
      const parsed: unknown = quietly(() => JSON.parse(storage?.getItem(SESSION_KEY) ?? "null"));
      if (isTokens(parsed)) held = parsed;
      return held;
    },
    async save(tokens) {
      held = tokens;
      quietly(() =>
        tokens
          ? storage?.setItem(SESSION_KEY, JSON.stringify(tokens))
          : storage?.removeItem(SESSION_KEY),
      );
    },
  };
}

function defaultStorage(): StorageLike | null {
  return quietly(() => (globalThis as { sessionStorage?: StorageLike }).sessionStorage ?? null);
}

function defaultPage(): PageLike | null {
  return (globalThis as { window?: PageLike }).window ?? null;
}

/** A page's fetch: the browser's, or a wrapper's. */
export type PageFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The page's own fetch, never with a cookie: the browser build sends tokens only. */
export function withoutCookies(fetcher: PageFetch = globalThis.fetch.bind(globalThis)): PageFetch {
  return (url, init = {}) => fetcher(url, { ...init, credentials: "omit" });
}

export interface TokenScreenHostOptions {
  /** The host's address, e.g. https://admin.example.com: where /api/v1 is. */
  hostUrl: string;
  /** Where the device session lives: `sessionTokenStore()` unless a wrapper keeps it. */
  store?: TokenStore;
  /** The name the customer sees in their list of sessions. */
  deviceName?: string;
  /** The page's fetch; default the browser's. Either way it is sent without cookies. */
  fetch?: PageFetch;
  /** The host no longer serves the contract these screens were built for (ADR 0417). */
  onUpgradeRequired?: (error: UpgradeRequiredError) => void;
}

export function tokenScreenHost(options: TokenScreenHostOptions): ScreenHost {
  const base = options.hostUrl.replace(/\/+$/, "");
  const store = options.store ?? sessionTokenStore();
  const deviceName = options.deviceName ?? "Web browser";
  const page = withoutCookies(options.fetch);
  const session = tokenSession({ baseUrl: base, store, fetch: page as unknown as FetchLike });
  // Every call through the session's fetch: the token, and one refresh when it has expired.
  const authorized = session.fetch as unknown as PageFetch;
  const api = createCustomerClient({
    baseUrl: base,
    fetch: session.fetch,
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
        // The session is over on the host (signed out elsewhere, the account closed): end it there
        // too where it can still be ended, so it leaves the list of devices, and forget it here.
        if (signedOut(error)) {
          await session.signOut();
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
      // The host's PDF route answers the screens' origin as the surface does (API_ALLOWED_ORIGINS).
      const response = await authorized(`${base}${agreementPdfPath(id)}`, {
        method: "GET",
        headers: {},
      });
      await saveResponse(response, `agreement-${id}.pdf`);
    },
  };
}
