// Equipment's staff tools (stage 59, step 3; ADR 0862). They become operations x.equipment.<tool>,
// run in the sandbox, and reach the host only through ctx.ops. None of them holds a rule: the
// tag's uniqueness, which moves an item and a fault may make, who may make them and what each move
// needs are the host's (index.ts). A tool asks, and reports what the host answered.
//
// Who may call which:
//   - equipment:report (every staff member; granted to a coach or a cleaner, ADR 0600): the
//     register, one item, report a fault (with or without taking the item out), take an item
//     out of service;
//   - equipment:manage (restricted, ADR 0625: admins and those granted it): put an item back in
//     service (a person's own act, never an AI's: decision 4), retire it, triage faults, and
//     correct a fault's report or why an item is out (fields only the tools write).
// Taking out, retiring, triage and corrections are a person's acts: the assistant, an MCP client
// or an automation may ask, and the call waits for a person (personApproves, ADR 0552). So is
// `reportFault`, which takes the item out in the same call (decision 3); `reportFaultOnly`
// changes nothing but the new fault, and the assistant may make it as an ordinary write.
import { defineTool, type ExtensionContext, OpsCallError, z } from "@composable-os/sdk";

export const ITEM = "equipment.item";
export const FAULT = "equipment.fault";
export const REPORT = "equipment:report";
export const MANAGE = "equipment:manage";

/** A record as record.get, record.create and record.update return it. */
interface HostRecord {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
  createdAt?: string | null;
}

const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);
const num = (value: unknown): number | null =>
  value === null || value === undefined || value === "" ? null : Number(value);
const ids = z.string().min(1).max(64);

const isConflict = (error: unknown) =>
  error instanceof OpsCallError
    ? error.code === "conflict"
    : (error as { code?: string })?.code === "conflict";

const ITEM_STATES = ["in_service", "out_of_service", "retired"] as const;
const FAULT_STATES = ["reported", "acknowledged", "fixed", "not_a_fault", "duplicate"] as const;
const SEVERITIES = ["safety_risk", "not_working", "worn"] as const;

/** A date (YYYY-MM-DD) on or after the day of `at`: under warranty on that day. */
const coversDay = (until: string | null, at: string | null | undefined) =>
  until !== null && typeof at === "string" && at.length >= 10 && until >= at.slice(0, 10);

const staffOf = (ctx: ExtensionContext) => (ctx.caller?.kind === "staff" ? ctx.caller : null);

// --- The register --------------------------------------------------------------------------------

const registerRow = z.object({
  id: z.string(),
  name: z.string().nullable(),
  tag: z.string().nullable(),
  category: z.string().nullable(),
  place: z.string().nullable(),
  state: z.enum(ITEM_STATES).nullable(),
  outSince: z.string().nullable(),
  outReason: z.string().nullable(),
  keeper: z.string().nullable().describe("The keeper's account id; empty means the managers"),
  issuedTo: z.string().nullable(),
  supplier: z.string().nullable(),
  warrantyUntil: z.string().nullable(),
  openFaults: z.number().describe("Faults reported or acknowledged, not yet closed"),
  safetyRisks: z.number().describe("Of the open faults, those reported as a safety risk"),
});

/** The most items one call lists. */
export const REGISTER_LIMIT = 200;

export const register = defineTool({
  description:
    "The equipment register: items with their tag, category, place, state (in service, out of " +
    "service with why and since when, retired), keeper, supplier, warranty end and how many " +
    "faults are open. Out-of-service items and those with open safety risks come first. Retired " +
    "items are left out unless state is retired. Narrow it with state, category, place or q (a " +
    "name, tag, make, model or serial). Read-only.",
  input: z.object({
    state: z.enum(ITEM_STATES).optional(),
    category: z.string().max(80).optional(),
    place: z.string().max(200).optional().describe("Only items whose place contains this"),
    q: z.string().trim().min(1).max(100).optional(),
  }),
  output: z.object({ items: z.array(registerRow), truncated: z.boolean() }),
  risk: "read",
  permission: REPORT,
  async handler(input, ctx) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.state) {
      where.push("i.state = ?");
      params.push(input.state);
    } else {
      where.push("i.state <> 'retired'");
    }
    if (input.category) {
      where.push("i.category = ?");
      params.push(input.category);
    }
    if (input.place) {
      where.push("instr(lower(i.place), lower(?)) > 0");
      params.push(input.place);
    }
    if (input.q) {
      where.push(
        "(instr(lower(i.name), lower(?)) > 0 OR lower(i.tag) = lower(?) OR " +
          "instr(lower(coalesce(i.make, '') || ' ' || coalesce(i.model, '') || ' ' || " +
          "coalesce(i.serial, '')), lower(?)) > 0)",
      );
      params.push(input.q, input.q, input.q);
    }
    // One statement whatever the size of the register: the items, their supplier's name and the
    // open faults counted per item in one grouped join (AC 17).
    const result = await ctx.ops.call<{ rows: Record<string, unknown>[]; truncated: boolean }>(
      "query.sql",
      {
        sql:
          "SELECT i.id AS id, i.name AS name, i.tag AS tag, i.category AS category, " +
          "i.place AS place, i.state AS state, i.out_since AS out_since, " +
          "i.out_reason AS out_reason, i.keeper AS keeper, i.issued_to AS issued_to, " +
          "o.name AS supplier, i.warranty_until AS warranty_until, " +
          "coalesce(f.open_faults, 0) AS open_faults, coalesce(f.safety_risks, 0) AS safety_risks " +
          "FROM rec_x_equipment_item i " +
          "LEFT JOIN rec_organisation o ON o.id = i.supplier " +
          "LEFT JOIN (SELECT item, count(*) AS open_faults, " +
          "sum(CASE WHEN severity = 'safety_risk' THEN 1 ELSE 0 END) AS safety_risks " +
          "FROM rec_x_equipment_fault WHERE state IN ('reported', 'acknowledged') GROUP BY item) f " +
          "ON f.item = i.id " +
          `WHERE ${where.join(" AND ")} ` +
          "ORDER BY (i.state = 'out_of_service') DESC, coalesce(f.safety_risks, 0) DESC, " +
          "coalesce(f.open_faults, 0) DESC, i.name ASC, i.id ASC",
        params,
        // The host stops at this many rows and says when there were more.
        maxRows: REGISTER_LIMIT,
      },
    );
    return {
      truncated: result.truncated === true,
      items: result.rows.slice(0, REGISTER_LIMIT).map((row) => ({
        id: String(row.id),
        name: text(row.name),
        tag: text(row.tag),
        category: text(row.category),
        place: text(row.place),
        state: (text(row.state) as (typeof ITEM_STATES)[number] | null) ?? null,
        outSince: text(row.out_since),
        outReason: text(row.out_reason),
        keeper: text(row.keeper),
        issuedTo: text(row.issued_to),
        supplier: text(row.supplier),
        warrantyUntil: text(row.warranty_until),
        openFaults: Number(row.open_faults ?? 0),
        safetyRisks: Number(row.safety_risks ?? 0),
      })),
    };
  },
});

// --- One item ------------------------------------------------------------------------------------

const faultRow = z.object({
  id: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  severity: z.enum(SEVERITIES).nullable(),
  state: z.enum(FAULT_STATES).nullable(),
  reportedBy: z.string().nullable(),
  reportedByName: z.string().nullable(),
  closedWhy: z.string().nullable(),
  reportedAt: z.string().nullable(),
  underWarranty: z
    .boolean()
    .describe("The item's warranty had not ended on the day it was reported"),
});

const itemOutput = z.object({
  id: z.string(),
  name: z.string().nullable(),
  tag: z.string().nullable(),
  category: z.string().nullable(),
  place: z.string().nullable(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  state: z.enum(ITEM_STATES).nullable(),
  outSince: z.string().nullable(),
  outReason: z.string().nullable(),
  keeper: z.string().nullable(),
  issuedTo: z.string().nullable(),
  supplierId: z.string().nullable(),
  supplier: z.string().nullable(),
  boughtOn: z.string().nullable(),
  warrantyUntil: z.string().nullable(),
  warrantyNotes: z.string().nullable(),
  renewalDue: z.string().nullable(),
  listForMembers: z.string().nullable(),
  notes: z.string().nullable(),
  costs: z.object({
    purchase: z.number().nullable().describe("What it cost to buy, in the base currency"),
  }),
  faults: z.array(faultRow).describe("Newest first, at most 50"),
  moreFaults: z.boolean(),
});

/** The most faults one item's answer lists. */
export const ITEM_FAULTS_LIMIT = 50;

async function readItem(ctx: ExtensionContext, id: string): Promise<HostRecord> {
  return ctx.ops.call<HostRecord>("record.get", { object: ITEM, id });
}

export const item = defineTool({
  description:
    "One item of the register: its details, state (and why and since when it is out of " +
    "service), keeper, who has it, supplier, purchase cost, warranty and renewal dates, and its " +
    "faults newest first, each saying whether the item was under warranty when it was reported. " +
    "Costs are for every staff member. Read-only.",
  input: z.object({ itemId: ids }),
  output: itemOutput,
  risk: "read",
  permission: REPORT,
  async handler(input, ctx) {
    const record = await readItem(ctx, input.itemId);
    const v = record.values;
    const supplierId = text(v.supplier);
    const [supplier, faults] = await Promise.all([
      supplierId
        ? ctx.ops
            .call<{ rows: { name: unknown }[] }>("query.sql", {
              sql: "SELECT name FROM rec_organisation WHERE id = ?",
              params: [supplierId],
            })
            .then((r) => text(r.rows[0]?.name))
        : Promise.resolve(null),
      ctx.ops.call<{ items: HostRecord[] }>("record.list", {
        object: FAULT,
        filter: { field: "item", op: "eq", value: record.id },
        sort: { field: "createdAt", direction: "desc" },
        limit: ITEM_FAULTS_LIMIT + 1,
      }),
    ]);
    const warrantyUntil = text(v.warrantyUntil);
    return {
      id: record.id,
      name: text(v.name),
      tag: text(v.tag),
      category: text(v.category),
      place: text(v.place),
      make: text(v.make),
      model: text(v.model),
      serial: text(v.serial),
      state: (text(v.state) as (typeof ITEM_STATES)[number] | null) ?? null,
      outSince: text(v.outSince),
      outReason: text(v.outReason),
      keeper: text(v.keeper),
      issuedTo: text(v.issuedTo),
      supplierId,
      supplier,
      boughtOn: text(v.boughtOn),
      warrantyUntil,
      warrantyNotes: text(v.warrantyNotes),
      renewalDue: text(v.renewalDue),
      listForMembers: text(v.listForMembers),
      notes: text(v.notes),
      costs: { purchase: num(v.cost) },
      moreFaults: faults.items.length > ITEM_FAULTS_LIMIT,
      faults: faults.items.slice(0, ITEM_FAULTS_LIMIT).map((f) => ({
        id: f.id,
        title: f.title,
        description: text(f.values.description),
        severity: (text(f.values.severity) as (typeof SEVERITIES)[number] | null) ?? null,
        state: (text(f.values.state) as (typeof FAULT_STATES)[number] | null) ?? null,
        reportedBy: text(f.values.reportedBy),
        reportedByName: text(f.values.reportedByName),
        closedWhy: text(f.values.closedWhy),
        reportedAt: f.createdAt ?? null,
        underWarranty: coversDay(warrantyUntil, f.createdAt),
      })),
    };
  },
});

// --- Out of service ------------------------------------------------------------------------------

/**
 * Takes the item out of service, from in service only (ADR 0437): of two people taking it out at
 * once, one write moves it. False when it was not in service; the caller says what it is.
 */
async function moveOut(ctx: ExtensionContext, itemId: string, reason: string): Promise<boolean> {
  try {
    await ctx.ops.call("record.update", {
      object: ITEM,
      id: itemId,
      from: "in_service",
      values: {
        state: "out_of_service",
        outReason: reason,
        outSince: new Date().toISOString(),
      },
    });
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}

const reason = z.string().trim().min(3).max(500);

const STATE_WORDS: Record<string, string> = {
  in_service: "in service",
  out_of_service: "out of service",
  retired: "retired",
};

/** Why a take-out did not happen: the item was not in service, or the host refused it. */
type MoveOutResult = { moved: true } | { moved: false; error: string | null };

/**
 * Takes the item out of service and says what happened, never throwing: for a report whose fault
 * is already recorded, which must say truthfully that the take-out failed.
 */
async function tryMoveOut(
  ctx: ExtensionContext,
  itemId: string,
  why: string,
): Promise<MoveOutResult> {
  try {
    return (await moveOut(ctx, itemId, why)) ? { moved: true } : { moved: false, error: null };
  } catch (error) {
    return { moved: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A short, stable digest of a text (FNV-1a, 32 bits): enough to tell one report from another. */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

const reportInput = {
  itemId: ids,
  description: z.string().trim().min(3).max(4000),
  severity: z.enum(SEVERITIES),
  requestId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "The caller's own id for this report, the same on every retry: a retry finds the report " +
        "it made rather than making a second. Left out, a report by the same person on the same " +
        "item with the same words and severity, still open, is the same report.",
    ),
};

const reportOutput = z.object({
  faultId: z.string(),
  itemId: z.string(),
  alreadyReported: z
    .boolean()
    .describe("This report was made before (a retry, or the same report again): no second fault"),
  takenOut: z.boolean().describe("This call took the item out of service"),
  takeOutFailed: z
    .string()
    .nullable()
    .describe("Why the take-out asked for did not happen, when it did not; the fault is recorded"),
  itemState: z.enum(ITEM_STATES).nullable(),
  underWarranty: z.boolean(),
  message: z.string(),
});

/**
 * Records a fault once: found by its report key (the caller's request id, or the reporter, item,
 * severity and words) among the open faults before it is made, and by the database's uniqueness
 * on the key when two calls make it at once. The host refuses a fault on a retired item.
 */
async function recordFault(
  ctx: ExtensionContext,
  input: { itemId: string; description: string; severity: string; requestId?: string | undefined },
): Promise<{ fault: HostRecord; again: boolean }> {
  const staff = staffOf(ctx);
  const who = staff?.userId ?? "-";
  // The item is part of every key: a request id used again on another item is another report.
  const reportKey = input.requestId
    ? `r:${who}:${input.itemId}:${input.requestId}`
    : `k:${who}:${input.itemId}:${input.severity}:${digest(input.description.toLowerCase())}`;
  /**
   * A fault found by the key is this report only when it says the same: the same item, words and
   * severity. Anything else is another report under a reused request id: refused, never answered
   * as "already reported" (the report it carries would be lost).
   */
  const same = (found: HostRecord): HostRecord => {
    const v = found.values;
    const words = (x: unknown) =>
      String(x ?? "")
        .trim()
        .toLowerCase();
    if (
      v.item !== input.itemId ||
      v.severity !== input.severity ||
      words(v.description) !== words(input.description)
    ) {
      throw new OpsCallError(
        "conflict",
        "This request id was used for another report. Send this report with a new request id, or with none.",
        { reason: "request_id_reused", faultId: found.id },
      );
    }
    return found;
  };
  const find = async () =>
    (
      await ctx.ops.call<{ items: HostRecord[] }>("record.list", {
        object: FAULT,
        filter: {
          and: [
            { field: "reportKey", op: "eq", value: reportKey },
            { field: "state", op: "in", value: ["reported", "acknowledged"] },
          ],
        },
        limit: 1,
      })
    ).items[0];
  const earlier = await find();
  if (earlier) return { fault: same(earlier), again: true };
  try {
    const fault = await ctx.ops.call<HostRecord>("record.create", {
      object: FAULT,
      values: {
        item: input.itemId,
        description: input.description,
        severity: input.severity,
        reportKey,
        reportedBy: staff?.userId ?? null,
        reportedByName: staff?.name || null,
      },
    });
    return { fault, again: false };
  } catch (error) {
    // The same report made at the same moment by another call: that one is this one.
    const raced = isConflict(error) ? await find() : undefined;
    if (raced) return { fault: same(raced), again: true };
    throw error;
  }
}

async function reportHandler(
  input: {
    itemId: string;
    description: string;
    severity: string;
    requestId?: string | undefined;
    takeOut?: { reason: string } | undefined;
  },
  ctx: ExtensionContext,
): Promise<z.input<typeof reportOutput>> {
  // The report first: a call stopped part way leaves the fault recorded, never an item taken
  // out with nothing saying why; a retry finds it and goes on to the take-out.
  const { fault, again } = await recordFault(ctx, input);
  const out = input.takeOut
    ? await tryMoveOut(ctx, input.itemId, input.takeOut.reason)
    : ({ moved: false, error: null } as MoveOutResult);
  const after = await readItem(ctx, input.itemId).catch(() => null);
  const state = (text(after?.values.state) as (typeof ITEM_STATES)[number] | null) ?? null;
  const underWarranty = coversDay(
    text(after?.values.warrantyUntil),
    fault.createdAt ?? new Date().toISOString(),
  );
  const failed =
    input.takeOut && !out.moved
      ? out.error
        ? `it could not be taken out of service (${out.error}); take it out with takeOut`
        : `it was not taken out of service: it is ${STATE_WORDS[state ?? ""] ?? "not in service"}`
      : null;
  const said = input.takeOut
    ? out.moved
      ? " It is out of service."
      : ` The fault is recorded, but ${failed}.`
    : "";
  return {
    faultId: fault.id,
    itemId: input.itemId,
    alreadyReported: again,
    takenOut: out.moved,
    takeOutFailed: input.takeOut && !out.moved ? failed : null,
    itemState: state,
    underWarranty,
    message: `${again ? "Already reported." : "Fault reported."}${said}${underWarranty ? " The item is under warranty." : ""}`,
  };
}

export const reportFault = defineTool({
  description:
    "Report a fault on an item and take it out of service in the same call: what is wrong " +
    "(never an injury: that goes on the incident form), how bad (safety_risk, not_working, worn) " +
    "and, in takeOut, why it must not be used. For a staff member who sees something unsafe " +
    "(decision 3). To report without taking it out, use reportFaultOnly. The report is recorded " +
    "as the caller's, once: a retry with the same requestId (or the same report while it is " +
    "open) finds it. The answer says whether it was taken out, and why not if not. A fault on a " +
    "retired item is refused. A person's act: the assistant, an MCP client or an automation " +
    "may ask, and it waits for a person to approve it.",
  input: z.object({
    ...reportInput,
    takeOut: z
      .object({ reason })
      .optional()
      .describe("Take the item out of service, with why it must not be used"),
  }),
  output: reportOutput,
  risk: "write",
  permission: REPORT,
  personApproves: true,
  handler: reportHandler,
});

export const reportFaultOnly = defineTool({
  description:
    "Report a fault on an item without taking it out of service: what is wrong (never an " +
    "injury: that goes on the incident form) and how bad (safety_risk, not_working, worn). The " +
    "report is recorded as the caller's, once: a retry with the same requestId (or the same " +
    "report while it is open) finds it. Nothing else changes: the item stays as it is, and a " +
    "manager triages the fault. To take the item out too, use reportFault or takeOut. A fault " +
    "on a retired item is refused.",
  input: z.object(reportInput),
  output: reportOutput,
  risk: "write",
  permission: REPORT,
  handler: (input, ctx) => reportHandler(input, ctx),
});

export const takeOut = defineTool({
  description:
    "Take an item out of service, with why it must not be used: any staff member may (decision " +
    "4). Only from in service; an item already out of service or retired is refused with its " +
    "state. Only a manager puts it back (putBack). A person's act: the assistant, an MCP client " +
    "or an automation may ask, and it waits for a person to approve it.",
  input: z.object({ itemId: ids, reason }),
  output: z.object({
    itemId: z.string(),
    state: z.literal("out_of_service"),
    outSince: z.string(),
  }),
  risk: "write",
  permission: REPORT,
  personApproves: true,
  recordAction: {
    object: ITEM,
    label: "Take out of service",
    idInput: "itemId",
    ask: {
      input: "reason",
      label: "Why must it not be used?",
      options: [
        { value: "Broken: do not use", label: "Broken" },
        { value: "Unsafe: do not use", label: "Unsafe" },
        { value: "Being serviced or repaired", label: "Being serviced or repaired" },
        { value: "Being cleaned", label: "Being cleaned" },
      ],
    },
    hideWhen: { field: "state", values: ["out_of_service", "retired"] },
  },
  async handler(input, ctx) {
    if (!(await moveOut(ctx, input.itemId, input.reason))) {
      const now = await readItem(ctx, input.itemId);
      const state = text(now.values.state) ?? "";
      // A refusal is an error, never an answer: an approved request that cannot apply shows it.
      throw new OpsCallError(
        "conflict",
        `The item is ${STATE_WORDS[state] ?? state}, not in service`,
        {
          reason: "not_in_service",
          state,
        },
      );
    }
    const after = await readItem(ctx, input.itemId);
    return {
      itemId: input.itemId,
      state: "out_of_service" as const,
      outSince: text(after.values.outSince) ?? "",
    };
  },
});

export const putBack = defineTool({
  description:
    "Put an item that is out of service back in service, once it is safe to use: a manager's " +
    "own act (equipment:manage), never the assistant's or an automation's (decision 4). Its " +
    "reason and time out of service are cleared; the state history keeps them.",
  input: z.object({ itemId: ids }),
  output: z.object({ itemId: z.string(), state: z.literal("in_service") }),
  risk: "write",
  permission: MANAGE,
  humanOnly: true,
  recordAction: {
    object: ITEM,
    label: "Put back in service",
    idInput: "itemId",
    confirm: "Is it safe to use again?",
    hideWhen: { field: "state", values: ["in_service", "retired"] },
  },
  async handler(input, ctx) {
    try {
      await ctx.ops.call("record.update", {
        object: ITEM,
        id: input.itemId,
        from: "out_of_service",
        values: { state: "in_service", outReason: null, outSince: null },
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      const now = await readItem(ctx, input.itemId);
      const state = text(now.values.state) ?? "";
      throw new OpsCallError(
        "conflict",
        `The item is ${STATE_WORDS[state] ?? state}, not out of service`,
        {
          reason: "not_out_of_service",
          state,
        },
      );
    }
    return { itemId: input.itemId, state: "in_service" as const };
  },
});

export const retire = defineTool({
  description:
    "Retire an item for good (worn out, replaced, sold, lost), with why: it leaves the register's " +
    "usual list, is no longer listed for members, and cannot come back. Its faults and history " +
    "stay. A manager's (equipment:manage); the assistant, an MCP client or an automation may " +
    "ask, and it waits for a person to approve it.",
  input: z.object({ itemId: ids, reason }),
  output: z.object({ itemId: z.string(), state: z.literal("retired") }),
  risk: "destructive",
  permission: MANAGE,
  personApproves: true,
  recordAction: {
    object: ITEM,
    label: "Retire",
    idInput: "itemId",
    ask: {
      input: "reason",
      label: "Why is it retired?",
      options: [
        { value: "Worn out", label: "Worn out" },
        { value: "Replaced", label: "Replaced" },
        { value: "Sold or given away", label: "Sold or given away" },
        { value: "Lost or stolen", label: "Lost or stolen" },
      ],
    },
    hideWhen: { field: "state", values: ["retired"] },
  },
  async handler(input, ctx) {
    const now = await readItem(ctx, input.itemId);
    const state = text(now.values.state) ?? "";
    if (state === "retired") {
      // Said as the other tools say it; the host would refuse the move either way.
      throw new OpsCallError("conflict", "The item is already retired", {
        reason: "already_retired",
        state,
      });
    }
    const before = text(now.values.notes);
    const line = `Retired ${new Date().toISOString().slice(0, 10)}: ${input.reason}`;
    try {
      // From the state just read (ADR 0437): a move made meanwhile is refused, never overwritten.
      await ctx.ops.call("record.update", {
        object: ITEM,
        id: input.itemId,
        from: state,
        values: {
          state: "retired",
          listForMembers: "not_listed",
          notes: before ? `${before}\n\n${line}` : line,
          // Not out of service any more: retired.
          outReason: null,
          outSince: null,
        },
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      throw new OpsCallError("conflict", "The item changed while it was being retired", {
        reason: "moved_meanwhile",
      });
    }
    return { itemId: input.itemId, state: "retired" as const };
  },
});

// --- Faults --------------------------------------------------------------------------------------

const TRIAGE_TO = {
  acknowledge: "acknowledged",
  fixed: "fixed",
  not_a_fault: "not_a_fault",
  duplicate: "duplicate",
} as const;

export const triage = defineTool({
  description:
    "Triage a fault: acknowledge it (seen, being dealt with), or close it as fixed, not a fault " +
    "or a duplicate, with why (what fixed it, or which report it repeats). A manager's " +
    "(equipment:manage); the assistant, an MCP client or an automation may ask, and it waits " +
    "for a person to approve it. A closed fault stays closed. It does not put the item back in " +
    "service: that is putBack.",
  input: z.object({
    faultId: ids,
    action: z.enum(["acknowledge", "fixed", "not_a_fault", "duplicate"]),
    why: z
      .string()
      .trim()
      .min(3)
      .max(1000)
      .optional()
      .describe("Why it is closed. Needed to close one; optional to acknowledge"),
  }),
  output: z.object({ faultId: z.string(), state: z.enum(FAULT_STATES) }),
  risk: "write",
  permission: MANAGE,
  personApproves: true,
  async handler(input, ctx) {
    const fault = await ctx.ops.call<HostRecord>("record.get", {
      object: FAULT,
      id: input.faultId,
    });
    const from = text(fault.values.state) ?? "";
    const to = TRIAGE_TO[input.action];
    // Which moves a fault may make, and that a close says why, are the host's (index.ts): a
    // closed fault, or a close without why, is refused by it and the refusal passed on.
    try {
      await ctx.ops.call("record.update", {
        object: FAULT,
        id: input.faultId,
        from,
        values: { state: to, ...(input.why ? { closedWhy: input.why } : {}) },
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      throw new OpsCallError("conflict", "The fault changed while it was being triaged", {
        reason: "moved_meanwhile",
      });
    }
    return { faultId: input.faultId, state: to };
  },
});

// --- Corrections ---------------------------------------------------------------------------------

export const correctFault = defineTool({
  description:
    "Correct a fault's report: how bad it is (safety_risk, not_working, worn) and what is wrong. " +
    "Once reported these are fixed for everyone else, so a safety risk is never quietly lowered; " +
    "a manager (equipment:manage) corrects them here. The assistant, an MCP client or an " +
    "automation may ask, and it waits for a person to approve it.",
  input: z
    .object({
      faultId: ids,
      severity: z.enum(SEVERITIES).optional(),
      description: z.string().trim().min(3).max(4000).optional(),
    })
    .refine((v) => v.severity !== undefined || v.description !== undefined, {
      message: "Give the severity, the description or both",
    }),
  output: z.object({
    faultId: z.string(),
    severity: z.enum(SEVERITIES).nullable(),
    description: z.string().nullable(),
  }),
  risk: "write",
  permission: MANAGE,
  personApproves: true,
  async handler(input, ctx) {
    const fault = await ctx.ops.call<HostRecord>("record.get", {
      object: FAULT,
      id: input.faultId,
    });
    const state = text(fault.values.state) ?? "";
    if (state !== "reported" && state !== "acknowledged") {
      // A closed fault is the item's history, kept as it was closed.
      throw new OpsCallError("conflict", "The fault is closed: its report is kept as it was", {
        reason: "closed",
        state,
      });
    }
    const after = await ctx.ops.call<HostRecord>("record.update", {
      object: FAULT,
      id: input.faultId,
      // Only while it is still open as read (ADR 0865): a close landing first wins.
      while: state,
      values: {
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.description ? { description: input.description } : {}),
      },
    });
    return {
      faultId: input.faultId,
      severity: (text(after.values.severity) as (typeof SEVERITIES)[number] | null) ?? null,
      description: text(after.values.description),
    };
  },
});

export const correctOutReason = defineTool({
  description:
    "Correct why an item that is out of service must not be used. Only the tools that take it " +
    "out write the reason, so nobody can change it to 'fine now' while it is out; a manager " +
    "(equipment:manage) corrects it here. To put the item back, use putBack. The assistant, an " +
    "MCP client or an automation may ask, and it waits for a person to approve it.",
  input: z.object({ itemId: ids, reason }),
  output: z.object({ itemId: z.string(), outReason: z.string().nullable() }),
  risk: "write",
  permission: MANAGE,
  personApproves: true,
  async handler(input, ctx) {
    const now = await readItem(ctx, input.itemId);
    const state = text(now.values.state) ?? "";
    if (state !== "out_of_service") {
      throw new OpsCallError(
        "conflict",
        `The item is ${STATE_WORDS[state] ?? state}, not out of service`,
        { reason: "not_out_of_service", state },
      );
    }
    const after = await ctx.ops.call<HostRecord>("record.update", {
      object: ITEM,
      id: input.itemId,
      // Only while it is still out of service (ADR 0865): a put-back landing first wins.
      while: "out_of_service",
      values: { outReason: input.reason },
    });
    return { itemId: input.itemId, outReason: text(after.values.outReason) };
  },
});
