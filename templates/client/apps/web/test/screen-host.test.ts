// Stage 75 step 2: the browser build's ScreenHost (src/screen-host/tokens.ts), against a fake
// host that answers as the HTTP surface does. It signs in with tokens as the mobile app does
// (ADR 0455), never sends a cookie, keeps the session in the tab's storage, tells the page when
// the host wants newer screens, and forgets a session the host has ended.
import { describe, expect, it } from "vitest";
import { saveResponse } from "../src/screen-host/index.ts";
import {
  LIVE_KEY,
  type LocksLike,
  lockName,
  type PageLike,
  SESSION_KEY,
  type StorageLike,
  sessionTokenStore,
  tokenScreenHost,
  withoutCookies,
} from "../src/screen-host/tokens.ts";

const HOST = "https://admin.example.com";

function memoryStorage(): StorageLike & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

/** A page's pagehide and pageshow, fired by the test. */
function fakePage(): PageLike & { fire(type: "pagehide" | "pageshow"): void } {
  const listeners = new Map<string, (() => void)[]>();
  return {
    addEventListener: (type, listener) =>
      void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    fire: (type) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
}

const tokens = (n: number, expiresIn = 600_000) => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  accessExpiresAt: new Date(Date.now() + expiresIn).toISOString(),
  sessionId: "ses_1",
});

interface Sent {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A host answering by path; every request it was sent is kept. */
function fakeHost(answer: (path: string, sent: Sent) => [number, unknown]) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const entry: Sent = {
      url,
      init,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      headers: { ...(init.headers as Record<string, string>) },
    };
    sent.push(entry);
    const [status, body] = answer(new URL(url).pathname, entry);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { sent, fetch };
}

const me = {
  id: "per_1",
  displayName: "Ada Lovelace",
  givenName: "Ada",
  familyName: "Lovelace",
  primaryEmail: "ada@example.com",
  primaryPhone: null,
  signInEmail: "ada@example.com",
  signInEmailVerified: true,
};

/**
 * Web Locks as one origin's tabs share them (`navigator.locks`): a lock is held while its
 * callback's promise is pending, or until the tab holding it is gone (`kill`: closed, discarded,
 * its process ended), when every lock it held is let go and the next waiter gets it.
 */
function fakeLocks() {
  const held = new Map<string, number>();
  const waiting: { name: string; grant: () => void }[] = [];
  const wake = (name: string) => {
    const at = waiting.findIndex((w) => w.name === name);
    if (at >= 0) waiting.splice(at, 1)[0]?.grant();
  };
  function tab(owner: number) {
    const mine = new Map<string, () => void>();
    const locks: LocksLike = {
      request: (name, options, callback) =>
        new Promise((resolve, reject) => {
          const grant = () => {
            held.set(name, owner);
            let freed = false;
            const free = () => {
              if (freed) return;
              freed = true;
              held.delete(name);
              mine.delete(name);
              resolve(undefined);
              wake(name);
            };
            mine.set(name, free);
            Promise.resolve(callback({ name })).then(free, free);
          };
          if (!held.has(name)) return grant();
          if (options.ifAvailable) {
            Promise.resolve(callback(null)).then(resolve, reject);
            return;
          }
          const waiter = { name, grant };
          waiting.push(waiter);
          options.signal?.addEventListener("abort", () => {
            const at = waiting.indexOf(waiter);
            if (at >= 0) waiting.splice(at, 1);
            reject(new Error("AbortError"));
          });
        }),
    };
    const kill = () => {
      for (const free of [...mine.values()]) free();
    };
    return { locks, kill };
  }
  return { tab, holder: (sessionId: string) => held.get(lockName(sessionId)) ?? null };
}

/** A new page of the same tab, or a copy: its own sessionStorage object with these items. */
function carried(from: ReturnType<typeof memoryStorage>) {
  const next = memoryStorage();
  for (const [key, value] of from.items) next.setItem(key, value);
  return next;
}

/** A store with no Web Locks (the mark stands in), and not a discarded tab. */
const noLocks = (storage: StorageLike | null, page: PageLike | null = null) =>
  sessionTokenStore(storage, page, { locks: null, wasDiscarded: false });

describe("the browser build's token store, with Web Locks (review of #542, S2)", () => {
  const WAIT = 50;

  it("starts a copy of a live tab signed out, and leaves the tab it was copied from signed in", async () => {
    const origin = fakeLocks();
    const first = origin.tab(1);
    const storage = memoryStorage();
    const store = sessionTokenStore(storage, fakePage(), { locks: first.locks, waitMs: WAIT });
    await store.save(tokens(1));
    expect(origin.holder("ses_1")).toBe(1);
    // Duplicate Tab: the browser copies the tab's storage while the first is still open.
    const copy = carried(storage);
    const copied = sessionTokenStore(copy, fakePage(), {
      locks: origin.tab(2).locks,
      waitMs: WAIT,
    });
    expect(await copied.load()).toBeNull();
    expect(copy.items.has(SESSION_KEY)).toBe(false);
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-1" });
    expect(origin.holder("ses_1")).toBe(1);
    // The copy signs in with a session of its own, which it then holds.
    await copied.save({ ...tokens(2), sessionId: "ses_2" });
    expect(origin.holder("ses_2")).toBe(2);
  });

  it("keeps a tab signed in when the browser discarded it and loads it again (no pagehide)", async () => {
    const origin = fakeLocks();
    const before = origin.tab(1);
    const storage = memoryStorage();
    await sessionTokenStore(storage, fakePage(), { locks: before.locks, waitMs: WAIT }).save(
      tokens(1),
    );
    before.kill();
    const again = sessionTokenStore(carried(storage), fakePage(), {
      locks: origin.tab(2).locks,
      wasDiscarded: true,
      waitMs: WAIT,
    });
    expect(await again.load()).toMatchObject({ refreshToken: "refresh-1" });
    expect(origin.holder("ses_1")).toBe(2);
  });

  it("keeps a tab signed in when it is reopened after its process was killed or crashed", async () => {
    const origin = fakeLocks();
    const before = origin.tab(1);
    const storage = memoryStorage();
    await sessionTokenStore(storage, fakePage(), { locks: before.locks, waitMs: WAIT }).save(
      tokens(1),
    );
    before.kill();
    const reopened = sessionTokenStore(carried(storage), fakePage(), {
      locks: origin.tab(2).locks,
      wasDiscarded: false,
      waitMs: WAIT,
    });
    expect(await reopened.load()).toMatchObject({ refreshToken: "refresh-1" });
  });

  it("keeps a reloaded tab signed in, though the page going lets the lock go a moment late", async () => {
    const origin = fakeLocks();
    const before = origin.tab(1);
    const storage = memoryStorage();
    const page = fakePage();
    await sessionTokenStore(storage, page, { locks: before.locks, waitMs: WAIT }).save(tokens(1));
    page.fire("pagehide");
    const reloaded = sessionTokenStore(carried(storage), fakePage(), {
      locks: origin.tab(2).locks,
      waitMs: 500,
    });
    setTimeout(before.kill, 20);
    expect(await reloaded.load()).toMatchObject({ refreshToken: "refresh-1" });
  });

  it("gives a reload longer for its old page to let go, and keeps it signed in (review of #548, F-d)", async () => {
    const origin = fakeLocks();
    const before = origin.tab(1);
    const storage = memoryStorage();
    await sessionTokenStore(storage, fakePage(), { locks: before.locks, waitMs: WAIT }).save(
      tokens(1),
    );
    // The old document lets go after the usual wait, inside a reload's longer one.
    setTimeout(before.kill, WAIT * 3);
    const reloaded = sessionTokenStore(carried(storage), fakePage(), {
      locks: origin.tab(2).locks,
      waitMs: WAIT,
      reloaded: true,
      reloadWaitMs: 1_000,
    });
    expect(await reloaded.load()).toMatchObject({ refreshToken: "refresh-1" });
    expect(origin.holder("ses_1")).toBe(2);
  });

  it("does not trust the navigation type alone: a 'reload' whose session another live tab holds is a copy (review of #554, S2)", async () => {
    const origin = fakeLocks();
    const storage = memoryStorage();
    await sessionTokenStore(storage, fakePage(), { locks: origin.tab(1).locks, waitMs: WAIT }).save(
      tokens(1),
    );
    const copy = carried(storage);
    const copied = sessionTokenStore(copy, fakePage(), {
      locks: origin.tab(2).locks,
      waitMs: WAIT,
      reloaded: true,
      reloadWaitMs: WAIT * 2,
    });
    expect(await copied.load()).toBeNull();
    expect(copy.items.has(SESSION_KEY)).toBe(false);
    expect(origin.holder("ses_1")).toBe(1);
  });

  it("keeps the session through the back-forward cache: the page and its lock are kept", async () => {
    const origin = fakeLocks();
    const page = fakePage();
    const store = sessionTokenStore(memoryStorage(), page, {
      locks: origin.tab(1).locks,
      waitMs: WAIT,
    });
    await store.save(tokens(1));
    page.fire("pagehide");
    page.fire("pageshow");
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-1" });
    expect(origin.holder("ses_1")).toBe(1);
  });

  it("a second store in the same page shares the session, and does not wipe it (F5)", async () => {
    const origin = fakeLocks();
    const tab = origin.tab(1);
    const storage = memoryStorage();
    await sessionTokenStore(storage, fakePage(), { locks: tab.locks, waitMs: WAIT }).save(
      tokens(1),
    );
    const second = sessionTokenStore(storage, fakePage(), { locks: tab.locks, waitMs: WAIT });
    expect(await second.load()).toMatchObject({ refreshToken: "refresh-1" });
    expect(storage.items.has(SESSION_KEY)).toBe(true);
  });

  it("lets the lock go when the session is forgotten", async () => {
    const origin = fakeLocks();
    const store = sessionTokenStore(memoryStorage(), fakePage(), {
      locks: origin.tab(1).locks,
      waitMs: WAIT,
    });
    await store.save(tokens(1));
    await store.save(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(origin.holder("ses_1")).toBeNull();
  });
});

describe("the browser build's token store, without Web Locks", () => {
  it("keeps the session in this tab's storage, so a reload is still signed in", async () => {
    const storage = memoryStorage();
    const tab = fakePage();
    const session = tokens(1);
    await noLocks(storage, tab).save(session);
    expect(JSON.parse(storage.items.get(SESSION_KEY) ?? "null")).toEqual(session);
    // A reload: the page goes (pagehide), and a new page's store reads the same storage.
    tab.fire("pagehide");
    const reloaded = carried(storage);
    expect(await noLocks(reloaded, fakePage()).load()).toMatchObject({
      accessToken: "access-1",
    });
  });

  it("starts a duplicated tab signed out, and leaves the tab it was copied from signed in (issue #540)", async () => {
    const original = memoryStorage();
    const store = noLocks(original, fakePage());
    await store.save(tokens(1));
    // Duplicate Tab: the browser copies the tab's storage, the live mark with it.
    const copy = carried(original);
    const copied = noLocks(copy, fakePage());
    expect(await copied.load()).toBeNull();
    expect(copy.items.has(SESSION_KEY)).toBe(false);
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-1" });
    expect(original.items.has(SESSION_KEY)).toBe(true);
  });

  it("does not count a discarded tab coming back as a copy", async () => {
    const storage = memoryStorage();
    await noLocks(storage, fakePage()).save(tokens(1));
    // Discarded: no pagehide, the mark left in its storage.
    const again = sessionTokenStore(carried(storage), fakePage(), {
      locks: null,
      wasDiscarded: true,
    });
    expect(await again.load()).toMatchObject({ refreshToken: "refresh-1" });
  });

  it("a second store in the same page does not wipe the session (F5)", async () => {
    const storage = memoryStorage();
    await noLocks(storage, fakePage()).save(tokens(1));
    expect(await noLocks(storage, fakePage()).load()).toMatchObject({ refreshToken: "refresh-1" });
    expect(storage.items.has(SESSION_KEY)).toBe(true);
  });

  it("marks the tab live again when the back-forward cache puts the page back", async () => {
    const storage = memoryStorage();
    const tab = fakePage();
    await noLocks(storage, tab).save(tokens(1));
    tab.fire("pagehide");
    expect(storage.items.has(LIVE_KEY)).toBe(false);
    tab.fire("pageshow");
    expect(storage.items.get(LIVE_KEY)).toBe("1");
  });

  it("keeps it in memory only when the storage refuses, and ignores what is not a session", async () => {
    const refusing: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const store = noLocks(refusing);
    expect(await store.load()).toBeNull();
    await store.save(tokens(2));
    expect(await store.load()).toMatchObject({ accessToken: "access-2" });
    const junk = memoryStorage();
    junk.setItem(SESSION_KEY, '{"accessToken": 1}');
    expect(await noLocks(junk).load()).toBeNull();
    junk.setItem(SESSION_KEY, "not json");
    expect(await noLocks(junk).load()).toBeNull();
    expect(await noLocks(null).load()).toBeNull();
  });
});

describe("the browser build's ScreenHost", () => {
  it("signs in by emailed code with tokens, at the host's address, and calls with the bearer token", async () => {
    const host = fakeHost((path) => {
      if (path === "/api/v1/auth/customer/code") return [200, { data: { ok: true } }];
      if (path === "/api/v1/auth/customer/sign-in") {
        return [200, { data: { ...tokens(1), account: "ready" } }];
      }
      if (path === "/api/v1/op/me.get") return [200, { data: me }];
      if (path === "/api/v1/op/me.update") return [200, { data: { ...me, displayName: "Ada" } }];
      return [404, { error: { code: "not_found", message: "No such route" } }];
    });
    const storage = memoryStorage();
    const screens = tokenScreenHost({
      hostUrl: `${HOST}/`,
      store: noLocks(storage),
      fetch: host.fetch,
      deviceName: "Ada's laptop",
    });
    expect(screens.build).toBe("browser");
    // Nobody signed in: no call is made to find out.
    expect(await screens.me()).toBeNull();
    expect(host.sent).toHaveLength(0);

    expect(await screens.requestCode("ada@example.com")).toBe(true);
    expect(await screens.signIn("ada@example.com", " 123456 ")).toBe(true);
    expect(host.sent.map((s) => s.url)).toEqual([
      `${HOST}/api/v1/auth/customer/code`,
      `${HOST}/api/v1/auth/customer/sign-in`,
    ]);
    expect(host.sent[1]?.body).toEqual({
      email: "ada@example.com",
      code: "123456",
      deviceName: "Ada's laptop",
    });
    expect(storage.items.has(SESSION_KEY)).toBe(true);

    expect(await screens.me()).toEqual({
      displayName: "Ada Lovelace",
      primaryEmail: "ada@example.com",
    });
    await screens.api.call("me.update", { displayName: "Ada" });
    const write = host.sent.at(-1);
    expect(write?.url).toBe(`${HOST}/api/v1/op/me.update`);
    expect(write?.headers.authorization).toBe("Bearer access-1");
    expect(write?.headers["idempotency-key"]).toMatch(/\S{16,}/);
    // No cookie is ever sent or asked for, even through a fetch a wrapper passes in.
    for (const request of host.sent) {
      expect(Object.keys(request.headers).map((h) => h.toLowerCase())).not.toContain("cookie");
      expect(request.init.credentials).toBe("omit");
    }
  });

  it("refreshes once and tries again when the host says the token has expired (a clock behind)", async () => {
    const host = fakeHost((path, sent) => {
      if (path === "/api/v1/auth/refresh") return [200, { data: tokens(2) }];
      if (sent.headers.authorization === "Bearer access-1") {
        return [
          401,
          {
            error: { code: "forbidden", message: "Expired", details: { reason: "token_expired" } },
          },
        ];
      }
      return [200, { data: me }];
    });
    const store = noLocks(memoryStorage());
    // Good for ten minutes by this browser's clock, ended by the host's.
    await store.save(tokens(1));
    const screens = tokenScreenHost({ hostUrl: HOST, store, fetch: host.fetch });
    expect(await screens.me()).toMatchObject({ displayName: "Ada Lovelace" });
    expect(host.sent.map((s) => new URL(s.url).pathname)).toEqual([
      "/api/v1/op/me.get",
      "/api/v1/auth/refresh",
      "/api/v1/op/me.get",
    ]);
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-2" });
  });

  it("answers false for a wrong code and for a host that will not send one", async () => {
    const host = fakeHost((path) =>
      path.endsWith("/code")
        ? [429, { error: { code: "rate_limited", message: "Too many" } }]
        : [
            403,
            { error: { code: "forbidden", message: "Wrong", details: { reason: "invalid_code" } } },
          ],
    );
    const screens = tokenScreenHost({
      hostUrl: HOST,
      store: noLocks(memoryStorage()),
      fetch: host.fetch,
    });
    expect(await screens.requestCode("ada@example.com")).toBe(false);
    expect(await screens.signIn("ada@example.com", "000000")).toBe(false);
  });

  it("signs out on the host with the refresh token and forgets the session", async () => {
    const host = fakeHost(() => [200, { data: { ok: true } }]);
    const storage = memoryStorage();
    const store = noLocks(storage);
    await store.save(tokens(3));
    const screens = tokenScreenHost({ hostUrl: HOST, store, fetch: host.fetch });
    await screens.signOut();
    expect(host.sent[0]?.url).toBe(`${HOST}/api/v1/auth/sign-out`);
    expect(host.sent[0]?.body).toEqual({ refreshToken: "refresh-3" });
    expect(storage.items.has(SESSION_KEY)).toBe(false);
    await store.save(tokens(4));
    await screens.forget();
    expect(await store.load()).toBeNull();
  });

  it("never ends the fresh session over a refusal of the one a refresh replaced (review of #542, S1)", async () => {
    // A clock behind the host's: access-1 has ended there. The refresh is held a moment, and any
    // call with access-1 that lands after it is not a token at all (`token_invalid`).
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshAsked = () => {};
    const refreshStarted = new Promise<void>((resolve) => {
      refreshAsked = resolve;
    });
    let rotated = false;
    let oldCalls = 0;
    const host = fakeHost((path, sent) => {
      if (path === "/api/v1/auth/refresh") return [200, { data: tokens(2) }];
      if (path === "/api/v1/auth/sign-out") return [200, { data: { ok: true } }];
      if (sent.headers.authorization === "Bearer access-1") {
        return [
          401,
          {
            error: {
              code: "forbidden",
              message: "No",
              details: { reason: rotated ? "token_invalid" : "token_expired" },
            },
          },
        ];
      }
      return [200, { data: me }];
    });
    // The fake host above answers at once; hold the refresh and the second old-token call.
    const fetch = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/api/v1/auth/refresh") {
        refreshAsked();
        await held;
        rotated = true;
      } else if (
        (init?.headers as Record<string, string> | undefined)?.authorization === "Bearer access-1"
      ) {
        oldCalls += 1;
        if (oldCalls > 1) {
          await held;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      return host.fetch(url, init);
    };
    const store = noLocks(memoryStorage());
    await store.save(tokens(1));
    const screens = tokenScreenHost({ hostUrl: HOST, store, fetch });
    const first = screens.me();
    const second = screens.me();
    await refreshStarted;
    release();
    expect(await first).toMatchObject({ displayName: "Ada Lovelace" });
    expect(await second).toMatchObject({ displayName: "Ada Lovelace" });
    expect(host.sent.some((s) => s.url.endsWith("/api/v1/auth/sign-out"))).toBe(false);
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-2" });
  });

  it("asks again, and signs nothing out, when the refused session is not the one the tab now holds", async () => {
    const store = noLocks(memoryStorage());
    await store.save(tokens(1));
    const host = fakeHost((path, sent) => {
      if (path === "/api/v1/auth/sign-out") return [200, { data: { ok: true } }];
      if (sent.headers.authorization === "Bearer access-3") return [200, { data: me }];
      return [
        401,
        { error: { code: "forbidden", message: "No", details: { reason: "session_idle" } } },
      ];
    });
    // While the call is out, the tab takes a new session (a sign-in elsewhere in the page).
    const fetch = async (url: string, init?: RequestInit) => {
      const answer = await host.fetch(url, init);
      if (answer.status === 401) await store.save({ ...tokens(3), sessionId: "ses_3" });
      return answer;
    };
    const screens = tokenScreenHost({ hostUrl: HOST, store, fetch });
    expect(await screens.me()).toMatchObject({ displayName: "Ada Lovelace" });
    expect(host.sent.some((s) => s.url.endsWith("/api/v1/auth/sign-out"))).toBe(false);
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-3" });
  });

  it("never signs out a session other than the one refused, even when it gives up (review of #548, F-a)", async () => {
    const store = noLocks(memoryStorage());
    await store.save(tokens(1));
    const host = fakeHost((path) =>
      path === "/api/v1/auth/sign-out"
        ? [200, { data: { ok: true } }]
        : [
            401,
            { error: { code: "forbidden", message: "No", details: { reason: "session_idle" } } },
          ],
    );
    // Each refusal arrives just as the tab has taken yet another session.
    let next = 3;
    const fetch = async (url: string, init?: RequestInit) => {
      const answer = await host.fetch(url, init);
      if (answer.status === 401) {
        await store.save({ ...tokens(next), sessionId: `ses_${next}` });
        next += 1;
      }
      return answer;
    };
    const screens = tokenScreenHost({ hostUrl: HOST, store, fetch });
    expect(await screens.me()).toBeNull();
    // The sessions the tab took meanwhile are not ended by a refusal of an earlier one.
    expect(host.sent.filter((s) => s.url.endsWith("/api/v1/auth/sign-out"))).toEqual([]);
    expect(await store.load()).toMatchObject({ sessionId: "ses_4" });
  });

  it("signs out on the host, and forgets, a session the host no longer takes", async () => {
    const host = fakeHost((path) =>
      path === "/api/v1/auth/sign-out"
        ? [200, { data: { ok: true } }]
        : [
            401,
            {
              error: {
                code: "forbidden",
                message: "Sign in again",
                details: { reason: "session_idle" },
              },
            },
          ],
    );
    const store = noLocks(memoryStorage());
    await store.save(tokens(5));
    const screens = tokenScreenHost({ hostUrl: HOST, store, fetch: host.fetch });
    expect(await screens.me()).toBeNull();
    expect(await store.load()).toBeNull();
    // Ended on the host too, so it leaves the customer's list of devices.
    const signOut = host.sent.find((s) => s.url.endsWith("/api/v1/auth/sign-out"));
    expect(signOut?.body).toEqual({ refreshToken: "refresh-5" });
  });

  it("refreshes an access token about to end before the call, once", async () => {
    const host = fakeHost((path) =>
      path === "/api/v1/auth/refresh" ? [200, { data: tokens(7) }] : [200, { data: me }],
    );
    const store = noLocks(memoryStorage());
    await store.save(tokens(6, 1_000));
    const screens = tokenScreenHost({ hostUrl: HOST, store, fetch: host.fetch });
    await Promise.all([screens.me(), screens.me()]);
    expect(host.sent.filter((s) => s.url.endsWith("/auth/refresh"))).toHaveLength(1);
    expect(host.sent.at(-1)?.headers.authorization).toBe("Bearer access-7");
  });

  it("tells the page when the host no longer serves the contract it was built for", async () => {
    const host = fakeHost(() => [
      426,
      { error: { code: "upgrade_required", message: "Update", details: { served: ["v2"] } } },
    ]);
    const store = noLocks(memoryStorage());
    await store.save(tokens(8));
    const told: unknown[] = [];
    const screens = tokenScreenHost({
      hostUrl: HOST,
      store,
      fetch: host.fetch,
      onUpgradeRequired: (error) => told.push(error.details),
    });
    await expect(screens.api.call("me.get", {})).rejects.toMatchObject({
      code: "upgrade_required",
    });
    expect(told).toEqual([{ served: ["v2"] }]);
  });

  it("asks for a signed PDF with the bearer token", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const store = noLocks(memoryStorage());
    await store.save(tokens(9));
    const screens = tokenScreenHost({
      hostUrl: HOST,
      store,
      fetch: async (url, init = {}) => {
        sent.push({ url, init });
        return new Response("nope", { status: 404 });
      },
    });
    await expect(screens.downloadAgreementPdf("aga_1")).rejects.toThrow(/404/);
    expect(sent[0]?.url).toBe(`${HOST}/api/v1/agreements/acceptances/aga_1.pdf`);
    const headers = (sent[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-9");
  });
});

describe("the page's fetch", () => {
  it("never sends the browser's cookies", async () => {
    const seen: RequestInit[] = [];
    const fetch = withoutCookies(async (_url, init) => {
      seen.push(init ?? {});
      return new Response("{}");
    });
    await fetch(`${HOST}/api/v1/op/me.get`, { method: "POST", credentials: "include" });
    expect(seen[0]?.credentials).toBe("omit");
  });

  it("saves a download under the name the host gave it", async () => {
    const clicked: { href: string; download: string }[] = [];
    const doc = {
      createElement: () => {
        const link = {
          href: "",
          download: "",
          click: () => clicked.push({ href: link.href, download: link.download }),
          remove: () => {},
        };
        return link;
      },
      body: { appendChild: () => {} },
    } as unknown as Document;
    await saveResponse(
      new Response("%PDF", {
        headers: { "content-disposition": 'attachment; filename="waiver-v1.pdf"' },
      }),
      "agreement.pdf",
      doc,
    );
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe("waiver-v1.pdf");
    expect(clicked[0]?.href).toMatch(/^blob:/);
  });
});
