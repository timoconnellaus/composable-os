// A fake Cloudflare REST API for tests of the CLI and the self-updater (ADR 0163). It keeps
// in-memory accounts, D1 databases (SQL runs on an injected engine), R2, KV, queues, Vectorize,
// Worker scripts with versions and deployments, secrets, schedules, assets upload sessions,
// Time Travel bookmarks, AI Gateways with custom providers and BYOK provider keys, Secrets Store
// stores and account API tokens. It answers `fetch(Request)`, so it can be passed to the client directly
// or served over HTTP (packages/create-composable-os/test).
//
// It is strict where the real API is: unknown routes 404, a Durable Object migration must carry
// the right old_tag, a version upload cannot carry migrations, and bearer tokens must match.

import { isLocationHint } from "@composable-os/product";

export interface SqlEngine {
  /** Runs SQL. Multi-statement SQL without params runs atomically. Returns one result set. */
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  /** An opaque bookmark of the current state. */
  bookmark(): Promise<string>;
  restore(bookmark: string): Promise<void>;
}

interface FakeScript {
  name: string;
  migrationTag?: string;
  versions: {
    id: string;
    metadata: Record<string, unknown>;
    modules: string[];
    /** Module source text by name, so a fake dispatch namespace can run the Worker. */
    sources: Record<string, string>;
  }[];
  current?: string;
  secrets: Map<string, string>;
  schedules: string[];
  workersDev: boolean;
  bindings: Record<string, unknown>[];
  /** Script tags (Workers for Platforms user Workers). */
  tags?: string[];
}

/** One AI Gateway log entry, as the fake serves it (the fields metering reads). */
export interface FakeGatewayLog {
  id: string;
  created_at: string;
  provider: string;
  model: string;
  cost: number | null;
  cached?: boolean;
  /** The request's `cf-aig-metadata`, as the JSON string AI Gateway stores. */
  metadata?: string;
}

export interface FakeCloudflareOptions {
  token: string;
  accountId: string;
  accountName?: string;
  subdomain?: string | null;
  zones?: { id: string; name: string }[];
  sql: () => SqlEngine;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown, info?: unknown) =>
  json(200, {
    success: true,
    errors: [],
    messages: [],
    result,
    ...(info ? { result_info: info } : {}),
  });
const fail = (status: number, code: number, message: string) =>
  json(status, { success: false, errors: [{ code, message }], messages: [], result: null });

export class FakeCloudflare {
  readonly accountId: string;
  readonly calls: { method: string; path: string }[] = [];
  readonly d1 = new Map<string, { name: string; engine: SqlEngine }>();
  readonly r2 = new Set<string>();
  /**
   * Every D1 and R2 create, with the location hint it carried (`primary_location_hint` for D1,
   * `locationHint` for R2, ADR 0580), or undefined when it carried none. A hint the real API
   * would refuse is refused here too.
   */
  readonly creates: { type: "d1" | "r2"; name: string; locationHint: string | undefined }[] = [];
  /** R2 objects by `<bucket>/<key>` (the object upload API, stage 24). */
  readonly r2Objects = new Map<string, Uint8Array>();
  /** Each bucket's lifecycle rules, as last put (stage 66 step 7: the exports bucket's expiry). */
  readonly r2Lifecycle = new Map<string, unknown>();
  /** Stream videos the account holds, by uid, with their creator (stage 66 step 7). */
  readonly streamCreators = new Map<string, string | null>();
  readonly kv = new Map<string, string>();
  readonly queues = new Map<
    string,
    {
      name: string;
      consumers: {
        consumer_id: string;
        script_name: string;
        settings: unknown;
        dead_letter_queue?: string | undefined;
      }[];
    }
  >();
  readonly vectorize = new Map<string, Record<string, unknown>>();
  readonly vectorizeMetadata = new Map<string, { propertyName: string; indexType: string }[]>();
  /** Workflows registered by script uploads (a workflow binding without script_name). */
  readonly workflows = new Map<string, { className: string; script: string }>();
  readonly scripts = new Map<string, FakeScript>();
  /**
   * Workers for Platforms dispatch namespaces (ADR 0210), each with its own user Workers. Like the
   * real API, user Workers have no versions, deployments, schedules or workers.dev.
   */
  readonly namespaces = new Map<string, Map<string, FakeScript>>();
  readonly customHostnames: {
    id: string;
    hostname: string;
    status: string;
    ssl?: { method?: string; status: string; validation_records?: unknown[] };
    ownership_verification?: { type: string; name: string; value: string };
    /** The zone it was made on (the control plane's tests make some without). */
    zone_id?: string;
  }[] = [];
  /**
   * Whether a custom hostname turns active on its next read (the control plane's tests, ADR
   * 0210). Off: it stays pending until `activateCustomHostname`, as a real one does until its
   * owner's DNS proves it (stage 66 step 8).
   */
  autoActivateCustomHostnames = true;
  /** Each zone's Cloudflare for SaaS fallback origin. */
  readonly fallbackOrigins = new Map<string, string>();
  /**
   * Zones (by id) where Cloudflare for SaaS is not enabled: their custom hostnames answer 403 with
   * 1404 and their fallback origin 401 with 1456, as the fleet's real Free zone did (2026-11-27).
   */
  readonly saasOff = new Set<string>();
  /** Workers routes on zones. */
  readonly routes: { id: string; zone_id: string; pattern: string; script: string }[] = [];
  /**
   * DNS records on zones. A Workers Custom Domain's own record is `readOnly`: made and removed
   * with the Custom Domain, refused when deleted on its own.
   */
  readonly dnsRecords: {
    id: string;
    zone_id: string;
    type: string;
    name: string;
    content: string;
    proxied: boolean;
    readOnly?: boolean;
  }[] = [];
  /** AI Gateway logs per gateway id, for metering tests (`addGatewayLog`). */
  readonly gatewayLogs = new Map<string, FakeGatewayLog[]>();
  readonly domains: { id?: string; hostname: string; service: string; zone_id: string }[] = [];
  readonly uploadedAssets = new Set<string>();
  /** AI Gateways by id, with their settings. */
  readonly gateways = new Map<string, Record<string, unknown>>();
  /** Account-wide custom providers by id. */
  readonly customProviders = new Map<string, Record<string, unknown>>();
  /** BYOK provider keys per gateway; `secret` holds the stored key (tests check it). */
  readonly providerConfigs = new Map<
    string,
    { id: string; provider_slug: string; alias: string; default_config: boolean; secret: string }[]
  >();
  readonly secretsStores = new Map<string, string>();
  /** Account API tokens created through the API, by id. */
  readonly tokens = new Map<
    string,
    {
      name: string;
      value: string;
      permissionGroups: string[];
      resources?: Record<string, string>;
      expiresOn?: string;
    }
  >();
  /** Tokens not created through the API that can call Workers AI (a supplied gateway token). */
  readonly workersAiTokens = new Set<string>();
  /** Return a Response to fail a call (failure injection), or undefined to let it through. */
  failOn: ((method: string, path: string, body: unknown) => Response | undefined) | null = null;
  subdomain: string | null;
  private readonly options: FakeCloudflareOptions;
  private counter = 0;
  private sessions = new Map<string, { pending: Set<string> }>();

  constructor(options: FakeCloudflareOptions) {
    this.options = options;
    this.accountId = options.accountId;
    this.subdomain = options.subdomain === undefined ? "example" : options.subdomain;
  }

  private id(prefix: string) {
    this.counter += 1;
    return `${prefix}-${this.counter.toString().padStart(6, "0")}`;
  }

  /** A Worker of the account, deployed with no code, for a test that routes to it. */
  addScript(name: string) {
    if (this.scripts.has(name)) return;
    this.scripts.set(name, {
      name,
      versions: [{ id: `v-${name}`, metadata: { bindings: [] }, modules: [], sources: {} }],
      current: `v-${name}`,
      secrets: new Map(),
      schedules: [],
      workersDev: false,
      bindings: [],
    });
  }

  /** What the client's DNS would do: its custom hostname proved, ownership and certificate. */
  activateCustomHostname(hostname: string) {
    const found = this.customHostnames.find((h) => h.hostname === hostname);
    if (!found) throw new Error(`no custom hostname ${hostname}`);
    found.status = "active";
    found.ssl = { ...(found.ssl ?? {}), status: "active" };
  }

  /** The deployed version's metadata of a script (what is live). */
  live(name: string) {
    const script = this.scripts.get(name);
    return script?.versions.find((v) => v.id === script.current);
  }

  /** A user Worker in a dispatch namespace, as uploaded last. */
  userWorker(namespace: string, name: string) {
    const script = this.namespaces.get(namespace)?.get(name);
    const live = script?.versions.find((v) => v.id === script.current);
    return script && live ? { ...live, tags: script.tags, secrets: script.secrets } : undefined;
  }

  addGatewayLog(gateway: string, log: Omit<FakeGatewayLog, "id">) {
    const logs = this.gatewayLogs.get(gateway) ?? [];
    logs.push({ ...log, id: this.id("log") });
    this.gatewayLogs.set(gateway, logs);
  }

  liveBinding(script: string, binding: string) {
    const bindings = (this.live(script)?.metadata.bindings ?? []) as { name: string }[];
    return bindings.find((b) => b.name === binding) as Record<string, unknown> | undefined;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const method = request.method;
    this.calls.push({ method, path });
    const auth = request.headers.get("authorization") ?? "";
    const isAssetUpload = path.endsWith("/workers/assets/upload");
    // Workers AI's catalogue (the installer's probe of a supplied gateway token, ADR 0330): any
    // token with Workers AI Read, a generated one or one a test registered in workersAiTokens.
    if (path === `/accounts/${this.accountId}/ai/models/search` && method === "GET") {
      const value = auth.replace(/^Bearer /, "");
      const generated = [...this.tokens.values()].find((t) => t.value === value);
      const allowed =
        value === this.options.token ||
        this.workersAiTokens.has(value) ||
        Boolean(generated?.permissionGroups.includes("pg-wai-read"));
      if (!allowed) return fail(403, 10000, "Authentication error");
      return ok([{ id: "m1", name: "@cf/meta/llama-3.1-8b-instruct" }]);
    }
    if (!isAssetUpload && auth !== `Bearer ${this.options.token}`) {
      return fail(403, 10000, "Authentication error");
    }
    const object = new RegExp(`^/accounts/${this.accountId}/r2/buckets/([^/]+)/objects/(.+)$`).exec(
      path,
    );
    if (object && method === "DELETE") {
      // Deleting a key that is not there succeeds, as R2's does.
      this.r2Objects.delete(`${object[1]}/${decodeURIComponent(object[2] as string)}`);
      return ok(null);
    }
    if (object && method === "PUT") {
      const bucket = object[1] as string;
      if (!this.r2.has(bucket)) return fail(404, 10006, `no bucket ${bucket}`);
      this.r2Objects.set(
        `${bucket}/${decodeURIComponent(object[2] as string)}`,
        new Uint8Array(await request.arrayBuffer()),
      );
      return ok({ key: decodeURIComponent(object[2] as string) });
    }
    let body: unknown;
    let form: FormData | undefined;
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("application/json")) body = await request.json();
    else if (type.includes("multipart/form-data")) form = await request.formData();
    const injected = this.failOn?.(method, path, body);
    if (injected) return injected;
    try {
      return await this.route(method, path, url, body, form, auth);
    } catch (error) {
      return fail(400, 7000, (error as Error).message);
    }
  };

  private async route(
    method: string,
    path: string,
    url: URL,
    body: unknown,
    form: FormData | undefined,
    auth: string,
  ): Promise<Response> {
    const a = `/accounts/${this.accountId}`;
    const b = body as Record<string, unknown>;
    if (path === "/user/tokens/verify") return ok({ id: "tok", status: "active" });
    if (path === "/accounts")
      return ok([{ id: this.accountId, name: this.options.accountName ?? "Test account" }], {
        page: 1,
        total_pages: 1,
      });
    if (path.startsWith("/accounts/") && !path.startsWith(a))
      return fail(403, 9109, "no access to account");
    if (path === "/zones") return ok(this.options.zones ?? [], { page: 1, total_pages: 1 });
    // Cloudflare for SaaS: a new custom hostname is pending until its owner's DNS verifies it.
    // On a zone without it (`saasOff`), every call answers as the real zone did (2026-11-27).
    const saasZone = /^\/zones\/([^/]+)\/custom_hostnames(?:\/|$)/.exec(path)?.[1];
    const fallback = /^\/zones\/([^/]+)\/custom_hostnames\/fallback_origin$/.exec(path);
    if (saasZone && this.saasOff.has(saasZone)) {
      return fallback
        ? fail(
            401,
            1456,
            "Access to configure this resource has not been granted for this zone. This feature is available with SSL for SaaS.",
          )
        : fail(
            403,
            1404,
            "No quota has been allocated for this zone or for this account. Please contact sales.",
          );
    }
    if (fallback && method === "PUT") {
      const zone = fallback[1] as string;
      const origin = String(b.origin);
      // "Create a proxied A, AAAA, or CNAME record pointing to your origin" first (the docs).
      if (!this.dnsRecords.some((r) => r.zone_id === zone && r.name === origin && r.proxied)) {
        return fail(
          400,
          1550,
          `The fallback origin ${origin} has no proxied DNS record on this zone`,
        );
      }
      this.fallbackOrigins.set(zone, origin);
      return ok({ origin, status: "pending_deployment" });
    }
    if (fallback && method === "GET") {
      const origin = this.fallbackOrigins.get(fallback[1] as string);
      return origin ? ok({ origin, status: "active" }) : fail(404, 1551, "no fallback origin");
    }
    if (fallback && method === "DELETE") {
      if (!this.fallbackOrigins.delete(fallback[1] as string)) {
        return fail(404, 1551, "no fallback origin");
      }
      return ok({ id: fallback[1] });
    }
    const chOne = /^\/zones\/([^/]+)\/custom_hostnames\/([^/]+)$/.exec(path);
    if (chOne && method === "DELETE") {
      const at = this.customHostnames.findIndex(
        (h) => h.id === chOne[2] && (h.zone_id ?? chOne[1]) === chOne[1],
      );
      if (at === -1) return fail(404, 1436, "custom hostname not found");
      this.customHostnames.splice(at, 1);
      return ok({ id: chOne[2] });
    }
    const ch = /^\/zones\/([^/]+)\/custom_hostnames$/.exec(path);
    if (ch) {
      const zone = ch[1] as string;
      if (method === "POST") {
        const hostname = String(b.hostname);
        if (this.customHostnames.some((h) => h.hostname === hostname)) {
          return fail(409, 1406, "Duplicate custom hostname found.");
        }
        const ssl = (b.ssl ?? {}) as { method?: string };
        const token = this.id("tok");
        const entry = {
          id: this.id("ch"),
          zone_id: zone,
          hostname,
          status: "pending",
          ssl: {
            method: ssl.method ?? "http",
            status: "pending_validation",
            ...(ssl.method === "txt"
              ? {
                  validation_records: [
                    { txt_name: `_acme-challenge.${hostname}`, txt_value: `acme-${token}` },
                  ],
                }
              : {}),
          },
          ownership_verification: {
            type: "txt",
            name: `_cf-custom-hostname.${hostname}`,
            value: `own-${token}`,
          },
        };
        this.customHostnames.push(entry);
        return ok(entry);
      }
      // `hostname` matches as a part of the name, and the list comes a page at a time (20 by
      // default), as the documented API's does: a caller wanting one hostname reads every page.
      const wanted = url.searchParams.get("hostname");
      const found = this.customHostnames.filter(
        (h) => (h.zone_id ?? zone) === zone && (!wanted || h.hostname.includes(wanted)),
      );
      const perPage = Math.max(1, Number(url.searchParams.get("per_page") ?? 20));
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const slice = found.slice((page - 1) * perPage, page * perPage);
      const shown = slice.map((h) => ({ ...h }));
      if (this.autoActivateCustomHostnames) for (const h of slice) h.status = "active";
      return ok(shown, {
        page,
        per_page: perPage,
        total_count: found.length,
        total_pages: Math.max(1, Math.ceil(found.length / perPage)),
      });
    }
    // Workers routes on a zone (stage 66 step 8). A route names a Worker of the account and a
    // hostname of the zone (one under its name, or one of its custom hostnames).
    const routeProblem = (zone: string, pattern: string, script: string): Response | null => {
      if (!this.scripts.has(script)) {
        return fail(400, 10007, `workers.api.error.script_not_found: ${script}`);
      }
      const host = pattern.replace(/\/.*$/, "").replace(/^\*\./, "x.");
      const zoneName = (this.options.zones ?? []).find((z) => z.id === zone)?.name;
      const onZone = zoneName !== undefined && (host === zoneName || host.endsWith(`.${zoneName}`));
      const custom = this.customHostnames.some(
        (h) => (h.zone_id ?? zone) === zone && h.hostname === host,
      );
      if (!onZone && !custom) {
        return fail(400, 10022, `The route's hostname ${host} is not on this zone`);
      }
      return null;
    };
    const routes = /^\/zones\/([^/]+)\/workers\/routes$/.exec(path);
    if (routes) {
      const zone = routes[1] as string;
      if (method === "POST") {
        const pattern = String(b.pattern);
        if (this.routes.some((r) => r.zone_id === zone && r.pattern === pattern)) {
          return fail(409, 10020, "A route with the same pattern already exists");
        }
        const problem = routeProblem(zone, pattern, String(b.script));
        if (problem) return problem;
        const entry = { id: this.id("route"), zone_id: zone, pattern, script: String(b.script) };
        this.routes.push(entry);
        return ok(entry);
      }
      return ok(this.routes.filter((r) => r.zone_id === zone));
    }
    const route = /^\/zones\/([^/]+)\/workers\/routes\/([^/]+)$/.exec(path);
    if (route) {
      const at = this.routes.findIndex((r) => r.zone_id === route[1] && r.id === route[2]);
      if (at === -1) return fail(404, 10019, "route not found");
      const found = this.routes[at] as (typeof this.routes)[number];
      if (method === "DELETE") {
        this.routes.splice(at, 1);
        return ok({ id: route[2] });
      }
      if (method === "PUT") {
        const problem = routeProblem(route[1] as string, String(b.pattern), String(b.script));
        if (problem) return problem;
        found.pattern = String(b.pattern);
        found.script = String(b.script);
        return ok(found);
      }
    }
    // DNS records on a zone (stage 66 step 8: the fleet's placeholders).
    const dns = /^\/zones\/([^/]+)\/dns_records$/.exec(path);
    if (dns) {
      const zone = dns[1] as string;
      if (method === "POST") {
        const name = String(b.name);
        const type = String(b.type);
        const addressing = (t: string) => t === "A" || t === "AAAA" || t === "CNAME";
        const clash = this.dnsRecords.find(
          (r) =>
            r.zone_id === zone &&
            r.name === name &&
            addressing(type) &&
            addressing(r.type) &&
            (type === "CNAME" || r.type === "CNAME" || r.readOnly),
        );
        if (clash) {
          return fail(400, 81053, "An A, AAAA, or CNAME record with that host already exists.");
        }
        const entry = {
          id: this.id("dns"),
          zone_id: zone,
          type,
          name,
          content: String(b.content),
          proxied: Boolean(b.proxied),
        };
        this.dnsRecords.push(entry);
        return ok(entry);
      }
      const name = url.searchParams.get("name");
      return ok(this.dnsRecords.filter((r) => r.zone_id === zone && (!name || r.name === name)));
    }
    const dnsOne = /^\/zones\/([^/]+)\/dns_records\/([^/]+)$/.exec(path);
    if (dnsOne && method === "DELETE") {
      const at = this.dnsRecords.findIndex((r) => r.zone_id === dnsOne[1] && r.id === dnsOne[2]);
      if (at === -1) return fail(404, 81044, "record not found");
      if (this.dnsRecords[at]?.readOnly) {
        return fail(
          400,
          1061,
          "This record is managed by a Workers Custom Domain and is read-only",
        );
      }
      this.dnsRecords.splice(at, 1);
      return ok({ id: dnsOne[2] });
    }
    if (path === `${a}/workers/subdomain`) {
      if (method === "PUT") {
        this.subdomain = String(b.subdomain);
        return ok({ subdomain: this.subdomain });
      }
      return this.subdomain ? ok({ subdomain: this.subdomain }) : fail(404, 10007, "no subdomain");
    }

    // D1
    if (path === `${a}/d1/database`) {
      if (method === "POST") {
        const name = String(b.name);
        if ([...this.d1.values()].some((d) => d.name === name)) return fail(400, 7502, "exists");
        const hint = b.primary_location_hint;
        if (hint !== undefined && !isLocationHint(hint))
          return fail(400, 7400, "invalid primary_location_hint");
        this.creates.push({ type: "d1", name, locationHint: hint });
        const uuid = this.id("d1");
        this.d1.set(uuid, { name, engine: this.options.sql() });
        return ok({ uuid, name });
      }
      return ok([...this.d1].map(([uuid, d]) => ({ uuid, name: d.name })));
    }
    let m = new RegExp(`^${a}/d1/database/([^/]+)(/.*)?$`).exec(path);
    if (m) {
      const db = this.d1.get(m[1] as string);
      if (!db) return fail(404, 7404, "database not found");
      const rest = m[2] ?? "";
      if (rest === "" && method === "DELETE") {
        this.d1.delete(m[1] as string);
        return ok(null);
      }
      if (rest === "/query") {
        const rows = await db.engine.query(String(b.sql), (b.params as unknown[]) ?? []);
        return ok([{ results: rows, success: true, meta: {} }]);
      }
      if (rest === "/export" && method === "POST") {
        // Completes at once: a dump URL on a Cloudflare-hosted, signed location.
        return ok({
          status: "complete",
          at_bookmark: await db.engine.bookmark(),
          result: { signed_url: `https://d1-exports.example/${m[1]}.sql?sig=fake` },
        });
      }
      if (rest === "/time_travel/bookmark") return ok({ bookmark: await db.engine.bookmark() });
      if (rest === "/time_travel/restore") {
        const previous = await db.engine.bookmark();
        await db.engine.restore(url.searchParams.get("bookmark") ?? "");
        return ok({ bookmark: url.searchParams.get("bookmark"), previous_bookmark: previous });
      }
    }

    // R2, KV, queues, Vectorize
    if (path === `${a}/r2/buckets`) {
      if (method === "POST") {
        const hint = b.locationHint;
        if (hint !== undefined && !isLocationHint(hint))
          return fail(400, 10040, "invalid locationHint");
        this.creates.push({ type: "r2", name: String(b.name), locationHint: hint });
        this.r2.add(String(b.name));
        return ok({ name: b.name });
      }
      return ok({ buckets: [...this.r2].map((name) => ({ name })) });
    }
    m = new RegExp(`^${a}/r2/buckets/([^/]+)/lifecycle$`).exec(path);
    if (m && method === "PUT") {
      if (!this.r2.has(m[1] as string)) return fail(404, 10006, `no bucket ${m[1]}`);
      this.r2Lifecycle.set(m[1] as string, b);
      return ok(null);
    }
    m = new RegExp(`^${a}/stream/([0-9a-f]{32})$`).exec(path);
    if (m && method === "POST") {
      if (!this.streamCreators.has(m[1] as string)) return fail(404, 10003, "video not found");
      if (typeof b.creator === "string") this.streamCreators.set(m[1] as string, b.creator);
      return ok({ uid: m[1], creator: this.streamCreators.get(m[1] as string) });
    }
    // A bucket's keys, a page at a time (`per_page`, `cursor`: the next key's index here).
    m = new RegExp(`^${a}/r2/buckets/([^/]+)/objects$`).exec(path);
    if (m && method === "GET") {
      const bucket = m[1] as string;
      if (!this.r2.has(bucket)) return fail(404, 10006, `no bucket ${bucket}`);
      const keys = [...this.r2Objects.keys()]
        .filter((k) => k.startsWith(`${bucket}/`))
        .map((k) => k.slice(bucket.length + 1))
        .sort();
      const from = Number(url.searchParams.get("cursor") ?? "0");
      const size = Number(url.searchParams.get("per_page") ?? "1000");
      const truncated = from + size < keys.length;
      return ok(
        keys.slice(from, from + size).map((key) => ({ key })),
        { is_truncated: truncated, ...(truncated ? { cursor: String(from + size) } : {}) },
      );
    }
    m = new RegExp(`^${a}/r2/buckets/([^/]+)$`).exec(path);
    if (m && method === "DELETE") {
      const bucket = m[1] as string;
      // As R2's: a bucket that holds an object is not deleted.
      if ([...this.r2Objects.keys()].some((k) => k.startsWith(`${bucket}/`))) {
        return fail(409, 10008, "The bucket you tried to delete is not empty");
      }
      this.r2.delete(bucket);
      return ok(null);
    }
    if (path === `${a}/storage/kv/namespaces`) {
      if (method === "POST") {
        if ([...this.kv.values()].includes(String(b.title)))
          return fail(400, 10014, "title exists");
        const id = this.id("kv");
        this.kv.set(id, String(b.title));
        return ok({ id, title: b.title });
      }
      return ok(
        [...this.kv].map(([id, title]) => ({ id, title })),
        { page: 1, total_pages: 1 },
      );
    }
    m = new RegExp(`^${a}/storage/kv/namespaces/([^/]+)$`).exec(path);
    if (m && method === "DELETE") {
      this.kv.delete(m[1] as string);
      return ok(null);
    }
    if (path === `${a}/queues`) {
      if (method === "POST") {
        const id = this.id("q");
        this.queues.set(id, { name: String(b.queue_name), consumers: [] });
        return ok({ queue_id: id, queue_name: b.queue_name });
      }
      return ok(
        [...this.queues].map(([queue_id, q]) => ({
          queue_id,
          queue_name: q.name,
          consumers: q.consumers,
        })),
        { page: 1, total_pages: 1 },
      );
    }
    m = new RegExp(`^${a}/queues/([^/]+)$`).exec(path);
    if (m && method === "DELETE") {
      const queue = this.queues.get(m[1] as string);
      if (!queue) return fail(404, 11000, "queue not found");
      // As the real API (the staging check's first run): a queue a Worker still binds, or that
      // is a consumer's dead-letter queue, or that still has a consumer, is not deleted.
      if (this.queueProducers(queue.name).length) {
        return fail(
          400,
          11005,
          `Cannot delete queue '${queue.name}' that is still referenced by a binding in a Worker. Unbind queue '${queue.name}' from the Workers '${this.queueProducers(queue.name).join(", ")}' first.`,
        );
      }
      if (
        [...this.queues.values()].some((q) =>
          q.consumers.some((c) => c.dead_letter_queue === queue.name),
        )
      ) {
        return fail(
          400,
          11005,
          `Cannot delete queue '${queue.name}' that serves as dead letter queue for consumers. Unbind queue '${queue.name}' from the consumers first.`,
        );
      }
      if (queue.consumers.length) {
        return fail(400, 11005, `Cannot delete queue '${queue.name}' that has consumers.`);
      }
      this.queues.delete(m[1] as string);
      return ok(null);
    }
    m = new RegExp(`^${a}/vectorize/v2/indexes/([^/]+)$`).exec(path);
    if (m && method === "DELETE") {
      if (!this.vectorize.delete(m[1] as string)) return fail(404, 40002, "index not found");
      this.vectorizeMetadata.delete(m[1] as string);
      return ok(null);
    }
    m = new RegExp(`^${a}/queues/([^/]+)/consumers(?:/([^/]+))?$`).exec(path);
    if (m) {
      const queue = this.queues.get(m[1] as string);
      if (!queue) return fail(404, 11000, "queue not found");
      if (method === "GET" && !m[2])
        return ok(queue.consumers.map((c) => ({ ...c, script: c.script_name })));
      if (method === "DELETE" && m[2]) {
        const at = queue.consumers.findIndex((c) => c.consumer_id === m?.[2]);
        if (at === -1) return fail(404, 11000, "consumer not found");
        queue.consumers.splice(at, 1);
        return ok(null);
      }
      const dlq = b.dead_letter_queue as string | undefined;
      if (dlq !== undefined && ![...this.queues.values()].some((q) => q.name === dlq)) {
        return fail(400, 11003, `dead letter queue ${dlq} does not exist`);
      }
      if (/^\$/.test(String(b.script_name)) || dlq?.startsWith("$")) {
        return fail(400, 11004, "unresolved placeholder in consumer");
      }
      if (m[2]) {
        const consumer = queue.consumers.find((c) => c.consumer_id === m?.[2]);
        if (!consumer) return fail(404, 11000, "consumer not found");
        consumer.settings = b.settings;
        consumer.dead_letter_queue = dlq;
        return ok(consumer);
      }
      const consumer = {
        consumer_id: this.id("c"),
        script_name: String(b.script_name),
        settings: b.settings,
        dead_letter_queue: dlq,
      };
      queue.consumers.push(consumer);
      return ok(consumer);
    }
    if (path === `${a}/vectorize/v2/indexes`) {
      if (method === "POST") {
        this.vectorize.set(String(b.name), (b.config as Record<string, unknown>) ?? {});
        return ok({ name: b.name });
      }
      return ok([...this.vectorize.keys()].map((name) => ({ name })));
    }
    m = new RegExp(`^${a}/vectorize/v2/indexes/([^/]+)/metadata_index/(list|create)$`).exec(path);
    if (m) {
      const index = m[1] as string;
      if (!this.vectorize.has(index)) return fail(404, 40002, "index not found");
      const list = this.vectorizeMetadata.get(index) ?? [];
      if (m[2] === "create") {
        if (list.some((p) => p.propertyName === b.propertyName)) {
          return fail(400, 40014, "metadata index already exists");
        }
        list.push({ propertyName: String(b.propertyName), indexType: String(b.indexType) });
        this.vectorizeMetadata.set(index, list);
        return ok({ mutationId: this.id("mut") });
      }
      return ok({ metadataIndexes: list });
    }

    // AI Gateway, custom providers, BYOK, Secrets Store, account tokens
    if (path === `${a}/ai-gateway/gateways`) {
      if (method === "POST") {
        const id = String(b.id);
        if (this.gateways.has(id)) return fail(400, 7001, "gateway already exists");
        if (b.authentication === false) return fail(400, 7002, "new gateways need authentication");
        const gateway = { authentication: true, ...b, id, store_id: b.store_id ?? null };
        this.gateways.set(id, gateway);
        return ok(gateway);
      }
      return ok([...this.gateways.values()]);
    }
    m = new RegExp(`^${a}/ai-gateway/gateways/([^/]+)/logs$`).exec(path);
    if (m && method === "GET") {
      if (!this.gateways.has(m[1] as string)) return fail(404, 7002, "gateway not found");
      const filters = JSON.parse(url.searchParams.get("filters") ?? "[]") as {
        key: string;
        operator: string;
        value: string[];
      }[];
      let logs = [...(this.gatewayLogs.get(m[1] as string) ?? [])];
      for (const f of filters) {
        if (f.key === "metadata.value" && f.operator === "eq") {
          // Any metadata entry with this value (the API does not pair it with a key).
          const wanted = String(f.value[0]);
          logs = logs.filter((l) => {
            try {
              return Object.values(JSON.parse(l.metadata ?? "{}") as object).some(
                (value) => String(value) === wanted,
              );
            } catch {
              return false;
            }
          });
          continue;
        }
        if (f.key !== "created_at") continue;
        const v = String(f.value[0]);
        logs = logs.filter((l) => (f.operator === "gt" ? l.created_at >= v : l.created_at < v));
      }
      logs.sort((x, y) => x.created_at.localeCompare(y.created_at));
      const perPage = Number(url.searchParams.get("per_page") ?? 50);
      const page = Number(url.searchParams.get("page") ?? 1);
      const total = Math.max(1, Math.ceil(logs.length / perPage));
      return ok(logs.slice((page - 1) * perPage, page * perPage), {
        page,
        total_pages: total,
      });
    }
    m = new RegExp(`^${a}/ai-gateway/gateways/([^/]+)(/provider_configs(?:/([^/]+))?)?$`).exec(
      path,
    );
    if (m) {
      const id = m[1] as string;
      const gateway = this.gateways.get(id);
      if (!gateway) return fail(404, 7002, "gateway not found");
      if (m[2]) {
        const configs = this.providerConfigs.get(id) ?? [];
        this.providerConfigs.set(id, configs);
        if (m[3] && method === "DELETE") {
          const index = configs.findIndex((c) => c.id === m?.[3]);
          if (index === -1) return fail(404, 7003, "provider config not found");
          configs.splice(index, 1);
          return ok(null);
        }
        if (method === "POST") {
          if (!gateway.store_id) return fail(400, 7010, "the gateway has no Secrets Store");
          if (configs.some((c) => c.provider_slug === b.provider_slug && c.alias === b.alias)) {
            return fail(400, 7011, "a key for this provider and alias exists");
          }
          const config = {
            id: this.id("pc"),
            provider_slug: String(b.provider_slug),
            alias: String(b.alias),
            default_config: Boolean(b.default_config),
            secret: String(b.secret),
          };
          configs.push(config);
          const { secret, ...shown } = config;
          return ok({ ...shown, secret_preview: `${secret.slice(0, 2)}…` });
        }
        return ok(
          configs.map(({ secret, ...shown }) => ({
            ...shown,
            secret_preview: `${secret.slice(0, 2)}…`,
          })),
        );
      }
      if (method === "DELETE") {
        this.gateways.delete(id);
        return ok(null);
      }
      if (method === "PUT") {
        if (gateway.authentication === true && b.authentication === false) {
          return fail(400, 7004, "Authentication cannot be disabled once enabled.");
        }
        const updated = { ...b, id, store_id: b.store_id ?? gateway.store_id ?? null };
        this.gateways.set(id, updated);
        return ok(updated);
      }
      return ok(gateway);
    }
    if (path === `${a}/ai-gateway/custom-providers`) {
      if (method === "POST") {
        if (!String(b.base_url).startsWith("https://")) return fail(400, 7020, "base_url");
        if ([...this.customProviders.values()].some((p) => p.slug === b.slug)) {
          return fail(400, 7021, "slug exists");
        }
        const provider = { ...b, id: this.id("cp") };
        this.customProviders.set(provider.id, provider);
        return ok(provider);
      }
      return ok([...this.customProviders.values()], { page: 1, total_pages: 1 });
    }
    m = new RegExp(`^${a}/ai-gateway/custom-providers/([^/]+)$`).exec(path);
    if (m) {
      const provider = this.customProviders.get(m[1] as string);
      if (!provider) return fail(404, 7022, "custom provider not found");
      if (method === "PATCH") Object.assign(provider, b);
      return ok(provider);
    }
    if (path === `${a}/secrets_store/stores`) {
      if (method === "POST") {
        const id = this.id("store");
        this.secretsStores.set(id, String(b.name));
        return ok({ id, name: b.name });
      }
      return ok(
        [...this.secretsStores].map(([id, name]) => ({ id, name })),
        { page: 1, total_pages: 1 },
      );
    }
    if (path === `${a}/tokens/permission_groups`) {
      const groups = [
        { id: "pg-aig-run", name: "AI Gateway Run" },
        { id: "pg-wai-read", name: "Workers AI Read" },
        { id: "pg-aig-edit", name: "AI Gateway Write" },
        { id: "pg-r2-read", name: "Workers R2 Storage Bucket Item Read" },
      ];
      const name = url.searchParams.get("name");
      return ok(groups.filter((g) => !name || g.name === name));
    }
    if (path === `${a}/tokens` && method === "POST") {
      const id = this.id("token");
      const value = `cf-token-${id}-${"v".repeat(32)}`;
      const policies = b.policies as { permission_groups: { id: string }[] }[];
      this.tokens.set(id, {
        name: String(b.name),
        value,
        permissionGroups: policies.flatMap((p) => p.permission_groups.map((g) => g.id)),
        resources: (policies[0] as { resources?: Record<string, string> } | undefined)?.resources,
        ...(b.expires_on ? { expiresOn: String(b.expires_on) } : {}),
      });
      return ok({ id, name: b.name, status: "active", value });
    }
    m = new RegExp(`^${a}/tokens/([^/]+)$`).exec(path);
    if (m && method === "DELETE") {
      if (!this.tokens.delete(m[1] as string)) return fail(404, 1003, "token not found");
      return ok(null);
    }

    // Workers
    if (path === `${a}/workers/scripts`) {
      return ok(
        [...this.scripts.values()].map((s) => ({ id: s.name, migration_tag: s.migrationTag })),
      );
    }
    if (path === `${a}/workers/domains` && method === "PUT") {
      const existing = this.domains.find((d) => d.hostname === b.hostname);
      if (existing) Object.assign(existing, b);
      else {
        // "You cannot create a Custom Domain on a hostname with an existing CNAME DNS record."
        if (
          this.dnsRecords.some(
            (r) => r.zone_id === b.zone_id && r.name === b.hostname && r.type === "CNAME",
          )
        ) {
          return fail(409, 100117, "Hostname already has an existing CNAME DNS record");
        }
        this.domains.push({
          ...(b as { hostname: string; service: string; zone_id: string }),
          id: this.id("dom"),
        });
        // Cloudflare makes the Custom Domain's DNS record itself, read-only, gone with it.
        this.dnsRecords.push({
          id: this.id("dns"),
          zone_id: String(b.zone_id),
          type: "AAAA",
          name: String(b.hostname),
          content: "100::",
          proxied: true,
          readOnly: true,
        });
      }
      return ok(b);
    }
    if (path === `${a}/workers/domains` && method === "GET") {
      return ok(
        this.domains.map((d) => ({ ...d })),
        { page: 1, total_pages: 1 },
      );
    }
    m = new RegExp(`^${a}/workers/domains/([^/]+)$`).exec(path);
    if (m && method === "DELETE") {
      const id = m[1] as string;
      const at = this.domains.findIndex((d) => d.id === id);
      if (at === -1) return fail(404, 100114, "domain not found");
      const [gone] = this.domains.splice(at, 1);
      const record = this.dnsRecords.findIndex(
        (r) => r.readOnly && r.name === gone?.hostname && r.zone_id === gone?.zone_id,
      );
      if (record !== -1) this.dnsRecords.splice(record, 1);
      return ok(null);
    }
    // The Durable Object namespaces: one per class a Worker of the account defines (a binding
    // with no script_name), gone with its Worker.
    if (path === `${a}/workers/durable_objects/namespaces` && method === "GET") {
      const namespaces = [...this.scripts.values()].flatMap((s) => {
        const live = s.versions.find((v) => v.id === s.current);
        const bindings = (live?.metadata.bindings ?? []) as {
          type: string;
          class_name?: string;
          script_name?: string;
        }[];
        return bindings
          .filter((x) => x.type === "durable_object_namespace" && !x.script_name)
          .map((x) => ({
            id: `ns-${s.name}-${x.class_name}`,
            name: `${s.name}_${x.class_name}`,
            script: s.name,
            class: x.class_name,
          }));
      });
      return ok(namespaces, { page: 1, total_pages: 1 });
    }
    if (path === `${a}/workflows` && method === "GET") {
      return ok(
        [...this.workflows.keys()].map((name) => ({ id: name, name })),
        { page: 1, total_pages: 1 },
      );
    }
    m = new RegExp(`^${a}/workflows/([^/]+)$`).exec(path);
    if (m && method === "DELETE") {
      if (!this.workflows.delete(decodeURIComponent(m[1] as string))) {
        return fail(404, 10200, "workflow not found");
      }
      return ok(null);
    }
    if (path === `${a}/workers/assets/upload`) {
      const jwt = auth.replace(/^Bearer /, "");
      const session = this.sessions.get(jwt);
      if (!session || !form) return fail(401, 10001, "bad upload token");
      for (const [hash] of form.entries()) {
        this.uploadedAssets.add(hash);
        session.pending.delete(hash);
      }
      if (session.pending.size === 0) {
        const done = this.id("assets-done");
        this.sessions.set(done, { pending: new Set() });
        return json(201, { success: true, errors: [], result: { jwt: done } });
      }
      return ok(null);
    }
    m = new RegExp(`^${a}/workers/scripts/([^/]+)(/.*)?$`).exec(path);
    if (m)
      return this.scriptRoute(this.scripts, false, method, m[1] as string, m[2] ?? "", b, form);

    // Workers for Platforms
    if (path === `${a}/workers/dispatch/namespaces`) {
      if (method === "POST") {
        const name = String(b.name);
        if (this.namespaces.has(name)) return fail(400, 100119, "namespace exists");
        this.namespaces.set(name, new Map());
        return ok({ namespace_name: name });
      }
      return ok([...this.namespaces.keys()].map((namespace_name) => ({ namespace_name })));
    }
    m = new RegExp(
      `^${a}/workers/dispatch/namespaces/([^/]+)(?:/scripts(?:/([^/]+)(/.*)?)?)?$`,
    ).exec(path);
    if (m) {
      const ns = this.namespaces.get(decodeURIComponent(m[1] as string));
      if (!ns) return fail(404, 100118, "namespace not found");
      if (!path.includes("/scripts")) return ok({ namespace_name: m[1] });
      if (!m[2]) {
        if (method === "DELETE") {
          const tag = (url.searchParams.get("tags") ?? "").replace(/:yes$/, "");
          for (const [name, script] of ns) if (script.tags?.includes(tag)) ns.delete(name);
          return ok(null);
        }
        return ok(
          [...ns.values()].map((sc) => ({
            script: { id: sc.name, migration_tag: sc.migrationTag, tags: sc.tags },
          })),
        );
      }
      return this.scriptRoute(ns, true, method, m[2], m[3] ?? "", b, form);
    }
    return fail(404, 7003, `no route for ${method} ${path}`);
  }

  private async scriptRoute(
    store: Map<string, FakeScript>,
    namespaced: boolean,
    method: string,
    name: string,
    rest: string,
    b: Record<string, unknown>,
    form: FormData | undefined,
  ): Promise<Response> {
    const script = store.get(name);
    if (namespaced && /^\/(versions|deployments|schedules|subdomain)$/.test(rest)) {
      return fail(404, 7003, `user Workers have no ${rest.slice(1)}`);
    }
    if (rest === "" && method === "PUT") {
      if (!form) return fail(400, 10021, "expected multipart");
      const { metadata, modules, sources } = await this.readUpload(form);
      const migrations = metadata.migrations as { old_tag?: string; new_tag?: string } | undefined;
      if (migrations) {
        if ((migrations.old_tag ?? undefined) !== script?.migrationTag) {
          return fail(
            400,
            10079,
            `migration old_tag ${migrations.old_tag} does not match ${script?.migrationTag}`,
          );
        }
      } else if (!script && this.needsMigration(metadata)) {
        return fail(400, 10074, "durable object classes need a migration");
      }
      const target: FakeScript = script ?? {
        name,
        versions: [],
        secrets: new Map(),
        schedules: [],
        workersDev: false,
        bindings: [],
        tags: [],
      };
      if (namespaced) target.tags = ((metadata.tags as string[] | undefined) ?? []).slice(0, 8);
      this.registerWorkflows(name, metadata);
      this.applySecrets(target, metadata);
      const versionId = this.id("ver");
      target.versions.push({ id: versionId, metadata, modules, sources });
      target.current = versionId;
      if (migrations?.new_tag) target.migrationTag = migrations.new_tag;
      store.set(name, target);
      return ok({ id: name, migration_tag: target.migrationTag });
    }
    // Works before the script exists, as for a first deploy.
    if (rest === "/assets-upload-session" && method === "POST") {
      const manifest = b.manifest as Record<string, { hash: string }>;
      const pending = new Set(
        Object.values(manifest)
          .map((f) => f.hash)
          .filter((h) => !this.uploadedAssets.has(h)),
      );
      const jwt = this.id("assets");
      this.sessions.set(jwt, { pending });
      return ok({ jwt, buckets: pending.size ? [[...pending]] : [] });
    }
    if (!script) return fail(404, 10007, `script ${name} not found`);
    if (rest === "" && method === "DELETE") {
      // As the real API, even with `?force=true` (the staging check's first run): a Worker that
      // consumes a queue is not deleted until its consumers are removed.
      if (
        !namespaced &&
        [...this.queues.values()].some((q) => q.consumers.some((c) => c.script_name === name))
      ) {
        return fail(
          403,
          10064,
          "Cannot delete this Worker as it is a consumer for a Queue. Remove it from the Queue's consumers first, then retry.",
        );
      }
      store.delete(name);
      return ok(null);
    }
    if (rest === "/versions" && method === "POST") {
      if (!form) return fail(400, 10021, "expected multipart");
      const { metadata, modules, sources } = await this.readUpload(form);
      if (metadata.migrations)
        return fail(400, 10211, "migrations are not supported with versions");
      this.registerWorkflows(name, metadata);
      this.applySecrets(script, metadata);
      const id = this.id("ver");
      script.versions.push({ id, metadata, modules, sources });
      return ok({ id });
    }
    if (rest === "/deployments") {
      const versions = b.versions as { version_id: string; percentage: number }[];
      const target = versions[0]?.version_id;
      if (!script.versions.some((v) => v.id === target)) return fail(400, 10215, "unknown version");
      script.current = target;
      return ok({ id: this.id("dep") });
    }
    const secret = /^\/secrets\/([^/]+)$/.exec(rest);
    if (secret && method === "DELETE") {
      const name = decodeURIComponent(secret[1] as string);
      if (!script.secrets.delete(name)) return fail(404, 10056, `secret ${name} not found`);
      return ok(null);
    }
    if (rest === "/secrets") {
      if (method === "PUT") {
        script.secrets.set(String(b.name), String(b.text));
        return ok({ name: b.name, type: "secret_text" });
      }
      return ok([...script.secrets.keys()].map((n) => ({ name: n, type: "secret_text" })));
    }
    if (rest === "/schedules" && method === "PUT") {
      script.schedules = (b as unknown as { cron: string }[]).map((s) => s.cron);
      return ok({ schedules: script.schedules.map((cron) => ({ cron })) });
    }
    if (rest === "/subdomain" && method === "POST") {
      script.workersDev = Boolean(b.enabled);
      return ok({ enabled: script.workersDev });
    }
    // The deployed version's bindings (secrets show by name only, as the real API's do).
    if (rest === "/settings" && method === "GET") {
      const live = script.versions.find((v) => v.id === script.current);
      return ok({ bindings: (live?.metadata.bindings ?? []) as unknown[] });
    }
    return fail(404, 7003, `no route for ${method} /scripts/${name}${rest}`);
  }

  /** The account's Workers whose live version binds `queue` (to send to it). */
  private queueProducers(queue: string): string[] {
    return [...this.scripts.values()]
      .filter((s) => {
        const live = s.versions.find((v) => v.id === s.current);
        const bindings = (live?.metadata.bindings ?? []) as { type: string; queue_name?: string }[];
        return bindings.some((x) => x.type === "queue" && x.queue_name === queue);
      })
      .map((s) => s.name);
  }

  private needsMigration(metadata: Record<string, unknown>) {
    const bindings = (metadata.bindings ?? []) as { type: string; script_name?: string }[];
    return bindings.some((b) => b.type === "durable_object_namespace" && !b.script_name);
  }

  private registerWorkflows(script: string, metadata: Record<string, unknown>) {
    const bindings = (metadata.bindings ?? []) as {
      type: string;
      workflow_name?: string;
      class_name?: string;
      script_name?: string;
    }[];
    for (const b of bindings) {
      if (b.type !== "workflow" || !b.workflow_name) continue;
      if (b.workflow_name.startsWith("$") || b.script_name?.startsWith("$")) {
        throw new Error(`unresolved placeholder in workflow binding ${b.workflow_name}`);
      }
      if (!b.script_name || b.script_name === script) {
        this.workflows.set(b.workflow_name, { className: String(b.class_name), script });
      }
    }
  }

  private applySecrets(script: FakeScript, metadata: Record<string, unknown>) {
    const bindings = (metadata.bindings ?? []) as { type: string; name: string; text?: string }[];
    const keep = ((metadata.keep_bindings ?? []) as string[]).includes("secret_text");
    if (!keep) script.secrets.clear();
    for (const binding of bindings) {
      if (binding.type === "secret_text") script.secrets.set(binding.name, String(binding.text));
    }
    // Secrets are not echoed into stored metadata.
    metadata.bindings = bindings.filter((b) => b.type !== "secret_text");
  }

  private async readUpload(form: FormData) {
    const metaPart = form.get("metadata");
    if (!metaPart || typeof metaPart === "string") throw new Error("missing metadata part");
    const metadata = JSON.parse(await metaPart.text()) as Record<string, unknown>;
    const modules = [...form.keys()].filter((k) => k !== "metadata");
    const main = String(metadata.main_module ?? "");
    if (!modules.includes(main)) throw new Error(`main_module ${main} has no part`);
    if (metadata.assets) {
      const jwt = (metadata.assets as { jwt?: string }).jwt ?? "";
      const session = this.sessions.get(jwt);
      if (!session || session.pending.size > 0)
        throw new Error("assets completion token is not valid");
    }
    const sources: Record<string, string> = {};
    for (const name of modules) {
      const part = form.get(name);
      if (part && typeof part !== "string") sources[name] = await part.text();
    }
    return { metadata, modules, sources };
  }
}
