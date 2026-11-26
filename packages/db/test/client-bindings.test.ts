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
  clientObjectNamer,
  clientVectorId,
  clientWorkflowId,
  isObjectName,
  keepBucketApart,
  keepKeyValueApart,
  keepLoaderApart,
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
/** The host's binding key, as a many-client deployment holds it (client-proofs.ts). */
const KEY = "the-host-binding-key-for-the-suite-0123456789";
const HOST = { COS_BINDING_KEY: KEY };
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

/**
 * Which methods of each kind of wrapper a cross-client test below has tried. The last test of
 * the file fails when a wrapper has a method no test has registered here (review of #512, S2).
 */
const tried = new Map<string, Set<string>>();
function covers(kind: string, ...methods: string[]): void {
  const set = tried.get(kind) ?? new Set<string>();
  for (const method of methods) set.add(method);
  tried.set(kind, set);
}

/** What a call did, as a string a failed expectation can print (an RPC stub cannot be printed). */
function outcome(run: () => unknown): "refused" | "allowed" | "failed" {
  try {
    run();
    return "allowed";
  } catch (error) {
    return error instanceof ClientPartError ? "refused" : "failed";
  }
}

describe("every kept-apart name", () => {
  it("has a wrapper, so none is left out of a client's environment or let through raw", () => {
    const keptApart = Object.entries(ENV_NAMES)
      .filter(([, use]) => use.use === "kept-apart")
      .map(([name]) => name);
    expect(keptApart.length).toBeGreaterThan(10);
    // Stream's token and signing key are strings, kept apart by a host that stamps each upload
    // with its client and refuses another creator (stage 66 step 5, with the Stream host): until
    // then they have no wrapper, so they are absent from every client's environment.
    const absentUntilStep5 = ["STREAM_API_TOKEN", "STREAM_SIGNING_JWK", "STREAM_SIGNING_KEY_ID"];
    expect(
      keptApart.filter((name) => !hasBindingWrapper(name) && !absentUntilStep5.includes(name)),
    ).toEqual([]);
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

  it("cannot delete B's object, or resume B's upload, by B's stored key", async () => {
    covers("bucket", "head", "get", "put", "delete", "list", "createMultipartUpload");
    covers("bucket", "resumeMultipartUpload");
    await b.put("keep", "b's");
    await a.delete("clients/gym-b/keep");
    await a.delete(["clients/gym-b/keep"]);
    expect(await (await b.get("keep"))?.text()).toBe("b's");
    const upload = await b.createMultipartUpload("b-big");
    const resumed = a.resumeMultipartUpload("clients/gym-b/b-big", upload.uploadId);
    expect(resumed.key).toBe("clients/gym-b/b-big");
    const finished = await (async () => {
      const part = await resumed.uploadPart(1, "from A");
      return resumed.complete([part]);
    })().then(
      () => "completed",
      () => "refused by the store",
    );
    // Under A's prefix the upload id is no upload of that key: the store refuses it, and B's
    // key holds nothing A wrote.
    expect(finished).toBe("refused by the store");
    expect(await real.BLOBS.head("clients/gym-b/b-big")).toBeNull();
    await upload.abort();
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

  it("cannot delete, overwrite or read B's key by B's stored key", async () => {
    covers("kv", "get", "getWithMetadata", "put", "delete", "list");
    await b.put("grant:keep", "b's grant");
    await a.delete("clients/gym-b/grant:keep");
    await a.put("clients/gym-b/grant:keep", "a's overwrite");
    expect(await b.get("grant:keep")).toBe("b's grant");
    expect((await a.getWithMetadata("clients/gym-b/grant:keep")).value).toBe("a's overwrite");
    expect(await real.OAUTH_KV.get("clients/gym-b/grant:keep")).toBe("b's grant");
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

  it("insert, like upsert, writes only in the client's namespace and ids", async () => {
    covers("vectors", "insert", "upsert", "query", "queryById", "getByIds", "deleteByIds");
    covers("vectors", "describe");
    const index = fakeIndex();
    const a = keepVectorsApart(index as unknown as Vectorize, A);
    await a.insert([{ id: "x:1", values: [1], namespace: "gym-b", metadata: { object: "x" } }]);
    const [stored] = [...index.vectors.values()];
    expect(stored?.namespace).toBe("gym-a");
    expect(stored?.id).toBe(await clientVectorId(A, "x:1"));
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
    covers("queue", "send", "sendBatch", "metrics");
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
    deleteBatch: async (ids: string[]) => {
      for (const id of ids) instances.delete(id);
      return { deleted: ids.map((id) => ({ id })), errors: [] };
    },
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

  it("cannot delete B's instances, by B's id or by B's stored id", async () => {
    covers("workflow", "get", "create", "createBatch", "deleteBatch");
    const workflow = fakeWorkflow();
    const a = keepWorkflowApart(workflow as unknown as Workflow<{ n: number }>, A);
    const b = keepWorkflowApart(workflow as unknown as Workflow<{ n: number }>, B);
    await b.create({ id: "run-9", params: { n: 9 } });
    const result = await a.deleteBatch(["run-9", "gym-b_run-9"]);
    expect(result.deleted.map((d) => d.id)).toEqual(["run-9", "gym-b_run-9"]);
    expect(workflow.instances.has("gym-b_run-9")).toBe(true);
    expect((await b.get("run-9")).id).toBe("run-9");
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
  const GEN_A = "a".repeat(32);
  const GEN_B = "b".repeat(32);
  const a = keepObjectsApart(real.CLIENT_DB, A, clientObjectNamer(HOST, A, GEN_A));
  const b = keepObjectsApart(real.CLIENT_DB, B, clientObjectNamer(HOST, B, GEN_B));
  const partsOf = (stored: string, generation: string | null, key: string | null = KEY) => {
    const parts = objectNameParts(stored);
    return parts && isObjectName(parts, generation, key)
      ? { client: parts.client, name: parts.name }
      : null;
  };

  it("names every object <client>:<proof>:<name>, so the same name is two objects", async () => {
    const stubA = a.get(a.idFromName("workspace"));
    const stubB = b.getByName("workspace");
    await stubA.query([{ sql: "CREATE TABLE IF NOT EXISTS mine (v TEXT)", params: [] }]);
    await stubA.query([{ sql: "INSERT INTO mine VALUES ('a')", params: [] }]);
    const fromB = await stubB.query([{ sql: "SELECT v FROM mine", params: [] }]);
    expect(fromB.ok).toBe(false);
    const fromA = await a.getByName("workspace").query([{ sql: "SELECT v FROM mine", params: [] }]);
    // A reads its own table (the answer's shape is ClientDb's; that it answers is what counts).
    expect(fromA.ok).toBe(true);
    const stored = clientObjectName(A, GEN_A, "workspace", KEY);
    expect(stored).toMatch(/^gym-a:[0-9a-f]{32}:workspace$/);
    expect(a.idFromName("workspace").equals(real.CLIENT_DB.idFromName(stored))).toBe(true);
  });

  it("cannot open B's object: not by B's id, a hex id, a unique id or B's prefixed name", async () => {
    const bId = b.idFromName("workspace");
    covers("objects", "idFromName", "idFromString", "newUniqueId", "get", "getByName");
    // As strings: a stub that should not have been handed out cannot be printed, and printing
    // one hangs the file (review of #512, S2).
    expect(outcome(() => a.get(bId))).toBe("refused");
    expect(
      outcome(() => a.get(real.CLIENT_DB.idFromName(clientObjectName(B, GEN_B, "workspace", KEY)))),
    ).toBe("refused");
    expect(() => a.idFromString(bId.toString())).toThrow(ClientPartError);
    expect(() => a.newUniqueId()).toThrow(ClientPartError);
    // A name that looks like B's is only a name under A.
    const looksLikeB = clientObjectName(B, GEN_B, "workspace", KEY);
    expect(a.idFromName(looksLikeB).equals(bId)).toBe(false);
    expect(partsOf(clientObjectName(A, GEN_A, looksLikeB, KEY), GEN_A)).toEqual({
      client: "gym-a",
      name: looksLikeB,
    });
    expectNoWayBack(a, real.CLIENT_DB);
  });

  it("reads a client back from a name only with the host's proof (review of #512, S1)", () => {
    expect(objectNameParts("x:1")).toBeNull();
    expect(objectNameParts("Admin:x")).toBeNull();
    expect(objectNameParts("gym-a:")).toBeNull();
    expect(objectNameParts(undefined)).toBeNull();
    // A name made with the raw namespace and no key: the plain `<client>:<name>` of before, a
    // made-up proof, another client's proof, or the right proof under another key.
    expect(partsOf("gym-b:workspace", GEN_B)).toBeNull();
    expect(partsOf(`gym-b:${"0".repeat(32)}:workspace`, GEN_B)).toBeNull();
    const aProof = clientObjectName(A, GEN_A, "workspace", KEY).split(":")[1];
    expect(partsOf(`gym-b:${aProof}:workspace`, GEN_B)).toBeNull();
    expect(partsOf(clientObjectName(B, GEN_B, "workspace", `${KEY}-other`), GEN_B)).toBeNull();
    expect(partsOf(clientObjectName(B, GEN_B, "workspace", KEY), GEN_B, null)).toBeNull();
    expect(partsOf(clientObjectName(B, GEN_B, "workspace", KEY), GEN_B)).toEqual({
      client: "gym-b",
      name: "workspace",
    });
    expect(() =>
      keepObjectsApart(real.CLIENT_DB, A, clientObjectNamer({}, A, GEN_A)).idFromName("x"),
    ).toThrow(/COS_BINDING_KEY/);
  });

  it("is no proof for a later client of the same id: the generation is in it (#515, S3)", () => {
    const before = clientObjectName(A, GEN_A, "workspace", KEY);
    expect(partsOf(before, GEN_A)).not.toBeNull();
    // gym-a removed and added again gets another generation: its objects are new ones.
    const LATER = "c".repeat(32);
    expect(partsOf(before, LATER)).toBeNull();
    expect(clientObjectName(A, LATER, "workspace", KEY)).not.toBe(before);
  });

  it("holds only one client's namer: no key, no host env (#515, S2)", () => {
    // The wrapper is a plain object of closures over the namer; nothing in it is the host's env.
    expectNoWayBack(a, HOST);
    expect(() => keepObjectsApart(real.CLIENT_DB, A, HOST as never)).toThrow(ClientPartError);
  });
});

describe("Worker Loader: the client in every worker id (review of #520, M3)", () => {
  const recordingLoader = () => {
    const asked: (string | null)[] = [];
    let loads = 0;
    return {
      asked,
      loads: () => loads,
      loader: {
        get: (id: string | null) => {
          asked.push(id);
          return { id } as unknown as WorkerStub;
        },
        load: () => {
          loads += 1;
          return {} as unknown as WorkerStub;
        },
      } as unknown as WorkerLoader,
    };
  };

  it("asks for client:<id>:<id> only: another client's prefixed id is only a name under A", () => {
    covers("loader", "get", "load");
    const real = recordingLoader();
    const a = keepLoaderApart(real.loader, A);
    const code = () => ({ compatibilityDate: "2026-10-01", mainModule: "m.js", modules: {} });
    a.get("ext:counter:tool", code);
    a.get("client:gym-b:ext:counter:tool", code);
    a.get(null, code);
    a.load(code());
    expect(real.asked).toEqual([
      "client:gym-a:ext:counter:tool",
      "client:gym-a:client:gym-b:ext:counter:tool",
      null,
    ]);
    expect(real.loads()).toBe(1);
    expect(() => a.get("", code)).toThrow(ClientPartError);
    expectNoWayBack(a, real.loader);
  });
});

describe("the runner: the client named on every call", () => {
  it("offers each listed method as callAs(<client>, <method>, args), and nothing else", async () => {
    covers("runner", ...RUNNER_METHODS);
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

describe("every method of every wrapper (review of #512, S2)", () => {
  it("has a cross-client test above: a method added to a wrapper with none fails here", () => {
    const fakeRunner = { callAs: () => undefined };
    const wrappers: Record<string, object> = {
      bucket: keepBucketApart(real.BLOBS, A),
      kv: keepKeyValueApart(real.OAUTH_KV, A),
      vectors: keepVectorsApart(fakeIndex() as unknown as Vectorize, A),
      queue: keepQueueApart(recordingQueue() as unknown as Queue<unknown>, A),
      workflow: keepWorkflowApart(fakeWorkflow() as unknown as Workflow<unknown>, A),
      objects: keepObjectsApart(real.CLIENT_DB, A, clientObjectNamer(HOST, A, null)),
      runner: keepRunnerApart(fakeRunner, A) as object,
      loader: keepLoaderApart({ get: () => null, load: () => null } as unknown as WorkerLoader, A),
    };
    const untested: string[] = [];
    for (const [kind, wrapper] of Object.entries(wrappers)) {
      const methods = Object.keys(wrapper).filter(
        (key) => typeof (wrapper as Record<string, unknown>)[key] === "function",
      );
      expect(methods.length, kind).toBeGreaterThan(0);
      for (const method of methods) {
        if (!tried.get(kind)?.has(method)) untested.push(`${kind}.${method}`);
      }
    }
    expect(untested).toEqual([]);
  });
});
