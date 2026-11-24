// Stage 48 step 5 (ADR 0710): me.portal, against the real host. Two fixture packs, installed as
// shipped, declare sections of My account: a timetable over bookings (which open to guardians), a
// tickets section (which do not) and a passes section. A member with no ticket has no Tickets
// section; after a ticket is theirs, they do. A parent whose child has a booking sees Bookings; a
// child's ticket shows no Tickets to the parent. Another member's records never show a section.
// Payment method shows only for someone who pays a subscription that has not ended. A pack that
// is disabled, a runtime extension's declaration, and a section on objects nobody holds add
// nothing; check and install refuse a runtime extension's `portal`.
//
// It also counts what one call runs on D1 (the local runtime enforces neither 1,000 statements
// per invocation nor 100 bound variables per statement): two statements of its own beside the
// pipeline's, the same after three more packs with sections are installed.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import type { ExtensionManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  BASE_PORTAL_SECTIONS,
  checkManifest,
  type PortalSection,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import { type Buyer, CURRENCY, createBuyer, outside, run } from "./order-fixtures.ts";

const NOW = new Date().toISOString();

/** An object a customer holds, by its `person` field; `guardians` opens a child's to the parent. */
function held(label: string, guardians: boolean): ExtensionManifest["objects"][string] {
  return {
    label,
    plural: `${label}s`,
    titleField: "name",
    fields: {
      name: { type: "text", label: "Name", required: true },
      person: { type: "relation", label: "Person", to: "person" },
    },
    customer: {
      field: "person",
      ...(guardians ? { guardians: {} } : {}),
      read: ["name"],
      write: [],
    },
  };
}

function gymPack(id: string): ExtensionManifest {
  return manifest(id, {
    objects: {
      booking: held("Booking", true),
      ticket: held("Ticket", false),
      // Shared with every signed-in customer: what everyone reads is nobody's own section.
      notice: {
        ...held("Notice", false),
        signedIn: { read: ["name"] },
      },
    },
    portal: {
      bookings: {
        label: "Bookings",
        web: { block: `${id}-timetable`, export: "Timetable" },
        native: { block: `${id}-native-timetable`, export: "TimetableScreen" },
        order: 10,
        has: [`${id}.booking`],
      },
      tickets: {
        label: "My tickets",
        web: { block: `${id}-my-tickets`, export: "MyTickets" },
        order: 40,
        has: [`${id}.ticket`],
      },
      notices: {
        label: "Notices",
        web: { block: `${id}-notices`, export: "Notices" },
        order: 45,
        has: [`${id}.notice`],
      },
    },
  });
}

function passPack(id: string): ExtensionManifest {
  return manifest(id, {
    objects: { pass: held("Pass", true) },
    portal: {
      passes: {
        label: "Passes",
        native: { block: `${id}-native-passes`, export: "PassesScreen" },
        order: 20,
        has: [`${id}.pass`],
      },
    },
  });
}

async function install(
  m: ExtensionManifest,
  status = "active",
  source: "shipped" | "runtime" = "shipped",
) {
  await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(m.id).run();
  await db.query
    .insertInto("core_extensions")
    .values({
      id: m.id,
      source,
      status,
      version: m.version,
      commit_oid: "test",
      manifest: JSON.stringify(m),
      user_id: admin.id,
      installed_at: NOW,
      updated_at: NOW,
    } as never)
    .execute();
}

const gym = gymPack(extId("prt"));
const passes = passPack(extId("prp"));
let admin: ActingUser;

const portal = (buyer: Buyer, dbOverride?: ReturnType<typeof createCrmDb>) =>
  run<{ sections: PortalSection[]; paysSubscription: boolean }>(
    "me.portal",
    {},
    dbOverride ? outside(buyer.principal, { db: dbOverride }) : outside(buyer.principal),
  );
const keys = async (buyer: Buyer) => (await portal(buyer)).sections.map((s) => s.key);
const packKeys = async (buyer: Buyer) =>
  (await portal(buyer)).sections.filter((s) => s.pack !== null).map((s) => s.key);
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, context(admin))).id;

async function child(guardian: Buyer): Promise<string> {
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: unique("Kid") },
    context(admin),
  );
  await run(
    "person.link.add",
    { guardianId: guardian.principal.personId, dependantId: person.id },
    context(admin),
  );
  return person.id;
}

/** A subscription the buyer pays, as the provider's verified events leave it. */
async function subscription(payer: Buyer, state: string): Promise<string> {
  const id = `sbs_${unique("prt")}`;
  const now = new Date().toISOString();
  const columns = {
    id,
    payer_person_id: payer.principal.personId,
    holder_person_id: payer.principal.personId,
    email: payer.email,
    placed_as: "customer",
    plan_object: `${passes.id}.pass`,
    plan_id: "plan",
    plan_title: "Monthly",
    amount: 4900,
    currency: CURRENCY,
    interval: "month",
    state,
    provider: "fake",
    provider_ref: `fsub_${id}`,
    cancel_at_period_end: 0,
    current_period_end: now,
    observed_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  };
  const names = Object.keys(columns);
  await env.DB.prepare(
    `INSERT INTO core_subscription (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  )
    .bind(...Object.values(columns))
    .run();
  return id;
}

const BASE = BASE_PORTAL_SECTIONS.filter((s) => s.key !== "payment").map((s) => s.key);

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(gym);
  await reconcile(passes);
  await install(gym);
  await install(passes);
});

describe("me.portal (stage 48, ADR 0710)", () => {
  it("lists the base sections, and no pack's for someone who holds nothing", async () => {
    const buyer = await createBuyer(admin, "nothing");
    const out = await portal(buyer);
    expect(out.sections.map((s) => s.key)).toEqual(BASE);
    expect(out.paysSubscription).toBe(false);
    expect(out.sections[0]).toEqual({
      key: "orders",
      pack: null,
      label: "Orders",
      order: 60,
      web: null,
      native: null,
    });
  });

  it("omits Tickets for a member with no ticket, and includes it once one is theirs (criterion 2)", async () => {
    const buyer = await createBuyer(admin, "tickets");
    await create(`${gym.id}.booking`, { name: "Monday class", person: buyer.principal.personId });
    expect(await packKeys(buyer)).toEqual([`${gym.id}.bookings`]);
    await create(`${gym.id}.ticket`, { name: "Gala", person: buyer.principal.personId });
    const out = await portal(buyer);
    expect(out.sections.filter((s) => s.pack).map((s) => s.key)).toEqual([
      `${gym.id}.bookings`,
      `${gym.id}.tickets`,
    ]);
    // Pack sections first, by order, then the base ones; each with its blocks.
    expect(out.sections.map((s) => s.key)).toEqual([
      `${gym.id}.bookings`,
      `${gym.id}.tickets`,
      ...BASE,
    ]);
    expect(out.sections[1]).toEqual({
      key: `${gym.id}.tickets`,
      pack: gym.id,
      label: "My tickets",
      order: 40,
      web: { block: `${gym.id}-my-tickets`, export: "MyTickets" },
      native: null,
    });
  });

  it("shows a parent Bookings for a child's booking, never Tickets for a child's ticket (criterion 2)", async () => {
    const parent = await createBuyer(admin, "parent");
    const kid = await child(parent);
    await create(`${gym.id}.ticket`, { name: "Kid's gala", person: kid });
    expect(await packKeys(parent)).toEqual([]);
    await create(`${gym.id}.booking`, { name: "Kids class", person: kid });
    await create(`${passes.id}.pass`, { name: "Kid's pass", person: kid });
    expect(await packKeys(parent)).toEqual([`${gym.id}.bookings`, `${passes.id}.passes`]);
  });

  it("never shows a section for another member's records, nor their child's (the isolation suite)", async () => {
    const owner = await createBuyer(admin, "owner");
    const kid = await child(owner);
    await create(`${gym.id}.booking`, { name: "Theirs", person: owner.principal.personId });
    await create(`${gym.id}.ticket`, { name: "Theirs", person: owner.principal.personId });
    await create(`${passes.id}.pass`, { name: "Their kid's", person: kid });
    await subscription(owner, "active");
    const stranger = await createBuyer(admin, "stranger");
    const out = await portal(stranger);
    expect(out.sections.map((s) => s.key)).toEqual(BASE);
    expect(out.paysSubscription).toBe(false);
  });

  it("a record shared with every signed-in customer is nobody's section", async () => {
    const buyer = await createBuyer(admin, "notice");
    const other = await createBuyer(admin, "noticer");
    await create(`${gym.id}.notice`, { name: "Open day", person: other.principal.personId });
    expect(await packKeys(buyer)).toEqual([]);
    expect(await packKeys(other)).toEqual([`${gym.id}.notices`]);
  });

  it("shows Payment method only for someone who pays a subscription that has not ended", async () => {
    const buyer = await createBuyer(admin, "payer");
    const id = await subscription(buyer, "ended");
    expect((await portal(buyer)).paysSubscription).toBe(false);
    expect(await keys(buyer)).not.toContain("payment");
    await env.DB.prepare(
      "UPDATE core_subscription SET state = 'past_due', version = version + 1 WHERE id = ?",
    )
      .bind(id)
      .run();
    const out = await portal(buyer);
    expect(out.paysSubscription).toBe(true);
    expect(out.sections.map((s) => s.key)).toContain("payment");
  });

  it("a pack disabled, a runtime extension's declaration and one not installed add nothing", async () => {
    const buyer = await createBuyer(admin, "installed");
    await create(`${gym.id}.booking`, { name: "Class", person: buyer.principal.personId });
    expect(await packKeys(buyer)).toEqual([`${gym.id}.bookings`]);
    await install(gym, "disabled");
    expect(await packKeys(buyer)).toEqual([]);
    // A runtime extension's `portal` is ignored at run time (check and install refuse it).
    await install(gym, "active", "runtime");
    expect(await packKeys(buyer)).toEqual([]);
    await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(gym.id).run();
    expect(await packKeys(buyer)).toEqual([]);
    await install(gym);
    expect(await packKeys(buyer)).toEqual([`${gym.id}.bookings`]);
  });

  it("is for customers only: staff are told it does not exist", async () => {
    await expect(run("me.portal", {}, context(admin))).rejects.toThrow();
  });

  it("check and install refuse a runtime extension's portal; a shipped one passes (criterion 5)", async () => {
    const id = extId("prr");
    const m = gymPack(id);
    const runtime = await checkManifest(db.query, id, m, NOW, { source: "runtime" });
    expect(runtime.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "outside_audience", path: "portal" }),
      ]),
    );
    const shipped = await checkManifest(db.query, id, m, NOW, { source: "shipped" });
    expect(shipped.issues.filter((i) => i.path.startsWith("portal"))).toEqual([]);
  });
});

describe("me.portal is bounded (stage 48 criterion 4)", () => {
  /** What one call ran on D1: each statement's bound variables. */
  let ran: number[] = [];
  const counted = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(inner, name) {
              if (name === "bind") {
                return (...values: unknown[]) => {
                  ran.push(values.length);
                  return inner.bind(...values);
                };
              }
              const value = Reflect.get(inner, name);
              if (typeof value === "function") {
                if (name === "all" || name === "first" || name === "run" || name === "raw") {
                  ran.push(0);
                }
                return value.bind(inner);
              }
              return value;
            },
          });
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const countedDb = createCrmDb(counted);

  async function measure(buyer: Buyer): Promise<number[]> {
    ran = [];
    await portal(buyer, countedDb);
    return ran;
  }

  it("reads two statements, each well under 100 bound variables, whatever the packs", async () => {
    const buyer = await createBuyer(admin, "bounded");
    await create(`${gym.id}.booking`, { name: "Class", person: buyer.principal.personId });
    const before = await measure(buyer);
    // Its own two, beside the pipeline's (the registry's freshness, the read count).
    expect(before.length).toBe(4);
    expect(Math.max(...before)).toBeLessThan(100);
    // Three more packs with sections, one of them held: nothing more is read.
    for (const prefix of ["prq", "prs", "prt"]) {
      const more = passPack(extId(prefix));
      await reconcile(more);
      await install(more);
      await create(`${more.id}.pass`, { name: "Pass", person: buyer.principal.personId });
    }
    const after = await measure(buyer);
    expect(after.length).toBe(before.length);
    expect(Math.max(...after)).toBeLessThan(100);
    expect((await packKeys(buyer)).length).toBe(4);
  });
});
