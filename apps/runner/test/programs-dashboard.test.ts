// Stage 41, step 4: the Training dashboard against a fixture worked out by hand (criterion 7's
// dashboard half), and the views and the Person page's tab and panels the pack ships. Its own file,
// so the database holds only this fixture and every number is exact.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  extensionDashboardId,
  memoryWidgetCache,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { createAdmin } from "./helpers.ts";
import {
  as,
  CLASSTYPE,
  create,
  createCustomer,
  EXERCISE,
  installPrograms,
  PROGRAM,
  run,
  staff,
  twoWeeks,
} from "./programs-fixture.ts";

let admin: ActingUser;
let ada: CustomerPrincipal;
let ben: CustomerPrincipal;
const today = new Date().toISOString().slice(0, 10);

interface Sessions {
  sessions: { id: string; name: string }[];
}

beforeAll(async () => {
  admin = await createAdmin();
  await installPrograms(admin);
  const bank = {
    pike: await create(admin, EXERCISE, { name: "Pike compression", measure: "reps" }),
    row: await create(admin, EXERCISE, { name: "Ring row", measure: "weight_reps" }),
  };
  const handstands = await create(admin, CLASSTYPE, { name: "Handstands" });
  ada = await createCustomer(admin, "ada", "Ada");
  ben = await createCustomer(admin, "ben", "Ben");
  const program = await create(admin, PROGRAM, {
    title: "Two weeks",
    kind: "client",
    layout: twoWeeks(bank),
  });
  await run("record.publish", { object: PROGRAM, id: program }, staff(admin));
  // Both clients from Monday 4 January 2027: four sessions each (4th, 7th, 11th, 14th).
  for (const who of [ada, ben]) {
    await run(
      "x.programs.assign",
      { programId: program, personId: who.personId, startDate: "2027-01-04" },
      staff(admin),
    );
  }
  // And the class, from the same Monday.
  await run(
    "x.programs.assign",
    { programId: program, classTypeId: handstands, startDate: "2027-01-04" },
    staff(admin),
  );
  // Ada, on Monday the 4th: two sets of ring rows and one pike at level 3; the session done.
  const monday = (await run<Sessions>("x.programs.today", { date: "2027-01-04" }, as(ada)))
    .sessions[0]?.id as string;
  for (const set of [1, 2]) {
    await run(
      "x.programs.logAdd",
      { sessionId: monday, item: "A1", setNumber: set, actual: { reps: 8, load: 20 } },
      as(ada),
    );
  }
  await run(
    "x.programs.logAdd",
    { sessionId: monday, item: "A2", level: 3, setNumber: 1, actual: { reps: 6 } },
    as(ada),
  );
  await run("x.programs.sessionComplete", { sessionId: monday }, as(ada));
  // Ada at the class on Thursday the 7th: one pike at level 1.
  const thursday = (
    await run<Sessions>(
      "x.programs.classToday",
      { classTypeId: handstands, date: "2027-01-07" },
      as(ada),
    )
  ).sessions[0]?.id as string;
  await run(
    "x.programs.logAdd",
    { sessionId: thursday, item: "A1", level: 1, setNumber: 1, actual: { reps: 5 } },
    as(ada),
  );
  // Ben skips his Thursday, and logs nothing at all.
  const bens = (await run<Sessions>("x.programs.today", { date: "2027-01-07" }, as(ben)))
    .sessions[0]?.id as string;
  await run("x.programs.sessionComplete", { sessionId: bens, state: "skipped" }, as(ben));
}, 120_000);

describe("the Training dashboard (criterion 7)", () => {
  it("every widget's numbers match the fixture worked out by hand", async () => {
    const dashboardId = extensionDashboardId("programs", "training");
    const dashboard = await run<{ widgets: { id: string }[] }>(
      "dashboard.get",
      { id: dashboardId },
      staff(admin),
    );
    expect(dashboard.widgets.map((w) => w.id)).toEqual([
      "planned",
      "done",
      "sets",
      "quiet-count",
      "planned-done",
      "sets-by-week",
      "exercises",
      "quiet",
    ]);
    const results: Record<string, Record<string, unknown>[]> = {};
    for (const { id } of dashboard.widgets) {
      const out = await run<{ rows: Record<string, unknown>[] }>(
        "widget.run",
        {
          dashboardId,
          widgetId: id,
          filters: { date: { from: "2027-01-01", to: "2027-02-01" } },
          refresh: true,
        },
        staff(admin, { widgetCache: memoryWidgetCache() }),
      );
      results[id] = out.rows;
    }
    // Two clients × four sessions; the class's sessions are not a client's.
    expect(results.planned).toEqual([{ value: 8 }]);
    expect(results.done).toEqual([{ value: 1 }]);
    // Ada's three sets on Monday and one at the class.
    expect(results.sets).toEqual([{ value: 4 }]);
    // Ben has an active program and no set: quiet. Ada logged (her sets are dated in 2027).
    expect(results["quiet-count"]).toEqual([{ value: 1 }]);
    expect(results["planned-done"]).toEqual([
      { week: "2027-01-04", planned: 4, done: 1, skipped: 1 },
      { week: "2027-01-11", planned: 4, done: 0, skipped: 0 },
    ]);
    expect(results["sets-by-week"]).toEqual([{ week: "2027-01-04", sets: 4 }]);
    expect(results.exercises?.map((r) => [r.label, r.value])).toEqual([
      ["Pike compression", 2],
      ["Ring row", 2],
    ]);
    expect(results.quiet).toEqual([
      { id: ben.personId, client: "Ben", program: "Two weeks for Ben", last_logged: null },
    ]);
    // Outside the period, nothing.
    const later = await run<{ rows: Record<string, unknown>[] }>(
      "widget.run",
      {
        dashboardId,
        widgetId: "planned",
        filters: { date: { from: "2027-02-01", to: "2027-03-01" } },
        refresh: true,
      },
      staff(admin, { widgetCache: memoryWidgetCache() }),
    );
    expect(later.rows).toEqual([{ value: 0 }]);
    expect(today < "2027-01-01").toBe(true);
  });
});

describe("the views and the Person page", () => {
  it("ships its views, the Training tab and the Programs and Sessions panels", async () => {
    const row = await env.DB.prepare(
      "SELECT manifest FROM core_extensions WHERE id = 'programs'",
    ).first<{
      manifest: string;
    }>();
    const manifest = JSON.parse(row?.manifest ?? "{}") as {
      views: Record<string, unknown>;
      recordTabs: Record<string, { on: string }>;
      recordPanels: Record<string, { on: string }>;
    };
    expect(Object.keys(manifest.views).sort()).toEqual([
      "activeAssignments",
      "bankByTheme",
      "programsPublished",
      "sessionsCalendar",
      "sessionsThisWeek",
      "setsThisWeek",
    ]);
    expect(manifest.recordTabs.personTraining?.on).toBe("person");
    expect(Object.keys(manifest.recordPanels).sort()).toEqual([
      "personAssignments",
      "personSessions",
    ]);
    // The tab's list is Ada's sets, newest first, as the host renders it.
    const sets = await run<{ items: { values: Record<string, unknown> }[] }>(
      "record.list",
      {
        object: "programs.log",
        filter: { field: "person", op: "eq", value: ada.personId },
        sort: { field: "date", direction: "desc" },
      },
      staff(admin),
    );
    expect(sets.items).toHaveLength(4);
    const published = await run<{ items: unknown[] }>(
      "record.list",
      { object: PROGRAM, filter: { field: "publishedVersion", op: "is_not_null" } },
      staff(admin),
    );
    expect(published.items).toHaveLength(1);
  });
});
