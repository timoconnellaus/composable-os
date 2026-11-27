// The typed client's runtime (stage 23, ADR 0418), in workerd: one of its two test targets (the
// other, test/bare.test.ts, runs it with no host globals at all, as React Native would).
import { describe, expect, it } from "vitest";
import {
  ApiError,
  createClient,
  type FetchLike,
  invalidateFromMeta,
  NetworkError,
  type RequestInitLike,
  signInErrorWords,
  type Tokens,
  tokenSession,
  UpgradeRequiredError,
} from "../src/index.ts";

type Ops = {
  "thing.get": { kind: "query"; input: { id: string }; output: { id: string; n: number } };
  "thing.bump": { kind: "mutation"; input: { id: string }; output: { n: number } };
};
const specs = {
  "thing.get": { kind: "query", invalidates: [] },
  "thing.bump": { kind: "mutation", invalidates: ["thing.get"] },
} as const;

interface Sent {
  url: string;
  init: RequestInitLike;
}

/** A host that answers from a script, recording what was sent. */
function host(answer: (sent: Sent, n: number) => { status: number; body: unknown } | "drop") {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, init });
    const reply = answer({ url, init }, sent.length);
    if (reply === "drop") throw new TypeError("network down");
    return {
      status: reply.status,
      headers: { get: () => null },
      text: async () => JSON.stringify(reply.body),
    };
  };
  return { fetch, sent };
}

const noWait = async () => {};

describe("calls", () => {
  it("posts the input to /api/v1/op/<name> and returns the data", async () => {
    const h = host(() => ({ status: 200, body: { data: { id: "a", n: 1 } } }));
    const api = createClient<Ops>(specs, { baseUrl: "https://host.example/", fetch: h.fetch });
    expect(await api.call("thing.get", { id: "a" })).toEqual({ id: "a", n: 1 });
    expect(h.sent[0]?.url).toBe("https://host.example/api/v1/op/thing.get");
    expect(h.sent[0]?.init.body).toBe('{"id":"a"}');
    // A read sends no idempotency key.
    expect(h.sent[0]?.init.headers["idempotency-key"]).toBeUndefined();
  });

  it("raises the envelope's error with its code, details and status", async () => {
    const h = host(() => ({
      status: 404,
      body: { error: { code: "not_found", message: "No thing", details: { id: "a" } } },
    }));
    const api = createClient<Ops>(specs, { baseUrl: "https://h", fetch: h.fetch });
    const error = await api.call("thing.get", { id: "a" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "not_found", status: 404, details: { id: "a" } });
  });

  it("an old app's call gets UpgradeRequiredError, and the app is told (criterion 8)", async () => {
    const h = host(() => ({
      status: 426,
      body: { error: { code: "upgrade_required", message: "Update the app" } },
    }));
    const told: UpgradeRequiredError[] = [];
    const api = createClient<Ops>(specs, {
      baseUrl: "https://h",
      fetch: h.fetch,
      onUpgradeRequired: (e) => told.push(e),
    });
    const error = await api.call("thing.get", { id: "a" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpgradeRequiredError);
    expect(told).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });
});

describe("idempotency keys", () => {
  it("a mutation sends one, and keeps it across the client's own retries", async () => {
    const h = host((_s, n) => (n < 3 ? "drop" : { status: 200, body: { data: { n: 7 } } }));
    let made = 0;
    const api = createClient<Ops>(specs, {
      baseUrl: "https://h",
      fetch: h.fetch,
      sleep: noWait,
      randomKey: () => `key-${++made}-aaaaaaaaaaaaaaaa`,
    });
    expect(await api.call("thing.bump", { id: "a" })).toEqual({ n: 7 });
    const keys = h.sent.map((s) => s.init.headers["idempotency-key"]);
    expect(keys).toEqual(Array(3).fill("key-1-aaaaaaaaaaaaaaaa"));
  });

  it("gives up after its retries with the last failure", async () => {
    const h = host(() => "drop");
    const api = createClient<Ops>(specs, { baseUrl: "https://h", fetch: h.fetch, sleep: noWait });
    await expect(api.call("thing.bump", { id: "a" })).rejects.toBeInstanceOf(NetworkError);
    expect(h.sent).toHaveLength(3);
  });

  it("does not retry a refusal", async () => {
    const h = host(() => ({
      status: 400,
      body: { error: { code: "invalid_input", message: "no" } },
    }));
    const api = createClient<Ops>(specs, { baseUrl: "https://h", fetch: h.fetch, sleep: noWait });
    await expect(api.call("thing.bump", { id: "a" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(h.sent).toHaveLength(1);
  });

  it("a mutation's options keep one key across TanStack Query's retries of the same variables", async () => {
    const h = host(() => ({ status: 200, body: { data: { n: 1 } } }));
    const api = createClient<Ops>(specs, { baseUrl: "https://h", fetch: h.fetch });
    const options = api.mutation("thing.bump");
    const variables = { id: "a" };
    await options.mutationFn(variables);
    await options.mutationFn(variables); // a retry: the same object
    await options.mutationFn({ id: "a" }); // a new mutation
    const keys = h.sent.map((s) => s.init.headers["idempotency-key"]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys.every((k) => typeof k === "string" && k.length >= 16)).toBe(true);
  });
});

describe("TanStack Query options", () => {
  it("query keys are [operation, input]; a mutation lists the keys it makes stale", async () => {
    const h = host(() => ({ status: 200, body: { data: { id: "a", n: 2 } } }));
    const api = createClient<Ops>(specs, { baseUrl: "https://h", fetch: h.fetch });
    const q = api.query("thing.get", { id: "a" });
    expect(q.queryKey).toEqual(["thing.get", { id: "a" }]);
    expect(await q.queryFn()).toEqual({ id: "a", n: 2 });
    const m = api.mutation("thing.bump");
    expect(m.mutationKey).toEqual(["thing.bump"]);
    expect(m.meta.invalidates).toEqual([["thing.get"]]);
    expect(api.invalidates("thing.bump")).toEqual([["thing.get"]]);
  });

  it("invalidateFromMeta invalidates what the mutation lists", async () => {
    const invalidated: unknown[] = [];
    const onSuccess = invalidateFromMeta({
      invalidateQueries: (filters) => invalidated.push(filters.queryKey),
    });
    await onSuccess(null, null, null, { meta: { invalidates: [["thing.get"]] } });
    expect(invalidated).toEqual([["thing.get"]]);
  });
});

describe("token sessions (ADR 0419)", () => {
  function memoryStore(initial: Tokens | null = null) {
    let tokens = initial;
    return {
      load: async () => tokens,
      save: async (next: Tokens | null) => {
        tokens = next;
      },
      peek: () => tokens,
    };
  }
  const tokens = (n: number, expiresIn: number, now: number): Tokens => ({
    accessToken: `at-${n}`,
    refreshToken: `rt-${n}`,
    accessExpiresAt: new Date(now + expiresIn).toISOString(),
    sessionId: "dvs_1",
  });

  it("sends the access token, and refreshes it once (not twice at once) before it ends", async () => {
    const now = 1_000_000;
    const store = memoryStore(tokens(1, 10_000, now));
    let refreshes = 0;
    const h = host((s) => {
      refreshes += 1;
      expect(JSON.parse(s.init.body ?? "{}")).toEqual({ refreshToken: "rt-1" });
      return { status: 200, body: { data: tokens(2, 600_000, now) } };
    });
    const session = tokenSession({ baseUrl: "https://h", store, fetch: h.fetch, now: () => now });
    const [a, b] = await Promise.all([session.headers(), session.headers()]);
    expect(a).toEqual({ authorization: "Bearer at-2" });
    expect(b).toEqual(a);
    expect(refreshes).toBe(1);
    expect(store.peek()?.refreshToken).toBe("rt-2");
  });

  it("a customer signing in again names the session it replaces; a first sign-in names none", async () => {
    const now = 1_000_000;
    const bodies: unknown[] = [];
    const h = host((s) => {
      bodies.push(JSON.parse(s.init.body ?? "{}"));
      return { status: 200, body: { data: tokens(9, 600_000, now) } };
    });
    const store = memoryStore(tokens(1, 600_000, now));
    const session = tokenSession({ baseUrl: "https://h", store, fetch: h.fetch, now: () => now });
    await session.signInWithCode("ada@example.com", "123456", "Phone");
    expect(bodies[0]).toMatchObject({ replaces: "rt-1" });
    expect(store.peek()?.refreshToken).toBe("rt-9");
    const fresh = tokenSession({ baseUrl: "https://h", store: memoryStore(), fetch: h.fetch });
    await fresh.signInWithCode("ada@example.com", "123456", "Phone");
    expect(bodies[1]).not.toHaveProperty("replaces");
    // Staff end their previous session themselves first (staffSession's endPrevious).
    await session.signInWithCode("ada@example.com", "123456", "Phone", "staff");
    expect(bodies[2]).not.toHaveProperty("replaces");
  });

  it("forgets the session when the host ends it", async () => {
    const now = 1_000_000;
    const store = memoryStore(tokens(1, 0, now));
    const h = host(() => ({
      status: 401,
      body: {
        error: {
          code: "forbidden",
          message: "Session ended",
          details: { reason: "session_ended" },
        },
      },
    }));
    const session = tokenSession({ baseUrl: "https://h", store, fetch: h.fetch, now: () => now });
    await expect(session.headers()).rejects.toBeInstanceOf(ApiError);
    expect(store.peek()).toBeNull();
    expect(await session.headers()).toEqual({});
  });

  describe("an access token the host refuses as expired (issue #540: a clock behind the host's)", () => {
    // The device's clock is 60 seconds behind the host's: at-1 looks good for 40 seconds more
    // here, and has ended there.
    const hostNow = 5_000_000;
    const deviceNow = hostNow - 60_000;
    const expired = {
      status: 401,
      body: {
        error: {
          code: "forbidden",
          message: "This access token has expired: refresh it",
          details: { reason: "token_expired" },
        },
      },
    };
    const ended = (reason: string) => ({
      status: 401,
      body: { error: { code: "forbidden", message: "Sign in again", details: { reason } } },
    });
    /** A host whose access tokens are good only once refreshed; `onRefresh` answers a refresh. */
    function skewedHost(onRefresh: (n: number) => { status: number; body: unknown } | "drop") {
      let refreshes = 0;
      const h = host((s) => {
        if (s.url.endsWith("/api/v1/auth/refresh")) {
          refreshes += 1;
          return onRefresh(refreshes);
        }
        const auth = s.init.headers.authorization;
        return auth === "Bearer at-1"
          ? expired
          : { status: 200, body: { data: { id: "a", n: 7 } } };
      });
      return { ...h, refreshes: () => refreshes };
    }
    const setUp = (h: { fetch: FetchLike }) => {
      const store = memoryStore(tokens(1, 40_000, deviceNow));
      const session = tokenSession({
        baseUrl: "https://h",
        store,
        fetch: h.fetch,
        now: () => deviceNow,
      });
      const api = createClient<Ops>(specs, {
        baseUrl: "https://h",
        fetch: session.fetch,
        retries: 0,
        sleep: noWait,
      });
      return { store, session, api };
    };

    it("refreshes once and sends the call again", async () => {
      const h = skewedHost(() => ({ status: 200, body: { data: tokens(2, 600_000, hostNow) } }));
      const { store, api } = setUp(h);
      expect(await api.call("thing.get", { id: "a" })).toEqual({ id: "a", n: 7 });
      expect(
        h.sent.map((s) => [s.url.replace("https://h", ""), s.init.headers.authorization]),
      ).toEqual([
        ["/api/v1/op/thing.get", "Bearer at-1"],
        ["/api/v1/auth/refresh", undefined],
        ["/api/v1/op/thing.get", "Bearer at-2"],
      ]);
      expect(store.peek()?.refreshToken).toBe("rt-2");
    });

    it("calls refused at once share one refresh", async () => {
      const h = skewedHost(() => ({ status: 200, body: { data: tokens(2, 600_000, hostNow) } }));
      const { api } = setUp(h);
      const answers = await Promise.all([
        api.call("thing.get", { id: "a" }),
        api.call("thing.get", { id: "b" }),
        api.call("thing.bump", { id: "c" }),
      ]);
      expect(answers).toHaveLength(3);
      expect(h.refreshes()).toBe(1);
    });

    it("keeps the session when the refresh fails for a reason that is not a refusal", async () => {
      for (const reply of [
        { status: 503, body: { error: { code: "internal", message: "Down" } } },
        { status: 429, body: { error: { code: "rate_limited", message: "Slow down" } } },
        "drop" as const,
      ]) {
        const h = skewedHost(() => reply);
        const { store, api } = setUp(h);
        await expect(api.call("thing.get", { id: "a" })).rejects.toBeTruthy();
        expect(store.peek()?.refreshToken, JSON.stringify(reply)).toBe("rt-1");
      }
    });

    it("forgets the session when the refresh is refused, and the call says so", async () => {
      const h = skewedHost(() => ended("session_ended"));
      const { store, api } = setUp(h);
      await expect(api.call("thing.get", { id: "a" })).rejects.toMatchObject({
        status: 401,
        details: { reason: "token_expired" },
      });
      expect(store.peek()).toBeNull();
    });

    it("passes any other refusal back as it came, with no refresh, and never loops", async () => {
      const idle = host(() => ended("session_idle"));
      const one = setUp(idle);
      await expect(one.api.call("thing.get", { id: "a" })).rejects.toMatchObject({
        details: { reason: "session_idle" },
      });
      expect(idle.sent).toHaveLength(1);
      // Refreshed, and still refused as expired: one refresh, the call sent twice, then the answer.
      const stubborn = host((s) =>
        s.url.endsWith("/auth/refresh")
          ? { status: 200, body: { data: tokens(2, 600_000, hostNow) } }
          : expired,
      );
      const two = setUp(stubborn);
      await expect(two.api.call("thing.get", { id: "a" })).rejects.toMatchObject({ status: 401 });
      expect(stubborn.sent).toHaveLength(3);
    });
  });

  describe("calls during a refresh (review of #542, S1 and F1)", () => {
    // The device's clock is behind the host's: at-1 looks good here and has ended there. The host
    // rotates the session when the refresh lands: from then on at-1 is not a token at all
    // (`token_invalid`), and at-2 is the session's.
    const hostNow = 5_000_000;
    const deviceNow = hostNow - 60_000;
    const refusal = (reason: string) => ({
      status: 401,
      body: { error: { code: "forbidden", message: reason, details: { reason } } },
    });
    const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    /**
     * A host whose refresh is held until `release()`. A call with at-1 is answered at once as
     * expired while the refresh has not been asked for; once it has, the answer waits for the
     * rotation and is then `token_invalid`, as a call that reaches the host just after it would.
     */
    function rotatingHost() {
      const log: string[] = [];
      let asked = false;
      let oldTokenCalls = 0;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let rotated = false;
      let refreshAsked = () => {};
      const refreshStarted = new Promise<void>((resolve) => {
        refreshAsked = resolve;
      });
      const answer = (reply: { status: number; body: unknown }) => ({
        status: reply.status,
        headers: { get: () => null },
        text: async () => JSON.stringify(reply.body),
      });
      const fetch: FetchLike = async (url, init) => {
        const path = url.replace("https://h", "");
        if (path === "/api/v1/auth/refresh") {
          log.push("refresh");
          asked = true;
          refreshAsked();
          await held;
          rotated = true;
          return answer({ status: 200, body: { data: tokens(2, 600_000, hostNow) } });
        }
        if (path === "/api/v1/auth/sign-out") {
          log.push(`sign-out ${JSON.parse(init.body ?? "{}").refreshToken}`);
          return answer({ status: 200, body: { data: { ok: true } } });
        }
        if (path === "/api/v1/auth/customer/sign-in") {
          log.push("sign-in");
          return answer({ status: 200, body: { data: tokens(9, 600_000, hostNow) } });
        }
        const auth = init.headers.authorization ?? "";
        log.push(`${path.replace("/api/v1/op/", "")} ${auth.replace("Bearer ", "")}`);
        if (auth === "Bearer at-1") {
          oldTokenCalls += 1;
          // The first is answered at once; any other is slow, and lands after the rotation.
          if (!asked && oldTokenCalls === 1) return answer(refusal("token_expired"));
          await refreshStarted;
          await held;
          await later();
          return answer(refusal(rotated ? "token_invalid" : "token_expired"));
        }
        return answer({ status: 200, body: { data: { id: "a", n: 7 } } });
      };
      return { fetch, log, release: () => release(), refreshStarted };
    }

    const setUp = (h: { fetch: FetchLike }) => {
      const store = memoryStore(tokens(1, 40_000, deviceNow));
      const session = tokenSession({
        baseUrl: "https://h",
        store,
        fetch: h.fetch,
        now: () => deviceNow,
      });
      const api = createClient<Ops>(specs, {
        baseUrl: "https://h",
        fetch: session.fetch,
        retries: 0,
        sleep: noWait,
      });
      return { store, session, api };
    };

    it("a call started while a refresh is in flight waits for it, and is never sent with the old token", async () => {
      const h = rotatingHost();
      const { api, store } = setUp(h);
      const first = api.call("thing.get", { id: "a" });
      await h.refreshStarted;
      const second = api.call("thing.get", { id: "b" });
      await later();
      h.release();
      expect(await first).toEqual({ id: "a", n: 7 });
      expect(await second).toEqual({ id: "a", n: 7 });
      expect(h.log.filter((line) => line === "refresh")).toHaveLength(1);
      // Only the first call ever left with at-1: the second waited for the refresh.
      expect(h.log.filter((line) => line === "thing.get at-1")).toHaveLength(1);
      expect(h.log).not.toContain("sign-out rt-2");
      expect(store.peek()?.refreshToken).toBe("rt-2");
    });

    it("a call sent with the old token that lands after the rotation is sent again with the new one", async () => {
      const h = rotatingHost();
      const { api } = setUp(h);
      // Both leave with at-1: the first is refused as expired at once and starts the refresh; the
      // second reaches the host after it has rotated, and is refused as no token at all.
      const first = api.call("thing.get", { id: "a" });
      const second = api.call("thing.get", { id: "b" });
      await h.refreshStarted;
      h.release();
      expect(await first).toEqual({ id: "a", n: 7 });
      expect(await second).toEqual({ id: "a", n: 7 });
      expect(h.log).toEqual(
        expect.arrayContaining(["thing.get at-1", "refresh", "thing.get at-2"]),
      );
      expect(h.log.filter((line) => line === "thing.get at-2")).toHaveLength(2);
    });

    it("a refresh that lands after a sign-out does not bring the session back", async () => {
      const h = rotatingHost();
      const { api, session, store } = setUp(h);
      const call = api.call("thing.get", { id: "a" }).catch((e: unknown) => e);
      await h.refreshStarted;
      await session.signOut();
      h.release();
      await call;
      expect(store.peek()).toBeNull();
    });

    it("a refresh that lands after a new sign-in does not overwrite it", async () => {
      const h = rotatingHost();
      const { api, session, store } = setUp(h);
      const call = api.call("thing.get", { id: "a" }).catch((e: unknown) => e);
      await h.refreshStarted;
      await session.signInWithCode("ada@example.com", "123456", "Phone");
      h.release();
      await call;
      expect(store.peek()?.refreshToken).toBe("rt-9");
    });

    it("never sends a call again as someone else: a new sign-in while it was out is another session (review of #548, S-a)", async () => {
      const sent: string[] = [];
      let answerFirst = () => {};
      const firstHeld = new Promise<void>((resolve) => {
        answerFirst = resolve;
      });
      const reply = (status: number, body: unknown) => ({
        status,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
      });
      const fetch: FetchLike = async (url, init) => {
        const path = url.replace("https://h", "");
        if (path === "/api/v1/auth/sign-out") return reply(200, { data: { ok: true } });
        if (path === "/api/v1/auth/customer/sign-in") {
          return reply(200, { data: { ...tokens(9, 600_000, hostNow), sessionId: "dvs_9" } });
        }
        sent.push(`${path} ${init.headers.authorization}`);
        if (init.headers.authorization === "Bearer at-1") {
          // A's call is slow, and by the time it is answered A is signed out.
          await firstHeld;
          return reply(401, refusal("token_invalid").body);
        }
        return reply(200, { data: { n: 1 } });
      };
      const store = memoryStore(tokens(1, 600_000, deviceNow));
      const session = tokenSession({ baseUrl: "https://h", store, fetch, now: () => deviceNow });
      const api = createClient<Ops>(specs, {
        baseUrl: "https://h",
        fetch: session.fetch,
        retries: 0,
        sleep: noWait,
      });
      const asA = api.call("thing.bump", { id: "a" }).catch((e: unknown) => e);
      await later();
      await session.signOut();
      await session.signInWithCode("bea@example.com", "123456", "Phone");
      answerFirst();
      expect(await asA).toMatchObject({ status: 401 });
      // Bea's token never carried Ada's write.
      expect(sent).toEqual(["/api/v1/op/thing.bump Bearer at-1"]);
    });

    it("never sends an expired call again as someone else either", async () => {
      const sent: string[] = [];
      let answerFirst = () => {};
      const firstHeld = new Promise<void>((resolve) => {
        answerFirst = resolve;
      });
      const reply = (status: number, body: unknown) => ({
        status,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
      });
      const fetch: FetchLike = async (url, init) => {
        const path = url.replace("https://h", "");
        if (path === "/api/v1/auth/sign-out") return reply(200, { data: { ok: true } });
        if (path === "/api/v1/auth/refresh") return reply(200, { data: tokens(2, 600_000, hostNow) });
        if (path === "/api/v1/auth/customer/sign-in") {
          return reply(200, { data: { ...tokens(9, 600_000, hostNow), sessionId: "dvs_9" } });
        }
        sent.push(`${path} ${init.headers.authorization}`);
        if (init.headers.authorization === "Bearer at-1") {
          await firstHeld;
          return reply(401, refusal("token_expired").body);
        }
        return reply(200, { data: { n: 1 } });
      };
      const store = memoryStore(tokens(1, 600_000, deviceNow));
      const session = tokenSession({ baseUrl: "https://h", store, fetch, now: () => deviceNow });
      const api = createClient<Ops>(specs, {
        baseUrl: "https://h",
        fetch: session.fetch,
        retries: 0,
        sleep: noWait,
      });
      const asA = api.call("thing.bump", { id: "a" }).catch((e: unknown) => e);
      await later();
      await session.signOut();
      await session.signInWithCode("bea@example.com", "123456", "Phone");
      answerFirst();
      expect(await asA).toMatchObject({ status: 401 });
      expect(sent).toEqual(["/api/v1/op/thing.bump Bearer at-1"]);
    });

    it("gives up on a refresh that never answers, keeps the session, and tries again on the next call (S-b)", async () => {
      let refreshes = 0;
      const fetch: FetchLike = async (url) => {
        if (url.endsWith("/api/v1/auth/refresh")) {
          refreshes += 1;
          return new Promise(() => {});
        }
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ data: { id: "a", n: 1 } }),
        };
      };
      // Due for a refresh by this device's clock.
      const store = memoryStore(tokens(1, 10_000, deviceNow));
      const session = tokenSession({
        baseUrl: "https://h",
        store,
        fetch,
        now: () => deviceNow,
        refreshTimeoutMs: 30,
      });
      const api = createClient<Ops>(specs, {
        baseUrl: "https://h",
        fetch: session.fetch,
        retries: 0,
        sleep: noWait,
      });
      const waiting = [api.call("thing.get", { id: "a" }), api.call("thing.get", { id: "b" })];
      for (const call of waiting) await expect(call).rejects.toBeInstanceOf(NetworkError);
      expect(refreshes).toBe(1);
      // Not a refusal: the session is kept.
      expect(store.peek()?.refreshToken).toBe("rt-1");
      await expect(api.call("thing.get", { id: "c" })).rejects.toBeInstanceOf(NetworkError);
      expect(refreshes).toBe(2);
    });

    it("two sessions over one store share one refresh (F-c)", async () => {
      let refreshes = 0;
      const fetch: FetchLike = async (url) => {
        if (url.endsWith("/api/v1/auth/refresh")) {
          refreshes += 1;
          await later();
          return {
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify({ data: tokens(2, 600_000, deviceNow) }),
          };
        }
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ data: { id: "a", n: 1 } }),
        };
      };
      const store = memoryStore(tokens(1, 10_000, deviceNow));
      const one = tokenSession({ baseUrl: "https://h", store, fetch, now: () => deviceNow });
      const two = tokenSession({ baseUrl: "https://h", store, fetch, now: () => deviceNow });
      await Promise.all([one.headers(), two.headers()]);
      expect(refreshes).toBe(1);
      // And a sign-out through one is a sign-out for a refresh the other started.
      await one.signOut();
      expect(store.peek()).toBeNull();
    });

    it("hands back a 401 it has read as a real Response (review of #542, F2)", async () => {
      const h = host(() => refusal("session_idle"));
      const store = memoryStore(tokens(1, 600_000, deviceNow));
      const session = tokenSession({
        baseUrl: "https://h",
        store,
        fetch: h.fetch,
        now: () => deviceNow,
      });
      const answer = await session.fetch("https://h/api/v1/op/thing.get", {
        method: "POST",
        headers: {},
        body: "{}",
      });
      expect(answer).toBeInstanceOf(Response);
      expect((answer as Response).ok).toBe(false);
      expect(await (answer as Response).json()).toMatchObject({
        error: { details: { reason: "session_idle" } },
      });
    });
  });

  it("says why a sign-in failed: not switched on, too many tries, offline (no silent failure)", async () => {
    const failure = async (reply: { status: number; body: unknown } | "drop") => {
      const h = host(() => reply);
      const session = tokenSession({ baseUrl: "https://h", store: memoryStore(), fetch: h.fetch });
      return session.requestCode("ada@example.com").then(
        () => null,
        (error: unknown) => error,
      );
    };
    // Sign-in not switched on: the host answers 503 (ADR 0455).
    const off = await failure({
      status: 503,
      body: {
        error: {
          code: "forbidden",
          message: "Customer sign-in is not set up",
          details: { reason: "sign_in_not_set_up" },
        },
      },
    });
    expect(signInErrorWords(off)).toBe(
      "Signing in is not switched on here yet. Try again later, or ask the business.",
    );
    // Too many tries, with how long to wait when the host says.
    const limited = await failure({
      status: 429,
      body: {
        error: { code: "rate_limited", message: "Slow down", details: { retryAfterSeconds: 90 } },
      },
    });
    expect(signInErrorWords(limited)).toBe("Too many tries. Wait 2 minutes, then try again.");
    expect(signInErrorWords(new ApiError("rate_limited", "Slow down", 429))).toBe(
      "Too many tries. Wait a few minutes, then try again.",
    );
    // Offline: no answer at all.
    const offline = await failure("drop");
    expect(offline).toBeInstanceOf(NetworkError);
    expect(signInErrorWords(offline)).toContain("Check your connection and try again");
    // A wrong code, a bad address, and anything else, each with what to do next.
    expect(
      signInErrorWords(new ApiError("forbidden", "No", 401, { reason: "invalid_code" }), "sign-in"),
    ).toBe("That code did not work. Check it, or ask for a new one.");
    expect(signInErrorWords(new ApiError("invalid_input", "email", 400))).toContain(
      "email address",
    );
    expect(signInErrorWords(new Error("boom"), "sign-in")).toBe(
      "We could not sign you in just now. Try again in a moment.",
    );
  });

  it("reads the status of an answer that is not JSON (a gateway's page)", async () => {
    const fetch: FetchLike = async () => ({
      status: 503,
      headers: { get: () => null },
      text: async () => "<html>Service unavailable</html>",
    });
    const session = tokenSession({ baseUrl: "https://h", store: memoryStore(), fetch });
    const error = await session.requestCode("ada@example.com").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect(signInErrorWords(error)).toContain("not switched on");
  });
});
