// The shared bindings kept apart (stage 66 step 4, ADR 0615): for each wrapper, code holding
// client A's binding tries every way it has to reach client B's part, and fails. Files and
// key-value run on real local R2 and KV, Durable Objects on a real namespace (CLIENT_DB's class);
// queues, Workflows, the search index and the runner on recording stand-ins that behave as the
// real ones do where it matters (one id space, namespaces, stamps).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ClientPartError,
  clientKey,
  clientObjectName,
  clientVectorId,
  clientWorkflowId,
  keepBucketApart,
  keepKeyValueApart,
  keepObjectsApart,
  keepQueueApart,
  keepRunnerApart,
  keepVectorsApart,
  keepWorkflowApart,
  objectNameParts,
  RUNNER_METHODS,
} from "../src/client-bindings.ts";
import type { ClientDb } from "../src/client-db.ts";
import { stampOf, workflowClientOf } from "../src/client-entries.ts";
import { ENV_NAME_PATTERNS, ENV_NAMES } from "../src/client-env-names.ts";
import { hasBindingWrapper } from "../src/client-environment.ts";
import type { ClientId } from "../src/registry.ts";

const A = "gym-a" as ClientId;
const B = "gym-b" as ClientId;
const real = env as unknown as {
  BLOBS: R2Bucket;
  OAUTH_KV: KVNamespace;
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
};

/** Every property, own or inherited, of a wrapped binding: none is the real binding. */
function expectNoWayBack(wrapped: unknown, realBinding: unknown) {
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string, depth: number) => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
    expect(value === realBinding, path).toBe(false);
    if (seen.has(value) || depth > 4) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor)
        walk(descriptor.value, `${path}.${String(key)}`, depth + 1);
    }
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype && proto !== Function.prototype) {
      walk(proto, `${path}.__proto__`, depth + 1);
    }
  };
  walk(wrapped, "binding", 0);
}

describe("every kept-apart name", () => {
  it("has a wrapper, so none is left out of a client's environment or let through raw", () => {
    const keptApart = Object.entries(ENV_NAMES)
      .filter(([, use]) => use.use === "kept-apart")
      .map(([name]) => name);
    expect(keptApart.length).toBeGreaterThan(10);
    expect(keptApart.filter((name) => !hasBindingWrapper(name))).toEqual([]);
    // The rate limits are matched by their pattern.
    expect(ENV_NAME_PATTERNS.some(({ use }) => use.use === "kept-apart")).toBe(true);
    expect(hasBindingWrapper("PUBLIC_RATE_LIMIT")).toBe(true);
  });
});

describe("files (BLOBS): a key prefix per client", () => {
  const a = keepBucketApart(real.BLOBS, A);
  const b = keepBucketApart(real.BLOBS, B);

  it("keeps what each writes under its own prefix, and gives back the client's own key", async () => {
    const put = await a.put("media/one", "a's file");
    expect(put?.key).toBe("media/one");
    await b.put("media/one", "b's file");
    expect(await (await a.get("media/one"))?.text()).toBe("a's file");
    expect(await (await b.get("media/one"))?.text()).toBe("b's file");
    expect((await real.BLOBS.get("clients/gym-a/media/one"))?.key).toBe("clients/gym-a/media/one");
    expect(await real.BLOBS.get("media/one")).toBeNull();
    const head = await a.head("media/one");
    expect(head?.key).toBe("media/one");
  });

  it("cannot name B's key: not by B's prefix, an absolute key, .. or a backslash", async () => {
    await b.put("secret", "b's secret");
    for (const key of [
      "../gym-b/secret",
      "media/../../gym-b/secret",
      "/clients/gym-b/secret",
      "clients/gym-b/secret",
      "..\\gym-b\\secret",
      "./secret",
      "",
    ]) {
      const found = await a.get(key).catch((error: unknown) => error);
      if (found instanceof ClientPartError) continue;
      // A key that is allowed lands under A's own prefix, where B's secret is not.
      expect(found, key).toBeNull();
    }
    await expect(a.get("../gym-b/secret")).rejects.toThrow(ClientPartError);
    await expect(a.delete(["ok", "../gym-b/secret"])).rejects.toThrow(ClientPartError);
    expect(await (await b.get("secret"))?.text()).toBe("b's secret");
    // Deleting "secret" in A's part leaves B's.
    await a.delete("secret");
    expect(await (await b.get("secret"))?.text()).toBe("b's secret");
  });

  it("lists only its own part: no prefix, startAfter or delimiter reaches above it", async () => {
    await a.put("list/1", "1");
    await a.put("list/2", "2");
    await b.put("list/3", "3");
    const all = await a.list({ prefix: "list/" });
    expect(all.objects.map((o) => o.key)).toEqual(["list/1", "list/2"]);
    const everything = await a.list();
    expect(everything.objects.every((o) => !o.key.startsWith("clients/"))).toBe(true);
    expect(everything.objects.some((o) => o.key === "list/3")).toBe(false);
    await expect(a.list({ prefix: "../" })).rejects.toThrow(ClientPartError);
    await expect(a.list({ prefix: "/" })).rejects.toThrow(ClientPartError);
    // A startAfter beyond the part lists nothing of B's.
    const after = await a.list({ startAfter: "zzzz" });
    expect(after.objects).toEqual([]);
    const top = await a.list({ delimiter: "/" });
    expect(top.delimitedPrefixes).toContain("list/");
    expect(top.delimitedPrefixes.every((p) => !p.startsWith("clients/"))).toBe(true);
  });

  it("ties a list cursor to its client: B's cursor, and a raw one, are refused in A", async () => {
    for (let i = 0; i < 3; i++) await b.put(`page/${i}`, String(i));
    const first = await b.list({ prefix: "page/", limit: 1 });
    expect(first.truncated).toBe(true);
    if (!first.truncated) throw new Error("unreachable");
    expect(first.cursor.startsWith("gym-b~")).toBe(true);
    await expect(a.list({ prefix: "page/", cursor: first.cursor })).rejects.toThrow(
      ClientPartError,
    );
    await expect(a.list({ cursor: first.cursor.slice("gym-b~".length) })).rejects.toThrow(
      ClientPartError,
    );
    // Even a forged one (B's raw cursor re-tied to A) lists only A's part.
    const forged = await a.list({ cursor: `gym-a~${first.cursor.slice("gym-b~".length)}` });
    expect(forged.objects.every((o) => !o.key.startsWith("page/"))).toBe(true);
    const second = await b.list({ prefix: "page/", limit: 1, cursor: first.cursor });
    expect(second.objects.map((o) => o.key)).toEqual(["page/1"]);
  });

  it("keeps multipart uploads to the client's key", async () => {
    const upload = await a.createMultipartUpload("big");
    expect(upload.key).toBe("big");
    const part = await upload.uploadPart(1, "x".repeat(10));
    const done = await upload.complete([part]);
    expect(done.key).toBe("big");
    expect(await b.get("big")).toBeNull();
    expect(() => a.resumeMultipartUpload("../gym-b/big", upload.uploadId)).toThrow(ClientPartError);
  });

  it("holds no way back to the real bucket", () => {
    expectNoWayBack(a, real.BLOBS);
    expect(clientKey(A, "x")).toBe("clients/gym-a/x");
  });
});

describe("key-value (OAUTH_KV): a key prefix per client", () => {
  const a = keepKeyValueApart(real.OAUTH_KV, A);
  const b = keepKeyValueApart(real.OAUTH_KV, B);

  it("keeps each client's keys apart, in single and bulk reads", async () => {
    await a.put("token:1", "a");
    await b.put("token:1", "b");
    expect(await a.get("token:1")).toBe("a");
    expect(await b.get("token:1")).toBe("b");
    expect(await real.OAUTH_KV.get("token:1")).toBeNull();
    const bulk = await a.get(["token:1", "token:2"]);
    expect([...bulk]).toEqual([
      ["token:1", "a"],
      ["token:2", null],
    ]);
    expect((await a.getWithMetadata("token:1")).value).toBe("a");
  });

  it("cannot name B's key, nor list or page above its own part", async () => {
    await b.put("grant:x", "b's grant");
    await expect(a.get("../gym-b/grant:x")).rejects.toThrow(ClientPartError);
    await expect(a.get("/clients/gym-b/grant:x")).rejects.toThrow(ClientPartError);
    expect(await a.get("clients/gym-b/grant:x")).toBeNull();
    await a.delete("grant:x");
    expect(await b.get("grant:x")).toBe("b's grant");
    const listed = await a.list();
    expect(listed.keys.map((k) => k.name)).not.toContain("grant:x");
    expect(listed.keys.every((k) => !k.name.startsWith("clients/"))).toBe(true);
    for (let i = 0; i < 3; i++) await b.put(`many:${i}`, "v");
    const page = await b.list({ prefix: "many:", limit: 1 });
    expect(page.list_complete).toBe(false);
    if (page.list_complete) throw new Error("unreachable");
    await expect(a.list({ cursor: page.cursor })).rejects.toThrow(ClientPartError);
  });

  it("holds no way back to the real namespace", () => {
    expectNoWayBack(a, real.OAUTH_KV);
  });
});

/** A Vectorize stand-in: one id space for the index, namespaces as Vectorize keeps them. */
function fakeIndex() {
  const vectors = new Map<string, VectorizeVector>();
  const calls: { method: string; args: unknown[] }[] = [];
  const index = {
    calls,
    vectors,
    describe: async () => ({ vectorCount: vectors.size }),
    upsert: async (list: VectorizeVector[]) => {
      calls.push({ method: "upsert", args: [list] });
      for (const v of list) vectors.set(v.id, v);
      return { mutationId: "m" };
    },
    insert: async (list: VectorizeVector[]) => index.upsert(list),
    deleteByIds: async (ids: string[]) => {
      calls.push({ method: "deleteByIds", args: [ids] });
      for (const id of ids) vectors.delete(id);
      return { mutationId: "m" };
    },
    getByIds: async (ids: string[]) =>
      ids.flatMap((id) => {
        const found = vectors.get(id);
        return found ? [found] : [];
      }),
    query: async (_vector: number[], options?: VectorizeQueryOptions) => {
      calls.push({ method: "query", args: [options] });
      const found = [...vectors.values()].filter(
        (v) => options?.namespace === undefined || v.namespace === options.namespace,
      );
      return {
        matches: found.map((v) => ({
          id: v.id,
          score: 1,
          namespace: v.namespace,
          metadata: v.metadata,
        })),
        count: found.length,
      };
    },
    queryById: async (id: string, options?: VectorizeQueryOptions) => {
      calls.push({ method: "queryById", args: [id, options] });
      return index.query([], options);
    },
  };
  return index;
}

describe("search (VECTORIZE): a namespace per client, ids no other client can name", () => {
  it("writes and queries only in the client's namespace, whatever the caller asks", async () => {
    const index = fakeIndex();
    const a = keepVectorsApart(index as unknown as Vectorize, A);
    const b = keepVectorsApart(index as unknown as Vectorize, B);
    await a.upsert([
      { id: "person:1", values: [1], metadata: { object: "person", id: "1" }, namespace: "gym-b" },
    ]);
    await b.upsert([{ id: "person:1", values: [2], metadata: { object: "person", id: "1" } }]);
    // Two vectors: the same caller's id is two ids in the index.
    expect(index.vectors.size).toBe(2);
    for (const v of index.vectors.values()) expect(v.id.startsWith("c:")).toBe(true);
    const fromA = await a.query([1], { topK: 10, namespace: "gym-b", returnMetadata: "all" });
    expect(fromA.matches).toEqual([
      { id: "person:1", score: 1, metadata: { object: "person", id: "1" } },
    ]);
    expect(
      index.calls
        .filter((c) => c.method === "query")
        .map((c) => (c.args[0] as VectorizeQueryOptions).namespace),
    ).toEqual(["gym-a"]);
    const none = await a.query([1], { topK: 10 });
    expect(none.matches[0]).toEqual({ id: "person:1", score: 1 });
  });

  it("cannot get, delete or query by an id of B's", async () => {
    const index = fakeIndex();
    const a = keepVectorsApart(index as unknown as Vectorize, A);
    const b = keepVectorsApart(index as unknown as Vectorize, B);
    await b.upsert([{ id: "deal:9", values: [3], metadata: { object: "deal", id: "9" } }]);
    const bStored = await clientVectorId(B, "deal:9");
    expect(await a.getByIds(["deal:9", bStored])).toEqual([]);
    await a.deleteByIds(["deal:9", bStored]);
    expect(index.vectors.size).toBe(1);
    expect((await b.getByIds(["deal:9"]))[0]?.id).toBe("deal:9");
    await a.queryById("deal:9");
    const byId = index.calls.filter((c) => c.method === "queryById").at(-1);
    expect(byId?.args[0]).toBe(await clientVectorId(A, "deal:9"));
    expect((byId?.args[1] as VectorizeQueryOptions | undefined)?.namespace).toBe("gym-a");
    await expect(a.describe()).rejects.toThrow(ClientPartError);
  });

  it("drops a match outside the client's namespace even if the index answered one", async () => {
    const index = fakeIndex();
    const a = keepVectorsApart(index as unknown as Vectorize, A);
    index.vectors.set("stray", {
      id: "stray",
      values: [1],
      namespace: "gym-b",
      metadata: { cos_vector_id: "x", object: "o", id: "1" },
    });
    const leaky = {
      ...index,
      query: async () => ({
        matches: [{ id: "stray", score: 1, namespace: "gym-b", metadata: { cos_vector_id: "x" } }],
        count: 1,
      }),
    };
    const wrapped = keepVectorsApart(leaky as unknown as Vectorize, A);
    expect((await wrapped.query([1])).matches).toEqual([]);
    expectNoWayBack(a, index);
  });
});

/** A queue stand-in that records what was sent. */
function recordingQueue() {
  const sent: { body: unknown; options?: unknown }[] = [];
  return {
    sent,
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
    send: async (body: unknown, options?: unknown) => {
      sent.push({ body, options });
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    sendBatch: async (messages: Iterable<{ body: unknown }>) => {
      for (const m of messages) sent.push({ body: m.body });
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
}

describe("queues: the client stamped on every message", () => {
  it("stamps each message with the client, whatever its body says", async () => {
    const queue = recordingQueue();
    const a = keepQueueApart(queue as unknown as Queue<unknown>, A);
    await a.send({ kind: "record", id: "1" });
    await a.send({ cosClient: "gym-b", body: { kind: "forged" } });
    await a.sendBatch([{ body: { kind: "batch" } }]);
    expect(queue.sent.map((m) => stampOf(m.body)?.client)).toEqual(["gym-a", "gym-a", "gym-a"]);
    // The consumer reads A's stamp, and the forged "stamp" is only A's body.
    expect(stampOf(queue.sent[1]?.body)).toEqual({
      client: "gym-a",
      body: { cosClient: "gym-b", body: { kind: "forged" } },
    });
    await expect(a.send("text", { contentType: "text" })).rejects.toThrow(ClientPartError);
    await expect(a.metrics()).rejects.toThrow(ClientPartError);
    expectNoWayBack(a, queue);
  });

  it("is read by the consumer only with a valid stamp", () => {
    expect(stampOf({ kind: "record" })).toBeNull();
    expect(stampOf({ cosClient: "Admin", body: 1 })).toBeNull();
    expect(stampOf({ cosClient: "gym-a" })).toBeNull();
    expect(stampOf(null)).toBeNull();
  });
});

/** A Workflow stand-in: one id space, an existing id refused. */
function fakeWorkflow() {
  const instances = new Map<string, { id: string; params: unknown }>();
  const handle = (id: string) =>
    ({
      id,
      status: async () => ({ status: "queued" }),
      pause: async () => {},
      resume: async () => {},
      terminate: async () => {},
      restart: async () => {},
      delete: async () => {},
      sendEvent: async () => {},
      subscribe: async () => ({}),
    }) as unknown as WorkflowInstance;
  return {
    instances,
    get: async (id: string) => {
      if (!instances.has(id)) throw new Error("instance.not_found");
      return handle(id);
    },
    create: async (options: { id: string; params: unknown }) => {
      if (instances.has(options.id)) throw new Error("already exists");
      instances.set(options.id, options);
      return handle(options.id);
    },
    createBatch: async (list: { id: string; params: unknown }[]) =>
      list.map((options) => {
        instances.set(options.id, options);
        return handle(options.id);
      }),
    deleteBatch: async (ids: string[]) => ({ deleted: ids.map((id) => ({ id })), errors: [] }),
  };
}

describe("Workflows: the client in the instance id and beside the params", () => {
  it("prefixes every id and stamps every params; get reaches only the client's", async () => {
    const workflow = fakeWorkflow();
    const a = keepWorkflowApart(workflow as unknown as Workflow<{ n: number }>, A);
    const b = keepWorkflowApart(workflow as unknown as Workflow<{ n: number }>, B);
    const made = await a.create({ id: "run-1", params: { n: 1 } });
    expect(made.id).toBe("run-1");
    await b.create({ id: "run-1", params: { n: 2 } });
    expect([...workflow.instances.keys()].sort()).toEqual(["gym-a_run-1", "gym-b_run-1"]);
    expect(workflow.instances.get("gym-a_run-1")?.params).toEqual({
      cosClient: "gym-a",
      params: { n: 1 },
    });
    expect((await a.get("run-1")).id).toBe("run-1");
    // B's instance, by its stored id or a forged one, is not reachable from A.
    await expect(a.get("gym-b_run-1")).rejects.toThrow(/not_found/);
    await expect(a.get("../gym-b_run-1")).rejects.toThrow(ClientPartError);
    const anonymous = await a.create({ params: { n: 3 } });
    expect(workflow.instances.has(`gym-a_${anonymous.id}`)).toBe(true);
    const batch = await a.createBatch([{ id: "run-2", params: { n: 4 } }]);
    expect(batch.map((i) => i.id)).toEqual(["run-2"]);
    await expect(a.createBatch({ count: 3 })).rejects.toThrow(ClientPartError);
    expect(clientWorkflowId(A, "run-1")).toBe("gym-a_run-1");
    expectNoWayBack(a, workflow);
  });

  it("runs as a client only when the id and the stamp agree", () => {
    expect(workflowClientOf("gym-a_run-1", { cosClient: "gym-a", params: { n: 1 } })).toEqual({
      client: "gym-a",
      params: { n: 1 },
    });
    expect(workflowClientOf("gym-a_run-1", { cosClient: "gym-b", params: {} })).toBeNull();
    expect(workflowClientOf("run-1", { cosClient: "gym-a", params: {} })).toBeNull();
    expect(workflowClientOf("gym-a_run-1", { n: 1 })).toBeNull();
  });
});

describe("Durable Object namespaces: the client in every name", () => {
  const a = keepObjectsApart(real.CLIENT_DB, A);
  const b = keepObjectsApart(real.CLIENT_DB, B);

  it("names every object <client>:<name>, so the same name is two objects", async () => {
    const stubA = a.get(a.idFromName("workspace"));
    const stubB = b.getByName("workspace");
    await stubA.query([{ sql: "CREATE TABLE IF NOT EXISTS mine (v TEXT)", params: [] }]);
    await stubA.query([{ sql: "INSERT INTO mine VALUES ('a')", params: [] }]);
    const fromB = await stubB.query([{ sql: "SELECT v FROM mine", params: [] }]);
    expect(fromB.ok).toBe(false);
    const fromA = await a.getByName("workspace").query([{ sql: "SELECT v FROM mine", params: [] }]);
    expect(fromA.ok && fromA.results[0]?.rows).toEqual([["a"]]);
    expect(a.idFromName("workspace").equals(real.CLIENT_DB.idFromName("gym-a:workspace"))).toBe(
      true,
    );
  });

  it("cannot open B's object: not by B's id, a hex id, a unique id or B's prefixed name", async () => {
    const bId = b.idFromName("workspace");
    expect(() => a.get(bId)).toThrow(ClientPartError);
    expect(() => a.get(real.CLIENT_DB.idFromName("gym-b:workspace"))).toThrow(ClientPartError);
    expect(() => a.idFromString(bId.toString())).toThrow(ClientPartError);
    expect(() => a.newUniqueId()).toThrow(ClientPartError);
    // A name that looks like B's is only a name under A.
    expect(a.idFromName("gym-b:workspace").equals(bId)).toBe(false);
    expect(objectNameParts(clientObjectName(A, "gym-b:workspace"))).toEqual({
      client: "gym-a",
      name: "gym-b:workspace",
    });
    expectNoWayBack(a, real.CLIENT_DB);
  });

  it("reads a client back from a name only when it is a client's", () => {
    expect(objectNameParts("x:1")).toBeNull();
    expect(objectNameParts("Admin:x")).toBeNull();
    expect(objectNameParts("gym-a:")).toBeNull();
    expect(objectNameParts(undefined)).toBeNull();
  });
});

describe("the runner: the client named on every call", () => {
  it("offers each listed method as callAs(<client>, <method>, args), and nothing else", async () => {
    const calls: { client: string; method: string; args: unknown[] }[] = [];
    const runner = {
      callAs: (client: string, method: string, args: unknown[]) => {
        calls.push({ client, method, args });
        return Promise.resolve({ client });
      },
      ping: () => Promise.resolve("the real binding"),
      fetch: () => Promise.resolve(new Response("the real binding")),
    };
    const a = keepRunnerApart(runner, A) as unknown as Record<
      string,
      ((...a: unknown[]) => Promise<unknown>) | undefined
    >;
    expect(await a.ping?.()).toEqual({ client: "gym-a" });
    await a.runTool?.({ tool: "x" });
    expect(calls).toEqual([
      { client: "gym-a", method: "ping", args: [] },
      { client: "gym-a", method: "runTool", args: [{ tool: "x" }] },
    ]);
    // Exactly the listed methods: no fetch, connect, callAs or then to reach the binding by.
    expect(Object.keys(a).sort()).toEqual([...RUNNER_METHODS].sort());
    for (const absent of ["fetch", "connect", "callAs", "then"]) {
      expect(a[absent], absent).toBeUndefined();
    }
    expect(Object.isFrozen(a)).toBe(true);
    // A client named inside a payload is only data: the call is still A's.
    await a.integration?.("call", { client: "gym-b" });
    expect(calls.at(-1)).toEqual({
      client: "gym-a",
      method: "integration",
      args: ["call", { client: "gym-b" }],
    });
    expectNoWayBack(a, runner);
  });
});
