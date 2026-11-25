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
