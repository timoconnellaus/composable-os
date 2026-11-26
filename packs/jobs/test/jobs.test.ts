// Stage 39 step 5: the Jobs pack against @composable-os/sdk/testing's in-memory host. Its manifest
// passes the contract checks with the stages, states, staffed shift, crew reach and permissions
// the host enforces; nothing is opened to customers or the public; every tool composes the host's
// record operations and moves a record only from a current read. apps/runner/test/jobs.test.ts
// and jobs-rostering.test.ts run the same pack in the real host: the facts, the crew moving with
// its visit, the clash, the crew's reach, what is unbilled, the CSV, and what an AI may do.
import { type ExtensionManifest, toManifest, validateManifest } from "@composable-os/sdk";
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import extension from "../index.ts";

const JOB = "jobs.job";
const SITE = "jobs.site";
const VISIT = "jobs.visit";
const PLACE = "jobs.assignment";
const LINE = "jobs.line";
const VARIATION = "jobs.variation";
const VISIT_TYPE = "jobs.visittype";
const CREW = { kind: "staff" as const, userId: "usr_crew", name: "Ari Crew" };

type Rows = Record<string, ({ id: string } & Record<string, unknown>)[]>;

function hostWith(
  records: Rows = {},
  sql: (input: Record<string, unknown>) => unknown = () => ({ rows: [] }),
) {
  const calls: Record<string, unknown>[] = [];
  const host = createTestHost(extension, {
    records,
    operations: {
      "query.sql": (input) => {
        calls.push(input);
        return sql(input);
      },
    },
  });
  return { host, calls };
}

const rowOf = (host: ReturnType<typeof hostWith>["host"], object: string, id: string) =>
  host.records.get(object)?.get(id) ?? {};
const rowsOf = (host: ReturnType<typeof hostWith>["host"], object: string) => [
  ...(host.records.get(object)?.values() ?? []),
];

const base = (): Rows => ({
  [JOB]: [{ id: "job_1", title: "Rewire", site: "site_1", billing: "fixed", stage: "stg_1" }],
  [SITE]: [{ id: "site_1", name: "1 Example St", line1: "1 Example St", suburb: "Newtown" }],
  [VISIT_TYPE]: [{ id: "vt_1", name: "Electrical", defaultMinutes: 90 }],
});

describe("the Jobs pack (test host)", () => {
  it("passes the contract checks, with the job on stages and the host's facts read-only", () => {
    const { host } = hostWith();
    expect(host.issues).toEqual([]);
    const { job, stage, visit, assignment, line, variation } = host.manifest.objects;
    expect(job?.stages?.field).toBe("stage");
    for (const fact of ["acceptedAt", "acceptedBy", "signedOffAt", "invoicedAt"]) {
      expect(job?.fields[fact]?.readOnly, fact).toBe(true);
    }
    const seeded = Object.values(stage?.seed ?? {}) as { name: string; requiredFields: string[] }[];
    const needs = Object.fromEntries(seeded.map((s) => [s.name, s.requiredFields]));
    expect(needs.Accepted).toEqual(["acceptedAt"]);
    expect(needs["Signed off"]).toEqual(["signedOffAt"]);
    expect(needs.Invoiced).toEqual(["invoicedAt"]);
    expect(seeded).toHaveLength(18);
    // A crew place is a shift whose times are its visit's, cancelled with it.
    expect(assignment?.staffed).toMatchObject({
      who: { field: "staff" },
      timesFrom: "visit",
      live: ["booked"],
      private: true,
    });
    expect(assignment?.states?.follows).toEqual({
      relation: "visit",
      when: { cancelled: "cancelled" },
      from: ["booked"],
    });
    // Every move of a visit, a crew place, a line and a variation is a tool's or the host's.
    for (const object of [visit, assignment, line, variation]) {
      for (const move of object?.states?.moves ?? []) expect(move.by).toEqual(["host"]);
    }
    // A line's words, numbers and what it belongs to are the pack's tools' only.
    for (const field of ["description", "job", "kind", "variation", "quantity", "unitPrice"]) {
      expect(line?.fields[field]?.readOnly, field).toBe(true);
    }
    expect(line?.states?.follows).toEqual({
      relation: "variation",
      when: { approved: "approved", declined: "void", withdrawn: "void" },
      from: ["draft"],
    });
    // What decides the crew's reach is a person's to change (ADR 0755).
    for (const [object, field] of [
      [assignment, "staff"],
      [assignment, "visit"],
      [assignment, "state"],
      [assignment, "starts"],
      [assignment, "ends"],
      [visit, "job"],
      [visit, "starts"],
      [visit, "ends"],
    ] as const) {
      expect(object?.fields[field]?.personApproves, field).toBe(true);
    }
  });

  it("holds prices to a restricted grant, gives the crew its reach, and opens nothing outside", () => {
    const { host } = hostWith();
    const m = host.manifest;
    expect(m.restricted).toEqual(["jobs:prices"]);
    expect(m.grantable).toEqual(["jobs:prices"]);
    const crew = m.roles?.crew;
    expect(crew?.permissions).toEqual(["jobs:crew"]);
    expect(crew?.read).toEqual([JOB, VISIT, PLACE, VISIT_TYPE]);
    expect(Object.keys(crew?.mine ?? {}).sort()).toEqual([PLACE, JOB, VISIT].sort());
    expect(crew?.mine?.[JOB]).toMatchObject({
      through: PLACE,
      who: "staff",
      path: "visit.job",
      live: ["booked"],
      within: { from: "starts", to: "ends", days: 7 },
    });
    const tools = m.tools;
    for (const name of [
      "addLine",
      "editLine",
      "approveLine",
      "voidLine",
      "unbilled",
      "exportUnbilled",
    ]) {
      expect(tools[name]?.permission, name).toBe("jobs:prices");
    }
    // An AI asks and a person decides.
    for (const name of [
      "bookVisit",
      "moveVisit",
      "cancelVisit",
      "assignCrew",
      "removeCrew",
      "editLine",
      "approveLine",
      "voidLine",
      "withdrawVariation",
    ]) {
      expect(tools[name]?.personApproves, name).toBe(true);
    }
    // A person's own act only.
    for (const name of [
      "recordAcceptance",
      "approveVariation",
      "declineVariation",
      "markOnTheWay",
      "markOnSite",
      "markDone",
      "markMissed",
      "exportUnbilled",
    ]) {
      expect(tools[name]?.humanOnly, name).toBe(true);
    }
    expect(tools.exportUnbilled?.auditReads).toBe(true);
    expect(tools.exportUnbilled?.redactResult).toEqual(["csv"]);
    // Ordinary writes the assistant may make.
    for (const name of ["enquire", "addMaterial", "addLine", "proposeVariation"]) {
      expect(tools[name]?.humanOnly, name).toBeFalsy();
      expect(tools[name]?.personApproves, name).toBeFalsy();
    }
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.audiences ?? ["staff"], name).toEqual(["staff"]);
    }
    for (const object of Object.values(m.objects)) {
      expect(object.customer).toBeUndefined();
      expect(object.public).toBeUndefined();
      expect(object.signedIn).toBeUndefined();
    }
  });
});

// What the contract refuses of the crew's reach (ADR 0756, beside ADR 0755's checks): the visit's
// times the host copies onto a crew place move the window, so they are a person's to change; and a
// cascade may take a crew place out of its live states, never into them.
describe("the crew's reach, as the contract holds it", () => {
  const issuesWith = (change: (m: ExtensionManifest) => void) => {
    const copy = structuredClone(toManifest(extension));
    change(copy);
    return validateManifest(copy).issues.map((i) => `${i.path}: ${i.message}`);
  };

  it("passes as declared", () => {
    expect(issuesWith(() => {})).toEqual([]);
  });

  for (const field of ["starts", "ends"]) {
    it(`refuses a visit's ${field} a person does not approve: it is copied onto the window`, () => {
      const found = issuesWith((m) => {
        const visit = m.objects.visit as { fields: Record<string, { personApproves?: boolean }> };
        delete visit.fields[field]?.personApproves;
      });
      expect(found.join("\n")).toMatch(
        new RegExp(`roles\\.crew\\.mine\\..*within.*"${field}" of jobs\\.visit, copied`),
      );
    });
  }

  it("refuses a cascade that would bring a crew place back into a live state", () => {
    const found = issuesWith((m) => {
      const states = m.objects.assignment?.states as { follows: { from: string[] } } & {
        moves: { from: string | string[]; to: string; by: string[] }[];
      };
      states.follows.from = ["booked", "cancelled"];
      states.moves.push({ from: "cancelled", to: "booked", by: ["host"] });
      (states.follows as unknown as { when: Record<string, string> }).when = {
        cancelled: "cancelled",
        booked: "booked",
      };
    });
    expect(found.join("\n")).toMatch(/states\.follows moves a record from a state outside live/);
  });

  it("refuses auditReads on a tool that writes (every write is audited already)", () => {
    const found = issuesWith((m) => {
      (m.tools.addLine as { auditReads?: true }).auditReads = true;
    });
    expect(found.join("\n")).toMatch(/tools\.addLine\.auditReads: auditReads is for a read tool/);
  });
});

describe("enquire", () => {
  it("makes a site for the customer and a job there; the same request finds it again", async () => {
    const { host } = hostWith();
    const input = {
      title: "Rewire the kitchen",
      customerId: "per_1",
      site: { line1: "2 Example St", suburb: "Newtown" },
      requestId: "req-00000001",
    };
    const out = await host.runTool<{ jobId: string; siteId: string; existing: boolean }>(
      "enquire",
      input,
    );
    expect(rowOf(host, SITE, out.siteId)).toMatchObject({
      name: "2 Example St",
      customer: "per_1",
    });
    expect(rowOf(host, JOB, out.jobId)).toMatchObject({
      title: "Rewire the kitchen",
      site: out.siteId,
      customer: "per_1",
      requestKey: "enquire:usr_admin:req-00000001",
    });
    const again = await host.runTool<{ jobId: string; existing: boolean }>("enquire", input);
    expect(again).toMatchObject({ jobId: out.jobId, existing: true });
    expect(rowsOf(host, SITE)).toHaveLength(1);
  });

  it("refuses a site id and a new site together", async () => {
    const { host } = hostWith();
    await expect(
      host.runTool("enquire", { title: "x", siteId: "site_1", site: { line1: "y" } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("jobSummary", () => {
  it("answers the job, its site, visits with crew, variations and line counts, and no price", async () => {
    const { host } = hostWith({
      ...base(),
      [VISIT]: [{ id: "vis_1", job: "job_1", visitType: "vt_1", state: "booked" }],
      [PLACE]: [{ id: "pl_1", visit: "vis_1", staff: "usr_crew", state: "booked" }],
      [VARIATION]: [{ id: "var_1", job: "job_1", title: "Extra", state: "proposed" }],
      [LINE]: [
        { id: "ln_1", job: "job_1", kind: "estimate", state: "draft", unitPrice: 100 },
        { id: "ln_2", job: "job_1", kind: "estimate", state: "draft", unitPrice: 100 },
      ],
    });
    const out = await host.runTool<Record<string, unknown>>("jobSummary", { jobId: "job_1" });
    expect(out).toMatchObject({
      id: "job_1",
      site: { id: "site_1", address: "1 Example St, Newtown" },
      visits: [{ id: "vis_1", crew: [{ id: "pl_1", staff: "usr_crew" }] }],
      variations: [{ id: "var_1", state: "proposed" }],
      lines: [{ kind: "estimate", state: "draft", count: 2 }],
    });
    expect(JSON.stringify(out)).not.toContain("unitPrice");
  });
});

describe("recordAcceptance", () => {
  it("sets the fact as the office's, approves the lines named, and moves the stage in one write", async () => {
    const { host } = hostWith({
      ...base(),
      [LINE]: [
        { id: "ln_1", job: "job_1", kind: "estimate", state: "draft" },
        { id: "ln_2", job: "job_1", kind: "estimate", state: "draft" },
      ],
    });
    const out = await host.runTool<{ approvedLines: string[]; stage: string }>("recordAcceptance", {
      jobId: "job_1",
      how: "Signed paper",
      estimateLines: ["ln_1"],
      stageId: "stg_acc",
    });
    expect(out.approvedLines).toEqual(["ln_1"]);
    expect(rowOf(host, LINE, "ln_1").state).toBe("approved");
    expect(rowOf(host, LINE, "ln_2").state).toBe("draft");
    expect(rowOf(host, JOB, "job_1")).toMatchObject({
      acceptedBy: "office",
      acceptedHow: "Signed paper",
      acceptedByName: "Admin",
      stage: "stg_acc",
    });
  });

  it("refuses a line that is not an estimate line of this job", async () => {
    const { host } = hostWith({
      ...base(),
      [LINE]: [{ id: "ln_9", job: "job_2", kind: "estimate", state: "draft" }],
    });
    await expect(
      host.runTool("recordAcceptance", { jobId: "job_1", how: "x", estimateLines: ["ln_9"] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("visits and crew", () => {
  it("bookVisit takes the visit type's length and puts each crew member on it", async () => {
    const { host } = hostWith(base());
    const out = await host.runTool<{ visitId: string; crew: { id: string }[] }>("bookVisit", {
      jobId: "job_1",
      visitTypeId: "vt_1",
      starts: "2031-06-02T00:00:00.000Z",
      crew: [{ staffId: "usr_a", lead: true }, { staffId: "usr_b" }],
      requestId: "req-visit-01",
    });
    expect(rowOf(host, VISIT, out.visitId)).toMatchObject({
      job: "job_1",
      ends: "2031-06-02T01:30:00.000Z",
      requestKey: "visit:job_1:req-visit-01",
    });
    expect(out.crew).toHaveLength(2);
    expect(rowOf(host, PLACE, out.crew[0]?.id as string)).toMatchObject({
      visit: out.visitId,
      staff: "usr_a",
      lead: true,
    });
  });

  it("moveVisit keeps the length; assignCrew and removeCrew write the crew place", async () => {
    const { host } = hostWith({
      ...base(),
      [VISIT]: [
        {
          id: "vis_1",
          job: "job_1",
          starts: "2031-06-02T00:00:00.000Z",
          ends: "2031-06-02T02:00:00.000Z",
          state: "booked",
        },
      ],
    });
    const moved = await host.runTool<{ ends: string }>("moveVisit", {
      visitId: "vis_1",
      starts: "2031-06-03T00:00:00.000Z",
    });
    expect(moved.ends).toBe("2031-06-03T02:00:00.000Z");
    const placed = await host.runTool<{ id: string }>("assignCrew", {
      visitId: "vis_1",
      staffId: "usr_a",
    });
    await host.runTool("removeCrew", { placeId: placed.id });
    expect(rowOf(host, PLACE, placed.id).state).toBe("cancelled");
  });

  it("cancelVisit and the marks move a visit from where it is", async () => {
    for (const [tool, from, to] of [
      ["cancelVisit", "booked", "cancelled"],
      ["markOnTheWay", "booked", "on_the_way"],
      ["markOnSite", "on_the_way", "on_site"],
      ["markDone", "on_site", "done"],
      ["markMissed", "booked", "missed"],
    ] as const) {
      const { host } = hostWith({ [VISIT]: [{ id: "vis_1", job: "job_1", state: from }] });
      const out = await host.runTool<{ state: string; changed: boolean }>(
        tool,
        { visitId: "vis_1" },
        { caller: CREW },
      );
      expect(out, tool).toMatchObject({ state: to, changed: true });
    }
  });
});

describe("the crew's day", () => {
  it("myVisits lists the caller's booked places with the visit, the job and its site", async () => {
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const end = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const { host } = hostWith({
      ...base(),
      [VISIT]: [
        { id: "vis_1", job: "job_1", starts: soon, ends: end, state: "booked", crewNotes: "Dog" },
      ],
      [PLACE]: [
        { id: "pl_1", visit: "vis_1", staff: "usr_crew", starts: soon, ends: end, state: "booked" },
        {
          id: "pl_2",
          visit: "vis_1",
          staff: "usr_other",
          starts: soon,
          ends: end,
          state: "booked",
        },
      ],
    });
    const out = await host.runTool<{ visits: Record<string, unknown>[] }>(
      "myVisits",
      {},
      { caller: CREW },
    );
    expect(out.visits).toHaveLength(1);
    expect(out.visits[0]).toMatchObject({
      id: "vis_1",
      placeId: "pl_1",
      crewNotes: "Dog",
      job: { id: "job_1", title: "Rewire" },
      site: { address: "1 Example St, Newtown" },
    });
  });

  it("myJob shows materials by quantity, never a price", async () => {
    const { host } = hostWith({
      ...base(),
      [LINE]: [
        {
          id: "ln_1",
          job: "job_1",
          kind: "material",
          quantity: 3,
          unit: "m",
          unitPrice: 9,
          state: "draft",
        },
        {
          id: "ln_2",
          job: "job_1",
          kind: "estimate",
          quantity: 1,
          unitPrice: 500,
          state: "approved",
        },
      ],
    });
    const out = await host.runTool<{ materials: unknown[] }>(
      "myJob",
      { jobId: "job_1" },
      { caller: CREW },
    );
    expect(out.materials).toEqual([
      expect.objectContaining({ id: "ln_1", quantity: 3, unit: "m" }),
    ]);
    expect(JSON.stringify(out)).not.toMatch(/unitPrice|500/);
  });
});

describe("lines", () => {
  it("addMaterial records what and how many, recorded by the caller; the same request once", async () => {
    const { host } = hostWith(base());
    const input = {
      jobId: "job_1",
      description: "Cable",
      quantity: 30,
      unit: "m",
      requestId: "req-mat-0001",
    };
    const out = await host.runTool<{ lineId: string }>("addMaterial", input, { caller: CREW });
    expect(rowOf(host, LINE, out.lineId)).toMatchObject({
      kind: "material",
      quantity: 30,
      recordedBy: "usr_crew",
      requestKey: "material:job_1:req-mat-0001",
    });
    expect(rowOf(host, LINE, out.lineId).unitPrice).toBeUndefined();
    const again = await host.runTool<{ lineId: string; existing: boolean }>("addMaterial", input, {
      caller: CREW,
    });
    expect(again).toEqual({ lineId: out.lineId, existing: true });
  });

  it("addLine adds a priced draft; editLine replaces a draft by a corrected copy, once", async () => {
    const { host } = hostWith(base());
    const made = await host.runTool<{ lineId: string }>("addLine", {
      jobId: "job_1",
      kind: "estimate",
      description: "Downlights",
      quantity: 6,
      unitPrice: 45,
    });
    const edited = await host.runTool<{ id: string; unitPrice: number; quantity: number }>(
      "editLine",
      { lineId: made.lineId, unitPrice: 40 },
    );
    expect(edited).toMatchObject({ unitPrice: 40, quantity: 6, state: "draft" });
    expect(rowOf(host, LINE, made.lineId)).toMatchObject({ state: "void", voidReason: "replaced" });
    expect(rowOf(host, LINE, edited.id)).toMatchObject({
      replaces: made.lineId,
      requestKey: `replace:${made.lineId}`,
    });
    const again = await host.runTool<{ id: string }>("editLine", {
      lineId: made.lineId,
      unitPrice: 40,
    });
    expect(again.id).toBe(edited.id);
  });

  it("approveLine approves a material line and refuses an estimate or variation line", async () => {
    const { host } = hostWith({
      [LINE]: [
        { id: "ln_m", job: "job_1", kind: "material", state: "draft" },
        { id: "ln_e", job: "job_1", kind: "estimate", state: "draft" },
        { id: "ln_v", job: "job_1", kind: "variation", state: "draft" },
      ],
    });
    await host.runTool("approveLine", { lineId: "ln_m" });
    expect(rowOf(host, LINE, "ln_m").state).toBe("approved");
    for (const lineId of ["ln_e", "ln_v"]) {
      await expect(host.runTool("approveLine", { lineId })).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
  });

  it("voidLine voids from where it is, saying why", async () => {
    const { host } = hostWith({
      [LINE]: [{ id: "ln_1", job: "job_1", kind: "material", state: "approved" }],
    });
    await host.runTool("voidLine", { lineId: "ln_1" });
    expect(rowOf(host, LINE, "ln_1")).toMatchObject({ state: "void", voidReason: "voided" });
  });
});

describe("variations", () => {
  it("proposeVariation makes the variation and its lines once per request", async () => {
    const { host } = hostWith(base());
    const input = {
      jobId: "job_1",
      title: "Extra point",
      why: "Asked on site",
      askedBy: "customer",
      lines: [
        { description: "Power point", quantity: 1 },
        { description: "Cable", quantity: 5 },
      ],
      requestId: "req-var-0001",
    };
    const out = await host.runTool<{ variationId: string; lineIds: string[] }>(
      "proposeVariation",
      input,
      { caller: CREW },
    );
    expect(rowOf(host, VARIATION, out.variationId)).toMatchObject({
      job: "job_1",
      proposedBy: "usr_crew",
      requestKey: "variation:job_1:req-var-0001",
    });
    expect(out.lineIds).toHaveLength(2);
    expect(rowOf(host, LINE, out.lineIds[0] as string)).toMatchObject({
      kind: "variation",
      variation: out.variationId,
    });
    const again = await host.runTool<{ variationId: string; lineIds: string[]; existing: boolean }>(
      "proposeVariation",
      input,
      { caller: CREW },
    );
    expect(again).toEqual({ ...out, existing: true });
  });

  it("approveVariation and declineVariation record the office's decision; withdrawVariation withdraws", async () => {
    for (const [tool, to] of [
      ["approveVariation", "approved"],
      ["declineVariation", "declined"],
      ["withdrawVariation", "withdrawn"],
    ] as const) {
      const { host } = hostWith({
        [VARIATION]: [{ id: "var_1", job: "job_1", state: "proposed" }],
      });
      await host.runTool(
        tool,
        tool === "withdrawVariation"
          ? { variationId: "var_1" }
          : { variationId: "var_1", note: "On the phone" },
      );
      const row = rowOf(host, VARIATION, "var_1");
      expect(row.state, tool).toBe(to);
      if (tool !== "withdrawVariation") {
        expect(row).toMatchObject({ decidedBy: "office", decidedByName: "Admin" });
      }
    }
  });
});

describe("what is unbilled", () => {
  const rows = [
    {
      job_id: "job_1",
      job_title: "Bathroom",
      billing: "fixed",
      line_id: "ln_1",
      kind: "estimate",
      description: "=Tiling, grout",
      quantity: 1.5,
      unit: "m2",
      unit_price: 33.33,
      amount: 5000,
    },
    {
      job_id: "job_1",
      job_title: "Bathroom",
      billing: "fixed",
      line_id: "ln_2",
      kind: "variation",
      description: "Niche",
      quantity: 1,
      unit_price: 250,
      amount: 25000,
    },
  ];

  it("unbilled is one statement, each job's total in integer minor units, truncation said", async () => {
    const { host, calls } = hostWith({}, () => ({ rows, truncated: true }));
    const out = await host.runTool<{
      jobs: { jobId: string; total: number }[];
      total: number;
      truncated: boolean;
    }>("unbilled", { jobId: "job_1" });
    expect(out.jobs).toEqual([expect.objectContaining({ jobId: "job_1", total: 30000 })]);
    expect(out.total).toBe(30000);
    expect(out.truncated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual(["job_1"]);
    expect(calls[0]?.maxRows).toBe(500);
    const sql = String(calls[0]?.sql);
    expect(sql).toContain("l.state = 'approved'");
    expect(sql).toContain("l.kind IN ('estimate', 'variation')");
    expect(sql).toContain("l.kind IN ('labour', 'material')");
  });

  it("exportUnbilled writes a CSV whose cells are quoted and never formulas", async () => {
    const { host } = hostWith({}, () => ({ rows, truncated: false }));
    const out = await host.runTool<{ csv: string; lines: number; filename: string }>(
      "exportUnbilled",
      {},
    );
    expect(out.lines).toBe(2);
    expect(out.filename).toMatch(/^unbilled-all-\d{4}-\d{2}-\d{2}\.csv$/);
    const [header, first] = out.csv.split("\r\n");
    expect(header).toBe(
      "job_id,job,billing,line_id,kind,description,quantity,unit,unit_price,amount_minor,tax_code,item_code",
    );
    expect(first).toBe(`job_1,Bathroom,fixed,ln_1,estimate,"'=Tiling, grout",1.5,m2,33.33,5000,,`);
  });
});
