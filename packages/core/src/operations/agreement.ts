// Agreement documents (stage 44 step 1, ADRs 0610 and 0611): a business's terms, waiver, health
// questions and a parent's consent, written as a working copy and published as versions nobody can
// change.
//
//   agreement.list / get / version.get / points / publishPreview   staff (records:read): read
//   agreement.create, agreement.draft.save   staff (agreements:manage): the working copy; the
//                                            assistant may write it, through the gate as any write
//   agreement.publish, attach, detach        staff (agreements:manage), a person only
//   agreement.retire                         staff (agreements:manage), a person only, destructive
//   agreement.takeEffect                     the minute cron (system origin only)
//
// Publishing, attaching, detaching and retiring are `actors: ["human"]`: the assistant, MCP clients
// (Code Mode included), automations and extension code are refused before the gate is asked, so
// nothing of them is ever queued (decision 12: an AI drafts, never publishes). Every one of them,
// and every version the cron makes current, bumps core_agreement_rev in its own batch. Staff
// audience only: nothing here is open to customers or the public.
import { sql } from "kysely";
import { z } from "zod";
import {
  AGREEMENT_CHANGES,
  AGREEMENT_FOR,
  AGREEMENT_HOW,
  AGREEMENT_KINDS,
  AGREEMENT_WHO,
  agreementPoints,
  bodyHasText,
  bodySchema,
  bumpRev,
  inEffect,
  type Question,
  questionsSchema,
  shownHash,
  tickLabelSchema,
  titleSchema,
  type VersionTiming,
} from "../agreements/documents.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const documentId = z.string().min(1).max(64).describe("The document's id (agd_…)");

const versionRef = z
  .object({ id: z.string(), number: z.number(), effectiveFrom: z.string() })
  .nullable();

const documentSummary = z.object({
  id: z.string(),
  kind: z.enum(AGREEMENT_KINDS),
  state: z.enum(["draft", "live", "retired"]),
  title: z.string().describe("The current version's title, or the working copy's before one"),
  current: versionRef.describe("The version in effect now"),
  scheduled: versionRef.describe("A published version that takes effect later"),
  agreeFrom: z.number().describe("Acceptances of versions numbered below this stop counting"),
  points: z.array(z.string()).describe("The agreement points it is attached to"),
  draftUpdatedAt: z.string(),
  retiredAt: z.string().nullable(),
});

const draftSchema = z.object({
  title: z.string(),
  body: z.unknown().nullable(),
  tickLabel: z.string().nullable(),
  questions: z
    .array(z.object({ key: z.string(), text: z.string(), noteOnYes: z.boolean() }))
    .nullable(),
  how: z.enum(AGREEMENT_HOW),
  who: z.enum(AGREEMENT_WHO),
  forWhom: z.enum(AGREEMENT_FOR),
  askAgainMonths: z.number().nullable(),
  rev: z.number(),
  updatedAt: z.string(),
  updatedBy: z.string(),
  hash: z.string().describe("Hash of what a person would be shown; publish names it"),
});

const versionSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.unknown(),
  tickLabel: z.string(),
  questions: draftSchema.shape.questions,
  how: z.enum(AGREEMENT_HOW),
  who: z.enum(AGREEMENT_WHO),
  forWhom: z.enum(AGREEMENT_FOR),
  askAgainMonths: z.number().nullable(),
  change: z.enum(AGREEMENT_CHANGES),
  effectiveFrom: z.string(),
  publishedAt: z.string(),
  publishedBy: z.string(),
  hash: z.string(),
});

type DocumentRow = {
  id: string;
  kind: (typeof AGREEMENT_KINDS)[number];
  state: "draft" | "live" | "retired";
  draft_title: string;
  draft_body: string | null;
  draft_tick_label: string | null;
  draft_questions: string | null;
  draft_how: (typeof AGREEMENT_HOW)[number];
  draft_who: (typeof AGREEMENT_WHO)[number];
  draft_for: (typeof AGREEMENT_FOR)[number];
  draft_ask_again_months: number | null;
  draft_rev: number;
  draft_updated_at: string;
  draft_updated_by: string;
  current_version_id: string | null;
  agree_from: number;
  created_at: string;
  created_by: string;
  retired_at: string | null;
  retired_by: string | null;
};

type VersionRow = {
  id: string;
  document_id: string;
  number: number;
  title: string;
  body: string;
  tick_label: string;
  questions: string | null;
  how: (typeof AGREEMENT_HOW)[number];
  who: (typeof AGREEMENT_WHO)[number];
  for_whom: (typeof AGREEMENT_FOR)[number];
  ask_again_months: number | null;
  change: (typeof AGREEMENT_CHANGES)[number];
  effective_from: string;
  published_at: string;
  published_by: string;
  draft_rev: number;
  hash: string;
};

const parse = <T>(json: string | null): T | null =>
  json === null ? null : (JSON.parse(json) as T);

async function loadDocument(ctx: HandlerContext, id: string): Promise<DocumentRow> {
  const row = await ctx.db
    .selectFrom("core_agreement_document")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("agreement document", id);
  return row as DocumentRow;
}

async function versionsOf(ctx: HandlerContext, id: string): Promise<VersionRow[]> {
  return (await ctx.db
    .selectFrom("core_agreement_version")
    .selectAll()
    .where("document_id", "=", id)
    .orderBy("number")
    .execute()) as VersionRow[];
}

async function pointsOf(ctx: HandlerContext, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const rows = await ctx.db
    .selectFrom("core_agreement_point")
    .select(["document_id", "point"])
    .where("document_id", "in", ids)
    .orderBy("point")
    .execute();
  for (const row of rows)
    out.set(row.document_id, [...(out.get(row.document_id) ?? []), row.point]);
  return out;
}

const ref = (v: VersionRow | undefined) =>
  v ? { id: v.id, number: v.number, effectiveFrom: v.effective_from } : null;

function summarise(
  doc: DocumentRow,
  versions: VersionRow[],
  points: string[],
  now: string,
): z.infer<typeof documentSummary> {
  const current = versions.find((v) => v.id === doc.current_version_id);
  const scheduled = versions.filter((v) => v.effective_from > now).at(-1);
  return {
    id: doc.id,
    kind: doc.kind,
    state: doc.state,
    title: current?.title ?? doc.draft_title,
    current: ref(current),
    scheduled: ref(scheduled),
    agreeFrom: doc.agree_from,
    points,
    draftUpdatedAt: doc.draft_updated_at,
    retiredAt: doc.retired_at,
  };
}

async function draftOf(doc: DocumentRow): Promise<z.infer<typeof draftSchema>> {
  const body = parse<unknown>(doc.draft_body);
  const questions = parse<Question[]>(doc.draft_questions);
  return {
    title: doc.draft_title,
    body,
    tickLabel: doc.draft_tick_label,
    questions,
    how: doc.draft_how,
    who: doc.draft_who,
    forWhom: doc.draft_for,
    askAgainMonths: doc.draft_ask_again_months,
    rev: doc.draft_rev,
    updatedAt: doc.draft_updated_at,
    updatedBy: doc.draft_updated_by,
    hash: await shownHash({
      title: doc.draft_title,
      body,
      tickLabel: doc.draft_tick_label,
      questions,
    }),
  };
}

function toVersion(v: VersionRow): z.infer<typeof versionSchema> {
  return {
    id: v.id,
    documentId: v.document_id,
    number: v.number,
    title: v.title,
    body: JSON.parse(v.body),
    tickLabel: v.tick_label,
    questions: parse<Question[]>(v.questions),
    how: v.how,
    who: v.who,
    forWhom: v.for_whom,
    askAgainMonths: v.ask_again_months,
    change: v.change,
    effectiveFrom: v.effective_from,
    publishedAt: v.published_at,
    publishedBy: v.published_by,
    hash: v.hash,
  };
}

/** Why the working copy cannot be published as it stands (empty when it can). */
function publishProblems(doc: DocumentRow): string[] {
  const problems: string[] = [];
  if (doc.state === "retired") problems.push("The document is retired");
  if (!bodyHasText(parse(doc.draft_body))) problems.push("The body has no text");
  if (!doc.draft_tick_label) problems.push("The tick label (the words beside the box) is empty");
  if (doc.kind === "health" && !doc.draft_questions) problems.push("A health form needs questions");
  return problems;
}

function refuseRetired(doc: DocumentRow): void {
  if (doc.state === "retired") {
    throw new ConflictError("This document is retired: it cannot change.", {
      rule: "agreement_retired",
    });
  }
}

export const agreementList = defineOperation({
  name: "agreement.list",
  description:
    "List the business's agreement documents (terms, waivers, health forms, a parent's consent): " +
    "each with its kind, state (draft, live or retired), the version in effect now and any " +
    "scheduled one, and the agreement points it is attached to. Titles and the business's own " +
    "text only: nothing here names a member. Read-only.",
  input: z.object({ retired: z.boolean().default(false).describe("Include retired documents") }),
  output: z.object({ items: z.array(documentSummary) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = ctx.db.selectFrom("core_agreement_document").selectAll();
    if (!input.retired) query = query.where("state", "!=", "retired");
    const docs = (await query.orderBy("created_at").limit(500).execute()) as DocumentRow[];
    const ids = docs.map((d) => d.id);
    const versions = ids.length
      ? ((await ctx.db
          .selectFrom("core_agreement_version")
          .selectAll()
          .where("document_id", "in", ids)
          .orderBy("number")
          .execute()) as VersionRow[])
      : [];
    const points = await pointsOf(ctx, ids);
    return {
      items: docs.map((doc) =>
        summarise(
          doc,
          versions.filter((v) => v.document_id === doc.id),
          points.get(doc.id) ?? [],
          ctx.now,
        ),
      ),
    };
  },
});

export const agreementGet = defineOperation({
  name: "agreement.get",
  description:
    "One agreement document: its summary, the working copy (the draft the editor changes, with " +
    "its hash) and its versions, newest first, without their bodies (agreement.version.get reads " +
    "one). Read-only.",
  input: z.object({ id: documentId }),
  output: documentSummary.extend({
    draft: draftSchema,
    versions: z.array(versionSchema.omit({ body: true, questions: true })),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const doc = await loadDocument(ctx, input.id);
    const versions = await versionsOf(ctx, doc.id);
    const points = (await pointsOf(ctx, [doc.id])).get(doc.id) ?? [];
    return {
      ...summarise(doc, versions, points, ctx.now),
      draft: await draftOf(doc),
      versions: versions
        .map((v) => {
          const { body: _body, questions: _questions, ...rest } = toVersion(v);
          return rest;
        })
        .reverse(),
    };
  },
});

export const agreementVersionGet = defineOperation({
  name: "agreement.version.get",
  description:
    "One published version of an agreement document, exactly as people are shown it: title, " +
    "body, tick label, questions, how a person agrees, and when it took or takes effect. A " +
    "version never changes. Read-only.",
  input: z.object({ id: z.string().min(1).max(64).describe("The version's id (agv_…)") }),
  output: versionSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_agreement_version")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError("agreement version", input.id);
    return toVersion(row as VersionRow);
  },
});

export const agreementPointsList = defineOperation({
  name: "agreement.points",
  description:
    "The agreement points installed packs declare (buying a membership, making a booking): the " +
    "places a business may attach its documents, each with its label, the kinds of document it " +
    "suggests and the objects that declare it. Read-only.",
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({
        point: z.string(),
        label: z.string(),
        suggests: z.array(z.string()),
        objects: z.array(z.string()),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler() {
    return { items: agreementPoints() };
  },
});

export const agreementCreate = defineOperation({
  name: "agreement.create",
  description:
    "Start a new agreement document as a draft: its title and kind (terms, waiver, health for a " +
    "health questions form, guardian for a parent's consent, other). The kind never changes. Its " +
    "working copy is then written with agreement.draft.save; nothing is asked of anyone until a " +
    "person publishes it and attaches it to an agreement point. The platform ships no wording: " +
    "the business writes its own.",
  input: z.object({ title: titleSchema, kind: z.enum(AGREEMENT_KINDS) }),
  output: z.object({ id: z.string() }),
  permission: "agreements:manage",
  risk: "write",
  async handler(input, ctx) {
    const id = newId("agreementDocument");
    ctx.write(
      ctx.db.insertInto("core_agreement_document").values({
        id,
        kind: input.kind,
        draft_title: input.title,
        draft_updated_at: ctx.now,
        draft_updated_by: ctx.user.id,
        created_at: ctx.now,
        created_by: ctx.user.id,
      }),
    );
    return { id };
  },
});

export const agreementDraftSave = defineOperation({
  name: "agreement.draft.save",
  description:
    "Write an agreement document's working copy: any of its title, body (rich text), tick label " +
    "(the words beside the box), how a person agrees (typed name, or a drawn signature), who " +
    "agrees (the participant or the payer), for whom (everyone, or only a dependant), and for a " +
    "health form its questions and after how many months it is asked again. Only what is given " +
    "changes. It changes no published version and nothing anyone is asked: a person publishes. " +
    "The assistant may write it for someone who holds agreements:manage.",
  input: z.object({
    id: documentId,
    title: titleSchema.optional(),
    body: bodySchema.optional(),
    tickLabel: tickLabelSchema.nullable().optional(),
    how: z.enum(AGREEMENT_HOW).optional(),
    who: z.enum(AGREEMENT_WHO).optional(),
    forWhom: z.enum(AGREEMENT_FOR).optional(),
    questions: questionsSchema.nullable().optional().describe("A health form's questions only"),
    askAgainMonths: z.number().int().min(1).max(120).nullable().optional(),
  }),
  output: draftSchema,
  permission: "agreements:manage",
  risk: "write",
  async handler(input, ctx) {
    const doc = await loadDocument(ctx, input.id);
    refuseRetired(doc);
    if (doc.kind !== "health" && (input.questions || input.askAgainMonths)) {
      throw new ValidationError("Only a health form has questions and asks again", {
        rule: "agreement_questions",
      });
    }
    const next: DocumentRow = {
      ...doc,
      ...(input.title !== undefined ? { draft_title: input.title } : {}),
      ...(input.body !== undefined ? { draft_body: JSON.stringify(input.body) } : {}),
      ...(input.tickLabel !== undefined ? { draft_tick_label: input.tickLabel } : {}),
      ...(input.how ? { draft_how: input.how } : {}),
      ...(input.who ? { draft_who: input.who } : {}),
      ...(input.forWhom ? { draft_for: input.forWhom } : {}),
      ...(input.questions !== undefined
        ? { draft_questions: input.questions ? JSON.stringify(input.questions) : null }
        : {}),
      ...(input.askAgainMonths !== undefined
        ? { draft_ask_again_months: input.askAgainMonths }
        : {}),
      draft_rev: doc.draft_rev + 1,
      draft_updated_at: ctx.now,
      draft_updated_by: ctx.user.id,
    };
    ctx.write(
      ctx.db
        .updateTable("core_agreement_document")
        .set({
          draft_title: next.draft_title,
          draft_body: next.draft_body,
          draft_tick_label: next.draft_tick_label,
          draft_how: next.draft_how,
          draft_who: next.draft_who,
          draft_for: next.draft_for,
          draft_questions: next.draft_questions,
          draft_ask_again_months: next.draft_ask_again_months,
          draft_rev: next.draft_rev,
          draft_updated_at: ctx.now,
          draft_updated_by: ctx.user.id,
        })
        .where("id", "=", doc.id),
    );
    return draftOf(next);
  },
});

export const agreementPublishPreview = defineOperation({
  name: "agreement.publishPreview",
  description:
    "What publishing an agreement document's working copy would make: the version number, " +
    "whether it is the first, what changed against the newest version (title, body, tick label, " +
    "questions, how, who, for whom), the working copy's hash to pass to agreement.publish, and " +
    "why it cannot be published yet if it cannot. Read-only.",
  input: z.object({ id: documentId }),
  output: z.object({
    number: z.number(),
    first: z.boolean(),
    changed: z.array(z.string()),
    draftHash: z.string(),
    latest: versionSchema.nullable(),
    problems: z.array(z.string()),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const doc = await loadDocument(ctx, input.id);
    const draft = await draftOf(doc);
    const latestRow = (await versionsOf(ctx, doc.id)).at(-1);
    const latest = latestRow ? toVersion(latestRow) : null;
    const changed: string[] = [];
    if (latest) {
      const pairs: [string, unknown, unknown][] = [
        ["title", draft.title, latest.title],
        ["body", draft.body, latest.body],
        ["tickLabel", draft.tickLabel, latest.tickLabel],
        ["questions", draft.questions, latest.questions],
        ["how", draft.how, latest.how],
        ["who", draft.who, latest.who],
        ["forWhom", draft.forWhom, latest.forWhom],
        ["askAgainMonths", draft.askAgainMonths, latest.askAgainMonths],
      ];
      for (const [name, a, b] of pairs) {
        if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changed.push(name);
      }
    }
    return {
      number: (latest?.number ?? 0) + 1,
      first: !latest,
      changed,
      draftHash: draft.hash,
      latest,
      problems: publishProblems(doc),
    };
  },
});

export const agreementPublish = defineOperation({
  name: "agreement.publish",
  description:
    "Publish an agreement document's working copy as its next version, which nobody can change " +
    "afterwards. change: small (earlier acceptances still count) or agree_again (everyone must " +
    "agree to this version before their next booking or purchase); a first version is first. " +
    "effectiveFrom (left out: now) schedules it; it cannot be in the past or before the newest " +
    "version's, and a published version cannot be withdrawn. draftHash is the working copy's hash " +
    "the person reviewed (agreement.publishPreview): a copy changed since is refused. Only a " +
    "person on the staff with agreements:manage can do this: never the assistant, an MCP client " +
    "or code. Audited.",
  input: z.object({
    documentId,
    change: z.enum(["small", "agree_again"]),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    draftHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  output: z.object({ document: documentSummary, version: versionSchema }),
  permission: "agreements:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output) => ({
    documentId: output.document.id,
    versionId: output.version.id,
    number: output.version.number,
    change: output.version.change,
  }),
  async handler(input, ctx) {
    // Belt and braces: the pipeline refused every other actor before the gate (`actors`).
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person publishes a document");
    const doc = await loadDocument(ctx, input.documentId);
    refuseRetired(doc);
    const draft = await draftOf(doc);
    if (draft.hash !== input.draftHash) {
      throw new ConflictError(
        "The working copy changed since you reviewed it. Look at it again before publishing.",
        { rule: "agreement_draft_changed" },
      );
    }
    const problems = publishProblems(doc);
    if (problems.length) {
      throw new ValidationError(`This document cannot be published yet: ${problems.join("; ")}`, {
        rule: "agreement_incomplete",
        problems,
      });
    }
    const versions = await versionsOf(ctx, doc.id);
    const latest = versions.at(-1);
    const effectiveFrom = input.effectiveFrom
      ? new Date(input.effectiveFrom).toISOString()
      : ctx.now;
    if (effectiveFrom < ctx.now) {
      throw new ValidationError("A version cannot take effect in the past", {
        rule: "agreement_effective_past",
      });
    }
    if (latest && effectiveFrom < latest.effective_from) {
      throw new ValidationError(
        `Version ${latest.number} takes effect at ${latest.effective_from}: a newer one cannot take effect before it`,
        { rule: "agreement_effective_order" },
      );
    }
    const number = (latest?.number ?? 0) + 1;
    const row: VersionRow = {
      id: newId("agreementVersion"),
      document_id: doc.id,
      number,
      title: draft.title,
      body: JSON.stringify(draft.body),
      tick_label: draft.tickLabel ?? "",
      questions: doc.kind === "health" ? doc.draft_questions : null,
      how: draft.how,
      who: draft.who,
      for_whom: draft.forWhom,
      ask_again_months: doc.kind === "health" ? draft.askAgainMonths : null,
      change: latest ? input.change : "first",
      effective_from: effectiveFrom,
      published_at: ctx.now,
      published_by: ctx.user.id,
      draft_rev: doc.draft_rev,
      hash: draft.hash,
    };
    // The trigger refuses the row unless the working copy is still the one read (draft_rev).
    ctx.write(ctx.db.insertInto("core_agreement_version").values(row));
    const timing: VersionTiming[] = [...versions, row];
    const effect = inEffect(timing, ctx.now);
    const next: DocumentRow = {
      ...doc,
      state: "live",
      current_version_id: effect.currentId,
      agree_from: effect.agreeFrom,
    };
    ctx.write(
      ctx.db
        .updateTable("core_agreement_document")
        .set({
          state: "live",
          current_version_id: effect.currentId,
          agree_from: effect.agreeFrom,
        })
        .where("id", "=", doc.id),
      bumpRev(ctx.db),
    );
    const points = (await pointsOf(ctx, [doc.id])).get(doc.id) ?? [];
    return {
      document: summarise(next, [...versions, row], points, ctx.now),
      version: toVersion(row),
    };
  },
});

const pointsInput = z.object({
  documentId,
  points: z.array(z.string().min(1).max(40)).min(1).max(20),
});

export const agreementAttach = defineOperation({
  name: "agreement.attach",
  description:
    "Attach a published agreement document to agreement points (agreement.points lists them), " +
    "so it is needed there: from step 3 of stage 44, nobody buys or books there without a current " +
    "acceptance of it. Nothing already bought or booked is touched. Only a person on the staff " +
    "with agreements:manage can do this. Audited.",
  input: pointsInput,
  output: documentSummary,
  permission: "agreements:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const doc = await loadDocument(ctx, input.documentId);
    refuseRetired(doc);
    if (doc.state !== "live") {
      throw new ConflictError("Publish the document before attaching it.", {
        rule: "agreement_not_live",
      });
    }
    const declared = new Set(agreementPoints().map((p) => p.point));
    const unknown = input.points.filter((p) => !declared.has(p));
    if (unknown.length) {
      throw new ValidationError(`No installed pack declares the point ${unknown.join(", ")}`, {
        rule: "agreement_point",
        points: unknown,
      });
    }
    const had = (await pointsOf(ctx, [doc.id])).get(doc.id) ?? [];
    const adding = [...new Set(input.points)].filter((p) => !had.includes(p));
    if (!adding.length) {
      throw new ConflictError("It is already attached there.", { rule: "agreement_attached" });
    }
    for (const point of adding) {
      ctx.write(
        ctx.db.insertInto("core_agreement_point").values({
          document_id: doc.id,
          point,
          attached_at: ctx.now,
          attached_by: ctx.user.id,
        }),
      );
    }
    ctx.write(bumpRev(ctx.db));
    return summarise(doc, await versionsOf(ctx, doc.id), [...had, ...adding].sort(), ctx.now);
  },
});

export const agreementDetach = defineOperation({
  name: "agreement.detach",
  description:
    "Detach an agreement document from agreement points: it is no longer needed there. " +
    "Acceptances people made are kept. Only a person on the staff with agreements:manage can do " +
    "this. Audited.",
  input: pointsInput,
  output: documentSummary,
  permission: "agreements:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const doc = await loadDocument(ctx, input.documentId);
    refuseRetired(doc);
    const had = (await pointsOf(ctx, [doc.id])).get(doc.id) ?? [];
    const missing = input.points.filter((p) => !had.includes(p));
    if (missing.length) {
      throw new ValidationError(`It is not attached to ${missing.join(", ")}`, {
        rule: "agreement_point",
        points: missing,
      });
    }
    ctx.write(
      ctx.db
        .deleteFrom("core_agreement_point")
        .where("document_id", "=", doc.id)
        .where("point", "in", input.points),
      bumpRev(ctx.db),
    );
    const left = had.filter((p) => !input.points.includes(p));
    return summarise(doc, await versionsOf(ctx, doc.id), left, ctx.now);
  },
});

export const agreementRetire = defineOperation({
  name: "agreement.retire",
  description:
    "Retire an agreement document: it is detached everywhere and needed nowhere, its working " +
    "copy is frozen, and it cannot be published again (write a new document instead). Its " +
    "versions and the acceptances people made are kept for good. Only a person on the staff " +
    "with agreements:manage can do this. Audited.",
  input: z.object({ documentId }),
  output: documentSummary,
  permission: "agreements:manage",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const doc = await loadDocument(ctx, input.documentId);
    refuseRetired(doc);
    ctx.write(
      ctx.db.deleteFrom("core_agreement_point").where("document_id", "=", doc.id),
      ctx.db
        .updateTable("core_agreement_document")
        .set({ state: "retired", retired_at: ctx.now, retired_by: ctx.user.id })
        .where("id", "=", doc.id),
      bumpRev(ctx.db),
    );
    return summarise(
      { ...doc, state: "retired", retired_at: ctx.now, retired_by: ctx.user.id },
      await versionsOf(ctx, doc.id),
      [],
      ctx.now,
    );
  },
});

export const agreementTakeEffect = defineOperation({
  name: "agreement.takeEffect",
  description:
    "Platform use only: make current the scheduled agreement versions whose time has come (the " +
    "minute cron), as a person published them. No input names a document or a version.",
  input: z.object({}),
  output: z.object({ documents: z.array(z.string()) }),
  permission: "agreements:manage",
  risk: "write",
  actors: ["automation"],
  hostStep: true,
  mcp: { expose: false },
  auditSummary: (output) => ({ count: output.documents.length }),
  async handler(_input, ctx) {
    if (ctx.origin.surface !== "system") {
      throw new ForbiddenError("Only the host's own cron makes scheduled versions current");
    }
    // Live documents with a version that has taken effect and is newer than the current one.
    const due = (
      await sql<DocumentRow>`
        SELECT d.* FROM core_agreement_document d
        WHERE d.state = 'live' AND EXISTS (
          SELECT 1 FROM core_agreement_version v
          WHERE v.document_id = d.id AND v.effective_from <= ${ctx.now}
            AND v.number > COALESCE(
              (SELECT c.number FROM core_agreement_version c WHERE c.id = d.current_version_id), 0)
        )
        LIMIT 50`.execute(ctx.db)
    ).rows;
    for (const doc of due) {
      const effect = inEffect(await versionsOf(ctx, doc.id), ctx.now);
      let update = ctx.db
        .updateTable("core_agreement_document")
        .set({ current_version_id: effect.currentId, agree_from: effect.agreeFrom })
        .where("id", "=", doc.id);
      update =
        doc.current_version_id === null
          ? update.where("current_version_id", "is", null)
          : update.where("current_version_id", "=", doc.current_version_id);
      ctx.write(update);
    }
    if (due.length) ctx.write(bumpRev(ctx.db));
    return { documents: due.map((d) => d.id) };
  },
});

export const agreementOperations = [
  agreementList,
  agreementGet,
  agreementVersionGet,
  agreementPointsList,
  agreementCreate,
  agreementDraftSave,
  agreementPublishPreview,
  agreementPublish,
  agreementAttach,
  agreementDetach,
  agreementRetire,
  agreementTakeEffect,
] as const;
