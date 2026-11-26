// A second client in the suite's isolate (stage 66 step 5, ADR 0617): its own database
// (`DB_OTHER_CLIENT`, a second D1 database), migrated, with an extension object of its own, a
// plan of its own and one person, so a module-level cache that is not kept per client shows the
// suite's own client something of this one's (or the other way round).
//
// Used by test/client-scope.test.ts (a test per cache) and, run around every test of the whole
// suite, by test/two-clients-turns.ts (`COS_TEST_DB=two-clients`).
import { env } from "cloudflare:workers";
import { applyMigrations, createCrmDb, type Migration } from "@composable-os/db";
import { manifestSchema } from "@composable-os/sdk";
import { schemaNames } from "../src/dashboards/run.ts";
import {
  type ActingUser,
  applyPlan,
  type ClientScope,
  clientScopesHeld,
  findPlanOnSale,
  getObject,
  invoke,
  listObjects,
  loadEntitlements,
  newId,
  planReconcile,
  refreshSchemaRegistry,
  runInClientScope,
} from "../src/index.ts";

const bindings = env as unknown as { DB_OTHER_CLIENT: D1Database; TEST_MIGRATIONS: Migration[] };

/** The other client's database: a second D1 database in the same Worker. */
export const otherDatabase: D1Database = bindings.DB_OTHER_CLIENT;
export const otherDb = createCrmDb(otherDatabase);

/** The other client's scope: what an entry of a many-client host runs its code in. */
export const OTHER_CLIENT: ClientScope = { database: otherDatabase, client: "other-client" };

/** The extension only the other client has installed, and its one object. */
export const OTHER_EXTENSION = "otherclientonly";
export const OTHER_OBJECT = `${OTHER_EXTENSION}.thing`;
/** The other client's plan: a user limit no test of the suite's own client sets. */
export const OTHER_MAX_USERS = 7777;
/** The name of the other client's one person. */
export const OTHER_PERSON = "Somebody of the other client";

let ready: Promise<ActingUser> | null = null;

/** Runs `run` as the other client (in its scope). */
export function asOtherClient<T>(run: () => T): T {
  return runInClientScope(OTHER_CLIENT, run);
}

/** Migrates and fills the other client's database once per file; its admin. */
export function otherClient(): Promise<ActingUser> {
  ready ??= (async () => {
    await applyMigrations(otherDatabase, bindings.TEST_MIGRATIONS);
    const existing = await otherDatabase
      .prepare("SELECT id, email, name FROM core_user WHERE role = 'admin' LIMIT 1")
      .first<{ id: string; email: string; name: string }>();
    if (existing) return { ...existing, role: "admin" };
    const id = newId("user");
    const now = new Date().toISOString();
    await otherDatabase.batch([
      otherDatabase
        .prepare(
          "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Other admin', 'admin@other-client.test', 1, ?, ?)",
        )
        .bind(id, now, now),
      otherDatabase.prepare("UPDATE core_user SET role = 'admin' WHERE id = ?").bind(id),
      otherDatabase
        .prepare(
          "INSERT INTO core_entitlements (key, value, updated_at) VALUES ('plan', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .bind(
          JSON.stringify({
            plan: "business",
            maxUsers: OTHER_MAX_USERS,
            maxRecords: null,
            platformAi: false,
            updatedAt: now,
          }),
          now,
        ),
    ]);
    const plan = await asOtherClient(() =>
      planReconcile(
        otherDb.query,
        manifestSchema.parse({
          id: OTHER_EXTENSION,
          version: "1.0.0",
          contractVersion: 1,
          objects: {
            thing: {
              label: "Thing",
              plural: "Things",
              titleField: "title",
              fields: { title: { type: "text", label: "Title", required: true } },
            },
          },
        }),
        { now },
      ),
    );
    await applyPlan((statements) => otherDb.batch(statements), plan);
    const admin: ActingUser = {
      id,
      email: "admin@other-client.test",
      name: "Other admin",
      role: "admin",
    };
    await asOtherClient(() =>
      invoke(
        "person.create",
        { displayName: OTHER_PERSON },
        { actor: "human", user: admin, origin: { surface: "ui" }, db: otherDb },
      ),
    );
    return admin;
  })();
  return ready;
}

/** Fails unless `ok`: what the other client's turn checks. */
function expectThat(ok: boolean, what: string): void {
  if (!ok) throw new Error(`Two clients in one isolate: ${what}`);
}

/**
 * The other client's turn: in its own scope it fills what core keeps at module level with its
 * own (its schema, its plan, its schema names, its plan on sale) and reads its own records, which
 * must be only its own: nothing the suite's own client wrote.
 */
export async function otherClientsTurn(): Promise<void> {
  const admin = await otherClient();
  await asOtherClient(async () => {
    await refreshSchemaRegistry(otherDb.query);
    expectThat(Boolean(getObject(OTHER_OBJECT)), "the other client does not see its own object");
    const plan = await loadEntitlements(otherDb.query);
    expectThat(plan?.maxUsers === OTHER_MAX_USERS, "the other client does not read its own plan");
    await schemaNames(otherDb.query);
    await findPlanOnSale(otherDb.query, new Date().toISOString(), { memo: true });
    const people = await invoke(
      "person.list",
      { limit: 10 },
      { actor: "human", user: admin, origin: { surface: "ui" }, db: otherDb },
    );
    const names = people.items.map((p) => (p as { displayName?: unknown }).displayName);
    expectThat(
      names.length === 1 && names[0] === OTHER_PERSON,
      `the other client's people are ${JSON.stringify(names)}, not only its own`,
    );
  });
}

/**
 * What the suite's own client must not see of the other client's, read without filling anything
 * (the schema registry is read, never loaded, here).
 */
export function ownClientSeesNoneOfTheOthers(): void {
  expectThat(
    !getObject(OTHER_OBJECT) && !listObjects().some((o) => o.name === OTHER_OBJECT),
    "the suite's own client sees the other client's extension object",
  );
}

export { clientScopesHeld };
