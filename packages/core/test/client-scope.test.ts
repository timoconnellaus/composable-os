// Stage 66 step 5 (criterion 5, ADR 0617): what core keeps at module level is kept per client.
// Two clients' databases in one isolate (the suite's own, `env.DB`, and test/other-client.ts's),
// each in its own scope as a many-client host's entries run them: a test per cache, each failing
// if the cache were one value for the isolate, plus the refusal of code outside every scope and
// the single-client path (no store) unchanged.

import { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cacheApiWidgetCache, memoryWidgetCache, widgetCacheKey } from "../src/dashboards/cache.ts";
import { forgetSchemaNames, schemaNames } from "../src/dashboards/run.ts";
import {
  type ClientScope,
  clearEntitlementsCache,
  clientScopesHeld,
  clientState,
  currentClientId,
  fieldStorage,
  getObject,
  listObjects,
  loadEntitlements,
  NoClientScopeError,
  objectTableOf,
  provideClientScope,
  refreshSchemaRegistry,
  runInClientScope,
} from "../src/index.ts";
import {
  forgetFailedItems,
  itemFailed,
  markFailed,
  type VisiblePackItem,
} from "../src/today/pack.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { db } from "./helpers.ts";
import {
  asOtherClient,
  OTHER_MAX_USERS,
  OTHER_OBJECT,
  otherClient,
  otherDatabase,
  otherDb,
} from "./other-client.ts";

const OWN: ClientScope = { database: env.DB, client: "own-client" };
const asOwnClient = <T>(run: () => T) => runInClientScope(OWN, run);

/** Lets the other side of a `Promise.all` run between two steps. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 5));

const OWN_EXTENSION = extId("ownclient");
const OWN_OBJECT = `${OWN_EXTENSION}.gadget`;

// The suite in its two-client mode gives core a store of its own; this file then has nothing to add.
describe.skipIf(clientScopesHeld())("module-level state on a host that serves many clients", () => {
  beforeAll(async () => {
    await otherClient();
    await reconcile(
      manifest(OWN_EXTENSION, {
        objects: {
          gadget: {
            label: "Gadget",
            plural: "Gadgets",
            titleField: "name",
            fields: { name: { type: "text", label: "Name", required: true } },
          },
        },
      }),
    );
    provideClientScope(new AsyncLocalStorage<ClientScope>(), { unscoped: "refuse" });
  });

  afterAll(() => provideClientScope(null));

  it("refuses code outside every client's scope, rather than give it another's", () => {
    expect(() => getObject("person")).toThrow(NoClientScopeError);
    expect(() => currentClientId()).toThrow(NoClientScopeError);
    expect(asOwnClient(() => currentClientId())).toBe("own-client");
  });

  it("keeps each client's extension schema apart, also when their requests interleave", async () => {
    const own = asOwnClient(async () => {
      await refreshSchemaRegistry(db.query);
      await turn();
      return {
        mine: Boolean(getObject(OWN_OBJECT)),
        theirs: Boolean(getObject(OTHER_OBJECT)),
        table: objectTableOf(OWN_OBJECT),
        storage: fieldStorage(OWN_OBJECT, "name")?.extension,
        listed: listObjects().map((o) => o.name),
      };
    });
    const other = asOtherClient(async () => {
      await turn();
      await refreshSchemaRegistry(otherDb.query);
      await turn();
      return {
        mine: Boolean(getObject(OTHER_OBJECT)),
        theirs: Boolean(getObject(OWN_OBJECT)),
        table: objectTableOf(OWN_OBJECT),
        listed: listObjects().map((o) => o.name),
      };
    });
    const [a, b] = await Promise.all([own, other]);
    expect(a).toMatchObject({ mine: true, theirs: false, storage: OWN_EXTENSION });
    expect(a.table).toBeTruthy();
    expect(a.listed).toContain(OWN_OBJECT);
    expect(a.listed).not.toContain(OTHER_OBJECT);
    expect(b).toMatchObject({ mine: true, theirs: false, table: undefined });
    expect(b.listed).not.toContain(OWN_OBJECT);
    // Each still holds its own afterwards: neither refresh replaced the other's.
    expect(asOwnClient(() => Boolean(getObject(OTHER_OBJECT)))).toBe(false);
    expect(asOtherClient(() => Boolean(getObject(OWN_OBJECT)))).toBe(false);
  });

  it("keeps each client's plan apart", async () => {
    clearEntitlementsCache();
    const theirs = await asOtherClient(() => loadEntitlements(otherDb.query));
    expect(theirs?.maxUsers).toBe(OTHER_MAX_USERS);
    // Within the 60 seconds the other client's plan is cached, the own client reads its own.
    const own = await asOwnClient(() => loadEntitlements(db.query));
    expect(own?.maxUsers ?? null).not.toBe(OTHER_MAX_USERS);
  });

  it("keeps each client's schema names apart (dashboards' and Today's validator)", async () => {
    forgetSchemaNames();
    const view = `x_${extId("ownview")}_v`;
    await env.DB.prepare(`CREATE VIEW ${view} AS SELECT 1 AS one`).run();
    try {
      const own = await asOwnClient(() => schemaNames(db.query));
      expect(own.has(view)).toBe(true);
      const theirs = await asOtherClient(() => schemaNames(otherDb.query));
      expect(theirs.has(view)).toBe(false);
    } finally {
      await env.DB.prepare(`DROP VIEW ${view}`).run();
      forgetSchemaNames();
    }
  });

  it("keeps Today's failed items apart: an item failing on one client's schema is tried on another's", async () => {
    forgetFailedItems();
    const item = { key: "pack.item", today: "SELECT nothing" } as unknown as VisiblePackItem;
    expect(asOwnClient(() => itemFailed(item))).toBe(false);
    const quiet = console.error;
    console.error = () => {};
    try {
      asOwnClient(() => markFailed(item, new Error("no such column")));
    } finally {
      console.error = quiet;
    }
    expect(asOwnClient(() => itemFailed(item))).toBe(true);
    expect(asOtherClient(() => itemFailed(item))).toBe(false);
    forgetFailedItems();
  });

  it("puts the client in the shared widget cache's key, and caches nothing for code that names none", async () => {
    const parts = { sql: "SELECT 1", params: [], maxRows: 1, scope: "role:admin", zone: "UTC" };
    const own = await asOwnClient(() => widgetCacheKey(parts));
    const theirs = await asOtherClient(() => widgetCacheKey(parts));
    expect(own).not.toBe(theirs);
    // An operation run where no entry named the client (a Durable Object's own call): no reuse of
    // the zone's shared cache at all, for want of a client to key it by.
    const stored = new Map<string, Response>();
    const shared = {
      async match(request: RequestInfo | URL) {
        return stored.get(String(request instanceof Request ? request.url : request))?.clone();
      },
      async put(request: RequestInfo | URL, response: Response) {
        stored.set(String(request instanceof Request ? request.url : request), response);
      },
    } as unknown as Cache;
    const unnamed = { database: otherDatabase, client: null };
    await runInClientScope(unnamed, () => cacheApiWidgetCache(shared).put("k", 1, "now"));
    expect(stored.size).toBe(0);
    await asOtherClient(() => cacheApiWidgetCache(shared).put("k", 1, "now"));
    expect(stored.size).toBe(1);
    expect(await runInClientScope(unnamed, () => cacheApiWidgetCache(shared).get("k"))).toBeNull();
    // The in-memory one of tests is the test's own: untouched.
    expect(memoryWidgetCache()).toBeTruthy();
  });

  it("gives each client its own value of a clientState, and one value with no store", () => {
    const state = clientState(() => ({ n: 0 }));
    asOwnClient(() => {
      state.get().n = 1;
    });
    asOtherClient(() => {
      state.get().n = 2;
    });
    expect(asOwnClient(() => state.get().n)).toBe(1);
    expect(asOtherClient(() => state.get().n)).toBe(2);
    state.reset();
    expect(asOwnClient(() => state.get().n)).toBe(0);
  });
});

describe("a single-client deployment (no store)", () => {
  it("keeps one value, read outside any scope, exactly as a module-level variable", () => {
    if (clientScopesHeld()) return;
    const state = clientState(() => ({ n: 0 }));
    state.get().n = 3;
    expect(state.get().n).toBe(3);
    expect(currentClientId()).toBeNull();
    // A scope given without a store is not held: the one value still.
    expect(runInClientScope(OWN, () => state.get().n)).toBe(3);
    expect(getObject("person")).toBeTruthy();
  });
});
