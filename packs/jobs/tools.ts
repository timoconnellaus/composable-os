// Jobs' staff tools (stage 39, step 5; ADR 0756). They become operations x.jobs.<tool>, run in the
// sandbox, and reach the host only through ctx.ops. None of them holds a rule: which stage needs
// which fact, who may be on a visit and when, a clash, the crew's reach, which moves a visit, a
// crew place, a line and a variation may make and who may make them are the host's (index.ts). A
// tool asks, and reports what the host answered.
//
// Who may call which:
//   - jobs:manage (every admin and member): enquiries, a job's summary, the office's record of an
//     acceptance and of a variation's decision (a person's own act), marking visits;
//   - jobs:schedule (every admin and member; with Rostering installed the host lets only a
//     rosterer say who works a shift, ADR 0626): booking, moving and cancelling visits, putting
//     crew on and off them. Each is a person's act: an AI's call waits for a person;
//   - jobs:crew (the crew role, and every member): their visits and jobs, marking a visit on the
//     way, on site, done or missed (their own act), materials and variations. Under the crew role
//     the host holds the account to its own jobs (ADR 0755), so these tools take what it reaches;
//   - jobs:prices (restricted, ADR 0625: admins and whoever an admin grants): lines with prices,
//     approving and voiding lines, and what is unbilled, as numbers and as a CSV (audited).
// No tool here returns a price, a cost or a rate but those naming jobs:prices.
//
// Not here yet: clocking in and out, and labour lines from approved time (stage 58 step 7); a
// customer's acceptance, approval and sign-off (step 4) and their link (step 6).
import { defineTool, type ExtensionContext, OpsCallError, z } from "@composable-os/sdk";

export const JOB = "jobs.job";
export const SITE = "jobs.site";
export const VISIT_TYPE = "jobs.visittype";
export const VISIT = "jobs.visit";
export const PLACE = "jobs.assignment";
export const LINE = "jobs.line";
export const VARIATION = "jobs.variation";
export const MANAGE = "jobs:manage";
export const SCHEDULE = "jobs:schedule";
export const CREW = "jobs:crew";
export const PRICES = "jobs:prices";

/** A record as record.get, record.create and record.update return it. */
interface HostRecord {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
  createdAt?: string | null;
  warnings?: Warning[];
}
interface Warning {
  code: string;
  account?: string | null;
  message: string;
}
interface Page {
  items: HostRecord[];
  nextCursor?: string | null;
}

const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);
const num = (value: unknown): number | null =>
  value === null || value === undefined || value === "" ? null : Number(value);
const id = z.string().min(1).max(64);
const words = (max: number) => z.string().trim().min(1).max(max);
const requestId = z
  .string()
  .trim()
  .min(8)
  .max(64)
  .optional()
  .describe(
    "A key the caller makes once per action and sends again on a retry (a phone with poor " +
      "signal): the same request finds what the first made instead of making it twice",
  );
const instant = z.string().datetime({ offset: true });

const codeOf = (error: unknown) =>
  error instanceof OpsCallError ? error.code : (error as { code?: string })?.code;
const isConflict = (error: unknown) => codeOf(error) === "conflict";

function staffOf(ctx: ExtensionContext) {
  if (ctx.caller?.kind !== "staff") {
    throw new OpsCallError("forbidden", "Only a staff member uses this tool");
  }
  return ctx.caller;
}

const get = (ctx: ExtensionContext, object: string, recordId: string) =>
  ctx.ops.call<HostRecord>("record.get", { object, id: recordId });

/** The live record of `object` holding `key`, or null. */
async function byKey(
  ctx: ExtensionContext,
  object: string,
  key: string,
  states?: readonly string[],
): Promise<HostRecord | null> {
  const page = await ctx.ops.call<Page>("record.list", {
    object,
    filter: states
      ? {
          and: [
            { field: "requestKey", op: "eq", value: key },
            { field: "state", op: "in", value: states },
          ],
        }
      : { field: "requestKey", op: "eq", value: key },
    limit: 1,
  });
  return page.items[0] ?? null;
}

/** Records of `object` by id, in one list call per 100 ids. */
async function byIds(ctx: ExtensionContext, object: string, ids: readonly string[]) {
  const found = new Map<string, HostRecord>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) {
    const page = await ctx.ops.call<Page>("record.list", {
      object,
      filter: { field: "id", op: "in", value: unique.slice(i, i + 100) },
      limit: 100,
    });
    for (const r of page.items) found.set(r.id, r);
  }
  return found;
}

const warningOut = z.object({
  code: z.string(),
  account: z.string().nullable(),
  message: z.string(),
});
const warningsOf = (r: HostRecord): z.infer<typeof warningOut>[] =>
  (r.warnings ?? []).map((w) => ({
    code: w.code,
    account: text(w.account),
    message: w.message,
  }));

const VISIT_STATES = ["booked", "on_the_way", "on_site", "done", "missed", "cancelled"] as const;
const VISIT_OPEN = ["booked", "on_the_way", "on_site"] as const;
const LINE_STATES = ["draft", "approved", "billed", "void"] as const;
const LINE_KINDS = ["estimate", "variation", "material", "labour"] as const;
const VARIATION_STATES = ["proposed", "approved", "declined", "withdrawn"] as const;

const visitState = (v: unknown) => (text(v) as (typeof VISIT_STATES)[number] | null) ?? null;

// --- Enquiries -----------------------------------------------------------------------------------

const siteInput = z.object({
  name: words(200).optional().describe("How the office knows it; the street address by default"),
  line1: words(200),
  line2: z.string().trim().max(200).optional(),
  suburb: z.string().trim().max(100).optional(),
  region: z.string().trim().max(100).optional(),
  postcode: z.string().trim().max(20).optional(),
  country: z.string().trim().max(100).optional(),
  hazards: z.string().trim().max(2000).optional(),
});

export const enquire = defineTool({
  description:
    "Takes an enquiry: a new job at the first stage of its pipeline (Trades unless another is " +
    "named), for a customer (a Person id) and at a site (an existing site's id, or a new " +
    "site's address, made for the same customer). A plain project names no site and the " +
    "Projects pipeline. Pass requestId to make it safe to send again. Opens the new job.",
  input: z.object({
    title: words(200),
    customerId: id.optional().describe("The Person the work is for"),
    organisationId: id.optional(),
    siteId: id.optional(),
    site: siteInput.optional().describe("A new site, when siteId is not given"),
    pipelineId: id.optional(),
    billing: z.enum(["fixed", "time_and_materials"]).optional(),
    description: z.string().trim().max(5000).optional(),
    requestId,
  }),
  output: z.object({
    jobId: z.string(),
    siteId: z.string().nullable(),
    stageId: z.string().nullable(),
    existing: z.boolean().describe("True when this request had already made the job"),
    open: z.object({ object: z.literal(JOB), id: z.string() }),
  }),
  risk: "write",
  permission: MANAGE,
  async handler(input, ctx) {
    const caller = staffOf(ctx);
    if (input.siteId && input.site) {
      throw new OpsCallError("invalid_input", "Give siteId or a new site, not both");
    }
    // The key names who asked and the request: another person's retry never finds this job.
    const key = input.requestId ? `enquire:${caller.userId}:${input.requestId}` : null;
    const done = (job: HostRecord, existing: boolean) => ({
      jobId: job.id,
      siteId: text(job.values.site),
      stageId: text(job.values.stage),
      existing,
      open: { object: JOB, id: job.id } as const,
    });
    if (key) {
      const found = await byKey(ctx, JOB, key);
      if (found) return done(found, true);
    }
    let siteId = input.siteId ?? null;
    if (input.site) {
      const site = await ctx.ops.call<HostRecord>("record.create", {
        object: SITE,
        values: {
          ...Object.fromEntries(
            Object.entries(input.site).filter(([, v]) => v !== undefined && v !== ""),
          ),
          name: input.site.name ?? input.site.line1,
          ...(input.customerId ? { customer: input.customerId } : {}),
        },
      });
      siteId = site.id;
    }
    try {
      const job = await ctx.ops.call<HostRecord>("record.create", {
        object: JOB,
        values: {
          title: input.title,
          ...(input.customerId ? { customer: input.customerId } : {}),
          ...(input.organisationId ? { organisation: input.organisationId } : {}),
          ...(siteId ? { site: siteId } : {}),
          ...(input.pipelineId ? { pipeline: input.pipelineId } : {}),
          ...(input.billing ? { billing: input.billing } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(key ? { requestKey: key } : {}),
        },
      });
      return done(job, false);
    } catch (error) {
      // The same request at once: the other call made it.
      if (key && isConflict(error)) {
        const found = await byKey(ctx, JOB, key);
        if (found) return done(found, true);
      }
      throw error;
    }
  },
});

// --- A job's summary -----------------------------------------------------------------------------

const crewOut = z.object({
  id: z.string(),
  staff: z.string().nullable(),
  lead: z.boolean(),
  state: z.string().nullable(),
});

const visitOut = z.object({
  id: z.string(),
  title: z.string().nullable(),
  visitType: z.string().nullable(),
  starts: z.string().nullable(),
  ends: z.string().nullable(),
  zone: z.string().nullable(),
  arrivalWindow: z.string().nullable(),
  state: z.enum(VISIT_STATES).nullable(),
});

/** The most visits, variations and lines a job's answer lists. */
export const SUMMARY_LIMIT = 50;

export const jobSummary = defineTool({
  description:
    "One job for the office: its stage, customer, site, billing basis, the facts the host keeps " +
    "(accepted, signed off, invoiced), its visits with their crew, its variations and how many " +
    "lines it has of each kind and state. No prices: what is owed is unbilled's, for those who " +
    "see prices. Read-only.",
  input: z.object({ jobId: id }),
  output: z.object({
    id: z.string(),
    title: z.string().nullable(),
    stage: z.string().nullable(),
    status: z.string().nullable(),
    pipeline: z.string().nullable(),
    customer: z.string().nullable(),
    organisation: z.string().nullable(),
    owner: z.string().nullable(),
    billing: z.string().nullable(),
    site: z
      .object({
        id: z.string(),
        name: z.string().nullable(),
        address: z.string().nullable(),
        hazards: z.string().nullable(),
      })
      .nullable(),
    acceptedAt: z.string().nullable(),
    acceptedBy: z.string().nullable(),
    signedOffAt: z.string().nullable(),
    invoicedAt: z.string().nullable(),
    visits: z.array(visitOut.extend({ crew: z.array(crewOut) })),
    moreVisits: z.boolean(),
    variations: z.array(
      z.object({ id: z.string(), title: z.string().nullable(), state: z.string().nullable() }),
    ),
    moreVariations: z.boolean(),
    lines: z
      .array(z.object({ kind: z.string(), state: z.string(), count: z.number() }))
      .describe("How many lines of each kind and state, at most the first 200 lines counted"),
  }),
  risk: "read",
  permission: MANAGE,
  async handler(input, ctx) {
    const job = await get(ctx, JOB, input.jobId);
    const v = job.values;
    const siteId = text(v.site);
    const [site, visits, variations, lines] = await Promise.all([
      siteId ? get(ctx, SITE, siteId) : Promise.resolve(null),
      ctx.ops.call<Page>("record.list", {
        object: VISIT,
        filter: { field: "job", op: "eq", value: job.id },
        sort: { field: "starts", direction: "asc" },
        limit: SUMMARY_LIMIT + 1,
      }),
      ctx.ops.call<Page>("record.list", {
        object: VARIATION,
        filter: { field: "job", op: "eq", value: job.id },
        sort: { field: "createdAt", direction: "desc" },
        limit: SUMMARY_LIMIT + 1,
      }),
      ctx.ops.call<Page>("record.list", {
        object: LINE,
        filter: { field: "job", op: "eq", value: job.id },
        limit: 200,
      }),
    ]);
    const shown = visits.items.slice(0, SUMMARY_LIMIT);
    const crew = shown.length
      ? await ctx.ops.call<Page>("record.list", {
          object: PLACE,
          filter: { field: "visit", op: "in", value: shown.map((x) => x.id) },
          limit: 200,
        })
      : { items: [] };
    const counts = new Map<string, number>();
    for (const line of lines.items) {
      const k = `${text(line.values.kind)}|${text(line.values.state)}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return {
      id: job.id,
      title: text(v.title),
      stage: text(v.stage),
      status: text(v.status),
      pipeline: text(v.pipeline),
      customer: text(v.customer),
      organisation: text(v.organisation),
      owner: text(v.owner),
      billing: text(v.billing),
      site: site ? siteOut(site) : null,
      acceptedAt: text(v.acceptedAt),
      acceptedBy: text(v.acceptedBy),
      signedOffAt: text(v.signedOffAt),
      invoicedAt: text(v.invoicedAt),
      visits: shown.map((visit) => ({
        ...visitOf(visit),
        crew: crew.items
          .filter((p) => text(p.values.visit) === visit.id)
          .map((p) => ({
            id: p.id,
            staff: text(p.values.staff),
            lead: p.values.lead === true,
            state: text(p.values.state),
          })),
      })),
      moreVisits: visits.items.length > SUMMARY_LIMIT,
      variations: variations.items.slice(0, SUMMARY_LIMIT).map((x) => ({
        id: x.id,
        title: text(x.values.title),
        state: text(x.values.state),
      })),
      moreVariations: variations.items.length > SUMMARY_LIMIT,
      lines: [...counts].map(([k, count]) => {
        const [kind, state] = k.split("|");
        return { kind: kind ?? "", state: state ?? "", count };
      }),
    };
  },
});

const visitOf = (visit: HostRecord): z.infer<typeof visitOut> => ({
  id: visit.id,
  title: visit.title ?? text(visit.values.title),
  visitType: text(visit.values.visitType),
  starts: text(visit.values.starts),
  ends: text(visit.values.ends),
  zone: text(visit.values.zone),
  arrivalWindow: text(visit.values.arrivalWindow),
  state: visitState(visit.values.state),
});

function siteOut(site: HostRecord) {
  const s = site.values;
  const address = [s.line1, s.line2, s.suburb, s.region, s.postcode, s.country]
    .map(text)
    .filter((part): part is string => part !== null)
    .join(", ");
  return {
    id: site.id,
    name: text(s.name),
    address: address || null,
    hazards: text(s.hazards),
  };
}

// --- The office's record of an acceptance --------------------------------------------------------

export const recordAcceptance = defineTool({
  description:
    "Records that the customer accepted the work, on their word or a paper estimate, before " +
    "quotes are built: sets the job's Accepted fact as the office's (never the customer's), " +
    "approves exactly the estimate lines named (what the customer accepted), and moves the job " +
    "to a stage when one is named. A person's own act; the assistant cannot do it.",
  input: z.object({
    jobId: id,
    how: words(500).describe("How the customer accepted: a signed paper estimate, a phone call"),
    estimateLines: z
      .array(id)
      .max(200)
      .describe("The estimate lines the customer accepted; other drafts stay drafts"),
    stageId: id.optional().describe("A stage to move the job to in the same write (Accepted)"),
  }),
  output: z.object({
    jobId: z.string(),
    acceptedAt: z.string().nullable(),
    stage: z.string().nullable(),
    approvedLines: z.array(z.string()),
  }),
  risk: "write",
  permission: MANAGE,
  humanOnly: true,
  redact: ["how"],
  async handler(input, ctx) {
    const caller = staffOf(ctx);
    const job = await get(ctx, JOB, input.jobId);
    const named = input.estimateLines.length
      ? await byIds(ctx, LINE, input.estimateLines)
      : new Map<string, HostRecord>();
    for (const lineId of input.estimateLines) {
      const line = named.get(lineId);
      if (
        !line ||
        text(line.values.job) !== job.id ||
        text(line.values.kind) !== "estimate" ||
        !["draft", "approved"].includes(String(line.values.state))
      ) {
        throw new OpsCallError(
          "invalid_input",
          `${lineId} is not a draft or approved estimate line of this job`,
        );
      }
    }
    const approved: string[] = [];
    for (const line of named.values()) {
      if (line.values.state === "draft") {
        try {
          await ctx.ops.call("record.update", {
            object: LINE,
            id: line.id,
            from: "draft",
            values: { state: "approved" },
          });
        } catch (error) {
          if (!isConflict(error)) throw error;
        }
      }
      approved.push(line.id);
    }
    // Recorded once: a retry after the fact is set changes nothing but the stage asked for.
    const fact = text(job.values.acceptedAt)
      ? {}
      : {
          acceptedAt: new Date().toISOString(),
          acceptedBy: "office",
          acceptedHow: input.how,
          acceptedByName: caller.name,
        };
    const updated =
      Object.keys(fact).length || input.stageId
        ? await ctx.ops.call<HostRecord>("record.update", {
            object: JOB,
            id: job.id,
            values: { ...fact, ...(input.stageId ? { stage: input.stageId } : {}) },
          })
        : job;
    return {
      jobId: job.id,
      acceptedAt: text(updated.values.acceptedAt),
      stage: text(updated.values.stage),
      approvedLines: approved,
    };
  },
});

// --- Visits and crew -----------------------------------------------------------------------------

const crewIn = z.object({ staffId: id, lead: z.boolean().optional() });

const placeOut = z.object({
  id: z.string(),
  staff: z.string(),
  warnings: z.array(warningOut),
});

export const bookVisit = defineTool({
  description:
    "Books a visit to a job's site at a time, with its crew (each person a crew place, a shift " +
    "on the roster). The end defaults to the visit type's usual length. Answers each crew " +
    "member's warnings (away, not qualified for the visit type); if anyone would be in two " +
    "places at once, nothing is booked and the refusal names them. An assistant's booking waits " +
    "for a person. Pass requestId to make it safe to send again.",
  input: z.object({
    jobId: id,
    visitTypeId: id,
    starts: instant,
    ends: instant.optional(),
    zone: z.string().max(64).optional().describe("An IANA time zone; the deployment's if left out"),
    arrivalWindow: z.string().trim().max(100).optional(),
    crewNotes: z.string().trim().max(2000).optional(),
    crew: z.array(crewIn).max(10).default([]),
    requestId,
  }),
  output: z.object({
    visitId: z.string(),
    existing: z.boolean(),
    crew: z.array(placeOut),
    open: z.object({ object: z.literal(VISIT), id: z.string() }),
  }),
  risk: "write",
  permission: SCHEDULE,
  personApproves: true,
  async handler(input, ctx) {
    staffOf(ctx);
    // The key names the job it books for: the same request id on another job is another visit.
    const key = input.requestId ? `visit:${input.jobId}:${input.requestId}` : null;
    let visit = key ? await byKey(ctx, VISIT, key, VISIT_OPEN) : null;
    const existing = visit !== null;
    if (!visit) {
      let ends = input.ends;
      if (!ends) {
        const type = await get(ctx, VISIT_TYPE, input.visitTypeId);
        const minutes = num(type.values.defaultMinutes) ?? 60;
        ends = new Date(Date.parse(input.starts) + minutes * 60_000).toISOString();
      }
      visit = await ctx.ops.call<HostRecord>("record.create", {
        object: VISIT,
        values: {
          job: input.jobId,
          visitType: input.visitTypeId,
          starts: input.starts,
          ends,
          ...(input.zone ? { zone: input.zone } : {}),
          ...(input.arrivalWindow ? { arrivalWindow: input.arrivalWindow } : {}),
          ...(input.crewNotes ? { crewNotes: input.crewNotes } : {}),
          ...(key ? { requestKey: key } : {}),
        },
      });
    }
    const crew: z.infer<typeof placeOut>[] = [];
    try {
      for (const member of input.crew) {
        crew.push(await place(ctx, visit.id, member.staffId, member.lead));
      }
    } catch (error) {
      // A clash refuses all (the host named who): the visit and any place made go, cancelled.
      if (!existing && isConflict(error)) {
        await ctx.ops
          .call("record.update", {
            object: VISIT,
            id: visit.id,
            from: "booked",
            values: { state: "cancelled" },
          })
          // The clash is what the caller needs to hear; a visit left booked shows on the board.
          .catch(() => undefined);
      }
      throw error;
    }
    return { visitId: visit.id, existing, crew, open: { object: VISIT, id: visit.id } as const };
  },
});

/** Puts `staffId` on the visit, or finds their place there: the host decides everything else. */
async function place(
  ctx: ExtensionContext,
  visitId: string,
  staffId: string,
  lead?: boolean,
): Promise<z.infer<typeof placeOut>> {
  try {
    const made = await ctx.ops.call<HostRecord>("record.create", {
      object: PLACE,
      values: { visit: visitId, staff: staffId, ...(lead ? { lead: true } : {}) },
    });
    return { id: made.id, staff: staffId, warnings: warningsOf(made) };
  } catch (error) {
    // Already on it (one place a person on a visit): their place, as it is.
    const rule = ((error as OpsCallError).details as { rule?: unknown } | undefined)?.rule;
    if (isConflict(error) && rule === "unique") {
      const page = await ctx.ops.call<Page>("record.list", {
        object: PLACE,
        filter: {
          and: [
            { field: "visit", op: "eq", value: visitId },
            { field: "staff", op: "eq", value: staffId },
            { field: "state", op: "eq", value: "booked" },
          ],
        },
        limit: 1,
      });
      const found = page.items[0];
      if (found) return { id: found.id, staff: staffId, warnings: [] };
    }
    throw error;
  }
}

export const moveVisit = defineTool({
  description:
    "Moves a visit to another time. Its whole crew moves with it in the same write; if anyone " +
    "would then be in two places at once, nothing moves and the refusal names them. Answers " +
    "each crew member's warnings. The end keeps the visit's length unless given. An " +
    "assistant's move waits for a person.",
  input: z.object({
    visitId: id,
    starts: instant,
    ends: instant.optional(),
    zone: z.string().max(64).optional(),
    arrivalWindow: z.string().trim().max(100).optional(),
  }),
  output: z.object({
    visitId: z.string(),
    starts: z.string().nullable(),
    ends: z.string().nullable(),
    warnings: z.array(warningOut),
  }),
  risk: "write",
  permission: SCHEDULE,
  personApproves: true,
  async handler(input, ctx) {
    staffOf(ctx);
    let ends = input.ends;
    if (!ends) {
      const visit = await get(ctx, VISIT, input.visitId);
      const length =
        Date.parse(String(visit.values.ends)) - Date.parse(String(visit.values.starts));
      ends = new Date(
        Date.parse(input.starts) + (Number.isFinite(length) ? length : 3_600_000),
      ).toISOString();
    }
    const moved = await ctx.ops.call<HostRecord>("record.update", {
      object: VISIT,
      id: input.visitId,
      values: {
        starts: input.starts,
        ends,
        ...(input.zone ? { zone: input.zone } : {}),
        ...(input.arrivalWindow !== undefined ? { arrivalWindow: input.arrivalWindow } : {}),
      },
    });
    return {
      visitId: moved.id,
      starts: text(moved.values.starts),
      ends: text(moved.values.ends),
      warnings: warningsOf(moved),
    };
  },
});

/** Moves a visit from where it is now to `to` (ADR 0437): of two at once, one moves it. */
async function moveVisitState(ctx: ExtensionContext, visitId: string, to: string) {
  const visit = await get(ctx, VISIT, visitId);
  const from = text(visit.values.state) ?? "booked";
  if (from === to) return { visitId: visit.id, state: to, changed: false };
  const moved = await ctx.ops.call<HostRecord>("record.update", {
    object: VISIT,
    id: visit.id,
    from,
    values: { state: to },
  });
  return { visitId: moved.id, state: text(moved.values.state) ?? to, changed: true };
}

const visitMoveOut = z.object({
  visitId: z.string(),
  state: z.string(),
  changed: z.boolean().describe("False when it was already in that state"),
});

export const cancelVisit = defineTool({
  description:
    "Cancels a visit that has not happened: its crew places are cancelled with it, off the " +
    "roster. An assistant's cancel waits for a person.",
  input: z.object({ visitId: id }),
  output: visitMoveOut,
  risk: "write",
  permission: SCHEDULE,
  personApproves: true,
  handler: (input, ctx) => moveVisitState(ctx, input.visitId, "cancelled"),
});

export const assignCrew = defineTool({
  description:
    "Puts a staff member on a visit (a crew place: a shift at the visit's time). Answers their " +
    "warnings (away, not qualified for the visit type), which never stop it; being on another " +
    "shift at that time does, and the refusal names it. With Rostering installed only someone " +
    "who rosters may do it. An assistant's call waits for a person.",
  input: z.object({ visitId: id, staffId: id, lead: z.boolean().optional() }),
  output: placeOut,
  risk: "write",
  permission: SCHEDULE,
  personApproves: true,
  handler: (input, ctx) => {
    staffOf(ctx);
    return place(ctx, input.visitId, input.staffId, input.lead);
  },
});

export const removeCrew = defineTool({
  description:
    "Takes a staff member off a visit: their crew place is cancelled, off the roster. An " +
    "assistant's call waits for a person.",
  input: z.object({ placeId: id }),
  output: z.object({ placeId: z.string(), state: z.string() }),
  risk: "write",
  permission: SCHEDULE,
  personApproves: true,
  async handler(input, ctx) {
    staffOf(ctx);
    try {
      const moved = await ctx.ops.call<HostRecord>("record.update", {
        object: PLACE,
        id: input.placeId,
        from: "booked",
        values: { state: "cancelled" },
      });
      return { placeId: moved.id, state: text(moved.values.state) ?? "cancelled" };
    } catch (error) {
      if (!isConflict(error)) throw error;
      const now = await get(ctx, PLACE, input.placeId);
      if (now.values.state === "cancelled") return { placeId: now.id, state: "cancelled" };
      throw error;
    }
  },
});

// --- The crew's day ------------------------------------------------------------------------------

const myVisitOut = visitOut.extend({
  placeId: z.string(),
  lead: z.boolean(),
  crewNotes: z.string().nullable(),
  job: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
  site: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      address: z.string().nullable(),
      hazards: z.string().nullable(),
    })
    .nullable(),
});

/** The most visits the crew's list holds. */
export const MY_VISITS_LIMIT = 50;

export const myVisits = defineTool({
  description:
    "The caller's own visits from today for the next days (7 by default, at most 14), soonest " +
    "first: each visit's time, arrival window, state, notes for the crew, the job and the " +
    "site's address and hazards. No prices. Read-only.",
  input: z.object({ days: z.number().int().min(1).max(14).default(7) }),
  output: z.object({ visits: z.array(myVisitOut), truncated: z.boolean() }),
  risk: "read",
  permission: [CREW, MANAGE],
  async handler(input, ctx) {
    const caller = staffOf(ctx);
    const now = Date.now();
    const from = new Date(now - 86_400_000).toISOString();
    const until = new Date(now + input.days * 86_400_000).toISOString();
    const places = await ctx.ops.call<Page>("record.list", {
      object: PLACE,
      filter: {
        and: [
          { field: "staff", op: "eq", value: caller.userId },
          { field: "state", op: "eq", value: "booked" },
          { field: "ends", op: "gte", value: from },
          { field: "starts", op: "lte", value: until },
        ],
      },
      sort: { field: "starts", direction: "asc" },
      limit: MY_VISITS_LIMIT + 1,
    });
    const shown = places.items.slice(0, MY_VISITS_LIMIT);
    const visits = await byIds(
      ctx,
      VISIT,
      shown.map((p) => String(p.values.visit)),
    );
    const jobs = await byIds(
      ctx,
      JOB,
      [...visits.values()].map((x) => String(x.values.job)),
    );
    // Only the sites of the jobs the host let the caller reach.
    const sites = await byIds(
      ctx,
      SITE,
      [...jobs.values()].map((j) => text(j.values.site)).filter((s): s is string => s !== null),
    );
    const out: z.infer<typeof myVisitOut>[] = [];
    for (const p of shown) {
      const visit = visits.get(String(p.values.visit));
      if (!visit) continue;
      const job = jobs.get(String(visit.values.job)) ?? null;
      const siteId = job ? text(job.values.site) : null;
      const site = siteId ? (sites.get(siteId) ?? null) : null;
      out.push({
        ...visitOf(visit),
        placeId: p.id,
        lead: p.values.lead === true,
        crewNotes: text(visit.values.crewNotes),
        job: job ? { id: job.id, title: text(job.values.title) } : null,
        site: site ? siteOut(site) : null,
      });
    }
    return { visits: out, truncated: places.items.length > MY_VISITS_LIMIT };
  },
});

export const myJob = defineTool({
  description:
    "A job as the crew sees it: its title and description, the site's address and hazards, " +
    "its visits, the materials recorded on it and its variations. Quantities, never prices. " +
    "Read-only.",
  input: z.object({ jobId: id }),
  output: z.object({
    id: z.string(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    site: myVisitOut.shape.site,
    visits: z.array(visitOut),
    materials: z.array(
      z.object({
        id: z.string(),
        description: z.string().nullable(),
        quantity: z.number().nullable(),
        unit: z.string().nullable(),
        state: z.enum(LINE_STATES).nullable(),
        recordedByName: z.string().nullable(),
      }),
    ),
    variations: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        state: z.enum(VARIATION_STATES).nullable(),
      }),
    ),
    truncated: z.boolean().describe("More visits, materials or variations than shown (50 each)"),
  }),
  risk: "read",
  permission: [CREW, MANAGE],
  async handler(input, ctx) {
    staffOf(ctx);
    // Under the crew role, the host answers not found for a job the caller is not on.
    const job = await get(ctx, JOB, input.jobId);
    const siteId = text(job.values.site);
    const [site, visits, materials, variations] = await Promise.all([
      siteId ? get(ctx, SITE, siteId) : Promise.resolve(null),
      ctx.ops.call<Page>("record.list", {
        object: VISIT,
        filter: { field: "job", op: "eq", value: job.id },
        sort: { field: "starts", direction: "asc" },
        limit: SUMMARY_LIMIT + 1,
      }),
      ctx.ops.call<Page>("record.list", {
        object: LINE,
        filter: {
          and: [
            { field: "job", op: "eq", value: job.id },
            { field: "kind", op: "eq", value: "material" },
          ],
        },
        sort: { field: "createdAt", direction: "asc" },
        limit: SUMMARY_LIMIT + 1,
      }),
      ctx.ops.call<Page>("record.list", {
        object: VARIATION,
        filter: { field: "job", op: "eq", value: job.id },
        sort: { field: "createdAt", direction: "desc" },
        limit: SUMMARY_LIMIT + 1,
      }),
    ]);
    return {
      id: job.id,
      title: text(job.values.title),
      description: text(job.values.description),
      site: site ? siteOut(site) : null,
      visits: visits.items.slice(0, SUMMARY_LIMIT).map(visitOf),
      materials: materials.items.slice(0, SUMMARY_LIMIT).map((l) => ({
        id: l.id,
        description: text(l.values.description),
        quantity: num(l.values.quantity),
        unit: text(l.values.unit),
        state: (text(l.values.state) as (typeof LINE_STATES)[number] | null) ?? null,
        recordedByName: text(l.values.recordedByName),
      })),
      variations: variations.items.slice(0, SUMMARY_LIMIT).map((x) => ({
        id: x.id,
        title: text(x.values.title),
        state: (text(x.values.state) as (typeof VARIATION_STATES)[number] | null) ?? null,
      })),
      truncated: [visits, materials, variations].some((p) => p.items.length > SUMMARY_LIMIT),
    };
  },
});

const markTool = (to: string, what: string) =>
  defineTool({
    description: `${what} A person's own act, by someone on the visit or the office; the assistant cannot do it.`,
    input: z.object({ visitId: id }),
    output: visitMoveOut,
    risk: "write",
    permission: [CREW, MANAGE],
    humanOnly: true,
    handler: (input, ctx) => {
      staffOf(ctx);
      return moveVisitState(ctx, input.visitId, to);
    },
  });

export const markOnTheWay = markTool("on_the_way", "Marks a booked visit on the way.");
export const markOnSite = markTool("on_site", "Marks a visit on site: the crew has arrived.");
export const markDone = markTool("done", "Marks a visit done: the work of the day is finished.");
export const markMissed = markTool(
  "missed",
  "Marks a visit missed: nobody could get in, or the crew could not come.",
);

// --- Lines ---------------------------------------------------------------------------------------

const lineIdOut = z.object({ lineId: z.string(), existing: z.boolean() });

/** Makes a line, or finds the one an earlier call with the same key made. */
async function makeLine(
  ctx: ExtensionContext,
  key: string | null,
  values: Record<string, unknown>,
): Promise<z.infer<typeof lineIdOut>> {
  if (key) {
    const found = await byKey(ctx, LINE, key);
    if (found) return { lineId: found.id, existing: true };
  }
  try {
    const made = await ctx.ops.call<HostRecord>("record.create", {
      object: LINE,
      values: { ...values, ...(key ? { requestKey: key } : {}) },
    });
    return { lineId: made.id, existing: false };
  } catch (error) {
    if (key && isConflict(error)) {
      const found = await byKey(ctx, LINE, key);
      if (found) return { lineId: found.id, existing: true };
    }
    throw error;
  }
}

export const addMaterial = defineTool({
  description:
    "Records a material used on a job: what, how many and in what unit (and a catalogue item's " +
    "code if it has one), as a draft line the office prices. By someone with a place on the " +
    "job, or the office. No price is asked or shown. Pass requestId to make it safe to send " +
    "again.",
  input: z.object({
    jobId: id,
    description: words(200),
    quantity: z.number().min(0).max(1_000_000),
    unit: z.string().trim().max(20).optional(),
    itemCode: z.string().trim().max(100).optional(),
    requestId,
  }),
  output: lineIdOut,
  risk: "write",
  permission: [CREW, MANAGE],
  handler(input, ctx) {
    const caller = staffOf(ctx);
    return makeLine(ctx, input.requestId ? `material:${input.jobId}:${input.requestId}` : null, {
      job: input.jobId,
      kind: "material",
      description: input.description,
      quantity: input.quantity,
      ...(input.unit ? { unit: input.unit } : {}),
      ...(input.itemCode ? { itemCode: input.itemCode } : {}),
      recordedBy: caller.userId,
      recordedByName: caller.name,
    });
  },
});

const money = z.number().min(0).max(10_000_000);

export const addLine = defineTool({
  description:
    "Adds a priced draft line to a job: an estimate line (what is quoted) or a material line. " +
    "Prices are in the base currency, before tax. Approving an estimate is the customer's " +
    "acceptance; a material line is approved with approveLine. Pass requestId to make it safe " +
    "to send again.",
  input: z.object({
    jobId: id,
    kind: z.enum(["estimate", "material"]),
    description: words(200),
    quantity: z.number().min(0).max(1_000_000),
    unit: z.string().trim().max(20).optional(),
    unitPrice: money.optional(),
    cost: money.optional(),
    taxCode: z.string().trim().max(40).optional(),
    itemCode: z.string().trim().max(100).optional(),
    requestId,
  }),
  output: lineIdOut,
  risk: "write",
  permission: PRICES,
  handler(input, ctx) {
    const caller = staffOf(ctx);
    const { jobId, requestId: request, ...rest } = input;
    return makeLine(ctx, request ? `line:${jobId}:${request}` : null, {
      job: jobId,
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      recordedBy: caller.userId,
      recordedByName: caller.name,
    });
  },
});

const lineOut = z.object({
  id: z.string(),
  job: z.string().nullable(),
  kind: z.enum(LINE_KINDS).nullable(),
  description: z.string().nullable(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  unitPrice: z.number().nullable(),
  cost: z.number().nullable(),
  taxCode: z.string().nullable(),
  state: z.enum(LINE_STATES).nullable(),
});
const lineOf = (l: HostRecord): z.infer<typeof lineOut> => ({
  id: l.id,
  job: text(l.values.job),
  kind: (text(l.values.kind) as (typeof LINE_KINDS)[number] | null) ?? null,
  description: text(l.values.description),
  quantity: num(l.values.quantity),
  unit: text(l.values.unit),
  unitPrice: num(l.values.unitPrice),
  cost: num(l.values.cost),
  taxCode: text(l.values.taxCode),
  state: (text(l.values.state) as (typeof LINE_STATES)[number] | null) ?? null,
});

export const editLine = defineTool({
  description:
    "Changes a draft line (its description, quantity, unit, price, cost, tax code or item; how " +
    "the office prices a material the crew recorded): the draft is voided as replaced and a " +
    "corrected draft made in its place, which this answers. A line's words and numbers never " +
    "change once written, so an approved, billed or void line is never changed (the host " +
    "refuses the void of anything but a draft). Safe to send again.",
  input: z.object({
    lineId: id,
    description: words(200).optional(),
    quantity: z.number().min(0).max(1_000_000).optional(),
    unit: z.string().trim().max(20).nullable().optional(),
    unitPrice: money.nullable().optional(),
    cost: money.nullable().optional(),
    taxCode: z.string().trim().max(40).nullable().optional(),
    itemCode: z.string().trim().max(100).nullable().optional(),
  }),
  output: lineOut,
  risk: "write",
  permission: PRICES,
  personApproves: true,
  async handler(input, ctx) {
    const caller = staffOf(ctx);
    const { lineId, ...rest } = input;
    const changes = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    const old = await get(ctx, LINE, lineId);
    if (!Object.keys(changes).length) return lineOf(old);
    // The key names the line it replaces: one copy, however often this is sent.
    const key = `replace:${old.id}`;
    if (old.values.state !== "void" || old.values.voidReason !== "replaced") {
      // From a draft only, in one write (ADR 0437): of a line approved meanwhile, the host
      // refuses the void as a conflict and nothing changes.
      await ctx.ops.call("record.update", {
        object: LINE,
        id: old.id,
        from: "draft",
        values: { state: "void", voidReason: "replaced" },
      });
    }
    const keep = [
      "job",
      "kind",
      "variation",
      "description",
      "quantity",
      "unit",
      "unitPrice",
      "cost",
      "itemCode",
      "taxCode",
    ];
    const values: Record<string, unknown> = { replaces: old.id };
    for (const name of keep) {
      const value = Object.hasOwn(changes, name) ? changes[name] : old.values[name];
      if (value !== null && value !== undefined && value !== "") values[name] = value;
    }
    const made = await makeLine(ctx, key, {
      ...values,
      recordedBy: caller.userId,
      recordedByName: caller.name,
    });
    return lineOf(await get(ctx, LINE, made.lineId));
  },
});

export const approveLine = defineTool({
  description:
    "Approves a draft material or labour line: it then counts as owed on a time and materials " +
    "job (and as cost on a fixed-price one) and cannot be changed. An estimate line is " +
    "approved by the customer's acceptance and a variation's lines with the variation, not " +
    "here. An assistant's call waits for a person.",
  input: z.object({ lineId: id }),
  output: lineOut,
  risk: "write",
  permission: PRICES,
  personApproves: true,
  async handler(input, ctx) {
    staffOf(ctx);
    const line = await get(ctx, LINE, input.lineId);
    const kind = text(line.values.kind);
    if (kind !== "material" && kind !== "labour") {
      throw new OpsCallError(
        "invalid_input",
        kind === "estimate"
          ? "An estimate line is approved by the customer's acceptance"
          : "A variation's lines are approved with the variation",
      );
    }
    return lineOf(
      await ctx.ops.call<HostRecord>("record.update", {
        object: LINE,
        id: line.id,
        from: "draft",
        values: { state: "approved" },
      }),
    );
  },
});

export const voidLine = defineTool({
  description:
    "Voids a draft or approved line: it no longer counts. A billed line is given back only when " +
    "its invoice is voided. An assistant's call waits for a person.",
  input: z.object({ lineId: id }),
  output: lineOut,
  risk: "write",
  permission: PRICES,
  personApproves: true,
  async handler(input, ctx) {
    staffOf(ctx);
    const line = await get(ctx, LINE, input.lineId);
    const from = text(line.values.state) ?? "draft";
    if (from === "void") return lineOf(line);
    return lineOf(
      await ctx.ops.call<HostRecord>("record.update", {
        object: LINE,
        id: line.id,
        from,
        values: { state: "void", voidReason: "voided" },
      }),
    );
  },
});

// --- Variations ----------------------------------------------------------------------------------

export const proposeVariation = defineTool({
  description:
    "Proposes extra work on a job (a variation): what, why and who asked, with its lines (what " +
    "and how many; the office prices them). It is approved before the work is done. By " +
    "someone with a place on the job, or the office. Pass requestId to make it safe to send " +
    "again.",
  input: z.object({
    jobId: id,
    title: words(200),
    why: words(2000),
    askedBy: z.enum(["customer", "crew", "office"]).optional(),
    lines: z
      .array(
        z.object({
          description: words(200),
          quantity: z.number().min(0).max(1_000_000),
          unit: z.string().trim().max(20).optional(),
        }),
      )
      .min(1)
      .max(20),
    requestId,
  }),
  output: z.object({
    variationId: z.string(),
    lineIds: z.array(z.string()),
    existing: z.boolean(),
  }),
  risk: "write",
  permission: [CREW, MANAGE],
  async handler(input, ctx) {
    const caller = staffOf(ctx);
    const key = input.requestId ? `variation:${input.jobId}:${input.requestId}` : null;
    let variation = key ? await byKey(ctx, VARIATION, key) : null;
    const existing = variation !== null;
    if (!variation) {
      try {
        variation = await ctx.ops.call<HostRecord>("record.create", {
          object: VARIATION,
          values: {
            job: input.jobId,
            title: input.title,
            why: input.why,
            ...(input.askedBy ? { askedBy: input.askedBy } : {}),
            proposedBy: caller.userId,
            proposedByName: caller.name,
            ...(key ? { requestKey: key } : {}),
          },
        });
      } catch (error) {
        variation = key && isConflict(error) ? await byKey(ctx, VARIATION, key) : null;
        if (!variation) throw error;
      }
    }
    const lineIds: string[] = [];
    for (const [i, line] of input.lines.entries()) {
      const made = await makeLine(ctx, `variation:${variation.id}:${i}`, {
        job: input.jobId,
        variation: variation.id,
        kind: "variation",
        description: line.description,
        quantity: line.quantity,
        ...(line.unit ? { unit: line.unit } : {}),
        recordedBy: caller.userId,
        recordedByName: caller.name,
      });
      lineIds.push(made.lineId);
    }
    return { variationId: variation.id, lineIds, existing };
  },
});

const decisionOut = z.object({
  variationId: z.string(),
  state: z.enum(VARIATION_STATES).nullable(),
  decidedBy: z.string().nullable(),
});

const decide = (to: "approved" | "declined", word: string) =>
  defineTool({
    description:
      `Records that the customer ${word} a proposed variation, on their word (a phone call, an ` +
      "email): recorded as the office's, never as the customer's own. " +
      (to === "approved" ? "Its lines are approved with it. " : "Its lines are voided with it. ") +
      "A person's own act; the assistant cannot do it.",
    input: z.object({
      variationId: id,
      note: words(500).describe("How the customer said so"),
    }),
    output: decisionOut,
    risk: "write",
    permission: MANAGE,
    humanOnly: true,
    redact: ["note"],
    async handler(input, ctx) {
      const caller = staffOf(ctx);
      try {
        const moved = await ctx.ops.call<HostRecord>("record.update", {
          object: VARIATION,
          id: input.variationId,
          from: "proposed",
          values: {
            state: to,
            decidedBy: "office",
            decidedAt: new Date().toISOString(),
            decidedByName: caller.name,
            decisionNote: input.note,
          },
        });
        return {
          variationId: moved.id,
          state: (text(moved.values.state) as (typeof VARIATION_STATES)[number] | null) ?? null,
          decidedBy: text(moved.values.decidedBy),
        };
      } catch (error) {
        if (!isConflict(error)) throw error;
        // Decided already (a retry, or someone else at once): say what it is.
        const now = await get(ctx, VARIATION, input.variationId);
        if (now.values.state === to) {
          return { variationId: now.id, state: to, decidedBy: text(now.values.decidedBy) };
        }
        throw error;
      }
    },
  });

export const approveVariation = decide("approved", "approved");
export const declineVariation = decide("declined", "declined");

export const withdrawVariation = defineTool({
  description:
    "Withdraws a proposed variation nobody wants any more: its lines are voided with it. An " +
    "assistant's call waits for a person.",
  input: z.object({ variationId: id }),
  output: decisionOut,
  risk: "write",
  permission: MANAGE,
  personApproves: true,
  async handler(input, ctx) {
    staffOf(ctx);
    const moved = await ctx.ops.call<HostRecord>("record.update", {
      object: VARIATION,
      id: input.variationId,
      from: "proposed",
      values: { state: "withdrawn" },
    });
    return {
      variationId: moved.id,
      state: (text(moved.values.state) as (typeof VARIATION_STATES)[number] | null) ?? null,
      decidedBy: text(moved.values.decidedBy),
    };
  },
});

// --- What is unbilled ----------------------------------------------------------------------------

/** The most lines one answer of what is unbilled holds. */
export const UNBILLED_LIMIT = 500;

interface UnbilledRow {
  jobId: string;
  jobTitle: string | null;
  billing: string | null;
  lineId: string;
  kind: string | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number;
  taxCode: string | null;
  itemCode: string | null;
}

/**
 * The approved, unbilled lines that are owed, one statement: on a fixed-price job its estimate and
 * variation lines, on a time and materials job its labour and material lines (decision 1). Each
 * line's amount is its quantity times its unit price in minor units, rounded once, half away from
 * zero (SQLite's round), as an integer.
 */
async function unbilledRows(
  ctx: ExtensionContext,
  jobId: string | undefined,
): Promise<{ rows: UnbilledRow[]; truncated: boolean }> {
  const result = await ctx.ops.call<{ rows: Record<string, unknown>[]; truncated: boolean }>(
    "query.sql",
    {
      sql:
        "SELECT j.id AS job_id, j.title AS job_title, j.billing AS billing, l.id AS line_id, " +
        "l.kind AS kind, l.description AS description, l.quantity AS quantity, l.unit AS unit, " +
        "l.unit_price AS unit_price, " +
        "CAST(round(round(coalesce(l.quantity, 0) * coalesce(l.unit_price, 0) * 100, 6)) AS INTEGER) AS amount, " +
        "l.tax_code AS tax_code, l.item_code AS item_code " +
        "FROM rec_x_jobs_line l JOIN rec_x_jobs_job j ON j.id = l.job " +
        "WHERE l.state = 'approved' AND (" +
        "(coalesce(j.billing, 'fixed') = 'fixed' AND l.kind IN ('estimate', 'variation')) OR " +
        "(j.billing = 'time_and_materials' AND l.kind IN ('labour', 'material')))" +
        (jobId ? " AND j.id = ?" : "") +
        " ORDER BY j.title ASC, j.id ASC, l.created_at ASC, l.id ASC",
      params: jobId ? [jobId] : [],
      maxRows: UNBILLED_LIMIT,
    },
  );
  return {
    truncated: result.truncated === true,
    rows: result.rows.slice(0, UNBILLED_LIMIT).map((r) => ({
      jobId: String(r.job_id),
      jobTitle: text(r.job_title),
      billing: text(r.billing),
      lineId: String(r.line_id),
      kind: text(r.kind),
      description: text(r.description),
      quantity: num(r.quantity),
      unit: text(r.unit),
      unitPrice: num(r.unit_price),
      amount: Number(r.amount ?? 0),
      taxCode: text(r.tax_code),
      itemCode: text(r.item_code),
    })),
  };
}

export const unbilled = defineTool({
  description:
    "What is owed and not yet billed, by job: on a fixed-price job its approved estimate and " +
    "variation lines, on a time and materials job its approved labour and material lines. Each " +
    "line's amount and each job's total are integers in minor units of the base currency " +
    "(cents), before tax. One job with jobId, else every job, at most 500 lines (truncated " +
    "says when there were more). Read-only.",
  input: z.object({ jobId: id.optional() }),
  output: z.object({
    jobs: z.array(
      z.object({
        jobId: z.string(),
        title: z.string().nullable(),
        billing: z.string().nullable(),
        total: z.number().int(),
        lines: z.array(
          z.object({
            lineId: z.string(),
            kind: z.string().nullable(),
            description: z.string().nullable(),
            quantity: z.number().nullable(),
            unit: z.string().nullable(),
            unitPrice: z.number().nullable(),
            amount: z.number().int(),
            taxCode: z.string().nullable(),
          }),
        ),
      }),
    ),
    total: z.number().int(),
    truncated: z.boolean(),
  }),
  risk: "read",
  permission: PRICES,
  async handler(input, ctx) {
    const { rows, truncated } = await unbilledRows(ctx, input.jobId);
    const jobs = new Map<
      string,
      {
        jobId: string;
        title: string | null;
        billing: string | null;
        total: number;
        lines: unknown[];
      }
    >();
    for (const r of rows) {
      const job = jobs.get(r.jobId) ?? {
        jobId: r.jobId,
        title: r.jobTitle,
        billing: r.billing,
        total: 0,
        lines: [],
      };
      job.total += r.amount;
      job.lines.push({
        lineId: r.lineId,
        kind: r.kind,
        description: r.description,
        quantity: r.quantity,
        unit: r.unit,
        unitPrice: r.unitPrice,
        amount: r.amount,
        taxCode: r.taxCode,
      });
      jobs.set(r.jobId, job);
    }
    const list = [...jobs.values()] as never[];
    return {
      jobs: list,
      total: rows.reduce((sum, r) => sum + r.amount, 0),
      truncated,
    };
  },
});

/** A CSV cell: quoted when it holds a comma, a quote or a line break; never a formula. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // A spreadsheet runs a cell starting with these as a formula: kept as text.
  if (/^[=+\-@\t\r]/.test(s) && typeof value === "string") s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const CSV_COLUMNS = [
  "job_id",
  "job",
  "billing",
  "line_id",
  "kind",
  "description",
  "quantity",
  "unit",
  "unit_price",
  "amount_minor",
  "tax_code",
  "item_code",
];

export const exportUnbilled = defineTool({
  description:
    "What is owed and not yet billed, as a CSV file for the accounting system: one row per " +
    "approved line that is owed (unbilled's), amounts in minor units of the base currency " +
    "before tax. At most 500 lines; truncated says when there were more. A person only, and " +
    "every download is in the audit log.",
  input: z.object({ jobId: id.optional() }),
  output: z.object({
    filename: z.string(),
    contentType: z.literal("text/csv"),
    csv: z.string(),
    lines: z.number().int(),
    truncated: z.boolean(),
  }),
  risk: "read",
  permission: PRICES,
  humanOnly: true,
  auditReads: true,
  redactResult: ["csv"],
  async handler(input, ctx) {
    const { rows, truncated } = await unbilledRows(ctx, input.jobId);
    const body = rows.map((r) =>
      [
        r.jobId,
        r.jobTitle,
        r.billing,
        r.lineId,
        r.kind,
        r.description,
        r.quantity,
        r.unit,
        r.unitPrice,
        r.amount,
        r.taxCode,
        r.itemCode,
      ]
        .map(cell)
        .join(","),
    );
    const day = new Date().toISOString().slice(0, 10);
    return {
      filename: `unbilled-${input.jobId ?? "all"}-${day}.csv`,
      contentType: "text/csv" as const,
      csv: `${[CSV_COLUMNS.join(","), ...body].join("\r\n")}\r\n`,
      lines: rows.length,
      truncated,
    };
  },
});
