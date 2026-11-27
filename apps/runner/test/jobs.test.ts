// Stage 39 step 5 (ADR 0756): the Jobs pack (packs/jobs) in the real host, its tools run in the
// sandbox, installed the way a product that lists the pack installs it, with real D1.
//
// What it shows, by the spec's acceptance criteria: a job taken as an enquiry moves through the
// seeded Trades pipeline, and Accepted, Signed off and Invoiced are refused to every path until
// the host's fact is set, the office's record of an acceptance being a person's own act (1); a
// visit booked with three crew moved by record.update moves all three crew places, and a move that
// would put one of them in two places is refused whole naming them (2); two people putting one
// person on two overlapping visits at once: exactly one succeeds (3); a crew place is made with its
// warnings (4); a crew account reaches only the jobs, visits and places of its own live places
// within the window, the rest not found, and reads no line, rate or price (6); a fixed-price job's
// unbilled total is its accepted estimate and approved variations, a time and materials job's its
// approved labour and materials, in integer minor units (11); an AI's assign waits for a person
// and its approval of a variation is refused (15); the CSV is for jobs:prices only, a person's,
// and audited (16). And what this pack adds to them: a line's words and numbers never change once
// written, so an approved line is not edited, re-pointed or put in the Trash by a record write; a
// variation's lines are approved or voided with it; every tool a person calls runs at once under
// every preset. apps/runner/test/jobs-rostering.test.ts runs it beside Rostering (4, 5).
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  loadStaffRights,
  refreshSchemaRegistry,
  roleMineFor,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, createMember, db, host, unique } from "./helpers.ts";

const packFiles = (sources: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(sources)
      .map(([path, text]) => [path.split("/").pop() as string, text] as const)
      .filter(([name]) => name !== "vitest.config.ts"),
  );
const files: Record<string, Record<string, string>> = {
  jobs: packFiles(
    import.meta.glob<string>("../../../packs/jobs/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
};

/** The extension host of a deployment whose product lists Jobs. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => s.id !== "jobs"),
    { id: "jobs", version: "0.1.0" },
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

const JOB = "jobs.job";
const SITE = "jobs.site";
const VISIT = "jobs.visit";
const PLACE = "jobs.assignment";
const LINE = "jobs.line";
const VARIATION = "jobs.variation";
const STAGE = "jobs.stage";
const RATE = "jobs.rate";

let admin: ActingUser;
let member: ActingUser;
let pricer: ActingUser;
let crewA: ActingUser;
let crewB: ActingUser;
let crewC: ActingUser;
/** On the crew's-reach jobs only. */
let crewD: ActingUser;
let customer: string;
let visitType: string;
const stages: Record<string, string> = {};
let projects: string;

const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  extensionHost: shippedHost,
  ...extra,
});
const assistant = (user: ActingUser) =>
  staff(user, { actor: "assistant", origin: { surface: "assistant", sessionId: unique("s") } });
const mcp = (user: ActingUser) => staff(user, { actor: "mcp", origin: { surface: "mcp" } });

function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext,
): Promise<T> {
  return invokeByName(name, input, ctx) as Promise<T>;
}

/** What a call was refused with: its code and the host's details (unwrapped from a tool's). */
async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    const inner = (e.details?.details ?? e.details) as Record<string, unknown> | undefined;
    // A host refusal a tool let escape is the host's code, carried in the tool's error.
    const code = e.code === "extension_error" ? String(e.details?.code) : e.code;
    return { code, message: e.message ?? "", inner: e.details?.code, details: inner };
  }
  throw new Error("expected a refusal");
}

async function staffAccount(name: string) {
  const id = `usr_${unique("j")}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 1, ?, ?, 'member')",
  )
    .bind(id, name, `${unique("j")}@example.com`, now, now)
    .run();
  return { id, email: "", name, role: "member" } as ActingUser;
}

type Rec = { id: string; values: Record<string, unknown>; warnings?: { code: string }[] };

const get = (object: string, id: string) => run<Rec>("record.get", { object, id }, staff(admin));

const DAY = 86_400_000;
/** An instant `days` from now at `hour` UTC. */
const at = (days: number, hour: number, minute = 0) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
};

/** A job taken as an enquiry by the member, at a new site. */
async function newJob(title: string, extra: Record<string, unknown> = {}) {
  return run<{ jobId: string; siteId: string | null; stageId: string | null }>(
    "x.jobs.enquire",
    {
      title,
      customerId: customer,
      site: { line1: `${unique("")} Example St`, suburb: "Newtown", postcode: "2042" },
      ...extra,
    },
    staff(member),
  );
}

/** A visit booked by the member, two hours from `days` days out at `hour`. */
async function newVisit(jobId: string, days: number, hour: number, crew: ActingUser[] = []) {
  return run<{
    visitId: string;
    crew: { id: string; staff: string; warnings: { code: string }[] }[];
  }>(
    "x.jobs.bookVisit",
    {
      jobId,
      visitTypeId: visitType,
      starts: at(days, hour),
      ends: at(days, hour + 2),
      crew: crew.map((c) => ({ staffId: c.id })),
    },
    staff(member),
  );
}

async function approveQueued(details: Record<string, unknown> | undefined, by: ActingUser) {
  const actionId = String((details as { actionId?: string } | undefined)?.actionId);
  const approve = (confirm?: string) =>
    run<{ results: { status: string }[] }>(
      "approval.approve",
      { actionIds: [actionId], ...(confirm ? { confirm } : {}) },
      staff(by),
    );
  return approve().catch(async (error: { details?: { confirmLabel?: string } }) => {
    const label = error.details?.confirmLabel;
    if (!label) throw error;
    return approve(label);
  });
}

beforeAll(async () => {
  admin = await createAdmin();
  await run("extension.install", { id: "jobs", shipped: true }, staff(admin));
  await refreshSchemaRegistry(db.query);
  member = await createMember();
  pricer = await staffAccount("Pat Prices");
  await run("user.setPermissions", { id: pricer.id, permissions: ["jobs:prices"] }, staff(admin));
  crewA = await staffAccount("Ari Crew");
  crewB = await staffAccount("Bo Crew");
  crewC = await staffAccount("Cy Crew");
  crewD = await staffAccount("Dee Crew");
  for (const c of [crewA, crewB, crewC, crewD]) {
    await run("user.setPackRole", { id: c.id, role: "jobs.crew" }, staff(admin));
  }
  customer = (
    await run<{ id: string }>(
      "person.create",
      { givenName: "Casey", familyName: unique("Customer") },
      staff(admin),
    )
  ).id;
  const { results } = await env.DB.prepare(
    "SELECT s.id AS id, s.name AS name, p.name AS pipeline FROM rec_x_jobs_stage s JOIN rec_x_jobs_pipeline p ON p.id = s.pipeline",
  ).all<{ id: string; name: string; pipeline: string }>();
  for (const r of results) stages[`${r.pipeline}:${r.name}`] = r.id;
  projects = String(
    (
      await env.DB.prepare("SELECT id FROM rec_x_jobs_pipeline WHERE name = 'Projects'").first<{
        id: string;
      }>()
    )?.id,
  );
  visitType = String(
    (
      await env.DB.prepare("SELECT id FROM rec_x_jobs_visittype WHERE name = 'Electrical'").first<{
        id: string;
      }>()
    )?.id,
  );
}, 180_000);

afterAll(() => setPreset("balanced"));

describe("the pack in a product", () => {
  it("is installed as shipped, with its pipelines, stages, visit types and rates seeded", async () => {
    const row = await env.DB.prepare("SELECT source, status FROM core_extensions WHERE id = ?")
      .bind("jobs")
      .first();
    expect(row).toEqual({ source: "shipped", status: "active" });
    expect(Object.keys(stages).filter((k) => k.startsWith("Trades:"))).toHaveLength(13);
    expect(Object.keys(stages).filter((k) => k.startsWith("Projects:"))).toHaveLength(5);
    const rates = await env.DB.prepare("SELECT count(*) AS n FROM rec_x_jobs_rate").first<{
      n: number;
    }>();
    expect(rates?.n).toBe(3);
  });
});

describe("the job's stages and the host's facts (AC 1)", () => {
  it("an enquiry starts at Enquiry on the Trades pipeline, at a new site for its customer", async () => {
    const job = await newJob("Rewire the kitchen");
    expect(job.stageId).toBe(stages["Trades:Enquiry"]);
    const record = await get(JOB, job.jobId);
    expect(record.values).toMatchObject({ customer, billing: "fixed", status: "open" });
    expect((await get(SITE, String(job.siteId))).values.customer).toBe(customer);
    // Through the stages a person drags it.
    for (const name of ["Site visit", "Quoting", "Quote sent"]) {
      await run(
        "record.update",
        { object: JOB, id: job.jobId, values: { stage: stages[`Trades:${name}`] } },
        staff(member),
      );
    }
  });

  it("refuses Accepted, Signed off and Invoiced to a person, the assistant and MCP until the fact is set, naming it", async () => {
    const job = await newJob("Replace the switchboard");
    for (const [stage, fact] of [
      ["Accepted", "acceptedAt"],
      ["Signed off", "signedOffAt"],
      ["Invoiced", "invoicedAt"],
    ] as const) {
      for (const ctx of [staff(member), staff(admin), assistant(admin), mcp(admin)]) {
        const refused = await refusal(
          run(
            "record.update",
            { object: JOB, id: job.jobId, values: { stage: stages[`Trades:${stage}`] } },
            ctx,
          ),
        );
        if (refused.code === "pending_approval") {
          // Asked: the approval fails at the same rule.
          const decided = await approveQueued(refused.details, admin);
          expect(decided.results.map((r) => r.status)).not.toEqual(["applied"]);
        } else {
          expect(refused.code, `${stage} ${ctx.actor}`).toBe("invalid_input");
          expect(JSON.stringify(refused.details)).toContain(fact);
        }
      }
      // Nor by writing the fact.
      expect(
        (
          await refusal(
            run(
              "record.update",
              { object: JOB, id: job.jobId, values: { [fact]: new Date().toISOString() } },
              staff(admin),
            ),
          )
        ).code,
      ).toBe("invalid_input");
    }
    expect((await get(JOB, job.jobId)).values.stage).toBe(stages["Trades:Enquiry"]);
  });

  it("the office records an acceptance, a person's own act: the fact set as the office's, the estimate named approved, then Accepted", async () => {
    const job = await newJob("Install downlights");
    const lineA = await run<{ lineId: string }>(
      "x.jobs.addLine",
      { jobId: job.jobId, kind: "estimate", description: "Downlights", quantity: 6, unitPrice: 45 },
      staff(pricer),
    );
    const lineB = await run<{ lineId: string }>(
      "x.jobs.addLine",
      { jobId: job.jobId, kind: "estimate", description: "Not agreed", quantity: 1, unitPrice: 99 },
      staff(pricer),
    );
    for (const ctx of [assistant(admin), mcp(admin)]) {
      const refused = await refusal(
        run(
          "x.jobs.recordAcceptance",
          { jobId: job.jobId, how: "Phone call", estimateLines: [lineA.lineId] },
          ctx,
        ),
      );
      expect(refused.code).toBe("forbidden");
    }
    const out = await run<{ acceptedAt: string; stage: string; approvedLines: string[] }>(
      "x.jobs.recordAcceptance",
      {
        jobId: job.jobId,
        how: "Signed paper estimate",
        estimateLines: [lineA.lineId],
        stageId: stages["Trades:Accepted"],
      },
      staff(member),
    );
    expect(out.stage).toBe(stages["Trades:Accepted"]);
    expect(out.approvedLines).toEqual([lineA.lineId]);
    expect((await get(JOB, job.jobId)).values).toMatchObject({
      acceptedBy: "office",
      acceptedHow: "Signed paper estimate",
      acceptedByName: member.name,
    });
    expect((await get(LINE, lineA.lineId)).values.state).toBe("approved");
    expect((await get(LINE, lineB.lineId)).values.state).toBe("draft");
    // Signed off still waits for its own fact.
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: JOB, id: job.jobId, values: { stage: stages["Trades:Signed off"] } },
            staff(member),
          ),
        )
      ).code,
    ).toBe("invalid_input");
  });

  it("the gated stages are an admin's, in person, to change", async () => {
    const accepted = stages["Trades:Accepted"] as string;
    for (const ctx of [staff(member), assistant(admin)]) {
      const refused = await refusal(
        run("record.update", { object: STAGE, id: accepted, values: { requiredFields: [] } }, ctx),
      );
      expect(["forbidden", "pending_approval"]).toContain(refused.code);
      if (refused.code === "pending_approval") {
        const decided = await approveQueued(refused.details, admin);
        expect(decided.results.map((r) => r.status)).not.toEqual(["applied"]);
      }
    }
    expect((await get(STAGE, accepted)).values.requiredFields).toEqual(["acceptedAt"]);
  });

  it("a project lives on the Projects pipeline with tasks and no site or visit (AC 14, time waits for stage 58)", async () => {
    const job = await run<{ jobId: string; siteId: string | null; stageId: string | null }>(
      "x.jobs.enquire",
      { title: "Open a second room", pipelineId: projects },
      staff(member),
    );
    expect(job.siteId).toBeNull();
    expect(job.stageId).toBe(stages["Projects:Planning"]);
    await run(
      "task.create",
      { title: "Order mats", links: [{ object: JOB, id: job.jobId }] },
      staff(member),
    );
    const tasks = await run<{ items: unknown[] }>(
      "task.list",
      { linkedRecordId: job.jobId },
      staff(member),
    );
    expect(tasks.items).toHaveLength(1);
    await run(
      "record.update",
      { object: JOB, id: job.jobId, values: { stage: stages["Projects:Done"] } },
      staff(member),
    );
    expect((await get(JOB, job.jobId)).values.status).toBe("won");
  });

  it("an enquiry sent twice with one request id makes one job", async () => {
    const requestId = unique("req-enquiry-");
    const input = { title: "Fix a leak", customerId: customer, requestId };
    const first = await run<{ jobId: string; existing: boolean }>(
      "x.jobs.enquire",
      input,
      staff(member),
    );
    const again = await run<{ jobId: string; existing: boolean }>(
      "x.jobs.enquire",
      input,
      staff(member),
    );
    expect(again).toMatchObject({ jobId: first.jobId, existing: true });
    // Another person's same id is another request.
    const other = await run<{ jobId: string; existing: boolean }>(
      "x.jobs.enquire",
      input,
      staff(admin),
    );
    expect(other.jobId).not.toBe(first.jobId);
  });
});

describe("visits and their crew (AC 2, 3, 4)", () => {
  it("a visit booked with three crew moved by record.update moves all three; a clash refuses it whole naming the person", async () => {
    const job = await newJob("Three-person install");
    const visit = await newVisit(job.jobId, 3, 1, [crewA, crewB, crewC]);
    expect(visit.crew).toHaveLength(3);
    // Each saved with its warnings (nobody is marked qualified for electrical work).
    // Each saved with its warnings (jobs-rostering.test.ts: away, not qualified): none stops it.
    for (const p of visit.crew) expect(Array.isArray(p.warnings)).toBe(true);
    const places = visit.crew.map((p) => p.id);
    for (const id of places) {
      expect((await get(PLACE, id)).values).toMatchObject({ starts: at(3, 1), ends: at(3, 3) });
    }
    await run(
      "record.update",
      { object: VISIT, id: visit.visitId, values: { starts: at(3, 5), ends: at(3, 7) } },
      staff(admin),
    );
    for (const id of places) {
      expect((await get(PLACE, id)).values).toMatchObject({ starts: at(3, 5), ends: at(3, 7) });
    }
    // Bo is on another visit from 08:00: moving this one over it is refused, naming Bo.
    const other = await newJob("Another job");
    await newVisit(other.jobId, 3, 8, [crewB]);
    const refused = await refusal(
      run(
        "x.jobs.moveVisit",
        { visitId: visit.visitId, starts: at(3, 7), ends: at(3, 9) },
        staff(member),
      ),
    );
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain("Bo Crew");
    for (const id of places) {
      expect((await get(PLACE, id)).values).toMatchObject({ starts: at(3, 5), ends: at(3, 7) });
    }
    expect((await get(VISIT, visit.visitId)).values.starts).toBe(at(3, 5));
    // Nobody writes a crew place's times, the pack's own code included.
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: PLACE, id: places[0], values: { starts: at(3, 9) } },
            staff(admin),
          ),
        )
      ).code,
    ).toBe("invalid_input");
  });

  it("a booking that would put someone in two places books nothing, and can be sent again", async () => {
    const busy = await newJob("Busy morning");
    await newVisit(busy.jobId, 4, 1, [crewC]);
    const job = await newJob("Clashing booking");
    const requestId = unique("req-visit-");
    const input = {
      jobId: job.jobId,
      visitTypeId: visitType,
      starts: at(4, 2),
      ends: at(4, 4),
      crew: [{ staffId: crewA.id }, { staffId: crewC.id }],
      requestId,
    };
    const refused = await refusal(run("x.jobs.bookVisit", input, staff(member)));
    expect(refused.code, refused.message).toBe("conflict");
    expect(refused.message).toContain("Cy Crew");
    const { results } = await env.DB.prepare(
      "SELECT v.state AS state, (SELECT count(*) FROM rec_x_jobs_assignment a WHERE a.visit = v.id AND a.state = 'booked') AS live FROM rec_x_jobs_visit v WHERE v.job = ?",
    )
      .bind(job.jobId)
      .all<{ state: string; live: number }>();
    expect(results).toEqual([{ state: "cancelled", live: 0 }]);
    // Sent again without the clash: booked.
    const booked = await run<{ visitId: string; existing: boolean }>(
      "x.jobs.bookVisit",
      { ...input, crew: [{ staffId: crewA.id }] },
      staff(member),
    );
    expect(booked.existing).toBe(false);
    const again = await run<{ visitId: string; existing: boolean }>(
      "x.jobs.bookVisit",
      { ...input, crew: [{ staffId: crewA.id }] },
      staff(member),
    );
    expect(again).toMatchObject({ visitId: booked.visitId, existing: true });
  });

  it("two people putting one person on two overlapping visits at once: exactly one succeeds", async () => {
    const one = await newVisit((await newJob("Race one")).jobId, 5, 1);
    const two = await newVisit((await newJob("Race two")).jobId, 5, 2);
    const results = await Promise.allSettled([
      run("x.jobs.assignCrew", { visitId: one.visitId, staffId: crewA.id }, staff(member)),
      run("x.jobs.assignCrew", { visitId: two.visitId, staffId: crewA.id }, staff(admin)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const { results: rows } = await env.DB.prepare(
      "SELECT count(*) AS n FROM rec_x_jobs_assignment WHERE staff = ? AND state = 'booked' AND visit IN (?, ?)",
    )
      .bind(crewA.id, one.visitId, two.visitId)
      .all<{ n: number }>();
    expect(rows[0]?.n).toBe(1);
  });

  it("assigning the same person twice finds their place; taking them off frees the time", async () => {
    const visit = await newVisit((await newJob("Twice")).jobId, 6, 1);
    const first = await run<{ id: string }>(
      "x.jobs.assignCrew",
      { visitId: visit.visitId, staffId: crewB.id },
      staff(member),
    );
    const again = await run<{ id: string }>(
      "x.jobs.assignCrew",
      { visitId: visit.visitId, staffId: crewB.id },
      staff(member),
    );
    expect(again.id).toBe(first.id);
    await run("x.jobs.removeCrew", { placeId: first.id }, staff(member));
    expect((await get(PLACE, first.id)).values.state).toBe("cancelled");
    const other = await newVisit((await newJob("Freed")).jobId, 6, 1, [crewB]);
    expect(other.crew).toHaveLength(1);
  });

  it("a visit cancelled cancels its crew; a live visit leaves the Trash to a person with its tools", async () => {
    const visit = await newVisit((await newJob("Cancel me")).jobId, 7, 1, [crewA, crewB]);
    for (const ctx of [assistant(admin), mcp(admin)]) {
      const refused = await refusal(
        run("record.delete", { object: VISIT, id: visit.visitId }, ctx),
      );
      expect(["forbidden", "pending_approval"]).toContain(refused.code);
      if (refused.code === "pending_approval") {
        const decided = await approveQueued(refused.details, admin);
        expect(decided.results.map((r) => r.status)).not.toEqual(["applied"]);
      }
    }
    // A record write cannot mark it done or cancelled.
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: VISIT, id: visit.visitId, values: { state: "cancelled" } },
            staff(admin),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    await run("x.jobs.cancelVisit", { visitId: visit.visitId }, staff(member));
    for (const p of visit.crew) expect((await get(PLACE, p.id)).values.state).toBe("cancelled");
  });

  it("a visit is booked only by bookVisit for a job: a record write cannot set its job", async () => {
    const job = await newJob("No direct visit");
    const refused = await refusal(
      run(
        "record.create",
        {
          object: VISIT,
          values: { job: job.jobId, visitType, starts: at(8, 1), ends: at(8, 2) },
        },
        staff(admin),
      ),
    );
    expect(refused.code).toBe("invalid_input");
  });
});

describe("the crew's reach (AC 6)", () => {
  let reached: string;
  let reachedVisit: string;
  let notReached: string;
  let farJob: string;

  beforeAll(async () => {
    reached = (await newJob("Crew D's job")).jobId;
    reachedVisit = (await newVisit(reached, 2, 22, [crewD])).visitId;
    notReached = (await newJob("Someone else's job")).jobId;
    await newVisit(notReached, 2, 22, [crewB]);
    farJob = (await newJob("Twenty days out")).jobId;
    await newVisit(farJob, 20, 1, [crewD]);
    await run(
      "x.jobs.addLine",
      { jobId: reached, kind: "estimate", description: "Labour", quantity: 2, unitPrice: 120 },
      staff(pricer),
    );
  });

  it("lists and opens only the jobs, visits and places of its own live places in the window", async () => {
    const jobs = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: JOB, limit: 200 },
      staff(crewD),
    );
    expect(jobs.items.map((j) => j.id)).toEqual([reached]);
    for (const id of [notReached, farJob]) {
      expect((await refusal(run("record.get", { object: JOB, id }, staff(crewD)))).code).toBe(
        "not_found",
      );
      expect(
        (await refusal(run("x.jobs.myJob", { jobId: id }, staff(crewD)))).inner ?? "not_found",
      ).toBe("not_found");
    }
    const visits = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: VISIT, limit: 200 },
      staff(crewD),
    );
    expect(visits.items.map((v) => v.id)).toEqual([reachedVisit]);
  });

  it("reads no line, rate or site directly, and calls no price tool", async () => {
    for (const object of [LINE, RATE, SITE]) {
      expect((await refusal(run("record.list", { object }, staff(crewD)))).code, object).toBe(
        "forbidden",
      );
    }
    for (const [name, input] of [
      ["x.jobs.unbilled", {}],
      ["x.jobs.exportUnbilled", {}],
      ["x.jobs.addLine", { jobId: reached, kind: "material", description: "x", quantity: 1 }],
      ["x.jobs.jobSummary", { jobId: reached }],
      ["x.jobs.bookVisit", { jobId: reached, visitTypeId: visitType, starts: at(2, 1) }],
    ] as const) {
      expect((await refusal(run(name, input, staff(crewD)))).code, name).toBe("forbidden");
    }
  });

  it("sees its day: its visit, the job and the site's address, and no price", async () => {
    const mine = await run<{ visits: { id: string; job: { id: string }; site: unknown }[] }>(
      "x.jobs.myVisits",
      { days: 7 },
      staff(crewD),
    );
    expect(mine.visits.map((v) => v.id)).toEqual([reachedVisit]);
    expect(mine.visits[0]?.job.id).toBe(reached);
    expect(mine.visits[0]?.site).toMatchObject({ address: expect.stringContaining("Example St") });
    const job = await run<Record<string, unknown>>(
      "x.jobs.myJob",
      { jobId: reached },
      staff(crewD),
    );
    expect(JSON.stringify(job)).not.toMatch(/unitPrice|cost|120/);
  });

  it("records a material and proposes a variation on its job, never on another", async () => {
    const material = await run<{ lineId: string }>(
      "x.jobs.addMaterial",
      { jobId: reached, description: "Cable 2.5mm", quantity: 30, unit: "m" },
      staff(crewD),
    );
    expect((await get(LINE, material.lineId)).values).toMatchObject({
      kind: "material",
      state: "draft",
      recordedBy: crewD.id,
    });
    expect((await get(LINE, material.lineId)).values.unitPrice ?? null).toBeNull();
    const requestId = unique("req-var-");
    const input = {
      jobId: reached,
      title: "Extra power point",
      why: "Customer asked on site",
      askedBy: "customer",
      lines: [{ description: "Double power point", quantity: 1 }],
      requestId,
    };
    const variation = await run<{ variationId: string; lineIds: string[] }>(
      "x.jobs.proposeVariation",
      input,
      staff(crewD),
    );
    const again = await run<{ variationId: string; lineIds: string[]; existing: boolean }>(
      "x.jobs.proposeVariation",
      input,
      staff(crewD),
    );
    expect(again).toMatchObject({ variationId: variation.variationId, existing: true });
    expect(again.lineIds).toEqual(variation.lineIds);
    for (const name of ["x.jobs.addMaterial", "x.jobs.proposeVariation"]) {
      const refused = await refusal(
        run(
          name,
          name === "x.jobs.addMaterial"
            ? { jobId: notReached, description: "x", quantity: 1 }
            : { ...input, jobId: notReached, requestId: unique("req-") },
          staff(crewD),
        ),
      );
      expect(refused.inner ?? refused.code, name).toBe("not_found");
    }
  });

  it("marks its own visit on the way, on site and done; another's is not found; the assistant cannot", async () => {
    expect(
      (await refusal(run("x.jobs.markOnTheWay", { visitId: reachedVisit }, assistant(admin)))).code,
    ).toBe("forbidden");
    await run("x.jobs.markOnTheWay", { visitId: reachedVisit }, staff(crewD));
    await run("x.jobs.markOnSite", { visitId: reachedVisit }, staff(crewD));
    const { results } = await env.DB.prepare("SELECT id FROM rec_x_jobs_visit WHERE job = ?")
      .bind(notReached)
      .all<{ id: string }>();
    const refused = await refusal(
      run("x.jobs.markDone", { visitId: String(results[0]?.id) }, staff(crewD)),
    );
    expect(refused.inner ?? refused.code).toBe("not_found");
    await run("x.jobs.markDone", { visitId: reachedVisit }, staff(crewD));
    expect((await get(VISIT, reachedVisit)).values.state).toBe("done");
    // Done is done: on site again is refused.
    expect(
      (await refusal(run("x.jobs.markOnSite", { visitId: reachedVisit }, staff(crewD)))).code,
    ).toBe("invalid_input");
  });

  it("a call carrying the crew's limit cannot move a visit's times, which decide the reach", async () => {
    // The limit a tool run the crew account started carries (the pipeline's own derivation).
    const limit = roleMineFor(
      await loadStaffRights(db.query, crewD.id),
      { name: "x.jobs.myJob" } as never,
      crewD.id,
    );
    expect(limit).not.toBeNull();
    const visit = await newVisit(reached, 2, 18, [crewD]);
    const refused = await refusal(
      run(
        "record.update",
        { object: VISIT, id: visit.visitId, values: { starts: at(2, 17), ends: at(2, 19) } },
        staff(member, { roleMine: limit ?? undefined }),
      ),
    );
    expect(refused.code).toBe("forbidden");
    expect(JSON.stringify(refused.details)).toContain("role_mine");
  });
});

describe("lines and what is unbilled (AC 11)", () => {
  it("a fixed-price job owes its accepted estimate and approved variations; materials are cost only", async () => {
    const job = await newJob("Fixed price bathroom");
    const est = await run<{ lineId: string }>(
      "x.jobs.addLine",
      {
        jobId: job.jobId,
        kind: "estimate",
        description: "Tiling",
        quantity: 1.5,
        unitPrice: 33.33,
      },
      staff(pricer),
    );
    await run(
      "x.jobs.recordAcceptance",
      { jobId: job.jobId, how: "Email", estimateLines: [est.lineId] },
      staff(member),
    );
    const variation = await run<{ variationId: string; lineIds: string[] }>(
      "x.jobs.proposeVariation",
      {
        jobId: job.jobId,
        title: "Extra niche",
        why: "Asked",
        lines: [{ description: "Niche", quantity: 1 }],
      },
      staff(member),
    );
    // The office prices the variation's line: a corrected draft replaces it.
    const priced = await run<{ id: string; unitPrice: number; state: string }>(
      "x.jobs.editLine",
      { lineId: variation.lineIds[0], unitPrice: 250 },
      staff(pricer),
    );
    expect(priced).toMatchObject({ unitPrice: 250, state: "draft" });
    expect((await get(LINE, String(variation.lineIds[0]))).values).toMatchObject({
      state: "void",
      voidReason: "replaced",
    });
    // Sent again: the same copy.
    const again = await run<{ id: string }>(
      "x.jobs.editLine",
      { lineId: variation.lineIds[0], unitPrice: 250 },
      staff(pricer),
    );
    expect(again.id).toBe(priced.id);
    // The assistant cannot approve it for the office.
    expect(
      (
        await refusal(
          run(
            "x.jobs.approveVariation",
            { variationId: variation.variationId, note: "Customer said yes" },
            assistant(admin),
          ),
        )
      ).code,
    ).toBe("forbidden");
    await run(
      "x.jobs.approveVariation",
      { variationId: variation.variationId, note: "Customer said yes on the phone" },
      staff(member),
    );
    expect((await get(VARIATION, variation.variationId)).values).toMatchObject({
      state: "approved",
      decidedBy: "office",
      decidedByName: member.name,
    });
    expect((await get(LINE, priced.id)).values.state).toBe("approved");
    const material = await run<{ lineId: string }>(
      "x.jobs.addLine",
      { jobId: job.jobId, kind: "material", description: "Grout", quantity: 2, unitPrice: 10 },
      staff(pricer),
    );
    await run("x.jobs.approveLine", { lineId: material.lineId }, staff(pricer));
    const owed = await run<{
      jobs: { jobId: string; total: number; lines: { amount: number }[] }[];
    }>("x.jobs.unbilled", { jobId: job.jobId }, staff(pricer));
    // 1.5 x 33.33 = 49.995, rounded once to 5000 cents; plus 250.00.
    expect(owed.jobs).toHaveLength(1);
    expect(owed.jobs[0]?.lines.map((l) => l.amount)).toEqual([5000, 25000]);
    expect(owed.jobs[0]?.total).toBe(30000);
    expect(Number.isInteger(owed.jobs[0]?.total)).toBe(true);
  });

  it("a time and materials job owes its approved materials (and labour), never a draft or an estimate", async () => {
    const job = await newJob("Hourly repairs", { billing: "time_and_materials" });
    await run(
      "x.jobs.addLine",
      { jobId: job.jobId, kind: "estimate", description: "Guess", quantity: 1, unitPrice: 500 },
      staff(pricer),
    );
    const used = await run<{ lineId: string }>(
      "x.jobs.addLine",
      { jobId: job.jobId, kind: "material", description: "Tap", quantity: 1, unitPrice: 89.99 },
      staff(pricer),
    );
    await run(
      "x.jobs.addLine",
      { jobId: job.jobId, kind: "material", description: "Draft", quantity: 3, unitPrice: 1 },
      staff(pricer),
    );
    await run("x.jobs.approveLine", { lineId: used.lineId }, staff(pricer));
    const owed = await run<{ jobs: { total: number }[]; total: number }>(
      "x.jobs.unbilled",
      { jobId: job.jobId },
      staff(pricer),
    );
    expect(owed.jobs[0]?.total).toBe(8999);
    // An estimate line is approved by an acceptance, not approveLine.
    const estimate = await run<{ lineId: string }>(
      "x.jobs.addLine",
      { jobId: job.jobId, kind: "estimate", description: "Est", quantity: 1, unitPrice: 1 },
      staff(pricer),
    );
    expect(
      (await refusal(run("x.jobs.approveLine", { lineId: estimate.lineId }, staff(pricer)))).inner,
    ).toBe("invalid_input");
  });

  it("an approved line is never changed: not edited, re-pointed, or put in the Trash by a record write", async () => {
    const job = await newJob("Locked line", { billing: "time_and_materials" });
    const otherJob = await newJob("Other job");
    const line = await run<{ lineId: string }>(
      "x.jobs.addLine",
      { jobId: job.jobId, kind: "material", description: "Pipe", quantity: 4, unitPrice: 12 },
      staff(pricer),
    );
    await run("x.jobs.approveLine", { lineId: line.lineId }, staff(pricer));
    for (const values of [{ unitPrice: 1 }, { quantity: 400 }, { job: otherJob.jobId }]) {
      expect(
        (
          await refusal(
            run("record.update", { object: LINE, id: line.lineId, values }, staff(admin)),
          )
        ).code,
      ).toBe("invalid_input");
    }
    expect(
      (await refusal(run("x.jobs.editLine", { lineId: line.lineId, unitPrice: 1 }, staff(pricer))))
        .code,
    ).toBe("conflict");
    for (const ctx of [staff(member), assistant(admin), mcp(admin)]) {
      const refused = await refusal(run("record.delete", { object: LINE, id: line.lineId }, ctx));
      expect(["forbidden", "pending_approval"]).toContain(refused.code);
      if (refused.code === "pending_approval") {
        const decided = await approveQueued(refused.details, admin);
        expect(decided.results.map((r) => r.status)).not.toEqual(["applied"]);
      }
    }
    // Billed is the host's (an invoice, step 8).
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: LINE, id: line.lineId, values: { state: "billed" } },
            staff(admin),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    expect((await get(LINE, line.lineId)).values).toMatchObject({
      state: "approved",
      unitPrice: 12,
      quantity: 4,
      job: job.jobId,
    });
    await run("x.jobs.voidLine", { lineId: line.lineId }, staff(pricer));
    expect((await get(LINE, line.lineId)).values.state).toBe("void");
  });

  it("a variation withdrawn or declined voids its lines", async () => {
    const job = await newJob("Variations");
    for (const tool of ["x.jobs.withdrawVariation", "x.jobs.declineVariation"]) {
      const v = await run<{ variationId: string; lineIds: string[] }>(
        "x.jobs.proposeVariation",
        { jobId: job.jobId, title: tool, why: "Maybe", lines: [{ description: "x", quantity: 1 }] },
        staff(member),
      );
      await run(
        tool,
        tool === "x.jobs.declineVariation"
          ? { variationId: v.variationId, note: "No thanks" }
          : { variationId: v.variationId },
        staff(member),
      );
      expect((await get(LINE, String(v.lineIds[0]))).values.state, tool).toBe("void");
    }
  });
});

describe("the CSV of what is unbilled (AC 16)", () => {
  it("downloads for jobs:prices, a person only, and every download is audited", async () => {
    const out = await run<{ csv: string; contentType: string; lines: number }>(
      "x.jobs.exportUnbilled",
      {},
      staff(pricer),
    );
    expect(out.contentType).toBe("text/csv");
    expect(out.csv.split("\r\n")[0]).toBe(
      "job_id,job,billing,line_id,kind,description,quantity,unit,unit_price,amount_minor,tax_code,item_code",
    );
    expect(out.lines).toBeGreaterThan(0);
    const rows = await env.DB.prepare(
      "SELECT outcome, result FROM core_audit WHERE operation = 'x.jobs.exportUnbilled' AND user_id = ?",
    )
      .bind(pricer.id)
      .all<{ outcome: string; result: string | null }>();
    expect(rows.results.map((r) => r.outcome)).toEqual(["ok"]);
    expect(String(rows.results[0]?.result)).not.toContain("Tiling");
    for (const ctx of [staff(member), staff(crewA), assistant(admin), mcp(admin)]) {
      expect((await refusal(run("x.jobs.exportUnbilled", {}, ctx))).code).toBe("forbidden");
    }
    expect((await refusal(run("x.jobs.unbilled", {}, staff(member)))).code).toBe("forbidden");
  });
});

describe("what an AI may do (AC 15)", () => {
  it("its bookings, moves, cancels and assignments wait for a person under balanced and autonomous", async () => {
    const job = await newJob("AI scheduling");
    const visit = await newVisit(job.jobId, 9, 1);
    try {
      for (const preset of ["balanced", "autonomous"] as const) {
        await setPreset(preset);
        for (const ctx of [assistant(admin), mcp(admin)]) {
          for (const [name, input] of [
            ["x.jobs.assignCrew", { visitId: visit.visitId, staffId: crewA.id }],
            ["x.jobs.moveVisit", { visitId: visit.visitId, starts: at(9, 3) }],
            ["x.jobs.cancelVisit", { visitId: visit.visitId }],
            ["x.jobs.bookVisit", { jobId: job.jobId, visitTypeId: visitType, starts: at(9, 6) }],
          ] as const) {
            expect((await refusal(run(name, input, ctx))).code, `${preset} ${name}`).toBe(
              "pending_approval",
            );
          }
        }
      }
    } finally {
      await setPreset("balanced");
    }
    expect((await get(VISIT, visit.visitId)).values).toMatchObject({
      state: "booked",
      starts: at(9, 1),
    });
  });

  it("a person approving its assignment applies exactly that assignment", async () => {
    const visit = await newVisit((await newJob("AI assign")).jobId, 10, 1);
    const asked = await refusal(
      run("x.jobs.assignCrew", { visitId: visit.visitId, staffId: crewC.id }, assistant(admin)),
    );
    expect(asked.code).toBe("pending_approval");
    const decided = await approveQueued(asked.details, admin);
    expect(decided.results.map((r) => r.status)).toEqual(["applied"]);
    const { results } = await env.DB.prepare(
      "SELECT staff FROM rec_x_jobs_assignment WHERE visit = ? AND state = 'booked'",
    )
      .bind(visit.visitId)
      .all<{ staff: string }>();
    expect(results.map((r) => r.staff)).toEqual([crewC.id]);
  });

  it("takes an enquiry and records a material as ordinary writes; never marks a visit or decides a variation", async () => {
    const job = await run<{ jobId: string }>(
      "x.jobs.enquire",
      { title: "From a phone call", customerId: customer },
      assistant(admin),
    );
    await run(
      "x.jobs.addMaterial",
      { jobId: job.jobId, description: "Fuse", quantity: 1 },
      assistant(admin),
    );
    const v = await run<{ variationId: string }>(
      "x.jobs.proposeVariation",
      {
        jobId: job.jobId,
        title: "AI drafted",
        why: "Notes",
        lines: [{ description: "x", quantity: 1 }],
      },
      assistant(admin),
    );
    for (const [name, input] of [
      ["x.jobs.approveVariation", { variationId: v.variationId, note: "yes" }],
      ["x.jobs.declineVariation", { variationId: v.variationId, note: "no" }],
      ["x.jobs.recordAcceptance", { jobId: job.jobId, how: "yes", estimateLines: [] }],
    ] as const) {
      for (const ctx of [assistant(admin), mcp(admin)]) {
        expect((await refusal(run(name, input, ctx))).code, name).toBe("forbidden");
      }
    }
    expect((await get(VARIATION, v.variationId)).values.state).toBe("proposed");
  });
});

// A person's own call of a humanOnly or personApproves tool is never held up by the approval
// policy, so every person's tool of the pack runs at once under every preset, cautious included,
// and leaves nothing waiting.
describe("a person's tools under every approval policy", () => {
  for (const preset of ["cautious", "balanced", "autonomous"] as const) {
    it(`the office and the pricer use each of their tools at once (${preset})`, async () => {
      const pending = async () =>
        (
          await env.DB.prepare(
            "SELECT count(*) AS n FROM core_pending_action WHERE status = 'pending'",
          ).first<{ n: number }>()
        )?.n;
      await setPreset(preset);
      try {
        const before = await pending();
        const job = await newJob(`Every tool ${preset}`);
        const visit = await newVisit(job.jobId, 11 + ["cautious", "balanced"].indexOf(preset), 1, [
          crewA,
        ]);
        const extra = await run<{ id: string }>(
          "x.jobs.assignCrew",
          { visitId: visit.visitId, staffId: crewB.id },
          staff(member),
        );
        await run("x.jobs.removeCrew", { placeId: extra.id }, staff(member));
        await run(
          "x.jobs.moveVisit",
          { visitId: visit.visitId, starts: at(11 + ["cautious", "balanced"].indexOf(preset), 3) },
          staff(member),
        );
        const line = await run<{ lineId: string }>(
          "x.jobs.addLine",
          { jobId: job.jobId, kind: "estimate", description: "Work", quantity: 1, unitPrice: 100 },
          staff(pricer),
        );
        const edited = await run<{ id: string }>(
          "x.jobs.editLine",
          { lineId: line.lineId, unitPrice: 110 },
          staff(pricer),
        );
        await run(
          "x.jobs.recordAcceptance",
          { jobId: job.jobId, how: "Paper", estimateLines: [edited.id] },
          staff(member),
        );
        const v = await run<{ variationId: string }>(
          "x.jobs.proposeVariation",
          { jobId: job.jobId, title: "V", why: "W", lines: [{ description: "x", quantity: 1 }] },
          staff(member),
        );
        await run("x.jobs.withdrawVariation", { variationId: v.variationId }, staff(member));
        const m = await run<{ lineId: string }>(
          "x.jobs.addMaterial",
          { jobId: job.jobId, description: "Cable", quantity: 1 },
          staff(member),
        );
        await run("x.jobs.voidLine", { lineId: m.lineId }, staff(pricer));
        await run("x.jobs.markOnTheWay", { visitId: visit.visitId }, staff(member));
        await run("x.jobs.cancelVisit", { visitId: visit.visitId }, staff(member));
        await run("x.jobs.jobSummary", { jobId: job.jobId }, staff(member));
        expect(await pending()).toBe(before);
      } finally {
        await setPreset("balanced");
      }
    });
  }
});
