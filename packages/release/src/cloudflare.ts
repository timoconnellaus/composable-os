// A small typed client for the Cloudflare REST API (v4), with `fetch` only: the CLI and the
// self-updater deploy without wrangler (ADR 0163). Endpoints and shapes are cited in ADR 0163.
//
// The client never logs, and errors carry the API's messages but never request bodies, so a
// token or secret value cannot end up in output.

import type { LocationHint } from "@composable-os/product";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

// The location hints D1 and R2 accept on create (ADR 0580). Defined with the product definition,
// where a client product's `location` names one; re-exported here beside the calls that send them.
export { isLocationHint, LOCATION_HINTS, type LocationHint } from "@composable-os/product";

export class CloudflareApiError extends Error {
  override name = "CloudflareApiError";
  readonly status: number;
  readonly codes: number[];
  constructor(message: string, status: number, codes: number[]) {
    super(message);
    this.status = status;
    this.codes = codes;
  }
}

/**
 * Cloudflare's answers on a zone that has not enabled Cloudflare for SaaS: 1456 ("Access to
 * configure this resource has not been granted for this zone. This feature is available with SSL
 * for SaaS", HTTP 401) on the fallback origin, and 1404 ("No quota has been allocated for this zone
 * or for this account", HTTP 403) on custom hostnames. Seen on the fleet's real zone, 2026-11-27.
 */
export const SAAS_NOT_ENABLED_CODES = Object.freeze([1456, 1404]);

/** A custom-hostname call on a zone without Cloudflare for SaaS. */
export class SaasNotEnabledError extends Error {
  override name = "SaasNotEnabledError";
}

export function isSaasNotEnabled(error: unknown): boolean {
  return (
    error instanceof SaasNotEnabledError ||
    (error instanceof CloudflareApiError &&
      error.codes.some((c) => SAAS_NOT_ENABLED_CODES.includes(c)))
  );
}

/** A custom-hostname call, its "not enabled" answer as `SaasNotEnabledError`. */
async function saasCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isSaasNotEnabled(error)) {
      throw new SaasNotEnabledError(
        "Cloudflare for SaaS (custom hostnames) is not enabled on this zone",
      );
    }
    throw error;
  }
}

/** A route of a pattern that is another Worker's. */
export class RouteTakenError extends Error {
  override name = "RouteTakenError";
  readonly pattern: string;
  readonly script: string | null;
  constructor(pattern: string, script: string | null) {
    super(
      `the route ${pattern} is ${script ? `${script}'s` : "another Worker's"}: never re-pointed (another deployment's, or someone's own)`,
    );
    this.pattern = pattern;
    this.script = script;
  }
}

/** The call's result, or null when Cloudflare answers 404. */
async function unless404<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return null;
    throw error;
  }
}

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: {
    page?: number;
    total_pages?: number;
    total_count?: number;
    cursor?: string;
    is_truncated?: boolean;
  };
}

export interface ModulePart {
  name: string;
  type: "esm" | "text" | "data" | "wasm";
  bytes: Uint8Array;
}

const CONTENT_TYPES: Record<ModulePart["type"], string> = {
  esm: "application/javascript+module",
  text: "text/plain",
  data: "application/octet-stream",
  wasm: "application/wasm",
};

export interface ScriptInfo {
  id: string;
  migration_tag?: string;
}

/** A Cloudflare for SaaS custom hostname, as much of it as cos reads. */
export interface CustomHostname {
  id: string;
  hostname: string;
  /** `pending` until its ownership is proved, then `active` (or `moved`, `blocked`, …). */
  status: string;
  /** The TXT record that proves the hostname's owner controls it. */
  ownership_verification?: { type?: string; name?: string; value?: string };
  ssl?: {
    /** `initializing`, `pending_validation`, …, `active`. */
    status?: string;
    validation_records?: { txt_name?: string; txt_value?: string }[];
  };
}

/** An AI Gateway as the API returns it (the fields this package reads or writes back). */
export interface AiGateway {
  id: string;
  collect_logs?: boolean;
  authentication?: boolean;
  cache_ttl?: number;
  cache_invalidate_on_update?: boolean;
  rate_limiting_interval?: number;
  rate_limiting_limit?: number;
  rate_limiting_technique?: string;
  store_id?: string | null;
  [key: string]: unknown;
}

export interface CustomProviderInfo {
  id: string;
  slug: string;
  name: string;
  base_url: string;
  enable?: boolean;
}

export interface ProviderConfigInfo {
  id: string;
  provider_slug: string;
  alias: string;
  default_config?: boolean;
  secret_preview?: string;
}

/** Settings an update sends back unchanged (the update API replaces them all). */
const GATEWAY_SETTING_KEYS = [
  "authentication",
  "byok_only",
  "cache_invalidate_on_update",
  "cache_ttl",
  "collect_logs",
  "log_management",
  "log_management_strategy",
  "logpush",
  "rate_limiting_interval",
  "rate_limiting_limit",
  "rate_limiting_technique",
  "retry_backoff",
  "retry_delay",
  "retry_max_attempts",
  "store_id",
  "zdr",
] as const;

/** A gateway's settings, for sending back in an update with some of them changed. */
export function gatewaySettingsOf(gateway: AiGateway): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of GATEWAY_SETTING_KEYS) {
    if (gateway[key] !== undefined && gateway[key] !== null) out[key] = gateway[key];
  }
  return out;
}

export interface CloudflareClientOptions {
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
  /**
   * A Workers for Platforms dispatch namespace (ADR 0210): script calls then address user Workers
   * in that namespace (`/workers/dispatch/namespaces/{ns}/scripts`) instead of the account's own
   * scripts. Everything else (D1, R2, queues, AI Gateway…) is account-wide either way.
   */
  namespace?: string;
}

export class CloudflareClient {
  readonly apiBase: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  /** The dispatch namespace script calls go to, if any (ADR 0210). */
  readonly namespace: string | undefined;

  constructor(options: CloudflareClientOptions) {
    this.token = options.token;
    this.apiBase = options.apiBase ?? CLOUDFLARE_API;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.namespace = options.namespace;
  }

  /** The same client, with script calls addressed to user Workers in a dispatch namespace. */
  forNamespace(namespace: string): CloudflareClient {
    return new CloudflareClient({
      token: this.token,
      apiBase: this.apiBase,
      fetch: this.fetchImpl,
      namespace,
    });
  }

  private scripts(accountId: string): string {
    return this.namespace
      ? `/accounts/${accountId}/workers/dispatch/namespaces/${encodeURIComponent(this.namespace)}/scripts`
      : `/accounts/${accountId}/workers/scripts`;
  }

  /** Workers for Platforms has no versions, deployments, schedules or workers.dev for user Workers. */
  private accountOnly(what: string): void {
    if (this.namespace) {
      throw new Error(`${what} is not available for user Workers in a dispatch namespace`);
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init: { headers?: Record<string, string>; raw?: BodyInit; auth?: string } = {},
  ): Promise<{ result: T; info?: Envelope<T>["result_info"] }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${init.auth ?? this.token}`,
      ...init.headers,
    };
    let payload: BodyInit | undefined = init.raw;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers,
      body: payload,
    });
    const text = await response.text();
    // A success with no body at all: 204 No Content, as detaching a Workers Custom Domain answers
    // (the first real run of stage 66 step 8's `cos client remove`, staging check 46022687687),
    // or a DELETE's empty 2xx. Nothing to read. Any other empty answer still fails: a read that
    // came back with nothing is an error, not an empty result.
    if (response.ok && text.trim() === "" && (response.status === 204 || method === "DELETE")) {
      return { result: undefined as T };
    }
    let envelope: Envelope<T> | null = null;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      envelope = null;
    }
    // A DELETE's documented 200 body is not always the envelope: a custom hostname's is `{id}`
    // alone, a DNS record's `{result: {id}}` (their API reference). A 2xx DELETE whose body says
    // nothing of success or errors is a success; its `result`, or the body itself, is the result.
    if (
      response.ok &&
      method === "DELETE" &&
      envelope &&
      typeof envelope === "object" &&
      envelope.success === undefined &&
      !envelope.errors?.length
    ) {
      return { result: ("result" in envelope ? envelope.result : envelope) as T };
    }
    if (!response.ok || !envelope?.success) {
      const errors = envelope?.errors ?? [];
      const detail = errors.map((e) => `${e.code}: ${e.message}`).join("; ") || response.statusText;
      throw new CloudflareApiError(
        `${method} ${path.replace(/\?.*$/, "")} failed (HTTP ${response.status}): ${detail}`,
        response.status,
        errors.map((e) => e.code),
      );
    }
    return { result: envelope.result, info: envelope.result_info };
  }

  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page < 100; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const { result, info } = await this.request<T[]>(
        "GET",
        `${path}${sep}page=${page}&per_page=50`,
      );
      out.push(...result);
      // Some listings (Workflows) give `total_count` and no `total_pages` (their API reference):
      // page until it is reached. With neither, one page, as before.
      const pages =
        info?.total_pages ??
        (info?.total_count !== undefined ? Math.ceil(info.total_count / 50) : undefined);
      if (result.length === 0 || pages === undefined || page >= pages) break;
    }
    return out;
  }

  // ---- Token, accounts, zones ---------------------------------------------------------------

  /** Verifies the token (user-owned, then account-owned). Returns its status. */
  async verifyToken(accountId?: string): Promise<{ id: string; status: string }> {
    try {
      return (await this.request<{ id: string; status: string }>("GET", "/user/tokens/verify"))
        .result;
    } catch (error) {
      if (!accountId) throw error;
      return (
        await this.request<{ id: string; status: string }>(
          "GET",
          `/accounts/${accountId}/tokens/verify`,
        )
      ).result;
    }
  }

  listAccounts() {
    return this.all<{ id: string; name: string }>("/accounts");
  }

  listZones(accountId: string) {
    return this.all<{ id: string; name: string; status: string }>(
      `/zones?account.id=${encodeURIComponent(accountId)}&status=active`,
    );
  }

  async workersSubdomain(accountId: string): Promise<string | null> {
    const found = await unless404(
      this.request<{ subdomain: string }>("GET", `/accounts/${accountId}/workers/subdomain`),
    );
    return found ? found.result.subdomain : null;
  }

  async createWorkersSubdomain(accountId: string, subdomain: string) {
    return (
      await this.request<{ subdomain: string }>("PUT", `/accounts/${accountId}/workers/subdomain`, {
        subdomain,
      })
    ).result.subdomain;
  }

  // ---- Storage resources ----------------------------------------------------------------------

  async listD1(accountId: string) {
    return (
      await this.request<{ uuid: string; name: string }[]>(
        "GET",
        `/accounts/${accountId}/d1/database?per_page=10000`,
      )
    ).result;
  }

  /**
   * Creates a database. A location hint (ADR 0580) is sent as `primary_location_hint`, the D1
   * create API's field; Cloudflare honours it only at creation, and best effort.
   */
  async createD1(accountId: string, name: string, options: { locationHint?: LocationHint } = {}) {
    return (
      await this.request<{ uuid: string; name: string }>(
        "POST",
        `/accounts/${accountId}/d1/database`,
        {
          name,
          ...(options.locationHint ? { primary_location_hint: options.locationHint } : {}),
        },
      )
    ).result;
  }

  async deleteD1(accountId: string, id: string) {
    await this.request("DELETE", `/accounts/${accountId}/d1/database/${id}`);
  }

  /** Runs SQL (several `;`-separated statements run as one batch). */
  async queryD1<Row = Record<string, unknown>>(
    accountId: string,
    databaseId: string,
    sql: string,
    params: (string | number | null)[] = [],
  ): Promise<{ results: Row[] }[]> {
    return (
      await this.request<{ results: Row[] }[]>(
        "POST",
        `/accounts/${accountId}/d1/database/${databaseId}/query`,
        { sql, params },
      )
    ).result;
  }

  /** The current D1 Time Travel bookmark. */
  async d1Bookmark(accountId: string, databaseId: string): Promise<string> {
    return (
      await this.request<{ bookmark: string }>(
        "GET",
        `/accounts/${accountId}/d1/database/${databaseId}/time_travel/bookmark`,
      )
    ).result.bookmark;
  }

  /** Restores a database to a bookmark, in place. Returns the bookmark that undoes it. */
  async d1Restore(accountId: string, databaseId: string, bookmark: string) {
    return (
      await this.request<{ bookmark: string; previous_bookmark: string }>(
        "POST",
        `/accounts/${accountId}/d1/database/${databaseId}/time_travel/restore?bookmark=${encodeURIComponent(bookmark)}`,
      )
    ).result;
  }

  async listR2(accountId: string) {
    return (
      await this.request<{ buckets: { name: string }[] }>(
        "GET",
        `/accounts/${accountId}/r2/buckets?per_page=1000`,
      )
    ).result.buckets;
  }

  /**
   * Creates a bucket. A location hint (ADR 0580) is sent as `locationHint`, the R2 create API's
   * field; Cloudflare honours it only the first time a bucket of that name is created, best effort.
   */
  async createR2(accountId: string, name: string, options: { locationHint?: LocationHint } = {}) {
    await this.request("POST", `/accounts/${accountId}/r2/buckets`, {
      name,
      ...(options.locationHint ? { locationHint: options.locationHint } : {}),
    });
  }

  async deleteR2(accountId: string, name: string) {
    await this.request("DELETE", `/accounts/${accountId}/r2/buckets/${name}`);
  }

  /** One page of a bucket's object keys, and the cursor of the next (null at the end). */
  async listR2Objects(
    accountId: string,
    bucket: string,
    cursor: string | null = null,
  ): Promise<{ keys: string[]; cursor: string | null }> {
    const { result, info } = await this.request<{ key: string }[]>(
      "GET",
      `/accounts/${accountId}/r2/buckets/${bucket}/objects?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    return {
      keys: result.map((o) => o.key),
      cursor: info?.is_truncated && info.cursor ? info.cursor : null,
    };
  }

  async deleteR2Object(accountId: string, bucket: string, key: string) {
    await this.request(
      "DELETE",
      `/accounts/${accountId}/r2/buckets/${bucket}/objects/${key.split("/").map(encodeURIComponent).join("/")}`,
    );
  }

  listKv(accountId: string) {
    return this.all<{ id: string; title: string }>(`/accounts/${accountId}/storage/kv/namespaces`);
  }

  async createKv(accountId: string, title: string) {
    return (
      await this.request<{ id: string; title: string }>(
        "POST",
        `/accounts/${accountId}/storage/kv/namespaces`,
        { title },
      )
    ).result;
  }

  async deleteKv(accountId: string, id: string) {
    await this.request("DELETE", `/accounts/${accountId}/storage/kv/namespaces/${id}`);
  }

  listQueues(accountId: string) {
    return this.all<{
      queue_id: string;
      queue_name: string;
      consumers?: { consumer_id?: string; script_name?: string; script?: string }[];
    }>(`/accounts/${accountId}/queues`);
  }

  async createQueue(accountId: string, name: string) {
    return (
      await this.request<{ queue_id: string; queue_name: string }>(
        "POST",
        `/accounts/${accountId}/queues`,
        { queue_name: name },
      )
    ).result;
  }

  async deleteQueue(accountId: string, id: string) {
    await this.request("DELETE", `/accounts/${accountId}/queues/${id}`);
  }

  /** A queue's consumers: each a Worker that consumes it, with its dead-letter queue if any. */
  async listQueueConsumers(accountId: string, queueId: string) {
    return (
      await this.request<
        {
          consumer_id: string;
          script?: string;
          script_name?: string;
          dead_letter_queue?: string;
        }[]
      >("GET", `/accounts/${accountId}/queues/${queueId}/consumers`)
    ).result;
  }

  /**
   * Removes one consumer of a queue. Cloudflare deletes neither a Worker that consumes a queue
   * (10064) nor a queue that is a consumer's dead-letter queue (11005) until this is done.
   */
  async deleteQueueConsumer(accountId: string, queueId: string, consumerId: string) {
    await this.request(
      "DELETE",
      `/accounts/${accountId}/queues/${queueId}/consumers/${consumerId}`,
    );
  }

  /**
   * Before Workers and queues are deleted: removes every consumer of each named queue (the
   * Workers consuming them, and the dead-letter links on those consumers). Returns what it
   * removed; a queue that is gone already is skipped.
   */
  async unconsumeQueues(accountId: string, queueNames: Iterable<string>) {
    const wanted = new Set(queueNames);
    const removed: { queue: string; consumer: string }[] = [];
    for (const queue of await this.listQueues(accountId)) {
      if (!wanted.has(queue.queue_name)) continue;
      for (const consumer of await this.listQueueConsumers(accountId, queue.queue_id)) {
        await this.deleteQueueConsumer(accountId, queue.queue_id, consumer.consumer_id);
        removed.push({
          queue: queue.queue_name,
          consumer: consumer.script_name ?? consumer.script ?? consumer.consumer_id,
        });
      }
    }
    return removed;
  }

  async putQueueConsumer(
    accountId: string,
    queueId: string,
    scriptName: string,
    settings: Record<string, unknown>,
    existingConsumerId?: string,
    deadLetterQueue?: string,
  ) {
    const body = {
      type: "worker",
      script_name: scriptName,
      settings,
      ...(deadLetterQueue ? { dead_letter_queue: deadLetterQueue } : {}),
    };
    if (existingConsumerId) {
      await this.request(
        "PUT",
        `/accounts/${accountId}/queues/${queueId}/consumers/${existingConsumerId}`,
        body,
      );
    } else {
      await this.request("POST", `/accounts/${accountId}/queues/${queueId}/consumers`, body);
    }
  }

  async listVectorize(accountId: string) {
    return (
      await this.request<{ name: string }[]>("GET", `/accounts/${accountId}/vectorize/v2/indexes`)
    ).result;
  }

  async createVectorize(accountId: string, name: string, config: Record<string, unknown>) {
    await this.request("POST", `/accounts/${accountId}/vectorize/v2/indexes`, { name, config });
  }

  async listVectorizeMetadataIndexes(accountId: string, index: string) {
    return (
      (
        await this.request<{ metadataIndexes?: { propertyName: string; indexType: string }[] }>(
          "GET",
          `/accounts/${accountId}/vectorize/v2/indexes/${index}/metadata_index/list`,
        )
      ).result.metadataIndexes ?? []
    );
  }

  /** Metadata indexes make a property filterable; create them before inserting vectors. */
  async createVectorizeMetadataIndex(
    accountId: string,
    index: string,
    propertyName: string,
    indexType: "string" | "number" | "boolean",
  ) {
    await this.request(
      "POST",
      `/accounts/${accountId}/vectorize/v2/indexes/${index}/metadata_index/create`,
      { propertyName, indexType },
    );
  }

  async deleteVectorize(accountId: string, name: string) {
    await this.request("DELETE", `/accounts/${accountId}/vectorize/v2/indexes/${name}`);
  }

  // ---- Workers --------------------------------------------------------------------------------

  async listScripts(accountId: string): Promise<ScriptInfo[]> {
    // A namespace lists `{ script: {…} }` entries; the account lists scripts directly.
    const { result } = await this.request<(ScriptInfo & { script?: ScriptInfo })[]>(
      "GET",
      this.scripts(accountId),
    );
    return result.map((entry) => entry.script ?? entry);
  }

  private form(metadata: Record<string, unknown>, modules: ModulePart[]): FormData {
    const form = new FormData();
    form.set(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      "metadata.json",
    );
    for (const module of modules) {
      form.set(
        module.name,
        new Blob([module.bytes as Uint8Array<ArrayBuffer>], { type: CONTENT_TYPES[module.type] }),
        module.name,
      );
    }
    return form;
  }

  /** Uploads and deploys a script (needed for a first deploy and for Durable Object migrations). */
  async putScript(
    accountId: string,
    name: string,
    metadata: Record<string, unknown>,
    modules: ModulePart[],
  ) {
    return (
      await this.request<{ id: string; migration_tag?: string }>(
        "PUT",
        `${this.scripts(accountId)}/${name}`,
        undefined,
        { raw: this.form(metadata, modules) },
      )
    ).result;
  }

  /** Uploads a version without moving traffic to it. */
  async uploadVersion(
    accountId: string,
    name: string,
    metadata: Record<string, unknown>,
    modules: ModulePart[],
  ): Promise<string> {
    this.accountOnly("Worker versions");
    return (
      await this.request<{ id: string }>(
        "POST",
        `${this.scripts(accountId)}/${name}/versions`,
        undefined,
        { raw: this.form(metadata, modules) },
      )
    ).result.id;
  }

  /** Sends 100% of traffic to a version. */
  async deployVersion(accountId: string, name: string, versionId: string, message?: string) {
    this.accountOnly("Worker deployments");
    await this.request("POST", `${this.scripts(accountId)}/${name}/deployments`, {
      strategy: "percentage",
      versions: [{ version_id: versionId, percentage: 100 }],
      ...(message ? { annotations: { "workers/message": message } } : {}),
    });
  }

  async deleteScript(accountId: string, name: string) {
    await this.request("DELETE", `${this.scripts(accountId)}/${name}?force=true`);
  }

  // ---- Workers for Platforms (ADR 0210) -------------------------------------------------------

  async getDispatchNamespace(accountId: string, name: string): Promise<{ name: string } | null> {
    const found = await unless404(
      this.request<{ namespace_name: string }>(
        "GET",
        `/accounts/${accountId}/workers/dispatch/namespaces/${encodeURIComponent(name)}`,
      ),
    );
    return found?.result ? { name } : null;
  }

  async createDispatchNamespace(accountId: string, name: string) {
    await this.request("POST", `/accounts/${accountId}/workers/dispatch/namespaces`, { name });
  }

  /** Deletes every user Worker in this client's namespace carrying `tag` (one tenant's Workers). */
  async deleteScriptsByTag(accountId: string, tag: string) {
    if (!this.namespace) throw new Error("deleting scripts by tag needs a dispatch namespace");
    await this.request(
      "DELETE",
      `${this.scripts(accountId)}?tags=${encodeURIComponent(`${tag}:yes`)}`,
    );
  }

  // ---- Cloudflare for SaaS custom hostnames (enterprise, ADR 0210) ---------------------------

  async customHostname(
    zoneId: string,
    hostname: string,
  ): Promise<{ id: string; status: string } | null> {
    const { result } = await this.request<{ id: string; hostname: string; status: string }[]>(
      "GET",
      `/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
    );
    const found = result.find((h) => h.hostname === hostname);
    return found ? { id: found.id, status: found.status } : null;
  }

  async createCustomHostname(zoneId: string, hostname: string) {
    return (
      await this.request<{ id: string; status: string }>(
        "POST",
        `/zones/${zoneId}/custom_hostnames`,
        { hostname, ssl: { method: "http", type: "dv" } },
      )
    ).result;
  }

  /**
   * A client's own domain on a host of many clients (stage 66 step 8, ADR 0619): a custom
   * hostname validated in real time (it turns active once the client's CNAME to the fleet's
   * target exists) with an HTTP-validated certificate, so it works for a client whose zone is
   * itself on Cloudflare, where pre-validation by TXT is not supported.
   */
  async createCustomHostnameForCname(zoneId: string, hostname: string): Promise<CustomHostname> {
    return saasCall(
      async () =>
        (
          await this.request<CustomHostname>("POST", `/zones/${zoneId}/custom_hostnames`, {
            hostname,
            ssl: { method: "http", type: "dv" },
          })
        ).result,
    );
  }

  /**
   * A custom hostname whole (status, certificate), or null. The documented `hostname.exact`
   * filter, every page read, and only an exact match counts (a filter not applied lists them all).
   */
  async findCustomHostname(zoneId: string, hostname: string): Promise<CustomHostname | null> {
    const all = await saasCall(() =>
      this.all<CustomHostname>(
        `/zones/${zoneId}/custom_hostnames?hostname.exact=${encodeURIComponent(hostname)}`,
      ),
    );
    return all.find((h) => h.hostname === hostname) ?? null;
  }

  async deleteCustomHostname(zoneId: string, id: string) {
    await saasCall(() =>
      unless404(this.request("DELETE", `/zones/${zoneId}/custom_hostnames/${id}`)),
    );
  }

  /**
   * Whether the zone has Cloudflare for SaaS (custom hostnames): false when Cloudflare answers
   * 1456 ("This feature is available with SSL for SaaS") or 1404 ("No quota has been allocated"),
   * as a Free zone that has not enabled it does (stage 66 step 8, the fleet's zone, 2026-11-27).
   */
  async saasEnabled(zoneId: string): Promise<boolean> {
    try {
      await this.request("GET", `/zones/${zoneId}/custom_hostnames?per_page=5`);
      return true;
    } catch (error) {
      if (isSaasNotEnabled(error)) return false;
      throw error;
    }
  }

  /** The zone's Cloudflare for SaaS fallback origin, or null when none is set. */
  async getFallbackOrigin(zoneId: string): Promise<string | null> {
    const found = await saasCall(() =>
      unless404(
        this.request<{ origin?: string } | null>(
          "GET",
          `/zones/${zoneId}/custom_hostnames/fallback_origin`,
        ),
      ),
    );
    return found?.result?.origin ?? null;
  }

  /** The zone's Cloudflare for SaaS fallback origin: where custom hostnames' traffic is sent. */
  async putFallbackOrigin(zoneId: string, origin: string) {
    await saasCall(() =>
      this.request("PUT", `/zones/${zoneId}/custom_hostnames/fallback_origin`, { origin }),
    );
  }

  /** Removes the zone's fallback origin (the staging check's own, at its teardown). */
  async deleteFallbackOrigin(zoneId: string) {
    await saasCall(() =>
      unless404(this.request("DELETE", `/zones/${zoneId}/custom_hostnames/fallback_origin`)),
    );
  }

  // ---- Workers routes and DNS records (stage 66 step 8) ---------------------------------------

  listRoutes(zoneId: string) {
    return this.request<{ id: string; pattern: string; script?: string }[]>(
      "GET",
      `/zones/${zoneId}/workers/routes`,
    ).then((r) => r.result);
  }

  /**
   * Puts `pattern` on `script`, made once. A route of that pattern for another Worker is never
   * re-pointed: it is another deployment's (a live fleet's beside a staging one on one zone) or
   * someone's own, and `RouteTakenError` says whose.
   */
  async putRoute(zoneId: string, pattern: string, script: string) {
    const existing = (await this.listRoutes(zoneId)).find((r) => r.pattern === pattern);
    if (existing) {
      if (existing.script === script) return;
      throw new RouteTakenError(pattern, existing.script ?? null);
    }
    await this.request("POST", `/zones/${zoneId}/workers/routes`, { pattern, script });
  }

  /** Removes the route of `pattern`, only when it is `script`'s (another Worker's is kept). */
  async deleteRoute(zoneId: string, pattern: string, script: string): Promise<boolean> {
    const existing = (await this.listRoutes(zoneId)).find((r) => r.pattern === pattern);
    if (!existing || existing.script !== script) return false;
    await unless404(this.request("DELETE", `/zones/${zoneId}/workers/routes/${existing.id}`));
    return true;
  }

  /**
   * The DNS records of exactly `name`: the documented `name.exact` filter (case-insensitive),
   * every page read, and only that name kept (a filter not applied lists the whole zone).
   */
  async listDnsRecords(zoneId: string, name: string) {
    const all = await this.all<{
      id: string;
      type: string;
      name: string;
      content: string;
      proxied?: boolean;
    }>(`/zones/${zoneId}/dns_records?name.exact=${encodeURIComponent(name)}`);
    return all.filter((r) => r.name.toLowerCase() === name.toLowerCase());
  }

  /** Every DNS record of a zone (the staging check's inventory). */
  listAllDnsRecords(zoneId: string) {
    return this.all<{ id: string; type: string; name: string; content: string }>(
      `/zones/${zoneId}/dns_records`,
    );
  }

  /** A DNS record as given (the staging check writes a client's own records with it). */
  async createDnsRecord(
    zoneId: string,
    record: { type: string; name: string; content: string; proxied?: boolean; ttl?: number },
  ) {
    return (await this.request<{ id: string }>("POST", `/zones/${zoneId}/dns_records`, record))
      .result;
  }

  async deleteDnsRecord(zoneId: string, id: string) {
    await unless404(this.request("DELETE", `/zones/${zoneId}/dns_records/${id}`));
  }

  /** Every custom hostname of a zone. */
  listCustomHostnames(zoneId: string) {
    return saasCall(() => this.all<CustomHostname>(`/zones/${zoneId}/custom_hostnames`));
  }

  /**
   * A proxied `AAAA 100::` record for `name` (the documented placeholder for a hostname a Worker
   * answers), made once: an existing record of that name is left as it is.
   */
  async ensureProxiedPlaceholder(zoneId: string, name: string): Promise<"made" | "there"> {
    if ((await this.listDnsRecords(zoneId, name)).length) return "there";
    await this.request("POST", `/zones/${zoneId}/dns_records`, {
      type: "AAAA",
      name,
      content: "100::",
      proxied: true,
      comment: "Composable OS fleet (stage 66): answered by a Worker",
    });
    return "made";
  }

  // ---- AI Gateway logs (metering, ADR 0213) --------------------------------------------------

  /**
   * One page (≤ 50) of a gateway's logs created in [from, to), oldest first, with the fields
   * metering needs. `cost` is AI Gateway's estimate in US dollars. `metadataValue` keeps only
   * logs with that value in their `cf-aig-metadata` (the shared platform gateway's tenant tag,
   * ADR 0213 amendment); `metadata` is the JSON string AI Gateway stores.
   */
  async gatewayLogs(
    accountId: string,
    gatewayId: string,
    window: { from: string; to: string; page: number; metadataValue?: string },
  ) {
    const filters = JSON.stringify([
      { key: "created_at", operator: "gt", value: [window.from] },
      { key: "created_at", operator: "lt", value: [window.to] },
      ...(window.metadataValue
        ? [{ key: "metadata.value", operator: "eq", value: [window.metadataValue] }]
        : []),
    ]);
    const { result, info } = await this.request<
      {
        id: string;
        provider: string;
        model: string;
        cost?: number | null;
        cached?: boolean;
        metadata?: string | null;
      }[]
    >(
      "GET",
      `/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/logs?per_page=50&page=${window.page}&order_by=created_at&order_by_direction=asc&filters=${encodeURIComponent(filters)}`,
    );
    return { logs: result, totalPages: info?.total_pages ?? 1 };
  }

  async listSecrets(accountId: string, name: string): Promise<string[]> {
    return (
      await this.request<{ name: string }[]>("GET", `${this.scripts(accountId)}/${name}/secrets`)
    ).result.map((s) => s.name);
  }

  async putSecret(accountId: string, name: string, secret: string, value: string) {
    await this.request("PUT", `${this.scripts(accountId)}/${name}/secrets`, {
      name: secret,
      text: value,
      type: "secret_text",
    });
  }

  /** Removes a secret from a Worker (a user Worker with `forNamespace`). Missing is not an error. */
  async deleteSecret(accountId: string, name: string, secret: string) {
    await unless404(
      this.request(
        "DELETE",
        `${this.scripts(accountId)}/${name}/secrets/${encodeURIComponent(secret)}`,
      ),
    );
  }

  async putSchedules(accountId: string, name: string, crons: string[]) {
    this.accountOnly("Cron Triggers");
    await this.request(
      "PUT",
      `${this.scripts(accountId)}/${name}/schedules`,
      crons.map((cron) => ({ cron })),
    );
  }

  async setWorkersDev(accountId: string, name: string, enabled: boolean) {
    this.accountOnly("workers.dev");
    await this.request("POST", `${this.scripts(accountId)}/${name}/subdomain`, {
      enabled,
      previews_enabled: false,
    });
  }

  async putDomain(accountId: string, hostname: string, service: string, zoneId: string) {
    await this.request("PUT", `/accounts/${accountId}/workers/domains`, {
      hostname,
      service,
      zone_id: zoneId,
      environment: "production",
    });
  }

  /**
   * The account's Workers Custom Domains: each hostname and the Worker it serves. The listing has
   * `result_info` but documents no `page` parameter: a page repeated by an API that ignores it is
   * not counted twice.
   */
  async listDomains(accountId: string) {
    const all = await this.all<{ id: string; hostname: string; service: string; zone_id: string }>(
      `/accounts/${accountId}/workers/domains`,
    );
    return [...new Map(all.map((d) => [d.id, d])).values()];
  }

  /**
   * Detaches a Custom Domain (Cloudflare removes the DNS record and certificate it made). It
   * answers 204 with no body; one already detached (404) is gone, so a re-run converges.
   */
  async deleteDomain(accountId: string, id: string) {
    await unless404(this.request("DELETE", `/accounts/${accountId}/workers/domains/${id}`));
  }

  /** The account's Durable Object namespaces, each with the Worker that defines its class. */
  listDurableObjectNamespaces(accountId: string) {
    return this.all<{ id: string; name: string; script?: string; class?: string }>(
      `/accounts/${accountId}/workers/durable_objects/namespaces`,
    );
  }

  /** A Worker's deployed bindings (a plain var with its text; a secret by name only). */
  async scriptBindings(accountId: string, name: string) {
    return (
      await this.request<{ bindings: { type: string; name: string; text?: string }[] }>(
        "GET",
        `${this.scripts(accountId)}/${name}/settings`,
      )
    ).result.bindings;
  }

  // ---- Workflows ------------------------------------------------------------------------------

  listWorkflows(accountId: string) {
    return this.all<{ id: string; name: string }>(`/accounts/${accountId}/workflows`);
  }

  /**
   * Creates or updates a Workflow (`PUT /accounts/{id}/workflows/{name}`): uploading the Worker
   * that exports its class does not create it. Wrangler makes this call after each deploy
   * (workers-sdk `triggersDeploy`); the deploy engine does the same.
   */
  async putWorkflow(
    accountId: string,
    name: string,
    definition: { class_name: string; script_name: string },
  ) {
    await this.request(
      "PUT",
      `/accounts/${accountId}/workflows/${encodeURIComponent(name)}`,
      definition,
    );
  }

  async deleteWorkflow(accountId: string, name: string) {
    await this.request("DELETE", `/accounts/${accountId}/workflows/${encodeURIComponent(name)}`);
  }

  // ---- AI Gateway (ADR 0180) -----------------------------------------------------------------

  /** The account's gateways (their ids). Needs AI Gateway Read or Edit. */
  listAiGateways(accountId: string) {
    return this.all<{ id: string }>(`/accounts/${accountId}/ai-gateway/gateways`);
  }

  /** A gateway by id, or null when there is none. Needs AI Gateway Read or Edit. */
  async getAiGateway(accountId: string, id: string): Promise<AiGateway | null> {
    const found = await unless404(
      this.request<AiGateway>("GET", `/accounts/${accountId}/ai-gateway/gateways/${id}`),
    );
    return found ? found.result : null;
  }

  async createAiGateway(accountId: string, settings: Record<string, unknown> & { id: string }) {
    return (
      await this.request<AiGateway>("POST", `/accounts/${accountId}/ai-gateway/gateways`, settings)
    ).result;
  }

  /** Replaces a gateway's settings (send them all: omitted ones fall back to defaults). */
  async updateAiGateway(accountId: string, id: string, settings: Record<string, unknown>) {
    return (
      await this.request<AiGateway>(
        "PUT",
        `/accounts/${accountId}/ai-gateway/gateways/${id}`,
        settings,
      )
    ).result;
  }

  async deleteAiGateway(accountId: string, id: string) {
    await this.request("DELETE", `/accounts/${accountId}/ai-gateway/gateways/${id}`);
  }

  /** The account's custom providers (account-wide, shared by every gateway). */
  listCustomProviders(accountId: string) {
    return this.all<CustomProviderInfo>(`/accounts/${accountId}/ai-gateway/custom-providers`);
  }

  async createCustomProvider(accountId: string, provider: Record<string, unknown>) {
    return (
      await this.request<CustomProviderInfo>(
        "POST",
        `/accounts/${accountId}/ai-gateway/custom-providers`,
        provider,
      )
    ).result;
  }

  async updateCustomProvider(accountId: string, id: string, changes: Record<string, unknown>) {
    return (
      await this.request<CustomProviderInfo>(
        "PATCH",
        `/accounts/${accountId}/ai-gateway/custom-providers/${id}`,
        changes,
      )
    ).result;
  }

  /** A gateway's stored provider keys (BYOK); only previews of the keys come back. */
  async listProviderConfigs(accountId: string, gatewayId: string) {
    return (
      await this.request<ProviderConfigInfo[]>(
        "GET",
        `/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/provider_configs`,
      )
    ).result;
  }

  async deleteProviderConfig(accountId: string, gatewayId: string, id: string) {
    await this.request(
      "DELETE",
      `/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/provider_configs/${id}`,
    );
  }

  listSecretsStores(accountId: string) {
    return this.all<{ id: string; name: string }>(`/accounts/${accountId}/secrets_store/stores`);
  }

  async createSecretsStore(accountId: string, name: string) {
    return (
      await this.request<{ id: string; name: string }>(
        "POST",
        `/accounts/${accountId}/secrets_store/stores`,
        { name },
      )
    ).result;
  }

  /**
   * Stores a provider key in a gateway as BYOK (the `default` alias), replacing any key already
   * stored for that provider. `provider` is the gateway's provider slug: a built-in one
   * (`openai`, `google-ai-studio`, …) or `custom-<slug>` for a custom provider. The key goes in
   * the request body only: it is never logged, returned or put in an error message.
   *
   * The key lands in the Secrets Store the gateway uses; a gateway without one is pointed at the
   * account's store (created if the account has none). Needs AI Gateway Edit and Secrets Store
   * Write. Used by `create-composable-os --provider-key` and meant for Settings → AI.
   */
  async setGatewayProviderKey(
    accountId: string,
    gatewayId: string,
    provider: string,
    key: string,
  ): Promise<{ provider: string; alias: string }> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) throw new Error(`bad provider slug ${provider}`);
    if (!key.trim()) throw new Error("the provider key is empty");
    const gateway = await this.getAiGateway(accountId, gatewayId);
    if (!gateway) throw new Error(`AI Gateway ${gatewayId} does not exist`);
    if (!gateway.store_id) {
      const store =
        (await this.listSecretsStores(accountId))[0] ??
        (await this.createSecretsStore(accountId, "default_secrets_store"));
      await this.updateAiGateway(accountId, gatewayId, {
        ...gatewaySettingsOf(gateway),
        store_id: store.id,
      });
    }
    const alias = "default";
    for (const config of await this.listProviderConfigs(accountId, gatewayId)) {
      // One key per provider and alias: replace, since provider configs cannot be updated.
      if (config.provider_slug === provider && config.alias === alias) {
        await this.deleteProviderConfig(accountId, gatewayId, config.id);
      }
    }
    await this.request(
      "POST",
      `/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/provider_configs`,
      { provider_slug: provider, alias, default_config: true, secret: key },
    );
    return { provider, alias };
  }

  // ---- Account API tokens ---------------------------------------------------------------------

  /** Permission groups an account token can be given, by exact name. Needs Account API Tokens Read. */
  async permissionGroups(accountId: string, name: string) {
    return (
      await this.request<{ id: string; name: string; scopes?: string[] }[]>(
        "GET",
        `/accounts/${accountId}/tokens/permission_groups?name=${encodeURIComponent(name)}`,
      )
    ).result.filter((g) => g.name === name);
  }

  /**
   * Checks that `token` can call Workers AI in the account (ADR 0330): lists one model of the
   * catalogue, which needs Workers AI Read. Throws (CloudflareApiError 401/403) when it cannot.
   * The token is sent only to the Cloudflare API, and never logged.
   */
  async probeWorkersAi(accountId: string, token: string): Promise<void> {
    await this.request("GET", `/accounts/${accountId}/ai/models/search?per_page=1`, undefined, {
      auth: token,
    });
  }

  /** Creates an account-owned API token. Returns its id and value (shown once). */
  async createAccountToken(
    accountId: string,
    name: string,
    permissionGroupIds: string[],
    options: {
      /** Narrower resources than the whole account (e.g. one R2 bucket). */
      resources?: Record<string, string>;
      /** ISO time the token stops working. */
      expiresOn?: string;
    } = {},
  ): Promise<{ id: string; value: string }> {
    const { result } = await this.request<{ id: string; value: string }>(
      "POST",
      `/accounts/${accountId}/tokens`,
      {
        name,
        ...(options.expiresOn ? { expires_on: options.expiresOn } : {}),
        policies: [
          {
            effect: "allow",
            resources: options.resources ?? { [`com.cloudflare.api.account.${accountId}`]: "*" },
            permission_groups: permissionGroupIds.map((id) => ({ id })),
          },
        ],
      },
    );
    return { id: result.id, value: result.value };
  }

  /**
   * A full SQL dump of a D1 database (the export API, polled until done). Returns the
   * Cloudflare-hosted, time-limited download URL: the dump never passes through the caller.
   */
  async exportD1(accountId: string, databaseId: string): Promise<string> {
    let bookmark: string | undefined;
    for (let i = 0; i < 30; i++) {
      const { result } = await this.request<{
        at_bookmark?: string;
        status?: string;
        error?: string;
        result?: { signed_url?: string };
      }>("POST", `/accounts/${accountId}/d1/database/${databaseId}/export`, {
        output_format: "polling",
        ...(bookmark ? { current_bookmark: bookmark } : {}),
      });
      if (result.status === "error") throw new Error(`D1 export failed: ${result.error ?? ""}`);
      if (result.status === "complete" && result.result?.signed_url)
        return result.result.signed_url;
      bookmark = result.at_bookmark ?? bookmark;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("D1 export did not finish in time");
  }

  async deleteAccountToken(accountId: string, id: string) {
    await this.request("DELETE", `/accounts/${accountId}/tokens/${id}`);
  }

  /** Puts one object in an R2 bucket (the org's extensions, stage 24). */
  async putR2Object(accountId: string, bucket: string, key: string, bytes: Uint8Array) {
    return (
      await this.request<unknown>(
        "PUT",
        `/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
        undefined,
        { raw: bytes as BodyInit, headers: { "content-type": "application/octet-stream" } },
      )
    ).result;
  }

  /**
   * Sets a bucket's object lifecycle rules (stage 66 step 7): the fleet's exports bucket deletes
   * what it keeps after `days` (a removed client's export is kept 90 days).
   */
  async putR2ExpiryRule(accountId: string, bucket: string, id: string, days: number) {
    await this.request("PUT", `/accounts/${accountId}/r2/buckets/${bucket}/lifecycle`, {
      rules: [
        {
          id,
          enabled: true,
          conditions: { prefix: "" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: days * 24 * 60 * 60 } },
        },
      ],
    });
  }

  /**
   * Stamps a Stream video with its creator (stage 66 step 7: an imported client's videos, which
   * the host's video host serves only to the client stamped as their creator). False when the
   * account has no such video (an export from another account carries none).
   */
  /**
   * A Stream video's creator as the account holds it: its stamp, null when it has none, or
   * undefined when the account has no such video (review of #552: an import takes a client only
   * when every video its database names is already that client's; it re-stamps none).
   */
  async streamVideoCreator(accountId: string, uid: string): Promise<string | null | undefined> {
    if (!/^[0-9a-f]{32}$/.test(uid)) throw new Error("Not a Stream video id");
    try {
      const video = await this.request<{ creator?: string | null }>(
        "GET",
        `/accounts/${accountId}/stream/${uid}`,
      );
      const creator = video.result?.creator;
      return typeof creator === "string" && creator ? creator : null;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  // ---- Static assets (direct upload) ----------------------------------------------------------

  /** Starts an assets upload session; returns the JWT and the hashes the API still needs. */
  async assetsUploadSession(
    accountId: string,
    name: string,
    manifest: Record<string, { hash: string; size: number }>,
  ) {
    return (
      await this.request<{ jwt: string; buckets?: string[][] }>(
        "POST",
        `${this.scripts(accountId)}/${name}/assets-upload-session`,
        { manifest },
      )
    ).result;
  }

  /** Uploads one bucket of assets (base64 parts named by hash). Returns the completion JWT, if any. */
  async uploadAssets(
    accountId: string,
    jwt: string,
    files: { hash: string; base64: string; contentType: string }[],
  ): Promise<string | undefined> {
    const form = new FormData();
    for (const file of files) {
      form.set(file.hash, new Blob([file.base64], { type: file.contentType }), file.hash);
    }
    const { result } = await this.request<{ jwt?: string } | null>(
      "POST",
      `/accounts/${accountId}/workers/assets/upload?base64=true`,
      undefined,
      { raw: form, auth: jwt },
    );
    return result?.jwt;
  }
}
