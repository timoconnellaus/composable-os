// Stage 75 step 2: the browser build's ScreenHost (src/screen-host/tokens.ts), against a fake
// host that answers as the HTTP surface does. It signs in with tokens as the mobile app does
// (ADR 0455), never sends a cookie, keeps the session in the tab's storage, tells the page when
// the host wants newer screens, and forgets a session the host has ended.
import { describe, expect, it } from "vitest";
import { saveResponse } from "../src/screen-host/index.ts";
import {
  LIVE_KEY,
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

describe("the browser build's token store", () => {
  it("keeps the session in this tab's storage, so a reload is still signed in", async () => {
    const storage = memoryStorage();
    const tab = fakePage();
    const session = tokens(1);
    await sessionTokenStore(storage, tab).save(session);
    expect(JSON.parse(storage.items.get(SESSION_KEY) ?? "null")).toEqual(session);
    // A reload: the page goes (pagehide), and a new page's store reads the same storage.
    tab.fire("pagehide");
    const reloaded = fakePage();
    expect(await sessionTokenStore(storage, reloaded).load()).toMatchObject({
      accessToken: "access-1",
    });
    reloaded.fire("pagehide");
    await sessionTokenStore(storage, fakePage()).save(null);
    expect(storage.items.has(SESSION_KEY)).toBe(false);
  });

  it("starts a duplicated tab signed out, and leaves the tab it was copied from signed in (issue #540)", async () => {
    const original = memoryStorage();
    const store = sessionTokenStore(original, fakePage());
    await store.save(tokens(1));
    // Duplicate Tab (or a link opened with its opener): the browser copies the tab's storage,
    // the live mark with it, while the first tab is still open.
    const copy = memoryStorage();
    for (const [key, value] of original.items) copy.setItem(key, value);
    const copied = sessionTokenStore(copy, fakePage());
    expect(await copied.load()).toBeNull();
    expect(copy.items.has(SESSION_KEY)).toBe(false);
    // The first tab keeps its session; the copy signs in with its own.
    expect(await store.load()).toMatchObject({ refreshToken: "refresh-1" });
    expect(original.items.has(SESSION_KEY)).toBe(true);
    await copied.save(tokens(2));
    expect(JSON.parse(original.items.get(SESSION_KEY) ?? "null").refreshToken).toBe("refresh-1");
  });

  it("marks the tab live again when the back-forward cache puts the page back", async () => {
    const storage = memoryStorage();
    const tab = fakePage();
    await sessionTokenStore(storage, tab).save(tokens(1));
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
    const store = sessionTokenStore(refusing);
    expect(await store.load()).toBeNull();
    await store.save(tokens(2));
    expect(await store.load()).toMatchObject({ accessToken: "access-2" });
    const junk = memoryStorage();
    junk.setItem(SESSION_KEY, '{"accessToken": 1}');
    expect(await sessionTokenStore(junk).load()).toBeNull();
    junk.setItem(SESSION_KEY, "not json");
    expect(await sessionTokenStore(junk).load()).toBeNull();
    expect(await sessionTokenStore(null).load()).toBeNull();
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
      store: sessionTokenStore(storage),
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
    const store = sessionTokenStore(memoryStorage());
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
      store: sessionTokenStore(memoryStorage()),
      fetch: host.fetch,
    });
    expect(await screens.requestCode("ada@example.com")).toBe(false);
    expect(await screens.signIn("ada@example.com", "000000")).toBe(false);
  });

  it("signs out on the host with the refresh token and forgets the session", async () => {
    const host = fakeHost(() => [200, { data: { ok: true } }]);
    const storage = memoryStorage();
    const store = sessionTokenStore(storage);
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
    const store = sessionTokenStore(memoryStorage());
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
    const store = sessionTokenStore(memoryStorage());
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
    const store = sessionTokenStore(memoryStorage());
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
    const store = sessionTokenStore(memoryStorage());
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
