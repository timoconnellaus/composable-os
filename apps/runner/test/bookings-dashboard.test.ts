// Stage 31a step 9: the Bookings dashboard against a fixture worked out by hand (acceptance
// criterion 16), on the shipped packs. Its own file, so the database holds only this fixture and
// every number is exact. Classes are placed from the real clock (the windows read it), in UTC so
// each class's local hour is the one written here.
//
// The fixture, for the dates from 30 days ago to 30 days ahead:
//   P1  Strength, coach Kim, 4 places, 3 days ago at 06:00: Ann came, Ben came, Cara did not
//       come, Dan cancelled late.
//   P2  Yoga, coach Lee, 3 places, 2 days ago at 18:00: Ann came, Ben came, Eve did not come.
//   F1  Strength, coach Kim, 1 place, in 2 days at 06:00: Ann booked and cancelled in time, Ben
//       waiting and moved in, Cara waiting.
//   X   Strength, in 4 days, cancelled by the gym with Eve's booking: counts for nothing.
//   O   Strength, 60 days ago (outside the dates): Ann came, her first class.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  extensionDashboardId,
  type InvocationContext,
  invokeByName,
  memoryWidgetCache,
  refreshSchemaRegistry,
  runWaitlistDue,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host } from "./helpers.ts";

const packFiles = (glob: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(glob)
      .map(([path, text]) => [path.split("/").pop() as string, text] as const)
      .filter(([name]) => name !== "vitest.config.ts"),
  );
const files: Record<string, Record<string, string>> = {
  programs: packFiles(
    import.meta.glob<string>("../../../packs/programs/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  bookings: packFiles(
    import.meta.glob<string>("../../../packs/bookings/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  memberships: packFiles(
    import.meta.glob<string>("../../../packs/memberships/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
};
const OURS = new Set(Object.keys(files));
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    { id: "bookings", version: "0.1.0" },
    { id: "memberships", version: "0.1.0" },
    { id: "programs", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    files[id]
      ? host.commit({
          id,
          files: files[id] as Record<string, string>,
          message: `Shipped ${id} 0.1.0`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const integrations = integrationRuntime(env);
const DAY = 86_400_000;
const CLASS = "bookings.class";
let admin: ActingUser;
const staff = (): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
});
const run = <T = Record<string, unknown>>(name: string, input: unknown) =>
  invokeByName(name, input, staff()) as Promise<T>;
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values })).id;

/** A day `days` from today (UTC) at `hour`:00 UTC. */
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

async function klass(values: {
  classType: string;
  coach?: string;
  startsAt: string;
  places: number;
}) {
  return create(CLASS, {
    ...values,
    endsAt: new Date(Date.parse(values.startsAt) + 3_600_000).toISOString(),
    timezone: "UTC",
  });
}
type Out = { result: string; bookingId?: string; reason?: string };
async function bookFor(classId: string, personId: string, extra: Record<string, unknown> = {}) {
  const out = await run<Out>("x.bookings.bookFor", { classId, personId, ...extra });
  if (out.result !== "booked" && out.result !== "waiting") {
    throw new Error(`Not booked: ${JSON.stringify(out)}`);
  }
  return out.bookingId as string;
}
const desk = (classId: string, personId: string) =>
  bookFor(classId, personId, { paidAtDesk: true });
const mark = async (bookingId: string, tool: "markAttended" | "markNoShow") => {
  const out = await run<Out>(`x.bookings.${tool}`, { bookingId });
  expect(out.result).not.toBe("refused");
};

const people: Record<string, string> = {};
const classes: Record<string, string> = {};

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "memberships"]) {
    await run("extension.install", { id, shipped: true });
  }
  await refreshSchemaRegistry(db.query);
  for (const name of ["Ann", "Ben", "Cara", "Dan", "Eve"]) {
    people[name] = (await run<{ id: string }>("person.create", { givenName: name })).id;
  }
  const strength = await create("programs.classtype", { name: "Strength" });
  const yoga = await create("programs.classtype", { name: "Yoga" });
  const kim = await create("bookings.coach", { name: "Kim" });
  const lee = await create("bookings.coach", { name: "Lee" });
  classes.P1 = await klass({ classType: strength, coach: kim, startsAt: at(-3, 6), places: 4 });
  classes.P2 = await klass({ classType: yoga, coach: lee, startsAt: at(-2, 18), places: 3 });
  classes.F1 = await klass({ classType: strength, coach: kim, startsAt: at(2, 6), places: 1 });
  classes.X = await klass({ classType: strength, coach: kim, startsAt: at(4, 6), places: 5 });
  classes.O = await klass({ classType: strength, coach: kim, startsAt: at(-60, 6), places: 5 });
  const P = people as Record<"Ann" | "Ben" | "Cara" | "Dan" | "Eve", string>;

  await mark(await desk(classes.O, P.Ann), "markAttended");

  await mark(await desk(classes.P1, P.Ann), "markAttended");
  await mark(await desk(classes.P1, P.Ben), "markAttended");
  await mark(await desk(classes.P1, P.Cara), "markNoShow");
  const late = await desk(classes.P1, P.Dan);
  expect((await run<Out>("x.bookings.cancelFor", { bookingId: late, keepUse: true })).result).toBe(
    "late_cancelled",
  );

  await mark(await desk(classes.P2, P.Ann), "markAttended");
  await mark(await desk(classes.P2, P.Ben), "markAttended");
  await mark(await desk(classes.P2, P.Eve), "markNoShow");

  // F1: Ann takes its one place; Ben waits (with a pass to be moved in with); Ann cancels in
  // time, the place goes to the waiting list and Ben is moved in; Cara waits behind.
  const annF1 = await desk(classes.F1, P.Ann);
  const type = await create("memberships.passtype", {
    title: "Pack of five",
    price: 50,
    uses: 5,
    validDays: 60,
    status: "on_sale",
  });
  for (const who of [P.Ben, P.Cara]) {
    await run("x.memberships.givePass", { personId: who, passTypeId: type, reason: "Fixture" });
  }
  const benF1 = await bookFor(classes.F1, P.Ben, { waitlist: true });
  expect((await run<Out>("x.bookings.cancelFor", { bookingId: annF1 })).result).toBe("cancelled");
  await runWaitlistDue(db);
  const promoted = await run<{ values: Record<string, unknown> }>("record.get", {
    object: "bookings.booking",
    id: benF1,
  });
  expect(promoted.values.state).toBe("booked");
  await bookFor(classes.F1, P.Cara, { waitlist: true });

  // X: cancelled by the gym with Eve's booking.
  await desk(classes.X, P.Eve);
  await run("x.bookings.cancelClass", { classId: classes.X, reason: "Fixture" });
}, 180_000);

describe("the Bookings dashboard (criterion 16)", () => {
  it("every widget's numbers match the fixture worked out by hand", async () => {
    const dashboardId = extensionDashboardId("bookings", "bookings");
    const dashboard = await run<{ widgets: { id: string }[] }>("dashboard.get", {
      id: dashboardId,
    });
    expect(dashboard.widgets.map((w) => w.id)).toEqual([
      "attended",
      "no-shows",
      "late-cancels",
      "full",
      "by-type",
      "by-hour",
      "by-coach",
      "misses-by-month",
      "waitlist",
      "first-visits",
      "misses-by-member",
    ]);
    const dates = { from: at(-30, 0).slice(0, 10), to: at(30, 0).slice(0, 10) };
    const results: Record<string, Record<string, unknown>[]> = {};
    for (const { id } of dashboard.widgets) {
      const out = await invokeByName(
        "widget.run",
        { dashboardId, widgetId: id, filters: { dates }, refresh: true },
        { ...staff(), widgetCache: memoryWidgetCache() },
      );
      results[id] = (out as { rows: Record<string, unknown>[] }).rows;
    }
    // P1: Ann and Ben; P2: Ann and Ben. O is outside the dates.
    expect(results.attended).toEqual([{ value: 4 }]);
    // Cara at P1, Eve at P2.
    expect(results["no-shows"]).toEqual([{ value: 2 }]);
    expect(results["late-cancels"]).toEqual([{ value: 1 }]);
    // Places taken: P1 3 of 4 (Dan's late cancel gave his back), P2 3 of 3, F1 1 of 1 (Ben):
    // 7 of 8 is 87.5%, rounded to 88. X was cancelled: not counted.
    expect(results.full).toEqual([{ value: 88 }]);
    // Strength: came 2 (P1), held 4 (P1's Ann, Ben, Cara; F1's Ben). Yoga: came 2, held 3.
    expect(results["by-type"]?.map((r) => [r.type, r.came, r.booked])).toEqual([
      ["Strength", 2, 4],
      ["Yoga", 2, 3],
    ]);
    expect(results["by-hour"]).toEqual([
      { hour: "06:00", came: 2 },
      { hour: "18:00", came: 2 },
    ]);
    expect(results["by-coach"]).toEqual([
      { coach: "Kim", came: 2 },
      { coach: "Lee", came: 2 },
    ]);
    // Per month of the class: P1's late cancel and no-show, P2's no-show, F1 with neither.
    const month = (iso: string) => iso.slice(0, 7);
    const expected = new Map<string, { late_cancels: number; no_shows: number }>();
    const add = (iso: string, late: number, noShow: number) => {
      const row = expected.get(month(iso)) ?? { late_cancels: 0, no_shows: 0 };
      expected.set(month(iso), {
        late_cancels: row.late_cancels + late,
        no_shows: row.no_shows + noShow,
      });
    };
    add(at(-3, 6), 1, 1);
    add(at(-2, 18), 0, 1);
    add(at(2, 6), 0, 0);
    expect(results["misses-by-month"]).toEqual(
      [...expected.entries()].sort().map(([m, row]) => ({ month: m, ...row })),
    );
    // F1's waiting list: Ben joined and got in, Cara joined.
    expect(results.waitlist).toEqual([{ type: "Strength", joined: 2, got_in: 1 }]);
    // Ann's first class was O, outside the dates; Ben's was P1, and he came back once (P2).
    expect(results["first-visits"]).toEqual([
      { id: people.Ben, member: "Ben", first_class: at(-3, 6), came_back: 1 },
    ]);
    expect(results["misses-by-member"]).toEqual([
      { id: people.Cara, member: "Cara", late_cancels: 0, no_shows: 1 },
      { id: people.Dan, member: "Dan", late_cancels: 1, no_shows: 0 },
      { id: people.Eve, member: "Eve", late_cancels: 0, no_shows: 1 },
    ]);
  });

  it("ships its saved views", async () => {
    const row = await env.DB.prepare(
      "SELECT manifest FROM core_extensions WHERE id = 'bookings'",
    ).first<{ manifest: string }>();
    const manifest = JSON.parse(row?.manifest ?? "{}") as { views: Record<string, unknown> };
    expect(Object.keys(manifest.views)).toEqual(
      expect.arrayContaining(["noShowsThisMonth", "lateCancelsThisMonth"]),
    );
  });
});
