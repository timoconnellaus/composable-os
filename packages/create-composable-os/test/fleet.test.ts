// The operator's commands for a host of many clients (stage 66 step 7, ADR 0618), criteria 11 to 13:
// `cos client add`, `cos fleet upgrade` across clients, export, import and remove, against the
// registry's real migrations (on Node's SQLite) and a stand-in for the operator's Worker (whose own
// code is tested on a real client's database in packages/db's operator.test.ts).
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, type Migration, type MigrationLevel } from "@composable-os/db";
import { type ClientId, REGISTRY_MIGRATIONS_TABLE, readRegistry } from "@composable-os/db/registry";
import { newHostKeys } from "@composable-os/db/registry-sealing";
import { listSenderDomains } from "@composable-os/db/registry-senders";
import { readClient, unfinishedOperation, wasRemoved } from "@composable-os/db/registry-writes";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addClient,
  canonicalDomain,
  exportClient,
  type FleetContext,
  importClient,
  listClientsCommand,
  pauseClient,
  registrableDomain,
  removeClient,
  resumeClient,
  senderCommand,
  setSecret,
} from "../src/fleet/clients.ts";
import {
  keysFingerprint,
  keysMismatch,
  newFleetKeys,
  readKeysFile,
  writeKeysFile,
} from "../src/fleet/keys.ts";
import { nodeD1 } from "../src/fleet/node-d1.ts";
import type { Operator } from "../src/fleet/operator-client.ts";
import { registryMigrations } from "../src/fleet/run.ts";
import { lazyOperator } from "../src/fleet/session.ts";
import { type FleetUpdateInput, fleetUpdate } from "../src/fleet/update.ts";
import type { Io } from "../src/io.ts";

const migrations = (n: number): Migration[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `${String(i + 1).padStart(4, "0")}_m.sql`,
    queries: [`CREATE TABLE t${i + 1} (v)`],
  }));

/** The operator's Worker as the commands see it, over in-memory clients' databases. */
class FakeOperator implements Operator {
  dbs = new Map<string, { applied: string[]; rows: Record<string, number>; erased?: boolean }>();
  files = new Map<string, Uint8Array>();
  exports = new Map<string, Uint8Array>();
  kv = new Set<string>();
  vectors = new Set<string>();
  bookmarks = new Map<string, string>();
  calls: string[] = [];
  /** A client whose next migration of this name fails. */
  failOn: { client: string; migration: string } | null = null;
  /** A client whose next migrate throws (a lost connection). */
  throwOn: string | null = null;
  /** A client whose next migrate applies every migration, then throws (its answer lost). */
  applyThenThrowOn: string | null = null;
  extensions: Record<string, { id: string; source: string; status: string; contract: number }[]> =
    {};
  secrets: Record<string, Record<string, string>> = {};
  /** The Stream ids a client's database names (core_media), by client. */
  mediaVideos: Record<string, string[]> = {};
  db(client: string) {
    let db = this.dbs.get(client);
    if (!db) {
      db = { applied: [], rows: {} };
      this.dbs.set(client, db);
    }
    return db;
  }
  level(client: string): MigrationLevel {
    const applied = this.db(client).applied;
    const highest = applied.length ? Number(applied.at(-1)?.slice(0, 4)) : null;
    return {
      latest: applied.at(-1) ?? null,
      applied: applied.length,
      schemaVersion: highest,
      expectedSchemaVersion: highest ?? 0,
      upToDate: true,
    };
  }
  async op<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
    const client = body.client as string;
    this.calls.push(`${action}${client ? ` ${client}` : ""}`);
    const r = (v: unknown) => v as T;
    switch (action) {
      case "health":
        return r({ ok: true });
      case "level":
        return r(this.level(client));
      case "place":
        return r({ first: true });
      case "migrate": {
        if (this.throwOn === client) {
          this.throwOn = null;
          throw new Error("connection lost");
        }
        const db = this.db(client);
        if (this.applyThenThrowOn === client) {
          this.applyThenThrowOn = null;
          for (const m of body.migrations as Migration[]) {
            if (!db.applied.includes(m.name)) db.applied.push(m.name);
          }
          throw new Error("the answer was lost after the migrations applied");
        }
        const applied: string[] = [];
        let failed = null;
        for (const m of body.migrations as Migration[]) {
          if (db.applied.includes(m.name)) continue;
          if (this.failOn?.client === client && this.failOn.migration === m.name) {
            this.failOn = null;
            failed = { name: m.name, error: "no such table" };
            break;
          }
          db.applied.push(m.name);
          applied.push(m.name);
        }
        return r({ applied, failed, level: this.level(client) });
      }
      case "bookmark": {
        const id = `bm-${this.bookmarks.size}`;
        this.bookmarks.set(id, JSON.stringify(this.db(client)));
        return r({ bookmark: id });
      }
      case "restore":
        this.dbs.set(client, JSON.parse(this.bookmarks.get(body.bookmark as string) as string));
        return r({ undo: "u" });
      case "query":
        if (String(body.sql).includes("core_media")) {
          return r({
            results: (this.mediaVideos[client] ?? []).map((uid) => ({ stream_uid: uid })),
          });
        }
        return r({ results: this.extensions[client] ?? [] });
      case "export-db-part": {
        const path = `${body.exportKey}/database/000000.json`;
        const part = {
          format: "cos-sql-export/1",
          id: "x",
          index: 0,
          statements: [JSON.stringify(this.db(client))],
          last: true,
          counts: this.db(client).rows,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(part));
        this.exports.set(path, bytes);
        const { createHash } = await import("node:crypto");
        return r({
          index: 0,
          last: true,
          statements: 1,
          path,
          next: null,
          counts: part.counts,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
      case "export-files-page": {
        const { createHash } = await import("node:crypto");
        const files = [];
        for (const [key, bytes] of this.files) {
          if (!key.startsWith(`${client}/`)) continue;
          const own = key.slice(client.length + 1);
          this.exports.set(`${body.exportKey}/files/${own}`, bytes);
          files.push({
            key: own,
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
        }
        return r({ files, next: null });
      }
      case "export-manifest":
        this.exports.set(
          `${body.exportKey}/manifest.json`,
          new TextEncoder().encode(JSON.stringify(body.manifest)),
        );
        return r({});
      case "import-db-part": {
        const part = body.part as { statements: string[] };
        const copied = JSON.parse(part.statements[0] as string);
        this.dbs.set(client, { ...copied, applied: [...copied.applied] });
        return r({ applied: true, done: true });
      }
      case "rebuild-views":
        return r({ views: 0, formulaErrors: 0 });
      case "requeue-embeddings":
        return r({ queued: 0 });
      case "secrets-export":
        return r({ derived: this.secrets[client] ?? {}, given: {}, problems: [] });
      case "erase-db":
        this.dbs.set(client, { applied: [], rows: {}, erased: true });
        return r({ ok: true });
      case "files-delete-page": {
        let deleted = 0;
        for (const key of [...this.files.keys()]) {
          if (key.startsWith(`${client}/`)) {
            this.files.delete(key);
            deleted += 1;
          }
        }
        return r({ deleted, more: false });
      }
      case "kv-delete-page":
      case "vectors-delete-page": {
        const set = action === "kv-delete-page" ? this.kv : this.vectors;
        let deleted = 0;
        for (const key of [...set]) {
          if (key.startsWith(`${client}/`)) {
            set.delete(key);
            deleted += 1;
          }
        }
        return r({ deleted, more: false });
      }
      default:
        throw new Error(`no such action ${action}`);
    }
  }
  async putFile(client: string, key: string, bytes: Uint8Array) {
    this.files.set(`${client}/${key}`, bytes);
  }
  async getExport(path: string) {
    const bytes = this.exports.get(path);
    if (!bytes) throw new Error(`no ${path}`);
    return bytes;
  }
}

function testIo(answers: string[] = [], interactive = false) {
  const lines: string[] = [];
  const io: Io = {
    interactive,
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    ask: async () => answers.shift() ?? "",
  };
  return { io, lines };
}

let registry: D1Database;
let operator: FakeOperator;
let keys: Awaited<ReturnType<typeof newHostKeys>>;
let out: ReturnType<typeof testIo>;
const ctx = (over: Partial<FleetContext> = {}): FleetContext => ({
  registry,
  operator,
  fleet: {
    environment: "live",
    callbackHostname: "callback.fleet.example",
    domain: "fleet.example",
    secretsPublicKey: keys.secretsPublicKey,
  },
  migrations: migrations(3),
  io: out.io,
  yes: false,
  dryRun: false,
  ...over,
});
const id = (s: string) => s as ClientId;

beforeEach(async () => {
  registry = nodeD1();
  await applyMigrations(registry, registryMigrations(), { table: REGISTRY_MIGRATIONS_TABLE });
  operator = new FakeOperator();
  keys ??= await newHostKeys();
  out = testIo();
});

describe("cos client add (criterion 11)", () => {
  it("makes a working client with no Worker upload, in under a minute, and prints its two hostnames", async () => {
    const started = Date.now();
    expect(
      await addClient(ctx(), { id: "gym-a", locationHint: "oc", webHostname: "gym-a.example" }),
    ).toBe(0);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(await readClient(registry, id("gym-a"))).toMatchObject({
      status: "active",
      schemaVersion: 3,
    });
    const snapshot = await readRegistry(registry);
    expect(snapshot.addresses.get(id("gym-a"))).toMatchObject({
      staff: "gym-a-admin.fleet.example",
      web: "gym-a.example",
    });
    expect(operator.calls).toEqual(["place gym-a", "migrate gym-a"]);
    expect(out.lines.join("\n")).toContain("with no Worker uploaded");
    expect(out.lines.join("\n")).toContain("staff https://gym-a-admin.fleet.example");
    expect(out.lines.join("\n")).toContain("web https://gym-a.example");
    // Once added it is a client: a second add is refused.
    await expect(addClient(ctx(), { id: "gym-a" })).rejects.toThrow(/already a client/);
  });

  it("never puts a client's web app on the fleet's domain beside the staff hostnames (no Public Suffix listing)", async () => {
    await expect(
      addClient(ctx(), { id: "gym-a", webHostname: "gym-a.fleet.example" }),
    ).rejects.toThrow(/never on the fleet's domain/);
    expect(await readClient(registry, id("gym-a"))).toBeNull();
    // With none named, it has only its staff hostname.
    await addClient(ctx(), { id: "gym-a" });
    expect((await readRegistry(registry)).addresses.get(id("gym-a"))?.web).toBeNull();
  });

  it("refuses a web hostname anywhere under the fleet domain's registrable domain, whatever the domain's spelling (review of #526, S3)", async () => {
    // P2: a sibling under the same registrable domain.
    const sibling = ctx({ fleet: { ...ctx().fleet, domain: "clients.fleet.example" } });
    await expect(
      addClient(sibling, { id: "gym-a", webHostname: "www.fleet.example" }),
    ).rejects.toThrow(/never on the fleet's domain/);
    // P3: a fleet domain written in another case, with a trailing dot.
    const spelled = ctx({ fleet: { ...ctx().fleet, domain: "Fleet.Example." } });
    await expect(
      addClient(spelled, { id: "gym-a", webHostname: "shop.fleet.example" }),
    ).rejects.toThrow(/never on the fleet's domain/);
    expect(await readClient(registry, id("gym-a"))).toBeNull();
    expect(canonicalDomain("Fleet.Example.")).toBe("fleet.example");
    expect(canonicalDomain("bücher.example")).toBe("xn--bcher-kva.example");
    expect(canonicalDomain("not a domain")).toBeNull();
    expect(registrableDomain("clients.fleet.example")).toBe("fleet.example");
    expect(registrableDomain("a.fleet.co.uk")).toBe("fleet.co.uk");
    // Its own domain is fine.
    expect(await addClient(sibling, { id: "gym-a", webHostname: "gym-a.example" })).toBe(0);
  });

  it("changes nothing on a dry run", async () => {
    await addClient(ctx({ dryRun: true }), { id: "gym-a" });
    expect(await readClient(registry, id("gym-a"))).toBeNull();
    expect(operator.calls).toEqual([]);
  });

  it("leaves a client that stopped part-way paused and unserved, and a re-run finishes it", async () => {
    operator.throwOn = "gym-a";
    await expect(addClient(ctx(), { id: "gym-a" })).rejects.toThrow(/connection lost/);
    expect(await readClient(registry, id("gym-a"))).toMatchObject({
      status: "paused",
      schemaVersion: null,
    });
    expect((await readRegistry(registry)).clients.get(id("gym-a"))?.status).toBe("paused");
    expect(await addClient(ctx(), { id: "gym-a" })).toBe(0);
    expect(await readClient(registry, id("gym-a"))).toMatchObject({
      status: "active",
      schemaVersion: 3,
    });
    expect(await unfinishedOperation(registry, "add", "gym-a")).toBeNull();
  });

  it("keeps a client whose migration fails paused, and refuses a removed id", async () => {
    operator.failOn = { client: "gym-a", migration: "0002_m.sql" };
    await expect(addClient(ctx(), { id: "gym-a" })).rejects.toThrow(/stays paused/);
    expect((await readClient(registry, id("gym-a")))?.status).toBe("paused");
    await addClient(ctx(), { id: "gym-a" });
    await removeClient(ctx({ yes: true }), "gym-a");
    await expect(addClient(ctx(), { id: "gym-a" })).rejects.toThrow(/never used again/);
  });

  it("can store a client's Stripe keys as given secrets, sealed, never printed", async () => {
    await addClient(ctx(), { id: "gym-a" });
    await setSecret(ctx(), "gym-a", "STRIPE_SECRET_KEY", "sk_live_never_printed_123");
    const row = await registry
      .prepare(
        "SELECT kind FROM registry_secrets WHERE client = 'gym-a' AND name = 'STRIPE_SECRET_KEY'",
      )
      .first<{ kind: string }>();
    expect(row?.kind).toBe("given");
    // Replacing it asks for the client's id first.
    await expect(
      setSecret(ctx(), "gym-a", "STRIPE_SECRET_KEY", "sk_live_other_456"),
    ).rejects.toThrow(/pass --yes/);
    await expect(setSecret(ctx(), "gym-a", "BETTER_AUTH_SECRET", "x".repeat(20))).rejects.toThrow(
      /derived/,
    );
    expect(out.lines.join("\n")).not.toContain("sk_live");
  });
});

describe("cos fleet upgrade with three clients (criterion 12)", () => {
  const update = (over: Partial<FleetUpdateInput> = {}) => {
    const log: string[] = [];
    const input: FleetUpdateInput = {
      from: "1.0.0",
      to: "1.1.0",
      migrations: migrations(5),
      supportedContracts: [1],
      upload: async () => {
        log.push("upload");
      },
      uploadPrevious: async () => {
        log.push("upload-previous");
      },
      smoke: async (hostname) => {
        log.push(`smoke ${hostname}`);
      },
      recordVersion: async (v) => {
        log.push(`version ${v}`);
      },
      ...over,
    };
    return { input, log };
  };
  const three = async () => {
    for (const c of ["gym-a", "gym-b", "gym-c"]) await addClient(ctx(), { id: c });
    operator.calls = [];
  };
  const statusOf = async (c: string) => (await readClient(registry, id(c)))?.status;

  it("migrates each, uploads once and leaves all three on the new version, served", async () => {
    await three();
    const { input, log } = update();
    expect(await fleetUpdate(ctx({ yes: true }), input)).toBe("succeeded");
    // Smoke-checked at the host's own health address: every client is paused then (M1).
    expect(log).toEqual(["upload", "smoke callback.fleet.example", "version 1.1.0"]);
    for (const c of ["gym-a", "gym-b", "gym-c"]) {
      expect(await readClient(registry, id(c))).toMatchObject({
        status: "active",
        schemaVersion: 5,
      });
      expect(operator.db(c).applied.length).toBe(5);
    }
  });

  it("with one client's migration made to fail: that client restored, nothing uploaded, the other two as they were", async () => {
    await three();
    operator.failOn = { client: "gym-b", migration: "0005_m.sql" };
    const { input, log } = update();
    expect(await fleetUpdate(ctx({ yes: true }), input)).toBe("undone");
    expect(log).toEqual([]);
    for (const c of ["gym-a", "gym-b", "gym-c"]) {
      expect(await readClient(registry, id(c))).toMatchObject({
        status: "active",
        schemaVersion: 3,
      });
      expect(operator.db(c).applied.length).toBe(3);
    }
    expect(operator.calls.filter((c) => c.startsWith("restore"))).toEqual([
      "restore gym-a",
      "restore gym-b",
    ]);
  });

  it("stops before changing anything when a client's own extension would stop working (decision 7)", async () => {
    await three();
    operator.extensions["gym-c"] = [
      { id: "own", source: "runtime", status: "active", contract: 0 },
    ];
    const { input, log } = update();
    expect(await fleetUpdate(ctx({ yes: true }), input)).toBe("blocked");
    expect(log).toEqual([]);
    expect(operator.calls.some((c) => c.startsWith("migrate") || c.startsWith("bookmark"))).toBe(
      false,
    );
    expect(await statusOf("gym-a")).toBe("active");
  });

  it("after a failed smoke check, uploads the previous Workers and restores every client", async () => {
    await three();
    const { input, log } = update({
      smoke: async () => {
        throw new Error("version 1.0.0");
      },
    });
    expect(await fleetUpdate(ctx({ yes: true }), input)).toBe("rolled-back");
    expect(log).toEqual(["upload", "upload-previous"]);
    for (const c of ["gym-a", "gym-b", "gym-c"]) {
      expect(await readClient(registry, id(c))).toMatchObject({
        status: "active",
        schemaVersion: 3,
      });
    }
  });

  it("leaves a client the operator paused paused, and undoes a run a crash stopped, on the re-run", async () => {
    await three();
    await pauseClient(ctx(), "gym-c");
    operator.throwOn = "gym-b";
    const { input, log } = update();
    await expect(fleetUpdate(ctx({ yes: true }), input)).rejects.toThrow(/connection lost/);
    // Part-way: every client paused, gym-a migrated.
    expect(await statusOf("gym-a")).toBe("paused");
    expect(operator.db("gym-a").applied.length).toBe(5);
    await expect(resumeClient(ctx(), "gym-a")).rejects.toThrow(/part-way/);
    expect(await fleetUpdate(ctx({ yes: true }), input)).toBe("undone");
    expect(operator.db("gym-a").applied.length).toBe(3);
    expect(await statusOf("gym-a")).toBe("active");
    expect(await statusOf("gym-c")).toBe("paused");
    // And then it runs.
    expect(await fleetUpdate(ctx({ yes: true }), input)).toBe("succeeded");
    expect(await statusOf("gym-c")).toBe("paused");
    expect(log.filter((l) => l === "upload")).toEqual(["upload"]);
  });

  it("refuses to add or import a client while an update is unfinished (review of #526, F-d)", async () => {
    await three();
    operator.throwOn = "gym-b";
    const { input } = update();
    await expect(fleetUpdate(ctx({ yes: true }), input)).rejects.toThrow(/connection lost/);
    await expect(addClient(ctx(), { id: "gym-d" })).rejects.toThrow(/has not finished/);
    expect(await readClient(registry, id("gym-d"))).toBeNull();
    expect(await fleetUpdate(ctx({ yes: true }), input)).toBe("undone");
    expect(await addClient(ctx(), { id: "gym-d" })).toBe(0);
  });

  it("refuses an operator's pause while an update runs, which would resume the client at its end (review of #526, N2)", async () => {
    await three();
    let refused = "";
    const { input } = update({
      upload: async () => {
        refused = await pauseClient(ctx(), "gym-b").then(
          () => "",
          (e: Error) => e.message,
        );
      },
    });
    expect(await fleetUpdate(ctx({ yes: true }), input)).toBe("succeeded");
    expect(refused).toMatch(/while an update .* is unfinished/);
    // Once it has finished, the pause holds.
    expect(await pauseClient(ctx(), "gym-b")).toBe(0);
    expect((await readClient(registry, id("gym-b")))?.status).toBe("paused");
  });

  it("smoke-checks the new Workers even when no client is active", async () => {
    await three();
    for (const c of ["gym-a", "gym-b", "gym-c"]) await pauseClient(ctx(), c);
    const { input, log } = update();
    expect(await fleetUpdate(ctx({ yes: true }), input)).toBe("succeeded");
    expect(log).toContain("smoke callback.fleet.example");
  });

  it("undoes a client whose migrations applied but whose answer was lost (review of #526, M2)", async () => {
    await three();
    operator.applyThenThrowOn = "gym-b";
    const { input } = update();
    await expect(fleetUpdate(ctx({ yes: true }), input)).rejects.toThrow(/answer was lost/);
    expect(operator.db("gym-b").applied.length).toBe(5);
    expect(await fleetUpdate(ctx({ yes: true }), input)).toBe("undone");
    for (const c of ["gym-a", "gym-b", "gym-c"]) {
      expect(operator.db(c).applied.length, c).toBe(3);
      expect(await readClient(registry, id(c))).toMatchObject({
        status: "active",
        schemaVersion: 3,
      });
    }
  });

  it("asks before pausing every client, and a dry run changes nothing", async () => {
    await three();
    const { input } = update();
    await expect(fleetUpdate(ctx(), input)).rejects.toThrow(/pass --yes/);
    expect(await fleetUpdate(ctx({ dryRun: true }), input)).toBe("nothing");
    expect(await statusOf("gym-a")).toBe("active");
  });
});

describe("one operator's command at a time (review of #526, S1)", () => {
  /** Opens the operator as `cos` does: each open sets a new token, which cuts off the last one. */
  function rotatingOpener(target: FakeOperator) {
    let current = 0;
    let opens = 0;
    return {
      opens: () => opens,
      open: async () => {
        opens += 1;
        current += 1;
        const mine = current;
        const live = () => {
          if (mine !== current) throw new Error("401: not the operator");
        };
        return {
          op: async <T>(action: string, body?: Record<string, unknown>) => {
            live();
            return target.op<T>(action, body);
          },
          putFile: async (client: string, key: string, bytes: Uint8Array) => {
            live();
            return target.putFile(client, key, bytes);
          },
          getExport: async (path: string) => {
            live();
            return target.getExport(path);
          },
          close: async () => {
            current += 1;
          },
        };
      },
    };
  }

  it("lets `list` run during an upgrade without cutting it off, and refuses a second command that would", async () => {
    for (const c of ["gym-a", "gym-b"]) await addClient(ctx(), { id: c });
    const opener = rotatingOpener(operator);
    const upgrade = lazyOperator(registry, opener.open, { command: "fleet upgrade live" });
    let refused = "";
    const outcome = await fleetUpdate(ctx({ operator: upgrade, yes: true }), {
      from: "1.0.0",
      to: "1.1.0",
      migrations: migrations(5),
      supportedContracts: [1],
      upload: async () => {
        // A second terminal, mid-upgrade: `list` reads the registry only.
        const listing = lazyOperator(registry, opener.open, { command: "client list" });
        expect(await listClientsCommand(ctx({ operator: listing }))).toBe(0);
        await listing.close();
        // A command that needs the operator's Worker is refused before it changes anything.
        const adding = lazyOperator(registry, opener.open, { command: "client add" });
        refused = await addClient(ctx({ operator: adding }), { id: "gym-c" }).then(
          () => "",
          (e: Error) => e.message,
        );
        await adding.close();
      },
      uploadPrevious: async () => {},
      smoke: async () => {},
      recordVersion: async () => {},
    });
    expect(outcome).toBe("succeeded");
    expect(opener.opens()).toBe(1);
    expect(refused).toMatch(/holds the operator's Worker/);
    expect(await readClient(registry, id("gym-c"))).toBeNull();
    // Given back at the end: the next command takes it.
    await upgrade.close();
    const next = lazyOperator(registry, opener.open, { command: "client add" });
    expect(await addClient(ctx({ operator: next }), { id: "gym-c" })).toBe(0);
    await next.close();
  });

  it("leaves the Worker to the run that took the session over: the older run's close does not cut it off (review of #526, N1)", async () => {
    const opener = rotatingOpener(operator);
    const a = lazyOperator(registry, opener.open, { command: "client export" });
    await a.op("health");
    const b = lazyOperator(registry, opener.open, { command: "client remove", takeOver: true });
    await b.op("health");
    // A is refused now, and closing it changes nothing of B's.
    await expect(a.op("health")).rejects.toThrow(/holds the operator's Worker/);
    await a.close();
    await expect(b.op("health")).resolves.toBeTruthy();
    // And B, having taken it over once, never takes it from a later command.
    await b.close();
    const c = lazyOperator(registry, opener.open, { command: "client add" });
    await c.op("health");
    await expect(b.op("health")).rejects.toThrow(/holds the operator's Worker/);
    await c.close();
  });

  it("keeps a live run's session from lapsing, however long it goes between calls (N1)", async () => {
    const opener = rotatingOpener(operator);
    let clock = 0;
    const a = lazyOperator(registry, opener.open, {
      command: "fleet upgrade live",
      now: () => clock,
      heartbeatMs: 5,
    });
    await a.op("health");
    // 20 minutes later, A still alive (a long upload, a long migration): its heartbeat renews.
    clock = 20 * 60_000;
    await new Promise((resolve) => setTimeout(resolve, 40));
    // 40 minutes in: past A's first 30, but not past its renewal.
    clock = 40 * 60_000;
    const late = lazyOperator(registry, opener.open, { command: "client add", now: () => clock });
    await expect(late.op("health")).rejects.toThrow(/holds the operator's Worker/);
    await expect(a.op("health")).resolves.toBeTruthy();
    await a.close();
  });

  it("waits for a heartbeat in flight when it closes, so the session row does not come back (review of #530, R4)", async () => {
    const opener = rotatingOpener(operator);
    // A slow registry: each renewal of the session takes 60 ms to land.
    const slow = {
      ...registry,
      prepare: (sql: string) => {
        const inner = registry.prepare(sql);
        if (!sql.includes("INSERT INTO registry_operator_session")) return inner;
        return {
          ...inner,
          bind: (...values: unknown[]) => {
            const bound = inner.bind(...values);
            return {
              ...bound,
              run: async () => {
                await new Promise((resolve) => setTimeout(resolve, 60));
                return bound.run();
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const a = lazyOperator(slow, opener.open, { command: "client export", heartbeatMs: 10 });
    await a.op("health");
    // A heartbeat is now sent and not yet landed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await a.close();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const row = await registry
      .prepare("SELECT holder FROM registry_operator_session WHERE id = 'operator'")
      .first();
    expect(row).toBeNull();
    // The next command takes it without --take-over.
    const next = lazyOperator(registry, opener.open, { command: "client add" });
    await expect(next.op("health")).resolves.toBeTruthy();
    await next.close();
  });

  it("takes over a session a killed command left only when its time ran out, or deliberately", async () => {
    const opener = rotatingOpener(operator);
    const killed = lazyOperator(registry, opener.open, { command: "client export", now: () => 0 });
    await killed.op("health");
    // Still held: refused.
    const early = lazyOperator(registry, opener.open, { command: "client add", now: () => 1_000 });
    await expect(early.op("health")).rejects.toThrow(/until/);
    // Its time ran out: taken.
    const late = lazyOperator(registry, opener.open, {
      command: "client add",
      now: () => 31 * 60_000,
    });
    await late.op("health");
    // Taken over deliberately, however recent.
    const over = lazyOperator(registry, opener.open, {
      command: "client remove",
      now: () => 31 * 60_000 + 1,
      takeOver: true,
    });
    await over.op("health");
    expect(opener.opens()).toBe(3);
  });
});

describe("a client's sender domains (issue #529)", () => {
  it("are added unverified, verified only once the operator confirms what it is confirming, and removed only when asked", async () => {
    await addClient(ctx(), { id: "gym-a" });
    // Not the fleet's own domain, nor a shared mail domain.
    await expect(senderCommand(ctx(), "add", "gym-a", "news.fleet.example")).rejects.toThrow(
      /fleet's own/,
    );
    await expect(senderCommand(ctx(), "add", "gym-a", "gmail.com")).rejects.toThrow(/shared mail/);
    expect(await senderCommand(ctx(), "add", "gym-a", "gym-a.example")).toBe(0);
    expect(await listSenderDomains(registry, "gym-a")).toMatchObject([
      { domain: "gym-a.example", verified: false },
    ]);
    // Verifying asks, and says what the operator confirms.
    const asked: string[] = [];
    const io = { ...testIo([], true).io, ask: async (q: string) => (asked.push(q), "gym-a") };
    await expect(senderCommand(ctx(), "verify", "gym-a", "gym-a.example")).rejects.toThrow(
      /pass --yes/,
    );
    expect(await senderCommand(ctx({ io }), "verify", "gym-a", "gym-a.example")).toBe(0);
    expect(asked[0]).toMatch(/onboarded to Email Sending in this deployment's Cloudflare account/);
    expect((await listSenderDomains(registry, "gym-a"))[0]?.verified).toBe(true);
    expect(await senderCommand(ctx(), "unverify", "gym-a", "gym-a.example")).toBe(0);
    expect((await listSenderDomains(registry, "gym-a"))[0]?.verified).toBe(false);
    await expect(senderCommand(ctx(), "remove", "gym-a", "gym-a.example")).rejects.toThrow(
      /pass --yes/,
    );
    expect(await senderCommand(ctx({ yes: true }), "remove", "gym-a", "gym-a.example")).toBe(0);
    expect(await listSenderDomains(registry, "gym-a")).toEqual([]);
  });

  it("go with an export, and come in with an import unverified", async () => {
    await addClient(ctx(), { id: "gym-a" });
    await senderCommand(ctx(), "add", "gym-a", "gym-a.example");
    await senderCommand(ctx({ yes: true }), "verify", "gym-a", "gym-a.example");
    const dir = join(mkdtempSync(join(tmpdir(), "s66s7-")), "export");
    await exportClient(ctx(), { id: "gym-a", out: dir, leaving: true });
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).senderDomains).toEqual([
      "gym-a.example",
    ]);
    // Imported as another client while the first still holds it: named, not added.
    await importClient(ctx(), { id: "gym-b", from: dir });
    expect(await listSenderDomains(registry, "gym-b")).toEqual([]);
    expect(out.lines.join("\n")).toContain("sender domain gym-a.example: not added");
    await senderCommand(ctx({ yes: true }), "remove", "gym-a", "gym-a.example");
    await importClient(ctx(), { id: "gym-c", from: dir });
    expect(await listSenderDomains(registry, "gym-c")).toMatchObject([
      { domain: "gym-a.example", verified: false },
    ]);
  });
});

describe("export, import and remove (criterion 13)", () => {
  it("exports a client with its files and secrets, and imports it as a new client with every count and file hash the same", async () => {
    await addClient(ctx(), { id: "gym-a" });
    operator.db("gym-a").rows = { core_person: 12, core_settings: 3 };
    operator.files.set("gym-a/media/one.jpg", new Uint8Array([1, 2, 3]));
    operator.files.set("gym-a/media/two.pdf", new Uint8Array([4, 5]));
    operator.secrets["gym-a"] = { BETTER_AUTH_SECRET: "derived-staff-secret-value-0123456789" };
    const dir = join(mkdtempSync(join(tmpdir(), "s66s7-")), "export");
    expect(await exportClient(ctx(), { id: "gym-a", out: dir })).toBe(0);
    expect(await readClient(registry, id("gym-a"))).toMatchObject({ status: "active" });
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.database.counts).toEqual({ core_person: 12, core_settings: 3 });
    expect(manifest.files.map((f: { key: string }) => f.key)).toEqual([
      "media/one.jpg",
      "media/two.pdf",
    ]);
    expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    // No key material in what was printed.
    expect(out.lines.join("\n")).not.toContain("derived-staff-secret-value");

    // Its records name two videos; this account's Stream holds one of them.
    const held = "a".repeat(32);
    const elsewhere = "b".repeat(32);
    operator.mediaVideos["gym-b"] = [held, elsewhere];
    const stamped: string[] = [];
    const videos = {
      setCreator: async (uid: string, creator: string) => {
        stamped.push(`${uid}=${creator}`);
        return uid === held;
      },
    };
    expect(await importClient(ctx({ videos }), { id: "gym-b", from: dir })).toBe(0);
    // Re-stamped with the creator step 5's video host checks: `<environment>:<client>`.
    expect(stamped).toEqual([`${held}=live:gym-b`, `${elsewhere}=live:gym-b`]);
    expect(out.lines.join("\n")).toContain(`1 not in this account's Stream`);
    expect(await readClient(registry, id("gym-b"))).toMatchObject({
      status: "active",
      imported: true,
      schemaVersion: 3,
    });
    expect(operator.db("gym-b").rows).toEqual(operator.db("gym-a").rows);
    expect(operator.files.get("gym-b/media/one.jpg")).toEqual(new Uint8Array([1, 2, 3]));
    const imported = await registry
      .prepare("SELECT name, kind FROM registry_secrets WHERE client = 'gym-b'")
      .all<{ name: string; kind: string }>();
    expect(imported.results).toEqual([{ name: "BETTER_AUTH_SECRET", kind: "imported" }]);
    expect(operator.calls).toContain("requeue-embeddings gym-b");
    // An import over an existing client is refused.
    await expect(importClient(ctx(), { id: "gym-b", from: dir })).rejects.toThrow(
      /already a client/,
    );
  });

  it("refuses a database part that is not what was exported, before writing anything", async () => {
    await addClient(ctx(), { id: "gym-a" });
    const dir = join(mkdtempSync(join(tmpdir(), "s66s7-")), "export");
    await exportClient(ctx(), { id: "gym-a", out: dir });
    const part = join(dir, "database", "000000.json");
    writeFileSync(part, readFileSync(part, "utf8").replace("applied", "applieD"));
    await expect(importClient(ctx(), { id: "gym-b", from: dir })).rejects.toThrow(
      /database\/000000.json is not what was exported/,
    );
    expect(await readClient(registry, id("gym-b"))).toBeNull();
  });

  it("refuses an export whose staff secret is too weak to sign sessions, before writing anything (S5)", async () => {
    await addClient(ctx(), { id: "gym-a" });
    operator.secrets["gym-a"] = { BETTER_AUTH_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    const dir = join(mkdtempSync(join(tmpdir(), "s66s7-")), "export");
    await exportClient(ctx(), { id: "gym-a", out: dir });
    await expect(importClient(ctx(), { id: "gym-b", from: dir })).rejects.toThrow(/too weak/);
    expect(await readClient(registry, id("gym-b"))).toBeNull();
  });

  it("refuses an export folder that was changed after it was made, before writing anything", async () => {
    await addClient(ctx(), { id: "gym-a" });
    operator.files.set("gym-a/a.txt", new Uint8Array([1]));
    const dir = join(mkdtempSync(join(tmpdir(), "s66s7-")), "export");
    await exportClient(ctx(), { id: "gym-a", out: dir });
    writeFileSync(join(dir, "files", "a.txt"), "changed");
    await expect(importClient(ctx(), { id: "gym-b", from: dir })).rejects.toThrow(
      /not what was exported/,
    );
    expect(await readClient(registry, id("gym-b"))).toBeNull();
  });

  it("removes a client only once its id is typed, after an export kept 90 days, and keeps the id for good", async () => {
    await addClient(ctx(), { id: "gym-a" });
    await addClient(ctx(), { id: "gym-b" });
    operator.files.set("gym-a/x", new Uint8Array([1]));
    operator.files.set("gym-b/x", new Uint8Array([2]));
    operator.kv.add("gym-a/grant");
    operator.vectors.add("gym-a/v1");
    // Not confirmed: nothing changes.
    await expect(removeClient(ctx(), "gym-a")).rejects.toThrow(/pass --yes/);
    await expect(removeClient(ctx({ io: testIo(["gym-b"], true).io }), "gym-a")).rejects.toThrow(
      /Not confirmed/,
    );
    expect(await readClient(registry, id("gym-a"))).not.toBeNull();
    expect(operator.calls.some((c) => c.startsWith("export"))).toBe(false);
    // Typed: exported, erased, its stores emptied, its rows gone and its id kept.
    expect(await removeClient(ctx({ io: testIo(["gym-a"], true).io }), "gym-a")).toBe(0);
    expect(
      [...operator.exports.keys()].some(
        (k) => k.startsWith("gym-a/") && k.endsWith("manifest.json"),
      ),
    ).toBe(true);
    expect(operator.db("gym-a").erased).toBe(true);
    expect(operator.files.has("gym-a/x")).toBe(false);
    expect(operator.files.has("gym-b/x")).toBe(true);
    expect(operator.kv.size + operator.vectors.size).toBe(0);
    expect(await readClient(registry, id("gym-a"))).toBeNull();
    expect(await wasRemoved(registry, "gym-a")).toBe(true);
    expect(await readClient(registry, id("gym-b"))).toMatchObject({ status: "active" });
  });

  it("carries a removal a crash stopped to its end on the re-run, the client served nowhere meanwhile", async () => {
    await addClient(ctx(), { id: "gym-a" });
    operator.files.set("gym-a/x", new Uint8Array([1]));
    const real = operator.op.bind(operator);
    let failed = false;
    operator.op = async <T>(action: string, body?: Record<string, unknown>) => {
      if (action === "files-delete-page" && !failed) {
        failed = true;
        throw new Error("connection lost");
      }
      return real<T>(action, body);
    };
    await expect(removeClient(ctx({ yes: true }), "gym-a")).rejects.toThrow(/connection lost/);
    expect((await readClient(registry, id("gym-a")))?.status).toBe("moving");
    expect(await removeClient(ctx({ yes: true }), "gym-a")).toBe(0);
    expect(await wasRemoved(registry, "gym-a")).toBe(true);
    expect(operator.files.size).toBe(0);
  });
});

describe("the keys file", () => {
  it("is written only outside a git working tree, mode 0600, never replaced, and read back only private", async () => {
    const outside = mkdtempSync(join(tmpdir(), "s66s7-keys-"));
    const keysFile = join(outside, "live.json");
    const made = await newFleetKeys("live");
    writeKeysFile(keysFile, made);
    expect(statSync(keysFile).mode & 0o777).toBe(0o600);
    expect(() => writeKeysFile(keysFile, made)).toThrow(/exists/);
    const repo = mkdtempSync(join(tmpdir(), "s66s7-repo-"));
    mkdirSync(join(repo, ".git"));
    expect(() => writeKeysFile(join(repo, "keys.json"), made)).toThrow(/git working tree/);
    const seen: string[] = [];
    const read = await readKeysFile(keysFile, (v) => seen.push(v));
    expect(read.propsKey).toBe(made.propsKey);
    expect(seen).toEqual(
      expect.arrayContaining([
        made.rootKey,
        made.secretsPrivateKey,
        made.bindingKey,
        made.propsKey,
      ]),
    );
    expect(made.bindingKey).not.toBe(made.propsKey);
  });

  it("is tied to its deployment: another file is refused by its public key or its keys' fingerprint (review of #526, S2)", async () => {
    const mine = await newFleetKeys("live");
    const other = await newFleetKeys("live");
    const fleet = {
      secretsPublicKey: mine.secretsPublicKey,
      keysFingerprint: keysFingerprint(mine),
    };
    expect(keysMismatch(fleet, mine)).toBeNull();
    expect(keysMismatch(fleet, other)).toMatch(/public key/);
    // The same sealing key with other binding or props keys.
    expect(keysMismatch(fleet, { ...mine, propsKey: other.propsKey })).toMatch(
      /root, binding or props/,
    );
    expect(keysMismatch(fleet, { ...mine, bindingKey: other.bindingKey })).toMatch(
      /root, binding or props/,
    );
    expect(keysFingerprint(mine)).not.toContain(mine.propsKey);
  });

  it("is made by cos fleet keys, which prints the public key and no key material", async () => {
    const { runIn, startWorld } = await import("./world.ts");
    const world = await startWorld();
    try {
      const path = join(mkdtempSync(join(tmpdir(), "s66s7-keys-")), "live.json");
      const { code, output } = await runIn(world, "fleet", "keys", "--env", "live", "--out", path);
      expect(code, output).toBe(0);
      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(output).toContain(written.secretsPublicKey);
      for (const name of ["rootKey", "secretsPrivateKey", "bindingKey", "propsKey"]) {
        expect(output).not.toContain(written[name]);
      }
      const refused = await runIn(world, "fleet", "keys", "--env", "live", "--out", path);
      expect(refused.code).toBe(1);
    } finally {
      world.server.close();
    }
  });
});

describe("cos fleet install", () => {
  it("installs a host of many clients: its registry migrated, cos-client-db and the operator's Worker, and the keys set", async () => {
    const { buildFixtureRelease } = await import("@composable-os/release/testing");
    const { runIn, startWorld } = await import("./world.ts");
    const world = await startWorld();
    try {
      await world.github.publish(await buildFixtureRelease({ version: "1.0.0", fleet: true }));
      const keysPath = join(mkdtempSync(join(tmpdir(), "s66s7-keys-")), "live.json");
      expect((await runIn(world, "fleet", "keys", "--env", "live", "--out", keysPath)).code).toBe(
        0,
      );
      const keysFile = JSON.parse(readFileSync(keysPath, "utf8"));
      const args = [
        "fleet",
        "install",
        "--env",
        "live",
        "--keys-file",
        keysPath,
        "--callback-hostname",
        "callback.fleet.example",
        "--domain",
        "fleet.example",
      ];
      const { code, output } = await runIn(world, ...args);
      expect(code, output).toBe(0);
      expect([...world.cf.scripts.keys()].sort()).toEqual([
        "demo-app",
        "demo-client-db",
        "demo-operator",
        "demo-runner",
      ]);
      const registry = [...world.cf.d1.values()].find((d) => d.name === "demo-registry");
      const applied = await registry?.engine.query(
        "SELECT name FROM registry_migrations ORDER BY name",
        [],
      );
      expect(applied?.map((r) => r.name)).toContain("0795_registry_operator.sql");
      expect(world.cf.scripts.get("demo-app")?.secrets.get("COS_PROPS_KEY")).toBe(
        keysFile.propsKey,
      );
      for (const name of ["rootKey", "secretsPrivateKey", "bindingKey", "propsKey"]) {
        expect(output).not.toContain(keysFile[name]);
      }
      // A re-run converges: nothing is made twice.
      const again = await runIn(world, ...args);
      expect(again.code, again.output).toBe(0);
      expect([...world.cf.d1.values()].filter((d) => d.name === "demo-registry").length).toBe(1);
      // Another keys file is refused, on install and on upgrade, before any key is set (S2).
      const otherPath = join(mkdtempSync(join(tmpdir(), "s66s7-keys-")), "other.json");
      expect((await runIn(world, "fleet", "keys", "--env", "live", "--out", otherPath)).code).toBe(
        0,
      );
      const swapped = args.map((a) => (a === keysPath ? otherPath : a));
      const refused = await runIn(world, ...swapped);
      expect(refused.code).toBe(1);
      expect(refused.output).toContain("is not this live deployment's");
      const upgrade = await runIn(
        world,
        "fleet",
        "upgrade",
        "--env",
        "live",
        "--keys-file",
        otherPath,
        "--yes",
      );
      expect(upgrade.code).toBe(1);
      expect(upgrade.output).toContain("is not this live deployment's");
      expect(world.cf.scripts.get("demo-app")?.secrets.get("COS_PROPS_KEY")).toBe(
        keysFile.propsKey,
      );
    } finally {
      world.server.close();
    }
  });
});

describe("cos fleet install for the staging check (fleet-staging-check.yml)", () => {
  it("takes a product from a file, with AI off and a location, chosen at the first install only", async () => {
    const { buildFixtureRelease, FIXTURE_PRODUCT_DEFINITION } = await import(
      "@composable-os/release/testing"
    );
    const { runIn, startWorld } = await import("./world.ts");
    const world = await startWorld();
    try {
      await world.github.publish(await buildFixtureRelease({ version: "1.0.0", fleet: true }));
      const dir = mkdtempSync(join(tmpdir(), "s66s7-product-"));
      const productFile = join(dir, "product.json");
      writeFileSync(productFile, JSON.stringify(FIXTURE_PRODUCT_DEFINITION));
      const keysPath = join(dir, "staging.json");
      const keys = await runIn(world, "fleet", "keys", "--env", "staging", "--out", keysPath);
      expect(keys.code, keys.output).toBe(0);
      const args = [
        "fleet",
        "install",
        "--env",
        "staging",
        "--keys-file",
        keysPath,
        "--callback-hostname",
        "callback.staging.example",
        "--domain",
        "staging.example",
        "--product-file",
        productFile,
      ];
      const { code, output } = await runIn(world, ...args, "--ai", "off", "--location", "oc");
      expect(code, output).toBe(0);
      expect([...world.cf.scripts.keys()].sort()).toEqual([
        "demo-app-staging",
        "demo-client-db-staging",
        "demo-operator-staging",
        "demo-runner-staging",
      ]);
      expect(world.cf.creates).toContainEqual({
        type: "d1",
        name: "demo-registry-staging",
        locationHint: "oc",
      });
      // AI off: no search index made, and the operator's Worker binds none.
      expect(world.cf.vectorize.size).toBe(0);
      expect(world.cf.liveBinding("demo-operator-staging", "VECTORIZE")).toBeUndefined();
      // A fleet that exists keeps what its first install chose.
      const again = await runIn(world, ...args, "--location", "weur");
      expect(again.code).toBe(1);
      expect(again.output).toContain("chosen at the first install");
      expect((await runIn(world, ...args)).code).toBe(0);
      // One product, one way.
      const both = await runIn(world, ...args, "--product", "demo");
      expect(both.output).toContain("give one");
      writeFileSync(productFile, JSON.stringify({ ...FIXTURE_PRODUCT_DEFINITION, id: "Bad Id" }));
      const bad = await runIn(world, ...args);
      expect(bad.code).toBe(1);
      expect(bad.output).toContain("--product-file");
    } finally {
      world.server.close();
    }
  });
});

describe("the staging check's forced failure (COS_FLEET_FORCE_FAILURE)", () => {
  const inCheck = {
    GITHUB_ACTIONS: "true",
    GITHUB_WORKFLOW_REF: "o/r/.github/workflows/fleet-staging-check.yml@refs/heads/main",
  };
  const where = { environment: "staging", productId: "cosstg-123" };

  it("is refused anywhere but a staging fleet of the check's product, in that workflow's run", async () => {
    const { forcedFailure } = await import("../src/fleet/forced-failure.ts");
    expect(forcedFailure({ ...inCheck }, where)).toBeNull();
    expect(forcedFailure({ ...inCheck, COS_FLEET_FORCE_FAILURE: "smoke" }, where)).toEqual({
      kind: "smoke",
    });
    expect(
      forcedFailure({ ...inCheck, COS_FLEET_FORCE_FAILURE: "migration:gym-b" }, where),
    ).toEqual({ kind: "migration", client: "gym-b" });
    const refused: [Record<string, string>, typeof where][] = [
      [
        { ...inCheck, COS_FLEET_FORCE_FAILURE: "smoke" },
        { ...where, environment: "live" },
      ],
      [
        { ...inCheck, COS_FLEET_FORCE_FAILURE: "smoke" },
        { ...where, productId: "crm" },
      ],
      [{ COS_FLEET_FORCE_FAILURE: "smoke" }, where],
      [
        {
          GITHUB_ACTIONS: "true",
          GITHUB_WORKFLOW_REF: "o/r/.github/workflows/release.yml@refs/tags/v1.0.0",
          COS_FLEET_FORCE_FAILURE: "smoke",
        },
        where,
      ],
      [{ ...inCheck, COS_FLEET_FORCE_FAILURE: "migration:../x" }, where],
      [{ ...inCheck, COS_FLEET_FORCE_FAILURE: "upload" }, where],
    ];
    for (const [env, at] of refused) {
      expect(() => forcedFailure(env, at), JSON.stringify([env, at])).toThrow(/refused here/);
    }
  });

  it("fails the named client's migration only: every client migrated before it restored, nothing uploaded", async () => {
    const { FORCED_MIGRATION, withForcedMigration } = await import(
      "../src/fleet/forced-failure.ts"
    );
    for (const c of ["gym-a", "gym-b"]) await addClient(ctx(), { id: c });
    // What each client's migrate call carried, seen beneath the forcing wrapper.
    const carried: Record<string, string[]> = {};
    const forced = withForcedMigration(
      {
        op: (action, body = {}) => {
          if (action === "migrate") {
            carried[body.client as string] = (body.migrations as Migration[]).map((m) => m.name);
          }
          return operator.op(action, body);
        },
        putFile: (client, key, bytes) => operator.putFile(client, key, bytes),
        getExport: (p) => operator.getExport(p),
      },
      "gym-b",
    );
    operator.failOn = { client: "gym-b", migration: FORCED_MIGRATION.name };
    const log: string[] = [];
    const outcome = await fleetUpdate(ctx({ operator: forced, yes: true }), {
      from: "1.0.0",
      to: "1.1.0",
      migrations: migrations(3),
      supportedContracts: [1],
      upload: async () => {
        log.push("upload");
      },
      uploadPrevious: async () => {
        log.push("upload-previous");
      },
      smoke: async () => {},
      recordVersion: async () => {},
    });
    expect(outcome).toBe("undone");
    expect(log).toEqual([]);
    expect(carried["gym-a"]).not.toContain(FORCED_MIGRATION.name);
    expect(carried["gym-b"]).toContain(FORCED_MIGRATION.name);
    expect(out.lines.join("\n")).toMatch(/stopped before any upload: gym-a, gym-b restored/);
    for (const c of ["gym-a", "gym-b"]) {
      expect(await readClient(registry, id(c))).toMatchObject({
        status: "active",
        schemaVersion: 3,
      });
    }
  });

  it("is refused by cos fleet upgrade on a live fleet before anything is read", async () => {
    const { runIn, startWorld } = await import("./world.ts");
    const world = await startWorld();
    try {
      world.env = { ...world.env, ...inCheck, COS_FLEET_FORCE_FAILURE: "smoke" };
      const { code, output } = await runIn(
        world,
        "fleet",
        "upgrade",
        "--env",
        "live",
        "--keys-file",
        "/nonexistent/keys.json",
        "--yes",
      );
      expect(code).toBe(1);
      expect(output).toContain("refused here: this is not a staging fleet");
      expect(world.cf.calls).toEqual([]);
    } finally {
      world.server.close();
    }
  });
});

describe("an export installed in another account (criterion 13)", () => {
  it("gives a single-client deployment with every row count and file hash the same, its staff secret kept", async () => {
    const { buildFixtureRelease, BASE_MIGRATIONS } = await import("@composable-os/release/testing");
    const { exportDatabase } = await import("@composable-os/db/sql-export");
    const { migrationOf } = await import("@composable-os/db/sql-split");
    const { createHash } = await import("node:crypto");
    const { runIn, startWorld } = await import("./world.ts");
    // The client's database as its host would export it: the release's schema, some rows.
    const source = nodeD1();
    await applyMigrations(
      source,
      BASE_MIGRATIONS.map(([name, sql]) => migrationOf(name, sql)),
    );
    for (const key of ["a", "b", "c"]) {
      await source
        .prepare("INSERT INTO core_settings (key, value, updated_at) VALUES (?, '1', '2026-11-27')")
        .bind(key)
        .run();
    }
    const dir = mkdtempSync(join(tmpdir(), "s66s7-export-"));
    mkdirSync(join(dir, "database"));
    mkdirSync(join(dir, "files", "media"), { recursive: true });
    const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
    const parts: { path: string; sha256: string; statements: number }[] = [];
    let counts: Record<string, number> = {};
    for await (const part of exportDatabase(source, { hold: "caller-paused" })) {
      const text = JSON.stringify(part);
      const path = `database/${String(part.index).padStart(6, "0")}.json`;
      writeFileSync(join(dir, path), text);
      parts.push({ path, sha256: sha(text), statements: part.statements.length });
      counts = part.counts ?? counts;
    }
    const files = [
      { key: "media/a.txt", bytes: new Uint8Array([7, 7, 7]) },
      { key: "media/b.bin", bytes: new Uint8Array([1, 2]) },
    ];
    for (const f of files) writeFileSync(join(dir, "files", f.key), f.bytes);
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        format: "cos-client-export/1",
        client: "gym-a",
        environment: "live",
        generation: "0".repeat(32),
        exportedAt: "2026-11-27T00:00:00Z",
        schemaVersion: 160,
        database: { parts, counts },
        files: files.map((f) => ({ key: f.key, size: f.bytes.length, sha256: sha(f.bytes) })),
        videos: "not exported",
      }),
    );
    const staffSecret = "exported-staff-secret-0123456789abcdef";
    writeFileSync(
      join(dir, "secrets.json"),
      JSON.stringify({
        client: "gym-a",
        derived: { BETTER_AUTH_SECRET: staffSecret, SUPPORT_COOKIE_SECRET: "s".repeat(40) },
        given: {},
      }),
      { mode: 0o600 },
    );

    const world = await startWorld();
    try {
      await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
      const { code, output } = await runIn(world, "install", "--yes", "--import", dir);
      expect(code, output).toBe(0);
      const db = [...world.cf.d1.values()].find((d) => d.name === "demo");
      const rows = await db?.engine.query("SELECT count(*) AS n FROM core_settings", []);
      expect(rows?.[0]?.n).toBe(counts.core_settings);
      for (const f of files) {
        expect(sha(world.cf.r2Objects.get(`demo-blobs/${f.key}`) as Uint8Array)).toBe(sha(f.bytes));
      }
      expect(world.cf.scripts.get("demo-app")?.secrets.get("BETTER_AUTH_SECRET")).toBe(staffSecret);
      expect(output).toContain("not set from the export");
      expect(output).not.toContain(staffSecret);
      // A second import into an install that exists is refused.
      const again = await runIn(world, "install", "--yes", "--import", dir);
      expect(again.code).toBe(1);
      expect(again.output).toContain("makes a new install");
    } finally {
      world.server.close();
    }
  });
});
