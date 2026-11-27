// Stage 39 step 5 (ADR 0756): the Jobs pack beside Rostering, in the real host. A crew place is a
// shift like a duty: with Rostering installed, only someone who rosters puts crew on a visit, by
// any path (decision 7, AC 4); a crew place is saved with its warnings, the person away or not
// qualified for the visit type (AC 4); it is on Rostering's week and in the person's calendar
// feed, and the time claim holds across a duty shift and a visit, so one person is never on both
// at once (AC 5).
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  readStaffFeed,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { createAdmin, createMember, db, host, unique } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const files: Record<string, Record<string, string>> = {
  jobs: packFiles("jobs"),
  rostering: packFiles("rostering"),
};

const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !(s.id in files)),
    { id: "jobs", version: "0.1.0" },
    { id: "rostering", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    files[id]
      ? host.commit({
          id,
          files: files[id] as Record<string, string>,
          message: `Shipped ${id}`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const VISIT = "jobs.visit";
const PLACE = "jobs.assignment";
const VISIT_TYPE = "jobs.visittype";
const ZONE = "Australia/Sydney";
const DAY = 86_400_000;

let admin: ActingUser;
let member: ActingUser;
let rosterer: ActingUser;
let crew: ActingUser;
let visitType: string;

const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  extensionHost: shippedHost,
  ...extra,
});

function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext,
): Promise<T> {
  return invokeByName(name, input, ctx) as Promise<T>;
}

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    const code = e.code === "extension_error" ? String(e.details?.code) : e.code;
    return { code, message: e.message ?? "" };
  }
  throw new Error("expected a refusal");
}

async function staffAccount(name: string) {
  const id = `usr_${unique("jr")}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 1, ?, ?, 'member')",
  )
    .bind(id, name, `${unique("jr")}@example.com`, now, now)
    .run();
  return { id, email: "", name, role: "member" } as ActingUser;
}

/** An instant `days` from now at `hour` UTC. */
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

async function newJob(title: string) {
  return (
    await run<{ jobId: string }>(
      "x.jobs.enquire",
      { title, site: { line1: `${unique("")} Roster St` } },
      staff(admin),
    )
  ).jobId;
}

async function newVisit(days: number, hour: number) {
  return (
    await run<{ visitId: string }>(
      "x.jobs.bookVisit",
      {
        jobId: await newJob(unique("Job ")),
        visitTypeId: visitType,
        starts: at(days, hour),
        ends: at(days, hour + 2),
      },
      staff(admin),
    )
  ).visitId;
}

beforeAll(async () => {
  admin = await createAdmin();
  for (const id of ["rostering", "jobs"]) {
    await run("extension.install", { id, shipped: true }, staff(admin));
  }
  await refreshSchemaRegistry(db.query);
  member = await createMember();
  rosterer = await staffAccount("Rae Rosters");
  await run(
    "user.setPermissions",
    { id: rosterer.id, permissions: ["rostering:manage"] },
    staff(admin),
  );
  crew = await staffAccount("Kit Crew");
  visitType = String(
    (
      await env.DB.prepare("SELECT id FROM rec_x_jobs_visittype WHERE name = 'Plumbing'").first<{
        id: string;
      }>()
    )?.id,
  );
}, 180_000);

describe("who puts crew on a visit, with Rostering installed (AC 4, decision 7)", () => {
  it("a member who does not roster cannot, by the tool or a record write; a rosterer can", async () => {
    const visit = await newVisit(2, 1);
    expect(
      (await refusal(run("x.jobs.assignCrew", { visitId: visit, staffId: crew.id }, staff(member))))
        .code,
    ).toBe("forbidden");
    expect(
      (
        await refusal(
          run("record.create", { object: PLACE, values: { visit, staff: crew.id } }, staff(member)),
        )
      ).code,
    ).toBe("forbidden");
    const placed = await run<{ id: string }>(
      "x.jobs.assignCrew",
      { visitId: visit, staffId: crew.id },
      staff(rosterer),
    );
    expect(placed.id).toBeTruthy();
    // Nor does the member take them off by a record write naming someone else.
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: PLACE, id: placed.id, values: { staff: member.id } },
            staff(member),
          ),
        )
      ).code,
    ).toBe("forbidden");
  });

  it("saves a place with its warnings: away, and not qualified for the visit type; qualified, no warning", async () => {
    // Kit says they are away on day 3.
    const day3 = new Date(Date.now() + 3 * DAY);
    const local = (d: Date, time: string) =>
      `${new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(d)}T${time}`;
    await run(
      "x.rostering.away",
      {
        kind: "other",
        startsAt: local(new Date(day3.getTime() - DAY), "00:00"),
        endsAt: local(new Date(day3.getTime() + DAY), "23:59"),
        zone: ZONE,
      },
      staff(crew),
    );
    // Plumbing is work someone is marked qualified for (the member), and Kit is not.
    await run(
      "x.rostering.qualify",
      { account: member.id, kind: { object: VISIT_TYPE, id: visitType }, qualified: true },
      staff(rosterer),
    );
    const visit = await newVisit(3, 2);
    const placed = await run<{ warnings: { code: string }[] }>(
      "x.jobs.assignCrew",
      { visitId: visit, staffId: crew.id },
      staff(rosterer),
    );
    expect(placed.warnings.map((w) => w.code).sort()).toEqual(["not_qualified", "unavailable"]);
    await run(
      "x.rostering.qualify",
      { account: crew.id, kind: { object: VISIT_TYPE, id: visitType }, qualified: true },
      staff(rosterer),
    );
    const later = await newVisit(6, 2);
    const ok = await run<{ warnings: { code: string }[] }>(
      "x.jobs.assignCrew",
      { visitId: later, staffId: crew.id },
      staff(rosterer),
    );
    expect(ok.warnings).toEqual([]);
  });
});

describe("crew places on the roster (AC 5)", () => {
  it("are on Rostering's week, as the visit type to others, and in the person's calendar feed", async () => {
    const visit = await newVisit(4, 3);
    const placed = await run<{ id: string }>(
      "x.jobs.assignCrew",
      { visitId: visit, staffId: crew.id },
      staff(rosterer),
    );
    const week = await run<{ shifts: { id: string; object: string; title?: string | null }[] }>(
      "x.rostering.week",
      {},
      staff(member),
    );
    const shift = week.shifts.find((s) => s.id === placed.id);
    expect(shift?.object).toBe(PLACE);
    // The crew place's title names the customer's job: other staff see the visit type.
    expect(JSON.stringify(shift)).not.toContain("Job ");
    const made = await run<{ path: string }>("x.rostering.feedRotate", {}, staff(crew));
    const token = /\/feed\/([A-Za-z0-9_-]{43})\.ics$/.exec(made.path)?.[1] as string;
    const feed = await readStaffFeed(db.query, token, new Date());
    expect(feed?.shifts.map((s) => s.id)).toContain(placed.id);
  });

  it("a duty shift and a visit are never one person's at once, whichever is written second", async () => {
    const duty = (
      await run<{ id: string }>(
        "record.create",
        { object: "rostering.duty", values: { name: unique("Van check"), place: "Depot" } },
        staff(admin),
      )
    ).id;
    await run(
      "record.create",
      {
        object: "rostering.shift",
        values: { duty, staff: crew.id, startsAt: at(5, 1), endsAt: at(5, 3), timezone: ZONE },
      },
      staff(rosterer),
    );
    const visit = await newVisit(5, 2);
    const refused = await refusal(
      run("x.jobs.assignCrew", { visitId: visit, staffId: crew.id }, staff(rosterer)),
    );
    expect(refused.code).toBe("conflict");
    // And the other way round: a duty over a crew place.
    const free = await newVisit(5, 6);
    await run("x.jobs.assignCrew", { visitId: free, staffId: crew.id }, staff(rosterer));
    expect(
      (
        await refusal(
          run(
            "record.create",
            {
              object: "rostering.shift",
              values: {
                duty,
                staff: crew.id,
                startsAt: at(5, 7),
                endsAt: at(5, 8),
                timezone: ZONE,
              },
            },
            staff(rosterer),
          ),
        )
      ).code,
    ).toBe("conflict");
    // Moving the visit onto the duty is refused, naming the person.
    const moved = await refusal(
      run("x.jobs.moveVisit", { visitId: free, starts: at(5, 1) }, staff(rosterer)),
    );
    expect(moved.code).toBe("conflict");
    expect(moved.message).toContain("Kit Crew");
    expect(
      (
        await run<{ values: { starts: string } }>(
          "record.get",
          { object: VISIT, id: free },
          staff(admin),
        )
      ).values.starts,
    ).toBe(at(5, 6));
  });
});
