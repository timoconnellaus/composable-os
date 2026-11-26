// The shared bindings of a many-client host, kept apart (stage 66 step 4, ADR 0615): one wrapper
// per kind of binding, each a `BindingWrapper` (client-environment.ts) that returns a binding of
// the same shape reaching only one client's part. They are what `BINDING_WRAPPERS` puts in a
// client's environment for every `kept-apart` name of `ENV_NAMES`.
//
// What every wrapper here holds to:
// - the client's part is fixed by the wrapper, from the client it was built for; nothing a caller
//   passes (a key, a prefix, a cursor, an id, a name, a namespace, a message) can name another's;
// - a call it cannot keep to that part is refused (thrown), never passed through;
// - it is a plain object of closures: no property, prototype or returned value is the real
//   binding (packages/db/test/client-bindings.test.ts walks each one);
// - what comes back is the caller's own view: keys, ids and names without the client's part.
//
// The other side of a stamp (a queue consumer, a Workflow, a Durable Object) reads it with the
// functions in client-entries.ts. A single-client deployment never builds any of this.
import {
  BINDING_KEY,
  bindingProof,
  generationPart,
  hostBindingKey,
  isBindingProof,
  PROOF,
} from "./client-proofs.ts";
import { type ClientId, isClientId } from "./registry.ts";

/** Why a wrapper refused a call: the message names the rule, never another client. */
export class ClientPartError extends Error {
  override name = "ClientPartError";
}

function refuse(message: string): never {
  throw new ClientPartError(message);
}

// --- Files (BLOBS, R2) and key-value (OAUTH_KV, KV): a key prefix per client ----------------

/** The prefix of every key of a client's part of a bucket or a key-value namespace. */
export function clientKeyPrefix(client: ClientId): string {
  return `clients/${client}/`;
}

/**
 * The stored key of a client's `key`. A key is the caller's name inside its part: never empty,
 * never absolute, never with a `.` or `..` segment, a backslash or a NUL, so no reading of it
 * (R2's and KV's are literal, but a key may one day be a URL path) can leave the prefix.
 */
export function clientKey(client: ClientId, key: unknown): string {
  if (typeof key !== "string" || key.length === 0) refuse("A key is a non-empty string");
  if (key.startsWith("/")) refuse("A key is relative to the client's part: no leading /");
  if (/[\\\0]/.test(key)) refuse("A key holds no backslash or NUL");
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    refuse("A key has no . or .. segment");
  }
  return `${clientKeyPrefix(client)}${key}`;
}

/** `stored` without the client's prefix, or null when it is not in the client's part. */
function ownKey(client: ClientId, stored: string): string | null {
  const prefix = clientKeyPrefix(client);
  return stored.startsWith(prefix) ? stored.slice(prefix.length) : null;
}

/** A list prefix inside the client's part: `""` lists the whole part, and nothing above it. */
function listPrefix(client: ClientId, prefix: unknown): string {
  if (prefix === undefined || prefix === null || prefix === "") return clientKeyPrefix(client);
  if (typeof prefix !== "string") refuse("A list prefix is a string");
  if (prefix.startsWith("/") || /[\\\0]/.test(prefix)) refuse("A list prefix is relative");
  if (prefix.split("/").some((segment) => segment === "..")) refuse("A list prefix has no ..");
  return `${clientKeyPrefix(client)}${prefix}`;
}

/**
 * A list cursor as a client sees it: the store's cursor tied to the client. A cursor is only
 * ever handed back to the client whose listing made it, and is refused from any other; and since
 * every listing's prefix is the client's own, even a cursor from elsewhere lists nothing above
 * the client's part.
 */
const CURSOR_SEPARATOR = "~";

function outCursor(client: ClientId, cursor: string): string {
  return `${client}${CURSOR_SEPARATOR}${cursor}`;
}

function inCursor(client: ClientId, cursor: unknown): string | undefined {
  if (cursor === undefined || cursor === null || cursor === "") return undefined;
  if (typeof cursor !== "string") refuse("A cursor is a string");
  const mine = `${client}${CURSOR_SEPARATOR}`;
  if (!cursor.startsWith(mine)) refuse("This cursor was not made by this client's listing");
  return cursor.slice(mine.length);
}

/**
 * An R2 object with the client's prefix taken off its key. A view of the real object: its body,
 * metadata and methods are the object's own, its key the client's.
 */
function ownObject<T extends R2Object | R2ObjectBody>(client: ClientId, object: T): T {
  const key = ownKey(client, object.key);
  if (key === null) refuse("The store answered with an object outside the client's part");
  const view: Record<string, unknown> = {
    key,
    version: object.version,
    size: object.size,
    etag: object.etag,
    httpEtag: object.httpEtag,
    checksums: object.checksums,
    uploaded: object.uploaded,
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
    range: object.range,
    storageClass: object.storageClass,
    ssecKeyMd5: object.ssecKeyMd5,
    writeHttpMetadata: (headers: Headers) => object.writeHttpMetadata(headers),
  };
  if ("body" in object) {
    const body = object as R2ObjectBody;
    Object.defineProperties(view, {
      body: { get: () => body.body, enumerable: true },
      bodyUsed: { get: () => body.bodyUsed, enumerable: true },
    });
    view.arrayBuffer = () => body.arrayBuffer();
    view.bytes = () => body.bytes();
    view.text = () => body.text();
    view.json = () => body.json();
    view.blob = () => body.blob();
  }
  return view as unknown as T;
}

function ownUpload(client: ClientId, upload: R2MultipartUpload): R2MultipartUpload {
  const key = ownKey(client, upload.key);
  if (key === null) refuse("The store answered with an upload outside the client's part");
  return {
    key,
    uploadId: upload.uploadId,
    uploadPart: (partNumber, value, options) => upload.uploadPart(partNumber, value, options),
    abort: () => upload.abort(),
    complete: async (parts) => ownObject(client, await upload.complete(parts)),
  };
}

/** Files (BLOBS), kept apart: every key under `clients/<client>/`, added on write, removed on list. */
export function keepBucketApart(bucket: R2Bucket, client: ClientId): R2Bucket {
  const key = (k: unknown) => clientKey(client, k);
  const wrapped: R2Bucket = {
    head: async (k) => {
      const found = await bucket.head(key(k));
      return found ? ownObject(client, found) : null;
    },
    get: (async (k: string, options?: R2GetOptions) => {
      const found = await bucket.get(key(k), options);
      return found ? ownObject(client, found) : null;
    }) as R2Bucket["get"],
    put: (async (
      k: string,
      value: Parameters<R2Bucket["put"]>[1],
      options?: Parameters<R2Bucket["put"]>[2],
    ) => {
      const put = await bucket.put(key(k), value, options);
      return put ? ownObject(client, put) : null;
    }) as R2Bucket["put"],
    createMultipartUpload: async (k, options) =>
      ownUpload(client, await bucket.createMultipartUpload(key(k), options)),
    resumeMultipartUpload: (k, uploadId) =>
      ownUpload(client, bucket.resumeMultipartUpload(key(k), uploadId)),
    delete: async (keys) => bucket.delete(Array.isArray(keys) ? keys.map(key) : key(keys)),
    list: async (options) => {
      const startAfter =
        options?.startAfter !== undefined ? clientKey(client, options.startAfter) : undefined;
      const cursor = inCursor(client, options?.cursor);
      const listed = await bucket.list({
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
        ...(options?.include !== undefined ? { include: options.include } : {}),
        prefix: listPrefix(client, options?.prefix),
        ...(startAfter !== undefined ? { startAfter } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      // Every object and prefix the store answered with is in the client's part (the prefix is
      // the client's); anything else would be the store's fault, and is dropped, never shown.
      const objects = listed.objects.flatMap((object) =>
        ownKey(client, object.key) === null ? [] : [ownObject(client, object)],
      );
      const delimitedPrefixes = listed.delimitedPrefixes.flatMap((prefix) => {
        const own = ownKey(client, prefix);
        return own === null ? [] : [own];
      });
      return listed.truncated
        ? { objects, delimitedPrefixes, truncated: true, cursor: outCursor(client, listed.cursor) }
        : { objects, delimitedPrefixes, truncated: false };
    },
  };
  return wrapped;
}

/** Key-value (OAUTH_KV), kept apart: every key under `clients/<client>/`. */
export function keepKeyValueApart(kv: KVNamespace, client: ClientId): KVNamespace {
  const key = (k: unknown) => clientKey(client, k);
  /** A bulk read's answer, by the caller's keys. */
  const ownMap = <V>(answer: Map<string, V>): Map<string, V> => {
    const out = new Map<string, V>();
    for (const [stored, value] of answer) {
      const own = ownKey(client, stored);
      if (own !== null) out.set(own, value);
    }
    return out;
  };
  const read =
    (method: "get" | "getWithMetadata") =>
    async (k: string | string[], options?: unknown): Promise<unknown> => {
      const call = kv[method] as (k: string | string[], o?: unknown) => Promise<unknown>;
      if (Array.isArray(k))
        return ownMap((await call.call(kv, k.map(key), options)) as Map<string, unknown>);
      return call.call(kv, key(k), options);
    };
  const wrapped = {
    get: read("get"),
    getWithMetadata: read("getWithMetadata"),
    put: async (
      k: string,
      value: Parameters<KVNamespace["put"]>[1],
      options?: KVNamespacePutOptions,
    ) => kv.put(key(k), value, options),
    delete: async (k: string) => kv.delete(key(k)),
    list: async (options?: KVNamespaceListOptions) => {
      const cursor = inCursor(client, options?.cursor);
      const listed = await kv.list({
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        prefix: listPrefix(client, options?.prefix),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const keys = listed.keys.flatMap((entry) => {
        const name = ownKey(client, entry.name);
        return name === null ? [] : [{ ...entry, name }];
      });
      return listed.list_complete
        ? { ...listed, keys }
        : { ...listed, keys, cursor: outCursor(client, listed.cursor) };
    },
  };
  return wrapped as unknown as KVNamespace;
}

// --- Search (VECTORIZE): a namespace per client, and ids no other client can name ------------

/** The metadata field that carries a vector's own id inside the client's part. */
export const VECTOR_ID_FIELD = "cos_vector_id";

const vectorEncoder = new TextEncoder();

/**
 * The stored id of a client's vector: a hash of the client and its id, so no id a client can
 * write is another's (Vectorize ids are one space for the whole index, whatever the namespace,
 * and 64 bytes at most, so a plain prefix would not fit beside the 64-byte ids already used).
 */
export async function clientVectorId(client: ClientId, id: unknown): Promise<string> {
  if (typeof id !== "string" || id.length === 0) refuse("A vector id is a non-empty string");
  const digest = await crypto.subtle.digest("SHA-256", vectorEncoder.encode(`${client}\n${id}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `c:${hex.slice(0, 56)}`;
}

type VectorIndex = VectorizeIndex | Vectorize;

/**
 * Search (VECTORIZE), kept apart: each client's vectors in the namespace named by its id, set by
 * the wrapper on every write and every query whatever the caller asks; ids hashed with the
 * client, so `getByIds` and `deleteByIds` never name another's vector; a match or vector the
 * index answers outside the client's namespace is dropped. The caller's own id travels in the
 * vector's metadata (`cos_vector_id`) and is what it gets back. `describe` (the whole index's
 * count) is refused.
 */
export function keepVectorsApart<V extends VectorIndex>(index: V, client: ClientId): V {
  const namespace: string = client;
  const toStored = async (vectors: VectorizeVector[]): Promise<VectorizeVector[]> =>
    Promise.all(
      vectors.map(async (vector) => {
        if (vectorEncoder.encode(vector.id ?? "").length > 64)
          refuse("A vector id is 64 bytes at most");
        return {
          ...vector,
          id: await clientVectorId(client, vector.id),
          namespace,
          metadata: { ...vector.metadata, [VECTOR_ID_FIELD]: vector.id },
        };
      }),
    );
  /** The caller's view of a vector or match: its own id, its own metadata. */
  const toOwn = <T extends { id: string; namespace?: string; metadata?: Record<string, unknown> }>(
    found: T,
    wantMetadata: boolean,
  ): T | null => {
    if (found.namespace !== undefined && found.namespace !== namespace) return null;
    const own = found.metadata?.[VECTOR_ID_FIELD];
    if (typeof own !== "string") return null;
    const { [VECTOR_ID_FIELD]: _own, ...metadata } = found.metadata ?? {};
    const { metadata: _all, namespace: _ns, ...rest } = found;
    return {
      ...rest,
      id: own,
      ...(wantMetadata ? { metadata } : {}),
    } as unknown as T;
  };
  const queryOptions = (options?: VectorizeQueryOptions): VectorizeQueryOptions => ({
    ...options,
    // The caller's own id is in the metadata: always read it, and give back only what was asked.
    returnMetadata: "all",
    namespace,
  });
  const wantsMetadata = (options?: VectorizeQueryOptions) =>
    Boolean(options?.returnMetadata) && options?.returnMetadata !== "none";
  const matches = (answer: VectorizeMatches, options?: VectorizeQueryOptions): VectorizeMatches => {
    const own = answer.matches.flatMap((match) => {
      const mine = toOwn(match, wantsMetadata(options));
      return mine ? [mine] : [];
    });
    return { matches: own, count: own.length };
  };
  const wrapped = {
    describe: async () => refuse("describe() counts every client's vectors: not for one client"),
    query: async (vector: VectorFloatArray | number[], options?: VectorizeQueryOptions) =>
      matches(await index.query(vector, queryOptions(options)), options),
    queryById: async (vectorId: string, options?: VectorizeQueryOptions) => {
      const byId = (index as Vectorize).queryById;
      if (typeof byId !== "function") refuse("This index has no queryById");
      return matches(
        await byId.call(index, await clientVectorId(client, vectorId), queryOptions(options)),
        options,
      );
    },
    insert: async (vectors: VectorizeVector[]) => index.insert(await toStored(vectors)),
    upsert: async (vectors: VectorizeVector[]) => index.upsert(await toStored(vectors)),
    deleteByIds: async (ids: string[]) =>
      index.deleteByIds(await Promise.all(ids.map((id) => clientVectorId(client, id)))),
    getByIds: async (ids: string[]) => {
      const found = await index.getByIds(
        await Promise.all(ids.map((id) => clientVectorId(client, id))),
      );
      return found.flatMap((vector) => {
        const mine = toOwn(vector, true);
        return mine ? [mine] : [];
      });
    },
  };
  return wrapped as unknown as V;
}

// --- Queues: the client stamped beside every message -----------------------------------------

/** A message as a client's queue sends it: the body untouched, the client beside it. */
export interface StampedMessage<Body = unknown> {
  cosClient: ClientId;
  body: Body;
}

/**
 * A queue (AUTOMATION_EVENTS, ROUTINE_DELIVERY), kept apart: every message the client sends goes
 * as `{ cosClient, body }`, stamped by the wrapper. Nothing in the body can change the stamp (a
 * body shaped like a stamp is only a body, stamped again), and the consumer (client-entries.ts,
 * `stampOf`) acts on each message as the client stamped, refusing a message with none. Only the
 * host's own Workers produce to its queues, all through this wrapper. `metrics()` (every
 * client's backlog) is refused.
 */
export function keepQueueApart<Body>(queue: Queue<Body>, client: ClientId): Queue<Body> {
  const stamp = (body: Body): StampedMessage<Body> => ({ cosClient: client, body });
  const contentType = (type: QueueContentType | undefined): QueueContentType | undefined => {
    // The stamp is an object: it travels as structured data, never as text or bytes.
    if (type === undefined || type === "v8" || type === "json") return type;
    return refuse(`A client's message is sent as v8 or json, not ${type}`);
  };
  const raw = queue as unknown as Queue<StampedMessage<Body>>;
  const wrapped = {
    metrics: async () => refuse("metrics() counts every client's messages: not for one client"),
    send: async (body: Body, options?: QueueSendOptions) => {
      const type = contentType(options?.contentType);
      return raw.send(stamp(body), { ...options, ...(type ? { contentType: type } : {}) });
    },
    sendBatch: async (
      messages: Iterable<MessageSendRequest<Body>>,
      options?: QueueSendBatchOptions,
    ) =>
      raw.sendBatch(
        [...messages].map((message) => {
          const type = contentType(message.contentType);
          return { ...message, body: stamp(message.body), ...(type ? { contentType: type } : {}) };
        }),
        options,
      ),
  };
  return wrapped as unknown as Queue<Body>;
}

// --- Workflows: the client in the instance id and beside the params --------------------------

/** What separates the client from the caller's id in a Workflow instance id. */
export const WORKFLOW_ID_SEPARATOR = "_";

/** The params a client's Workflow instance is created with: the caller's, the client beside. */
export interface StampedParams<Params = unknown> {
  cosClient: ClientId;
  params: Params;
}

/** Workflow instance ids: letters, digits, `-` and `_`, 100 at most (Cloudflare's limits). */
const WORKFLOW_ID = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
const WORKFLOW_ID_MAX = 100;

/**
 * The stored id of a client's instance: `<client>_<id>`. A client id never holds `_`, so the
 * first `_` ends it, and no id a client can pass makes another's.
 */
export function clientWorkflowId(client: ClientId, id: unknown): string {
  if (typeof id !== "string" || id.length === 0)
    refuse("A Workflow instance id is a non-empty string");
  const stored = `${client}${WORKFLOW_ID_SEPARATOR}${id}`;
  if (!WORKFLOW_ID.test(id) || stored.length > WORKFLOW_ID_MAX) {
    refuse("Not a Workflow instance id: letters, digits, - and _, and short enough for the client");
  }
  return stored;
}

function ownInstance(client: ClientId, instance: WorkflowInstance): WorkflowInstance {
  const prefix = `${client}${WORKFLOW_ID_SEPARATOR}`;
  if (!instance.id.startsWith(prefix)) refuse("The Workflow answered with another's instance");
  return {
    id: instance.id.slice(prefix.length),
    pause: () => instance.pause(),
    resume: () => instance.resume(),
    terminate: (options?: WorkflowInstanceTerminateOptions) => instance.terminate(options),
    restart: (options?: WorkflowInstanceRestartOptions) => instance.restart(options),
    delete: () => instance.delete(),
    status: () => instance.status(),
    sendEvent: (event: { type: string; payload: unknown }) => instance.sendEvent(event),
    subscribe: (options?: WorkflowInstanceSubscribeOptions) => instance.subscribe(options),
  } as WorkflowInstance;
}

/**
 * A Workflow (AUTOMATION_WORKFLOW, HELLO_WORKFLOW), kept apart: every instance id is
 * `<client>_<id>` (an id the caller leaves out is made for it), so `get` reaches only the
 * client's instances; the params go as `{ cosClient, params }`, and the Workflow acts as the
 * client only when the two agree (client-entries.ts, `workflowClientOf`). A batch by count
 * (instances with made-up ids) and `deleteBatch` by raw ids are refused or kept to the client.
 */
export function keepWorkflowApart<Params>(
  workflow: Workflow<Params>,
  client: ClientId,
): Workflow<Params> {
  const raw = workflow as unknown as Workflow<StampedParams<Params>>;
  const options = (
    input: WorkflowInstanceCreateOptions<Params> | undefined,
  ): WorkflowInstanceCreateOptions<StampedParams<Params>> => {
    const { params, id, ...rest } = input ?? {};
    return {
      ...rest,
      id: clientWorkflowId(client, id ?? crypto.randomUUID()),
      params: { cosClient: client, params: params as Params },
    };
  };
  const wrapped = {
    get: async (id: string) => ownInstance(client, await raw.get(clientWorkflowId(client, id))),
    create: async (input?: WorkflowInstanceCreateOptions<Params>) =>
      ownInstance(client, await raw.create(options(input))),
    createBatch: async (
      input: WorkflowBatchCreateOptions<Params> | WorkflowInstanceCreateOptions<Params>[],
    ) => {
      if (Array.isArray(input)) {
        const created = await raw.createBatch(input.map(options));
        return created.map((instance) => ownInstance(client, instance));
      }
      if (!input.instances) return refuse("A client's Workflow batch names its instances");
      const result = await raw.createBatch({ instances: input.instances.map(options) });
      const prefix = `${client}${WORKFLOW_ID_SEPARATOR}`;
      return {
        created: result.created.map((instance) => ownInstance(client, instance)),
        errors: result.errors.map((error) => ({
          ...error,
          ...(error.id?.startsWith(prefix) ? { id: error.id.slice(prefix.length) } : {}),
        })),
      };
    },
    deleteBatch: async (ids: string[]) => {
      const prefix = `${client}${WORKFLOW_ID_SEPARATOR}`;
      const result = await raw.deleteBatch(ids.map((id) => clientWorkflowId(client, id)));
      const own = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
      return {
        deleted: result.deleted.map((entry) => ({ ...entry, id: own(entry.id) })),
        errors: result.errors.map((error) => ({ ...error, id: own(error.id) })),
      };
    },
  };
  return wrapped as unknown as Workflow<Params>;
}

// --- Durable Object namespaces: the client in every object's name ----------------------------

/** What separates the client, the proof and the caller's name in a Durable Object's name. */
export const OBJECT_NAME_SEPARATOR = ":";

/** The runtime exposes `ctx.id.name` inside an object only for names of 1,024 bytes at most. */
const OBJECT_NAME_MAX_BYTES = 1024;

/**
 * Names one client's objects: `name` → the stored name `<client>:<proof>:<name>`, the proof the
 * host's HMAC (`COS_BINDING_KEY`) of the client, its secret generation and the name. A client id
 * never holds `:` and a proof is hex, so the first two `:` end them, and every name a caller passes
 * stays under its client. Made by the directory for one client (`clientObjectNamer`); the
 * namespace wrapper holds only this function, never the key or the host's `env` (#515, S2).
 */
export type ClientObjectNamer = (name: unknown) => string;

/**
 * The namer of `client`'s objects under the host's key in its real `env`, for the client's
 * generation (a client id removed and added again would get other objects; #515, S3).
 */
export function clientObjectNamer(
  host: object,
  client: ClientId,
  generation: string | null,
): ClientObjectNamer {
  const key = hostBindingKey(host);
  const part = generationPart(generation);
  return (name) => clientObjectName(client, part, name, key);
}

/** The stored name of a client's object (see `ClientObjectNamer`). */
export function clientObjectName(
  client: ClientId,
  generation: string,
  name: unknown,
  key: string | null,
): string {
  if (typeof name !== "string" || name.length === 0)
    refuse("A Durable Object name is a non-empty string");
  if (!key) refuse(`${BINDING_KEY} is not bound: no client's object can be named`);
  const proof = bindingProof(key, PROOF.object, client, generation, name);
  const stored = `${client}${OBJECT_NAME_SEPARATOR}${proof}${OBJECT_NAME_SEPARATOR}${name}`;
  if (vectorEncoder.encode(stored).length > OBJECT_NAME_MAX_BYTES) {
    refuse("A Durable Object name is too long for the object to know its client");
  }
  return stored;
}

/**
 * The client, the proof and the caller's name of an object, from its stored name, unchecked:
 * null when it has no client part. The object checks the proof (`isObjectName`) once it has read
 * its client's generation from the registry.
 */
export function objectNameParts(
  stored: string | undefined | null,
): { client: ClientId; proof: string; name: string } | null {
  if (typeof stored !== "string") return null;
  const first = stored.indexOf(OBJECT_NAME_SEPARATOR);
  if (first <= 0) return null;
  const second = stored.indexOf(OBJECT_NAME_SEPARATOR, first + 1);
  if (second <= first) return null;
  const client = stored.slice(0, first);
  const proof = stored.slice(first + 1, second);
  const name = stored.slice(second + 1);
  if (!isClientId(client) || name.length === 0) return null;
  return { client, proof, name };
}

/** Whether an object's name parts carry the host's proof for the client's `generation`. */
export function isObjectName(
  parts: { client: ClientId; proof: string; name: string },
  generation: string | null,
  key: string | null,
): boolean {
  return isBindingProof(
    key,
    parts.proof,
    PROOF.object,
    parts.client,
    generationPart(generation),
    parts.name,
  );
}

/** Which client each id a namespace wrapper made is for: `get` opens only the client's ids. */
const objectIdClient = new WeakMap<DurableObjectId, ClientId>();

/**
 * A Durable Object namespace (ASSISTANT, AGENT_JOB, EXTENSION_WORKSPACE, CODE_MODE_GATE,
 * INTEGRATION_HOST, FAKE_ACCOUNT, FAKE_PROVIDER), kept apart: every object is named by the
 * client's namer (`idFromName`, `getByName`), and `get` opens only an id made by a wrapper for the
 * same client. `idFromString` (a hex id says nothing of whose it is) and `newUniqueId` (an object
 * with no name cannot know its client) are refused. The object reads its client from its own name
 * and checks the proof (client-entries.ts, `ClientObject`). The wrapper holds the namer of one
 * client only: nothing in it names another client's object.
 */
export function keepObjectsApart<N extends DurableObjectNamespace<never> | DurableObjectNamespace>(
  namespace: N,
  client: ClientId,
  namer: ClientObjectNamer,
): N {
  if (typeof namer !== "function") refuse("No namer: this client's objects cannot be named");
  const real = namespace as unknown as DurableObjectNamespace;
  const own = (id: DurableObjectId): DurableObjectId => {
    objectIdClient.set(id, client);
    return id;
  };
  const wrap = (inner: DurableObjectNamespace): DurableObjectNamespace =>
    ({
      idFromName: (name: string) => own(inner.idFromName(namer(name))),
      idFromString: () =>
        refuse("idFromString cannot be kept to one client: name the object instead"),
      newUniqueId: () =>
        refuse("newUniqueId makes an object with no name, which cannot know its client"),
      get: (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) => {
        if (objectIdClient.get(id) !== client)
          refuse("This id is not one of this client's objects");
        return inner.get(id, options);
      },
      getByName: (name: string, options?: DurableObjectNamespaceGetDurableObjectOptions) =>
        inner.getByName(namer(name), options),
      // No `jurisdiction()`: nothing in the host uses it, and it is left out rather than wrapped.
    }) as unknown as DurableObjectNamespace;
  return wrap(real) as unknown as N;
}

// --- Worker Loader: the client in every worker id -----------------------------------------

/** The prefix of every Worker Loader id a client's environment asks for: `client:<id>:`. */
export function clientWorkerIdPrefix(client: ClientId): string {
  return `client:${client}:`;
}

/**
 * Worker Loader (LOADER), kept apart (review of #520, M3): `get(id, code)` asks for the worker
 * `client:<client>:<id>`, so a pack's warm isolate, and any module-level state its code keeps, is
 * never another client's, and an id a caller passes (even another client's prefixed id) is only a
 * name under this client. `get(null, …)` names no warm worker and goes through as it is; `load`
 * takes no id. A single-client deployment's LOADER is the real one, its ids unchanged.
 */
export function keepLoaderApart(loader: WorkerLoader, client: ClientId): WorkerLoader {
  const prefix = clientWorkerIdPrefix(client);
  return {
    get: (id: string | null, getCode: Parameters<WorkerLoader["get"]>[1]) => {
      if (id !== null && (typeof id !== "string" || id.length === 0)) {
        refuse("A Worker Loader id is a non-empty string, or null");
      }
      return loader.get(id === null ? null : `${prefix}${id}`, getCode);
    },
    load: (code: Parameters<WorkerLoader["load"]>[0]) => loader.load(code),
  } as WorkerLoader;
}

// --- The runner: the app names the client on every call --------------------------------------

/** What the runner offers the app on a many-client host: its methods, as one client. */
export interface ClientRunnerEntry {
  /**
   * One of `RUNNER_METHODS` as `client`, with its arguments: the runner builds that client's
   * environment and runs the method on it.
   */
  callAs(client: string, method: string, args: unknown[]): unknown;
}

/**
 * Every method of the runner's RPC (apps/runner/src/rpc.ts, `RunnerRpc`), listed: the RUNNER
 * wrapper offers these and nothing else. apps/runner's two-client suite fails when the runner's
 * `ClientRunner` has a method this list does not.
 */
export const RUNNER_METHODS = [
  "ping",
  "startHelloWorkflow",
  "helloWorkflowStatus",
  "commit",
  "shipped",
  "commitShipped",
  "evaluate",
  "runTool",
  "versions",
  "files",
  "listWorkspace",
  "workingCopy",
  "writeFiles",
  "commitWorkingCopy",
  "eject",
  "runCode",
  "runProducer",
  "describeChange",
  "installShipped",
  "integration",
  "gatekeeperFetch",
  "testAutomation",
  "startManualRun",
  "retryRun",
  "replayRun",
  "cancelRun",
] as const;

/**
 * The service binding to the runner (RUNNER), kept apart: each method of `RUNNER_METHODS` calls
 * `callAs(<client>, <method>, args)`, the client its own argument, so the runner runs it in that
 * client's environment (and never reads a client from a payload).
 * The runner trusts the client it is told because only the host's own Workers are bound to it (it
 * has no public route: `workers_dev` off, no routes). No other method is offered: no `fetch`, no
 * `connect`, nothing forwarded by name.
 */
export function keepRunnerApart<R>(runner: R, client: ClientId): R {
  const entry = runner as unknown as ClientRunnerEntry;
  const methods: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of RUNNER_METHODS) {
    methods[method] = (...args: unknown[]) => entry.callAs(client, method, args);
  }
  return Object.freeze(methods) as unknown as R;
}
