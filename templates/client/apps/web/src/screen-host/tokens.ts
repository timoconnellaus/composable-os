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
// So the tab using a session holds a Web Lock named for it while it is open; a tab that starts
// with a session whose lock another live tab holds is a copy: it starts signed out, and signs in
// on its own (issue #540). A tab the browser discarded, or whose process it killed, holds no lock
// any more, so it comes back signed in. Without Web Locks, a mark the tab keeps in its storage
// while open stands in, which a discarded tab (`document.wasDiscarded`) does not count against
// (a killed one there starts signed out: the safe side). A token is never put in an address. Script that runs in the page could read the store, as it could use a
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

/** The little of the Web Locks API (`navigator.locks`) the store uses; a test passes its own. */
export interface LocksLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

/** What the store reads of the page it runs in; each part defaults to the browser's own. */
export interface TabLike {
  /** `navigator.locks`, or null where the browser has none. */
  locks?: LocksLike | null;
  /** `document.wasDiscarded`: the browser discarded this tab and is loading it again. */
  wasDiscarded?: boolean;
  /**
   * How long a starting tab waits for another tab to let a session's lock go, in ms: a page that
   * is reloading lets go as it is unloaded; a live tab never does. Default 1000.
   */
  waitMs?: number;
  /** The page was loaded by a reload (`performance` navigation type "reload"): never a copy. */
  reloaded?: boolean;
}

/** The lock a tab holds while it uses a session. */
export const lockName = (sessionId: string) => `cos.customer.session:${sessionId}`;

/** What one page has already claimed, by its storage: a second store there is not a copy (F5). */
const thisPage = new WeakMap<object, { marked: boolean; holds: Set<string> }>();

function pageState(key: object) {
  let state = thisPage.get(key);
  if (!state) {
    state = { marked: false, holds: new Set() };
    thisPage.set(key, state);
  }
  return state;
}

/**
 * The browser build's token store: memory first, mirrored to `storage` (this tab's
 * sessionStorage) so a reload keeps the tab signed in. One session to one tab:
 * - With Web Locks, the tab using a session holds its lock (`lockName`). A starting tab whose
 *   stored session's lock another tab still holds after `waitMs` is a copy (Duplicate Tab): it
 *   drops the copied session and starts signed out. A reload, a discarded tab coming back, or a
 *   tab reopened after a crash finds the lock free, and stays signed in.
 * - Without them, the tab keeps a mark in its storage while open (removed on `pagehide`, set
 *   again on `pageshow`); a tab that starts with a mark it did not set, and that the browser did
 *   not discard, is a copy. A tab whose process was killed starts signed out there.
 * A second store in the same page shares what the first claimed. With no storage, or one that
 * refuses, the session is kept in memory only, while the page is open.
 */
export function sessionTokenStore(
  storage: StorageLike | null = defaultStorage(),
  page: PageLike | null = defaultPage(),
  tab: TabLike = {},
): TokenStore {
  const locks = tab.locks === undefined ? defaultLocks() : tab.locks;
  const discarded = tab.wasDiscarded ?? defaultWasDiscarded();
  const waitMs = tab.waitMs ?? 1000;
  const reloaded = tab.reloaded ?? defaultReloaded();
  const here = storage ? pageState(storage) : { marked: false, holds: new Set<string>() };
  let held: Tokens | null = null;
  let holding: { sessionId: string; letGo: () => void } | null = null;

  /**
   * Takes the session's lock for this page, waiting `wait` ms for another to let it go, or until
   * it does ("forever": a reloaded page whose old document is slow to let go, F-d).
   */
  async function claim(sessionId: string, wait: number | "forever" = waitMs): Promise<boolean> {
    if (!locks || here.holds.has(sessionId)) return true;
    let letGo = () => {};
    const kept = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const timeout = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout;
    const options =
      wait === "forever" ? {} : timeout ? { signal: timeout(wait) } : { ifAvailable: true };
    const got = await new Promise<boolean>((resolve) => {
      locks
        .request(lockName(sessionId), options, (lock) => {
          resolve(lock !== null);
          // Held for as long as this page uses the session.
          return lock === null ? undefined : kept;
        })
        .catch(() => resolve(false));
    });
    if (!got) return false;
    if (wait === "forever" && held?.sessionId !== sessionId) {
      // The session changed while this page waited: the lock is not this page's to keep.
      letGo();
      return false;
    }
    release();
    here.holds.add(sessionId);
    holding = {
      sessionId,
      letGo: () => {
        here.holds.delete(sessionId);
        letGo();
      },
    };
    return true;
  }

  function release() {
    holding?.letGo();
    holding = null;
  }

  const mark = () => {
    if (!storage) return;
    quietly(() => storage.setItem(LIVE_KEY, "1"));
    here.marked = true;
  };

  /** Whether the session found at start is another live tab's (this tab is its copy). */
  async function copied(stored: Tokens): Promise<boolean> {
    // A reload is this same tab, never a copy (F-d): its old document may still be letting the
    // lock go, so the lock is taken when it does.
    if (reloaded) {
      if (locks && !(await claim(stored.sessionId))) {
        void claim(stored.sessionId, "forever");
      }
      return false;
    }
    if (locks) return !(await claim(stored.sessionId));
    if (discarded || here.marked) return false;
    return quietly(() => storage?.getItem(LIVE_KEY)) != null;
  }

  const ready = (async () => {
    const parsed: unknown = quietly(() => JSON.parse(storage?.getItem(SESSION_KEY) ?? "null"));
    if (isTokens(parsed)) {
      if (await copied(parsed)) {
        // A copy of a tab that is still open: its session is that tab's, never this one's.
        quietly(() => storage?.removeItem(SESSION_KEY));
      } else {
        held = parsed;
      }
    }
    mark();
    page?.addEventListener("pagehide", () => {
      quietly(() => storage?.removeItem(LIVE_KEY));
      here.marked = false;
    });
    page?.addEventListener("pageshow", mark);
  })();

  return {
    async load() {
      await ready;
      return held;
    },
    async save(tokens) {
      await ready;
      held = tokens;
      quietly(() =>
        tokens
          ? storage?.setItem(SESSION_KEY, JSON.stringify(tokens))
          : storage?.removeItem(SESSION_KEY),
      );
      if (!tokens) release();
      else if (holding?.sessionId !== tokens.sessionId) await claim(tokens.sessionId);
    },
  };
}

function defaultStorage(): StorageLike | null {
  return quietly(() => (globalThis as { sessionStorage?: StorageLike }).sessionStorage ?? null);
}

function defaultPage(): PageLike | null {
  return (globalThis as { window?: PageLike }).window ?? null;
}

function defaultLocks(): LocksLike | null {
  return (globalThis as { navigator?: { locks?: LocksLike } }).navigator?.locks ?? null;
}

function defaultReloaded(): boolean {
  const timing = (
    globalThis as {
      performance?: { getEntriesByType?: (type: string) => { type?: string }[] };
    }
  ).performance;
  return quietly(() => timing?.getEntriesByType?.("navigation")[0]?.type === "reload") === true;
}

function defaultWasDiscarded(): boolean {
  return (globalThis as { document?: { wasDiscarded?: boolean } }).document?.wasDiscarded === true;
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
      // Twice at most: a refusal of a session this tab has since replaced (a refresh or a
      // sign-in landed meanwhile) says nothing about the session it holds now.
      for (let tries = 0; ; tries += 1) {
        const before = await store.load();
        if (!before) return null;
        try {
          const me = await api.call("me.get", {});
          return { displayName: me.displayName, primaryEmail: me.primaryEmail };
        } catch (error) {
          if (!signedOut(error)) throw error;
          const now = await store.load();
          if (now && now.refreshToken !== before.refreshToken && tries === 0) continue;
          // The session is over on the host (signed out elsewhere, the account closed): end it
          // there too where it still can be, so it leaves the list of devices, and forget it. Only
          // the session that was refused: a newer one is left alone.
          if (now?.refreshToken === before.refreshToken) await session.signOut();
          return null;
        }
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
