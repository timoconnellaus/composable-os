// What is timed (stage 66 step 1, criterion 1): a typical staff page and a customer checkout, each
// as the operations the app's own screens call, run against one database handle. The same code
// runs in the local harness (test/timing.test.ts) and in the deployed proof Worker (src/worker.ts),
// once on D1 and once on a client's database, so the two are timed doing the same work.
//
// - staff list:  the People page's first load, `person.list` (50 rows) and `record.count`.
// - record page: a person's page, `person.get` and its timeline (`activity.listForRecord`).
// - checkout:    a guest starting an order of two things and opening the provider's page
//                (`order.start`, then `order.checkout`), with a stand-in payments gatekeeper
//                that answers at once, so only the host's own work is timed.

import {
  type ActingUser,
  applyPlan,
  coreRegistry,
  createInvoker,
  type IntegrationRuntime,
  type InvocationContext,
  type OutsideInvocationContext,
  planReconcile,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { type CrmDb, createCrmDb } from "@composable-os/db";
import { manifestSchema } from "@composable-os/sdk";

const invoker = createInvoker(coreRegistry);
const call = <T>(name: string, input: unknown, ctx: Parameters<typeof invoker.invokeByName>[2]) =>
  invoker.invokeByName(name, input, ctx) as Promise<T>;

export const SCENARIOS = ["staff-list", "record-page", "checkout"] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** The shop extension the checkout buys from; the same id on both databases. */
const SHOP = "proofshop";
const CLASS_PASS = `${SHOP}.pass`;
const RETURN_ORIGIN = "https://proof.example";
const CURRENCY = "AUD";

/** How many people the seed makes: a small gym's members. */
export const SEED_PEOPLE = 300;
/** People made per call of `seed`, so a call stays well inside 1,000 queries on Cloudflare. */
export const SEED_CHUNK = 20;

const ADMIN_EMAIL = "proof-admin@proof.example";

export interface Seeded {
  admin: ActingUser;
  /** A person with a timeline, for the record page. */
  personId: string;
  /** Two things for sale, for the checkout. */
  passes: [string, string];
}

async function adminOf(db: D1Database): Promise<ActingUser | null> {
  const row = await db
    .prepare("SELECT id, name, email FROM core_user WHERE email = ?")
    .bind(ADMIN_EMAIL)
    .first<{ id: string; name: string; email: string }>();
  return row ? { ...row, role: "admin" } : null;
}

function staff(crm: CrmDb, admin: ActingUser): InvocationContext {
  return { actor: "human", user: admin, origin: { surface: "ui" }, db: crm };
}

/** A payments gatekeeper that opens every checkout at once (no provider, no network). */
const payments: IntegrationRuntime = new Proxy({} as IntegrationRuntime, {
  get(_target, key) {
    if (key === "availableVendors") return async () => ["payments"];
    if (key === "callAsHost") {
      return async (input: { method: string; args: unknown[] }) => {
        if (input.method !== "createCheckout") throw new Error(`not used: ${input.method}`);
        const ref = `fcs_${crypto.randomUUID()}`;
        return {
          value: { provider: "fake", ref, url: `https://pay.example/${ref}`, expiresAt: null },
          pending: [],
          applied: [],
        };
      };
    }
    return () => Promise.reject(new Error(`not used: ${String(key)}`));
  },
});

const shopManifest = manifestSchema.parse({
  id: SHOP,
  version: "1.0.0",
  contractVersion: 1,
  objects: {
    pass: {
      label: "Class pass",
      plural: "Class passes",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        price: { type: "currency", label: "Price", currency: CURRENCY },
      },
      sellable: { price: "price" },
      public: { read: ["name", "price"] },
    },
  },
});

/**
 * Seeds `db` a step at a time: the admin, the shop and its two passes, then people in chunks,
 * each with a note. Returns what is left to make; call again until it is 0. Idempotent.
 */
export async function seed(db: D1Database): Promise<{ remaining: number }> {
  const crm = createCrmDb(db);
  let admin = await adminOf(db);
  if (!admin) {
    const now = new Date().toISOString();
    const id = `usr_proof${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db
      .prepare(
        "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Proof admin', ?, 1, ?, ?)",
      )
      .bind(id, ADMIN_EMAIL, now, now)
      .run();
    await db.prepare("UPDATE core_user SET role = 'admin' WHERE id = ?").bind(id).run();
    admin = { id, name: "Proof admin", email: ADMIN_EMAIL, role: "admin" };
    const plan = await planReconcile(crm.query, shopManifest, { now });
    await applyPlan((statements) => crm.batch(statements), plan);
    await refreshSchemaRegistry(crm.query);
    await call(
      "order.settings.update",
      { currency: CURRENCY, returnOrigins: [RETURN_ORIGIN] },
      staff(crm, admin),
    );
    for (const [name, price] of [
      ["Ten classes", 180],
      ["Open gym month", 95],
    ] as const) {
      await call(
        "record.create",
        { object: CLASS_PASS, values: { name, price } },
        staff(crm, admin),
      );
    }
    const connection = `con_proof${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await db
      .prepare(
        "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'payments', 'org', ?, 'Payments', 'active', ?, ?, ?)",
      )
      .bind(
        connection,
        id,
        JSON.stringify([
          {
            key: "merchant",
            url: "payments://merchant/fake",
            pattern: "payments://merchant/:provider",
            title: "Payments with Fake provider",
            tsType: "PaymentsSession",
            bindingName: "PAYMENTS",
          },
        ]),
        now,
        now,
      )
      .run();
  }
  await refreshSchemaRegistry(crm.query);
  const have = await db.prepare("SELECT count(*) AS n FROM core_person").first<{ n: number }>();
  const made = have?.n ?? 0;
  const make = Math.min(SEED_CHUNK, SEED_PEOPLE - made);
  for (let i = 0; i < make; i += 1) {
    const n = made + i + 1;
    const person = await call<{ id: string }>(
      "person.create",
      {
        givenName: `Member${n}`,
        familyName: `Proof${n}`,
        emails: [{ email: `member${n}@proof.example` }],
      },
      staff(crm, admin),
    );
    await call(
      "activity.log",
      {
        type: "note",
        body: `Joined; prefers early classes (${n})`,
        links: [{ object: "person", id: person.id }],
      },
      staff(crm, admin),
    );
  }
  return { remaining: SEED_PEOPLE - made - make };
}

/** What the scenarios need from a seeded database. */
export async function seeded(db: D1Database): Promise<Seeded> {
  const crm = createCrmDb(db);
  await refreshSchemaRegistry(crm.query);
  const admin = await adminOf(db);
  if (!admin) throw new Error("not seeded: call seed() until nothing remains");
  const person = await db
    .prepare("SELECT id FROM core_person ORDER BY id LIMIT 1 OFFSET 7")
    .first<{ id: string }>();
  const { results } = await db
    .prepare(`SELECT id FROM x_${SHOP}_pass ORDER BY id LIMIT 2`)
    .all<{ id: string }>();
  if (!person || results.length < 2) throw new Error("not seeded");
  return {
    admin,
    personId: person.id,
    passes: [results[0]?.id as string, results[1]?.id as string],
  };
}

/** Runs `scenario` once on `db`; resolves when the page (or checkout) has everything it shows. */
export async function runScenario(scenario: Scenario, db: D1Database, data: Seeded): Promise<void> {
  const crm = createCrmDb(db);
  const ctx = staff(crm, data.admin);
  switch (scenario) {
    case "staff-list": {
      await call("person.list", { limit: 50 }, ctx);
      await call("record.count", { object: "person" }, ctx);
      return;
    }
    case "record-page": {
      await call("person.get", { id: data.personId, includeDeleted: true }, ctx);
      await call(
        "activity.listForRecord",
        { object: "person", recordId: data.personId, limit: 25 },
        ctx,
      );
      return;
    }
    case "checkout": {
      const guest: OutsideInvocationContext = {
        principal: { kind: "public" },
        db: crm,
        integrations: payments,
      };
      const order = await call<{ id: string; token: string }>(
        "order.start",
        {
          lines: data.passes.map((id) => ({ object: CLASS_PASS, id })),
          email: `guest-${crypto.randomUUID().slice(0, 8)}@buyers.example`,
          pay: "full",
        },
        guest,
      );
      await call(
        "order.checkout",
        { id: order.id, token: order.token, returnUrl: `${RETURN_ORIGIN}/thanks` },
        guest,
      );
      return;
    }
  }
}

/** Times `runs` runs of `scenario` (after one unmeasured run), in milliseconds. */
export async function timeScenario(
  scenario: Scenario,
  db: D1Database,
  data: Seeded,
  runs: number,
): Promise<number[]> {
  await runScenario(scenario, db, data);
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    await runScenario(scenario, db, data);
    times.push(performance.now() - started);
  }
  return times;
}

/** The median and the 95th percentile of `times`, nearest rank. */
export function summarise(times: number[]): { runs: number; median: number; p95: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const rank = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
  return {
    runs: sorted.length,
    median: Math.round(rank(0.5) * 10) / 10,
    p95: Math.round(rank(0.95) * 10) / 10,
  };
}
