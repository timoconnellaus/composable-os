// Checklists' operations (stage 45 step 4b, ADR 0650).
//
// **Templates** are the business's own words, not personal: every staff account reads them
// (`checklist.list`, `checklist.get`); a person holding `checklists:write` (admins, and anyone an
// admin grants it) writes them in Settings → Checklists (`checklist.save`). An AI acting for such a
// person may draft one, and its write always waits for a person who holds it too (`alwaysReview`
// for the assistant and MCP, and the approver's permission checked at approval): what staff are
// asked to do never changes on an AI's word alone.
//
// **Runs and ticks** are tool-only, as the roster's operations are (ADR 0621): called from a
// shipped pack's tool run (Rostering's), for the staff account the pipeline verified as the tool's
// caller (`ctx.extension.tool.calledBy`, ADR 0625), never anything in the input. Each is a
// person's own, at the screen: the calling tool is `humanOnly` and the caller a person, so no
// assistant, MCP client or automation reads how a checklist went or ticks it (a tick says a person
// did the step). The run's person ticks their own; someone who rosters may tick for them, with
// why, recorded as theirs for that person; nobody else reads or ticks it, and to anyone else a run
// is not there. What someone writes on a step, why it was not done and why it was ticked for
// someone never reaches the audit log, a notice, an error or a stored reply: the inputs are
// redacted and the writes answer without them.

import type { CrmDb } from "@composable-os/db";
import { sql } from "kysely";
import { z } from "zod";
import {
  declaredOf,
  GRACE_SECONDS,
  inWindow,
  MAX_STEPS,
  makeRunStatement,
  type RecordFacts,
  recordFacts,
  stepsOf,
  templateCopies,
  usable,
} from "../checklists/index.ts";
import {
  checklistDue,
  checklistWorkDue,
  type RunRow,
  type RunView,
  runOf,
  runViews,
} from "../checklists/runs.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnknownOperationError,
  ValidationError,
} from "../errors.ts";
import type { GateFloor } from "../gate.ts";
import { newId } from "../ids.ts";
import { invoke } from "../invoke.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { loadGeneralSettings } from "../settings.ts";
import { isRosterer, toolCaller } from "../staffing/rosterers.ts";
import { titles } from "../staffing/week.ts";
import { addLocalDays, parseLocalDate, wallClockToInstant } from "../time/local.ts";
import { SYSTEM_USER } from "../users.ts";
import { assertShippedToolRun } from "./staffing.ts";

// --- Templates ------------------------------------------------------------------------------------

const stepInput = z.object({
  text: z.string().trim().min(1).max(300).describe("What to do, in a line"),
  required: z.boolean().default(true).describe("Must be ticked (done or not done with why)"),
  note: z.boolean().default(false).describe("Asks for a note: ticking it done needs one"),
});

const templateShape = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string().nullable(),
  active: z.boolean(),
  version: z.number().int(),
  steps: z.array(z.object({ text: z.string(), required: z.boolean(), note: z.boolean() })),
  updatedAt: z.string(),
  updatedBy: z.string(),
});

export const checklistList = defineOperation({
  name: "checklist.list",
  description:
    "The business's checklists (templates of steps staff tick off on a duty: a close-down " +
    "clean, opening up), each with its purpose, whether it is in use (`active`: only an active " +
    "one can be picked), its version and how many steps it has. Not how any shift's checklist " +
    "went. Read-only.",
  input: z.object({
    active: z.boolean().optional().describe("Only active ones (true) or inactive ones (false)"),
  }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        purpose: z.string().nullable(),
        active: z.boolean(),
        version: z.number().int(),
        steps: z.number().int(),
        updatedAt: z.string(),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  async handler(input, ctx) {
    let q = ctx.db
      .selectFrom("core_checklist as c")
      .select([
        "c.id",
        "c.name",
        "c.purpose",
        "c.active",
        "c.version",
        "c.updated_at",
        sql<number>`(SELECT count(*) FROM core_checklist_step s WHERE s.checklist_id = c.id)`.as(
          "steps",
        ),
      ])
      .orderBy("c.active", "desc")
      .orderBy("c.name")
      .limit(500);
    if (input.active !== undefined) q = q.where("c.active", "=", input.active ? 1 : 0);
    const rows = await q.execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        purpose: r.purpose,
        active: r.active === 1,
        version: r.version,
        steps: Number(r.steps),
        updatedAt: r.updated_at,
      })),
    };
  },
});

export const checklistGet = defineOperation({
  name: "checklist.get",
  description:
    "One checklist with its steps in order: each step's text, whether it is required and " +
    "whether it asks for a note. Read-only.",
  input: z.object({ id: z.string().min(1).max(64) }),
  output: templateShape,
  permission: "records:read",
  risk: "read",
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_checklist")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError("checklist", input.id);
    const copy = (await templateCopies(ctx.db, [row.id])).get(row.id);
    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      active: row.active === 1,
      version: row.version,
      steps: copy?.steps ?? [],
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  },
});

export const checklistSave = defineOperation({
  name: "checklist.save",
  description:
    "Write a checklist: a new one (no `id`), or a change to one (its name, purpose, whether it " +
    "is in use, and its steps, given whole and in order; at most 50). Shifts already given a run " +
    "of it keep the steps as they were; later runs copy the new ones. Needs checklists:write. An " +
    "assistant's or MCP client's write always waits for a person who holds it too, so staff " +
    "are only ever asked to follow a checklist a person approved.",
  input: z.object({
    id: z.string().min(1).max(64).optional().describe("The checklist to change; empty: a new one"),
    name: z.string().trim().min(1).max(120),
    purpose: z.string().trim().max(500).nullable().optional(),
    active: z.boolean().default(true),
    steps: z.array(stepInput).min(1).max(MAX_STEPS),
  }),
  output: z.object({ id: z.string(), version: z.number().int(), changed: z.boolean() }),
  permission: "checklists:write",
  risk: "write",
  actors: ["human", "assistant", "mcp"],
  // A draft waits for a person (decision 25): the assistant never changes what staff are asked to
  // do on its own.
  alwaysReview: ["assistant", "mcp"],
  async handler(input, ctx) {
    const steps = input.steps.map((s) => ({ text: s.text, required: s.required, note: s.note }));
    const purpose = input.purpose?.trim() ? input.purpose.trim() : null;
    if (!input.id) {
      const id = newId("checklist");
      ctx.write(
        ctx.db.insertInto("core_checklist").values({
          id,
          name: input.name,
          purpose,
          active: input.active ? 1 : 0,
          version: 1,
          created_by: ctx.user.id,
          created_at: ctx.now,
          updated_by: ctx.user.id,
          updated_at: ctx.now,
        }),
        ...stepWrites(ctx, id, steps),
      );
      ctx.recordChange({
        object: "checklist",
        id,
        action: "create",
        after: { name: input.name, purpose, active: input.active, steps: steps.length },
      });
      return { id, version: 1, changed: true };
    }
    const before = await ctx.db
      .selectFrom("core_checklist")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!before) throw new NotFoundError("checklist", input.id);
    const old = (await templateCopies(ctx.db, [before.id])).get(before.id)?.steps ?? [];
    const stepsChanged = JSON.stringify(old) !== JSON.stringify(steps);
    const changed =
      stepsChanged ||
      before.name !== input.name ||
      before.purpose !== purpose ||
      (before.active === 1) !== input.active;
    if (!changed) return { id: before.id, version: before.version, changed: false };
    // The version follows what a run copies: its name and steps.
    const version =
      stepsChanged || before.name !== input.name ? before.version + 1 : before.version;
    ctx.write(
      // Two saves racing, planned from one version: the second fails whole.
      sql`INSERT INTO core_staff_guard (expected, actual) SELECT 1, count(*) FROM core_checklist WHERE id = ${before.id} AND version = ${before.version} AND updated_at = ${before.updated_at}`.compile(
        ctx.db,
      ),
      ctx.db
        .updateTable("core_checklist")
        .set({
          name: input.name,
          purpose,
          active: input.active ? 1 : 0,
          version,
          updated_by: ctx.user.id,
          updated_at: ctx.now,
        })
        .where("id", "=", before.id),
      ...(stepsChanged
        ? [
            ctx.db.deleteFrom("core_checklist_step").where("checklist_id", "=", before.id),
            ...stepWrites(ctx, before.id, steps),
          ]
        : []),
    );
    ctx.recordChange({
      object: "checklist",
      id: before.id,
      action: "update",
      before: {
        name: before.name,
        purpose: before.purpose,
        active: before.active === 1,
        steps: old.length,
      },
      after: { name: input.name, purpose, active: input.active, steps: steps.length },
    });
    return { id: before.id, version, changed: true };
  },
});

function stepWrites(
  ctx: HandlerContext,
  id: string,
  steps: readonly { text: string; required: boolean; note: boolean }[],
) {
  return steps.map((s, position) =>
    ctx.db.insertInto("core_checklist_step").values({
      checklist_id: id,
      position,
      text: s.text,
      required: s.required ? 1 : 0,
      asks_note: s.note ? 1 : 0,
    }),
  );
}

// --- Who calls a run ------------------------------------------------------------------------------

/**
 * A run's caller: a shipped pack's tool a person calls themselves (never an AI acting for one),
 * for their own account. Answers that account.
 */
async function personAtScreen(ctx: HandlerContext, name: string): Promise<string> {
  await assertShippedToolRun(ctx, name);
  const tool = ctx.extension?.tool;
  if (tool?.humanOnly !== true || tool.calledBy?.actor !== "human") {
    throw new ForbiddenError(
      "A checklist is a person's own: only they (or whoever rosters, for them) read or tick it, never an assistant.",
      { rule: "human_only" },
    );
  }
  return toolCaller(ctx) as string;
}

const recordInput = {
  object: z.string().min(1).max(81).describe("The record's object, e.g. rostering.shift"),
  id: z.string().min(1).max(64),
};

/** A record that declares `checklists`, as it is now; not found when it is not one. */
async function factsFor(ctx: HandlerContext, object: string, id: string): Promise<RecordFacts> {
  const d = declaredOf(object);
  const facts = d ? (await recordFacts(ctx.db, d, [id])).get(id) : undefined;
  if (!facts) throw new NotFoundError(object, id);
  return facts;
}

interface Standing {
  account: string;
  /** The record's person now. */
  isPerson: boolean;
  rosters: boolean;
  /** Whether they may read the run. */
  reads: boolean;
}

/** The caller's standing toward a record's run (one read of who ticked it, one of who rosters). */
async function standing(
  ctx: HandlerContext,
  account: string,
  facts: RecordFacts,
  run: RunRow | null,
): Promise<Standing> {
  const isPerson = facts.account !== null && facts.account === account;
  const rosters = await isRosterer(ctx.db, account);
  let reads = isPerson || rosters || run?.account_id === account;
  if (!reads && run) {
    const ticked = await ctx.db
      .selectFrom("core_checklist_tick")
      .select("run_id")
      .where("run_id", "=", run.id)
      .where((eb) => eb.or([eb("ticked_by", "=", account), eb("ticked_for", "=", account)]))
      .executeTakeFirst();
    reads = ticked !== undefined;
  }
  return { account, isPerson, rosters, reads };
}

/** How a checklist went is not there for anyone else (not even that it was missed). */
const notThere = (object: string, id: string) => new NotFoundError(`checklist of ${object}`, id);

// --- Shapes ---------------------------------------------------------------------------------------

const tickShape = z.object({
  done: z.boolean(),
  why: z.string().nullable(),
  note: z.string().nullable(),
  by: z.string(),
  byName: z.string(),
  for: z.string(),
  forName: z.string(),
  onBehalf: z.boolean().describe("Ticked by someone who rosters for the run's person"),
  onBehalfWhy: z.string().nullable(),
  at: z.string(),
  label: z
    .string()
    .describe('"Ticked by X", or "Ticked by X for Y" for a tick on someone\'s behalf'),
});

const runShape = z.object({
  id: z.string(),
  object: z.string(),
  record: z.string(),
  template: z.object({ id: z.string(), name: z.string(), version: z.number().int() }),
  state: z.enum(["open", "done", "missed", "cancelled"]),
  account: z.string().nullable(),
  name: z.string().nullable(),
  opens: z.string(),
  closes: z.string(),
  tickUntil: z.string(),
  madeAt: z.string(),
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  closedByName: z.string().nullable(),
  closedWhy: z.string().nullable(),
  steps: z.array(
    z.object({
      position: z.number().int(),
      text: z.string(),
      required: z.boolean(),
      asksNote: z.boolean(),
      tick: tickShape.nullable(),
      missed: z.boolean(),
    }),
  ),
  corrections: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      by: z.string(),
      byName: z.string(),
      at: z.string(),
    }),
  ),
});

// --- Reading a record's checklist -----------------------------------------------------------------

export const checklistForRecord = defineOperation({
  name: "checklist.forRecord",
  description:
    "Tool-only (a shipped pack's tool): a shift's checklist and how it is going, for its person " +
    "or someone who rosters: each step, its tick (who ticked it, and for whom), what was missed, " +
    "and corrections. Before its run is made, the checklist's steps as they are now. `canTick` " +
    "says whether the caller may tick it now (its person, or someone who rosters for them, from " +
    "when it opens until 2 hours after it closes). To anyone else it is not there. A person's own " +
    "read, never an assistant's. Read-only.",
  input: z.object(recordInput),
  output: z.object({
    template: z.object({ id: z.string(), name: z.string() }).nullable(),
    run: runShape.nullable(),
    preview: z
      .array(z.object({ text: z.string(), required: z.boolean(), asksNote: z.boolean() }))
      .nullable()
      .describe("The steps as they are now, before the run is made"),
    opens: z.string().nullable(),
    closes: z.string().nullable(),
    tickUntil: z.string().nullable(),
    canTick: z.boolean(),
    /** Ticking is for someone else (the caller rosters and is not the person). */
    onBehalf: z.boolean(),
    forName: z.string().nullable().describe("Whose run it is now"),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const account = await personAtScreen(ctx, "checklist.forRecord");
    const facts = await factsFor(ctx, input.object, input.id);
    const run = await runOf(ctx.db, facts.object, facts.id);
    const s = await standing(ctx, account, facts, run);
    if (!s.reads) throw notThere(input.object, input.id);
    const now = Math.floor(Date.parse(ctx.now) / 1000);
    const template = run
      ? { id: run.checklist_id, name: run.name }
      : facts.template
        ? await (async () => {
            const t = (await templateCopies(ctx.db, [facts.template as string])).get(
              facts.template as string,
            );
            return usable(t) ? t : null;
          })()
        : null;
    const view = run ? ((await runViews(ctx.db, [run]))[0] as RunView) : null;
    const preview =
      !run && template && "steps" in template
        ? template.steps.map((st) => ({ text: st.text, required: st.required, asksNote: st.note }))
        : null;
    const open = run ? run.state === "open" : template !== null;
    const canTick =
      open &&
      facts.live &&
      facts.account !== null &&
      inWindow(facts, now) &&
      (s.isPerson || s.rosters);
    const iso = (n: number | null) => (n === null ? null : new Date(n * 1000).toISOString());
    const names = facts.account
      ? await ctx.db
          .selectFrom("core_user")
          .select(["name", "email"])
          .where("id", "=", facts.account)
          .executeTakeFirst()
      : undefined;
    return {
      template: template ? { id: template.id, name: template.name } : null,
      run: view,
      preview,
      opens: iso(facts.opens),
      closes: iso(facts.closes),
      tickUntil: iso(facts.closes === null ? null : facts.closes + GRACE_SECONDS),
      canTick,
      onBehalf: canTick && !s.isPerson,
      forName: names ? names.name || names.email : null,
    };
  },
});

// --- Ticking --------------------------------------------------------------------------------------

/**
 * What a tick or a done needs: the record live with someone on it, inside its window, a run (made
 * now from its template if the cron has not yet), open, and the caller its person or someone who
 * rosters (who then says why).
 */
async function prepareTick(
  ctx: HandlerContext,
  name: string,
  input: { object: string; id: string; forWhy?: string | undefined },
): Promise<{
  account: string;
  facts: RecordFacts & { account: string };
  run: RunRow | null;
  make: ReturnType<typeof makeRunStatement> | null;
  runId: string;
  steps: ReturnType<typeof stepsOf>;
  onBehalf: boolean;
}> {
  const account = await personAtScreen(ctx, name);
  const facts = await factsFor(ctx, input.object, input.id);
  const run = await runOf(ctx.db, facts.object, facts.id);
  const s = await standing(ctx, account, facts, run);
  if (!s.isPerson && !s.rosters) {
    if (s.reads) {
      throw new ForbiddenError(
        "This checklist is no longer yours to tick: its shift is someone else's now.",
        { rule: "checklist_not_yours" },
      );
    }
    throw notThere(input.object, input.id);
  }
  if (!facts.live) {
    throw new ConflictError(
      "This shift is not on (cancelled or removed), so its checklist is not ticked.",
      {
        rule: "checklist_not_live",
      },
    );
  }
  if (facts.account === null) {
    throw new ConflictError(
      "Nobody is on this shift, so there is nobody to tick its checklist for.",
      {
        rule: "checklist_nobody",
      },
    );
  }
  if (run && run.state !== "open") {
    throw new ConflictError(
      `This checklist is ${run.state === "done" ? "done" : `closed (${run.state})`}, so it does not change.`,
      {
        rule: "checklist_closed",
        state: run.state,
      },
    );
  }
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  if (!inWindow(facts, now)) {
    const early = facts.opens !== null && now < facts.opens;
    throw new ConflictError(
      early
        ? "This checklist opens when the shift starts."
        : "This checklist closed 2 hours after the shift ended.",
      { rule: "checklist_window", opens: facts.opens, closes: facts.closes },
    );
  }
  const onBehalf = !s.isPerson;
  if (onBehalf && !input.forWhy?.trim()) {
    throw new ValidationError(
      "Ticking for someone else needs a reason (it is kept with the tick).",
      { field: "forWhy", rule: "checklist_for_why" },
    );
  }
  let make: ReturnType<typeof makeRunStatement> | null = null;
  let runId = run?.id ?? "";
  let steps = run ? stepsOf(run.steps) : [];
  if (!run) {
    const template = facts.template
      ? (await templateCopies(ctx.db, [facts.template])).get(facts.template)
      : undefined;
    if (!usable(template)) throw notThere(input.object, input.id);
    runId = newId("checklistRun");
    make = makeRunStatement(runId, facts, template, ctx.now);
    steps = template.steps;
  }
  return {
    account,
    facts: facts as RecordFacts & { account: string },
    run,
    make,
    runId,
    steps,
    onBehalf,
  };
}

const PRIVATE_INPUTS = ["note", "why", "forWhy"];

export const checklistTick = defineOperation({
  name: "checklist.tick",
  description:
    "Tool-only (a shipped pack's tool): tick one step of a shift's checklist: done (with a note " +
    "where the step asks for one), not done (with why), or clear a tick. The shift's person ticks " +
    "their own; someone who rosters may tick for them, with why (`forWhy`), kept as ticked by " +
    "them for that person, never as the person's own. From when the shift starts until 2 hours " +
    "after it ends; a checklist marked done never changes. A person's own act, never an " +
    "assistant's.",
  input: z.object({
    ...recordInput,
    step: z
      .number()
      .int()
      .min(0)
      .max(MAX_STEPS - 1)
      .describe("The step's position, from 0"),
    state: z.enum(["done", "not_done", "clear"]),
    note: z.string().trim().max(1000).optional().describe("What was found or done"),
    why: z.string().trim().max(500).optional().describe("Why it was not done"),
    forWhy: z.string().trim().max(500).optional().describe("Ticking for someone else: why"),
  }),
  output: z.object({
    run: z.string(),
    step: z.number().int(),
    state: z.enum(["done", "not_done", "clear"]),
    ticked: z.number().int().describe("Steps ticked now"),
    of: z.number().int(),
  }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  // What someone wrote on a step, why it was not done, why it was ticked for them: private.
  redact: PRIVATE_INPUTS,
  auditSummary: (output) => ({ run: output.run, step: output.step, state: output.state }),
  async handler(input, ctx) {
    const p = await prepareTick(ctx, "checklist.tick", input);
    const step = p.steps[input.step];
    if (!step) {
      throw new ValidationError(`This checklist has ${p.steps.length} steps.`, { field: "step" });
    }
    const note = input.note?.trim() || null;
    const why = input.why?.trim() || null;
    if (input.state === "done" && step.note && !note) {
      throw new ValidationError(`"${step.text}" asks for a note: write what was found or done.`, {
        field: "note",
        rule: "checklist_note_needed",
      });
    }
    if (input.state === "not_done" && !why) {
      throw new ValidationError("Say why it was not done.", {
        field: "why",
        rule: "checklist_why",
      });
    }
    if (p.make) ctx.write(p.make);
    // The record's run, whoever made it: this call a moment ago, or the minute cron meanwhile.
    const runOfRecord = sql<string>`(SELECT id FROM core_checklist_run WHERE object_type = ${p.facts.object} AND record_id = ${p.facts.id})`;
    // Whose run it is now (a shift reassigned is continued by its new person).
    ctx.write(
      ctx.db
        .updateTable("core_checklist_run")
        .set({ account_id: p.facts.account })
        .where("id", "=", runOfRecord)
        .where("state", "=", "open"),
    );
    if (input.state === "clear") {
      ctx.write(
        ctx.db
          .deleteFrom("core_checklist_tick")
          .where("run_id", "=", runOfRecord)
          .where("position", "=", input.step),
      );
    } else {
      const values = {
        done: input.state === "done" ? 1 : 0,
        why: input.state === "done" ? null : why,
        note,
        ticked_by: p.account,
        ticked_for: p.facts.account,
        on_behalf: p.onBehalf ? 1 : 0,
        on_behalf_why: p.onBehalf ? (input.forWhy?.trim() ?? null) : null,
        ticked_at: ctx.now,
      };
      ctx.write(
        ctx.db
          .insertInto("core_checklist_tick")
          .values({ run_id: runOfRecord, position: input.step, ...values })
          .onConflict((oc) => oc.columns(["run_id", "position"]).doUpdateSet(values)),
      );
    }
    const before = p.run
      ? await ctx.db
          .selectFrom("core_checklist_tick")
          .select("position")
          .where("run_id", "=", p.run.id)
          .execute()
      : [];
    const ticked = new Set(before.map((t) => t.position));
    if (input.state === "clear") ticked.delete(input.step);
    else ticked.add(input.step);
    return {
      run: p.runId,
      step: input.step,
      state: input.state,
      ticked: ticked.size,
      of: p.steps.length,
    };
  },
});

export const checklistComplete = defineOperation({
  name: "checklist.complete",
  description:
    "Tool-only (a shipped pack's tool): mark a shift's checklist done, once every required step " +
    "is ticked (done, or not done with why). Done is final: nothing of it changes again, for " +
    "anyone (a correction is a note someone who rosters adds beside it). The shift's person " +
    "marks their own; someone who rosters may for them, with why. A person's own act.",
  input: z.object({
    ...recordInput,
    forWhy: z.string().trim().max(500).optional().describe("Marking it for someone else: why"),
  }),
  output: z.object({ run: z.string(), state: z.literal("done") }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: PRIVATE_INPUTS,
  auditSummary: (output) => output,
  async handler(input, ctx) {
    const p = await prepareTick(ctx, "checklist.complete", input);
    const ticks = p.run
      ? await ctx.db
          .selectFrom("core_checklist_tick")
          .select("position")
          .where("run_id", "=", p.run.id)
          .execute()
      : [];
    const ticked = new Set(ticks.map((t) => t.position));
    const left = p.steps
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s.required && !ticked.has(i));
    if (left.length) {
      throw new ValidationError(
        `Not every required step is ticked: ${left.map(({ s }) => s.text).join("; ")}.`,
        { rule: "checklist_incomplete", steps: left.map(({ i }) => i) },
      );
    }
    if (p.make) ctx.write(p.make);
    ctx.write(
      sql`INSERT INTO core_staff_guard (expected, actual) SELECT 1, count(*) FROM core_checklist_run WHERE id = ${p.runId} AND state = 'open'`.compile(
        ctx.db,
      ),
      ctx.db
        .updateTable("core_checklist_run")
        .set({
          state: "done",
          account_id: p.facts.account,
          closed_at: ctx.now,
          closed_by: p.account,
          closed_why: p.onBehalf ? (input.forWhy?.trim() ?? null) : null,
        })
        .where("id", "=", p.runId)
        .where("state", "=", "open"),
    );
    return { run: p.runId, state: "done" as const };
  },
});

// --- Rosterers -------------------------------------------------------------------------------------

async function assertRostererAtScreen(ctx: HandlerContext, name: string): Promise<string> {
  const account = await personAtScreen(ctx, name);
  if (!(await isRosterer(ctx.db, account))) {
    throw new ForbiddenError("Only someone who rosters reads everyone's checklists.", {
      rule: "rostering",
    });
  }
  return account;
}

export const checklistCorrect = defineOperation({
  name: "checklist.correct",
  description:
    "Tool-only (a shipped pack's tool): add a correction beside a closed checklist run (done, " +
    "missed or cancelled): a note kept with it, never a change to its ticks. Someone who rosters. " +
    "A person's own act.",
  input: z.object({
    run: z.string().min(1).max(64),
    text: z.string().trim().min(1).max(1000),
  }),
  output: z.object({ id: z.string(), run: z.string() }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["text"],
  auditSummary: (output) => output,
  async handler(input, ctx) {
    const account = await assertRostererAtScreen(ctx, "checklist.correct");
    const run = await ctx.db
      .selectFrom("core_checklist_run")
      .select(["id", "state"])
      .where("id", "=", input.run)
      .executeTakeFirst();
    if (!run) throw new NotFoundError("checklist run", input.run);
    if (run.state === "open") {
      throw new ConflictError("This checklist is still open: tick it instead of correcting it.", {
        rule: "checklist_open",
      });
    }
    const id = newId("checklistNote");
    ctx.write(
      ctx.db.insertInto("core_checklist_note").values({
        id,
        run_id: run.id,
        text: input.text,
        written_by: account,
        written_at: ctx.now,
      }),
    );
    return { id, run: run.id };
  },
});

/** The most days one read of the runs covers, and the most runs it gives. */
const RUNS_MAX_DAYS = 62;
const RUNS_MAX = 500;

export const checklistRuns = defineOperation({
  name: "checklist.runs",
  description:
    "Tool-only (a shipped pack's tool): how checklists went, by checklist and date: every run " +
    "opening from `from` to `to` (local dates, both included, at most 62 days), each with its " +
    "shift, its person, whether it is open, done, missed or cancelled, how many steps were " +
    "ticked, which were missed, and how many were ticked for the person by someone else. " +
    "Someone who rosters only; a person's own read. Read-only.",
  input: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    template: z.string().min(1).max(64).optional().describe("Only this checklist's runs"),
  }),
  output: z.object({
    zone: z.string(),
    runs: z.array(
      z.object({
        id: z.string(),
        object: z.string(),
        record: z.string(),
        title: z.string(),
        template: z.object({ id: z.string(), name: z.string() }),
        state: z.enum(["open", "done", "missed", "cancelled"]),
        account: z.string().nullable(),
        name: z.string().nullable(),
        opens: z.string(),
        closes: z.string(),
        steps: z.number().int(),
        ticked: z.number().int(),
        onBehalf: z.number().int().describe("Ticks made for the person by someone who rosters"),
        missed: z.array(z.string()).describe("The steps nobody ticked, when it was missed"),
        corrections: z.number().int(),
      }),
    ),
    truncated: z.boolean(),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertRostererAtScreen(ctx, "checklist.runs");
    const from = parseLocalDate(input.from);
    const to = parseLocalDate(input.to);
    if (!from || !to) throw new ValidationError("Not a date", { field: from ? "to" : "from" });
    if (input.to < input.from) {
      throw new ValidationError("It must end on or after its first date", { field: "to" });
    }
    const days =
      (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
        86_400_000 +
      1;
    if (days > RUNS_MAX_DAYS) {
      throw new ValidationError(`At most ${RUNS_MAX_DAYS} days at a time`, { field: "to" });
    }
    const { timezone } = await loadGeneralSettings(ctx.db);
    const start = wallClockToInstant({ ...from, hour: 0, minute: 0 }, timezone) / 1000;
    const end = wallClockToInstant({ ...addLocalDays(to, 1), hour: 0, minute: 0 }, timezone) / 1000;
    let q = ctx.db
      .selectFrom("core_checklist_run as r")
      .selectAll("r")
      .select([
        sql<number>`(SELECT count(*) FROM core_checklist_tick t WHERE t.run_id = r.id)`.as(
          "ticked",
        ),
        sql<number>`(SELECT count(*) FROM core_checklist_tick t WHERE t.run_id = r.id AND t.on_behalf = 1)`.as(
          "behalf",
        ),
        sql<number>`(SELECT count(*) FROM core_checklist_note n WHERE n.run_id = r.id)`.as("notes"),
      ])
      .where("r.opens", ">=", start)
      .where("r.opens", "<", end)
      .orderBy("r.opens")
      .limit(RUNS_MAX + 1);
    if (input.template) q = q.where("r.checklist_id", "=", input.template);
    const rows = await q.execute();
    const truncated = rows.length > RUNS_MAX;
    if (truncated) rows.length = RUNS_MAX;
    const names = new Map<string, string>();
    const accounts = [...new Set(rows.map((r) => r.account_id).filter((a): a is string => !!a))];
    if (accounts.length) {
      for (const u of await ctx.db
        .selectFrom("core_user")
        .select(["id", "name", "email"])
        .where("id", "in", jsonList(accounts))
        .execute()) {
        names.set(u.id, u.name || u.email);
      }
    }
    const titleOf = new Map<string, string>();
    for (const object of new Set(rows.map((r) => r.object_type))) {
      const t = await titles(
        ctx,
        object,
        rows.filter((r) => r.object_type === object).map((r) => r.record_id),
      );
      for (const [id, title] of t) titleOf.set(`${object}\u0000${id}`, title);
    }
    return {
      zone: timezone,
      truncated,
      runs: rows.map((r) => {
        const steps = stepsOf(r.steps);
        let missed: number[] = [];
        try {
          missed = r.missed_steps ? (JSON.parse(r.missed_steps) as number[]) : [];
        } catch {
          missed = [];
        }
        return {
          id: r.id,
          object: r.object_type,
          record: r.record_id,
          title: titleOf.get(`${r.object_type}\u0000${r.record_id}`) ?? r.name,
          template: { id: r.checklist_id, name: r.name },
          state: r.state,
          account: r.account_id,
          name: r.account_id ? (names.get(r.account_id) ?? "a former staff member") : null,
          opens: new Date(r.opens * 1000).toISOString(),
          closes: new Date(r.closes * 1000).toISOString(),
          steps: steps.length,
          ticked: Number(r.ticked),
          onBehalf: Number(r.behalf),
          missed: missed.map((i) => steps[i]?.text ?? `Step ${i + 1}`),
          corrections: Number(r.notes),
        };
      }),
    };
  },
});

// --- The minute cron ------------------------------------------------------------------------------

export const checklistDueOperation = defineOperation({
  name: "checklist.due",
  description:
    "Platform use only (the minute cron, as the host): makes checklist runs for shifts opening " +
    "within a day, keeps open runs with their shift's person and times, and closes those past " +
    "their close and grace: missed (the rosterers are told) or cancelled. Returns what it did.",
  input: z.object({}),
  output: z.object({
    made: z.number().int(),
    missed: z.number().int(),
    cancelled: z.number().int(),
    moved: z.number().int(),
  }),
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  hostStep: true,
  mcp: { expose: false },
  auditSummary: (output) => output,
  async handler(_input, ctx) {
    if (ctx.origin.surface !== "system") throw new UnknownOperationError("checklist.due");
    return checklistDue(ctx);
  },
});

/** The minute cron's checklist step: one `checklist.due`, as the host, when there is work. */
export async function runChecklistDue(
  db: CrmDb,
  { floor, clock }: { floor?: GateFloor; clock?: () => Date } = {},
): Promise<{ made: number; missed: number; cancelled: number; moved: number }> {
  const now = (clock?.() ?? new Date()).toISOString();
  if (!(await checklistWorkDue(db.query, now)))
    return { made: 0, missed: 0, cancelled: 0, moved: 0 };
  return (await invoke(
    "checklist.due",
    {},
    {
      actor: "automation",
      user: SYSTEM_USER,
      origin: { surface: "system", automationId: "system.checklists" },
      db,
      ...(floor ? { floor } : {}),
      ...(clock ? { clock } : {}),
    },
  )) as { made: number; missed: number; cancelled: number; moved: number };
}

export const checklistOperations = [
  checklistList,
  checklistGet,
  checklistSave,
  checklistForRecord,
  checklistTick,
  checklistComplete,
  checklistCorrect,
  checklistRuns,
  checklistDueOperation,
] as const;
