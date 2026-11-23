// Acceptances (stage 44 step 2, ADRs 0642 and 0643): a person agrees to a published version, for
// themselves or as a guardian for a dependant; staff record a paper form; staff mark a minor;
// staff read a Person's agreements, the acceptances and who still has something due; staff with
// agreements:health read a health form's answers, every read audited.
//
//   me.agreements.due / list / get     a signed-in customer: their own and their live dependants'
//   me.agreements.accept               a signed-in customer, for themselves or a live dependant
//   agreement.person                   staff (records:read): a Person's documents and history
//   agreement.acceptances, due.list    staff (records:read): lists, with no name typed or drawn
//   agreement.healthNotes              staff and pack code a person started: a yes or no per Person
//   agreement.acceptance.get           staff, a person only: one acceptance, typed name and strokes
//   agreement.answers.get              agreements:health, a person only, audited: the answers
//   agreement.recordPaper              agreements:paper, a person only
//   agreement.setMinor                 people:link, a person only
//
// Who may agree for whom is identity, and health answers are health information: no AI actor
// accepts, records paper, sets the mark, or reads a name typed, a signature or an answer, with any
// grant (`actors: ["human"]`, and the customer operations are open to customers only). Every input
// that holds one is redacted in the audit, and errors name rules, never values.
import { sql } from "kysely";
import { z } from "zod";
import { planAcceptance } from "../agreements/accept.ts";
import {
  answersSchema,
  type Signature,
  signatureSchema,
  typedNameSchema,
} from "../agreements/capture.ts";
import { type Question, versionIntact } from "../agreements/documents.ts";
import {
  acceptanceKey,
  acceptancesOf,
  appliesTo,
  attachedDocuments,
  countingAcceptance,
  type DueReason,
  isMinor,
  type PersonFacts,
  personFacts,
} from "../agreements/due.ts";
import { ForbiddenError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { type CustomerPrincipal, holdsPermission } from "../principals.ts";
import { isLiveDependant } from "../visibility/guardians.ts";

const id = (what: string) => z.string().min(1).max(64).describe(what);
const BY = ["self", "guardian", "guest", "paper"] as const;
const HOW = ["typed", "drawn", "paper"] as const;
const CHANNEL = ["web", "app", "paper", "desk"] as const;
const REASONS = ["never", "agree_again", "ask_again", "guardian"] as const;

const questionOut = z.object({ key: z.string(), text: z.string(), noteOnYes: z.boolean() });

/** A version as a person reads it before agreeing. */
const versionOut = z.object({
  id: z.string(),
  documentId: z.string(),
  number: z.number(),
  kind: z.string(),
  title: z.string(),
  body: z.unknown(),
  tickLabel: z.string(),
  questions: z.array(questionOut).nullable(),
  how: z.enum(["typed", "drawn"]),
  effectiveFrom: z.string(),
  hash: z.string(),
});

const acceptanceSummary = z.object({
  id: z.string(),
  documentId: z.string(),
  title: z.string(),
  kind: z.string(),
  versionId: z.string(),
  versionNumber: z.number(),
  personId: z.string().nullable(),
  by: z.enum(BY),
  how: z.enum(HOW),
  channel: z.enum(CHANNEL),
  acceptedAt: z.string(),
  agentPersonId: z.string().nullable().describe("The guardian who agreed for a dependant"),
  recordedBy: z.string().nullable().describe("Paper: the staff user who recorded it"),
  signedOn: z.string().nullable().describe("Paper: the date on the form"),
  counts: z.boolean().describe("Whether it is the acceptance that counts for its document now"),
});
type AcceptanceSummary = z.infer<typeof acceptanceSummary>;

interface AcceptanceRow {
  id: string;
  document_id: string;
  version_id: string;
  person_id: string | null;
  by: (typeof BY)[number];
  how: (typeof HOW)[number];
  channel: (typeof CHANNEL)[number];
  accepted_at: string;
  agent_person_id: string | null;
  recorded_by: string | null;
  signed_on: string | null;
  title: string;
  kind: string;
  number: number;
}

/** Acceptances with their document's kind and their version's title and number. */
function acceptanceRows(ctx: HandlerContext) {
  return ctx.db
    .selectFrom("core_agreement_acceptance as a")
    .innerJoin("core_agreement_version as v", "v.id", "a.version_id")
    .innerJoin("core_agreement_document as d", "d.id", "a.document_id")
    .select([
      "a.id",
      "a.document_id",
      "a.version_id",
      "a.person_id",
      "a.by",
      "a.how",
      "a.channel",
      "a.accepted_at",
      "a.agent_person_id",
      "a.recorded_by",
      "a.signed_on",
      "v.title",
      "v.number",
      "d.kind",
    ]);
}

function summary(row: AcceptanceRow, counting: ReadonlySet<string>): AcceptanceSummary {
  return {
    id: row.id,
    documentId: row.document_id,
    title: row.title,
    kind: row.kind,
    versionId: row.version_id,
    versionNumber: row.number,
    personId: row.person_id,
    by: row.by,
    how: row.how,
    channel: row.channel,
    acceptedAt: row.accepted_at,
    agentPersonId: row.agent_person_id,
    recordedBy: row.recorded_by,
    signedOn: row.signed_on,
    counts: counting.has(row.id),
  };
}

/** A version's content as a person is shown it, checked intact. */
async function versionsById(
  ctx: HandlerContext,
  ids: string[],
): Promise<Map<string, z.infer<typeof versionOut>>> {
  const out = new Map<string, z.infer<typeof versionOut>>();
  if (!ids.length) return out;
  const rows = await ctx.db
    .selectFrom("core_agreement_version as v")
    .innerJoin("core_agreement_document as d", "d.id", "v.document_id")
    .selectAll("v")
    .select("d.kind")
    .where("v.id", "in", [...new Set(ids)])
    .execute();
  for (const v of rows) {
    // A version whose stored text does not match its hash is never shown to agree to.
    if (!(await versionIntact(v, v.kind))) continue;
    out.set(v.id, {
      id: v.id,
      documentId: v.document_id,
      number: v.number,
      kind: v.kind,
      title: v.title,
      body: JSON.parse(v.body),
      tickLabel: v.tick_label,
      questions: v.questions ? (JSON.parse(v.questions) as Question[]) : null,
      how: v.how,
      effectiveFrom: v.effective_from,
      hash: v.hash,
    });
  }
  return out;
}

/** Each document attached anywhere, as it stands for one Person. */
const documentStatus = z.object({
  documentId: z.string(),
  kind: z.string(),
  title: z.string(),
  points: z.array(z.string()),
  versionId: z.string().describe("The version in effect"),
  versionNumber: z.number(),
  status: z.enum(["current", "due"]),
  reason: z.enum(REASONS).nullable().describe("Why it is due: never agreed, agree again, …"),
  acceptanceId: z.string().nullable().describe("The acceptance that counts now"),
  acceptedAt: z.string().nullable(),
});
type DocumentStatus = z.infer<typeof documentStatus>;

/** Where one Person stands on every document attached anywhere (spec 44, the Person tab). */
async function standing(
  ctx: HandlerContext,
  personId: string,
  facts: PersonFacts,
): Promise<{ documents: DocumentStatus[]; counting: Set<string> }> {
  const docs = (await attachedDocuments(ctx.db, null)).filter((d) => appliesTo(d, facts));
  const accepted = await acceptancesOf(
    ctx.db,
    [personId],
    docs.map((d) => d.id),
  );
  const counting = new Set<string>();
  const documents = docs.map((doc) => {
    const { acceptance, reason } = countingAcceptance(
      doc,
      facts,
      accepted.get(acceptanceKey(personId, doc.id)) ?? [],
      ctx.now,
    );
    if (acceptance) counting.add(acceptance.id);
    return {
      documentId: doc.id,
      kind: doc.kind,
      title: doc.title,
      points: doc.points,
      versionId: doc.current.id,
      versionNumber: doc.current.number,
      status: acceptance ? ("current" as const) : ("due" as const),
      reason: acceptance ? null : (reason as DueReason),
      acceptanceId: acceptance?.id ?? null,
      acceptedAt: acceptance?.acceptedAt ?? null,
    };
  });
  return { documents, counting };
}

/** Whose current health acceptance holds a yes (decision 18): a mark, no content. */
async function healthYes(ctx: HandlerContext, personIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!personIds.length) return out;
  const health = (await attachedDocuments(ctx.db, null)).filter((d) => d.kind === "health");
  if (!health.length) return out;
  const accepted = await acceptancesOf(
    ctx.db,
    personIds,
    health.map((d) => d.id),
  );
  const counting: string[] = [];
  for (const personId of personIds) {
    const facts = await personFacts(ctx.db, personId);
    for (const doc of health) {
      const { acceptance } = countingAcceptance(
        doc,
        facts,
        accepted.get(acceptanceKey(personId, doc.id)) ?? [],
        ctx.now,
      );
      if (acceptance) counting.push(acceptance.id);
    }
  }
  if (!counting.length) return out;
  const yes = await ctx.db
    .selectFrom("core_agreement_answer as n")
    .innerJoin("core_agreement_acceptance as a", "a.id", "n.acceptance_id")
    .select("a.person_id")
    .where("n.acceptance_id", "in", counting)
    .where("n.any_yes", "=", 1)
    .execute();
  for (const row of yes) if (row.person_id) out.add(row.person_id);
  return out;
}

async function namesOf(ctx: HandlerContext, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Map();
  const rows = await ctx.db
    .selectFrom("core_person")
    .select(["id", "display_name"])
    .where("id", "in", wanted)
    .execute();
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

async function userNames(ctx: HandlerContext, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Map();
  const rows = await ctx.db
    .selectFrom("core_user")
    .select(["id", "name"])
    .where("id", "in", wanted)
    .execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** A live, out-of-the-Trash Person, or not found. */
async function requirePerson(ctx: HandlerContext, personId: string): Promise<PersonFacts> {
  const facts = await personFacts(ctx.db, personId);
  if (!facts.exists || facts.inTrash) throw new NotFoundError("person", personId);
  return facts;
}

const isPerson = (ctx: HandlerContext) => ctx.actor === "human";

// --- A signed-in customer ------------------------------------------------------------------------

function customerOf(ctx: HandlerContext): CustomerPrincipal {
  if (ctx.principal.kind !== "customer") {
    throw new OperationError("internal", `${ctx.operation} is for a customer's call`);
  }
  return ctx.principal;
}

/** The caller and the live dependants they agree for, with names (the seam's family). */
async function myPeople(ctx: HandlerContext) {
  const me = customerOf(ctx);
  const family = await ctx.records.family();
  return [
    { personId: me.personId, name: family.self?.name ?? "", self: true },
    ...family.dependants.map((d) => ({ personId: d.personId, name: d.name, self: false })),
  ];
}

const dueItem = z.object({
  documentId: z.string(),
  kind: z.string(),
  title: z.string(),
  reason: z.enum(REASONS),
  version: versionOut,
});

export const meAgreementsDue = defineOperation({
  name: "me.agreements.due",
  description:
    "What you, as a signed-in customer, and each child linked to you still have to agree to: each " +
    "due document's version in effect, to read and agree to with me.agreements.accept. " +
    "canAgree is false for someone a parent or guardian agrees for. Read-only.",
  input: z.object({}),
  output: z.object({
    people: z.array(
      z.object({
        personId: z.string(),
        name: z.string(),
        self: z.boolean(),
        canAgree: z.boolean().describe("False when a parent or guardian agrees for them"),
        due: z.array(dueItem),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    const people = await myPeople(ctx);
    const out = [];
    for (const person of people) {
      const facts = await personFacts(ctx.db, person.personId);
      const { documents } = await standing(ctx, person.personId, facts);
      const due = documents.filter((d) => d.status === "due");
      const versions = await versionsById(
        ctx,
        due.map((d) => d.versionId),
      );
      out.push({
        personId: person.personId,
        name: person.name,
        self: person.self,
        canAgree: !(person.self && isMinor(facts)),
        due: due.flatMap((d) => {
          const version = versions.get(d.versionId);
          return version
            ? [
                {
                  documentId: d.documentId,
                  kind: d.kind,
                  title: d.title,
                  reason: d.reason ?? "never",
                  version,
                },
              ]
            : [];
        }),
      });
    }
    return { people: out };
  },
});

export const meAgreementsList = defineOperation({
  name: "me.agreements.list",
  description:
    "Your agreements, as a signed-in customer, and those of each child linked to you: every " +
    "acceptance, newest first, with the document, the version, who agreed and how, and whether " +
    "it is the one that counts now. me.agreements.get reads one. Read-only.",
  input: z.object({}),
  output: z.object({ items: z.array(acceptanceSummary) }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    const people = await myPeople(ctx);
    const counting = new Set<string>();
    for (const person of people) {
      const facts = await personFacts(ctx.db, person.personId);
      for (const id of (await standing(ctx, person.personId, facts)).counting) counting.add(id);
    }
    const rows = (await acceptanceRows(ctx)
      .where(
        "a.person_id",
        "in",
        people.map((p) => p.personId),
      )
      .orderBy("a.accepted_at", "desc")
      .limit(500)
      .execute()) as AcceptanceRow[];
    return { items: rows.map((row) => summary(row, counting)) };
  },
});

const strokesOut = z
  .object({ width: z.number(), height: z.number(), strokes: z.array(z.array(z.array(z.number()))) })
  .nullable();
const answersOut = z.array(
  z.object({ key: z.string(), yes: z.boolean(), note: z.string().optional() }),
);

export const meAgreementsGet = defineOperation({
  name: "me.agreements.get",
  description:
    "One of your acceptances, or a linked child's, as a signed-in customer: the version as you " +
    "were shown it, the name typed, the signature drawn, and a health form's answers. Read-only.",
  input: z.object({ id: id("The acceptance's id (aga_…)") }),
  output: acceptanceSummary.extend({
    version: versionOut,
    typedName: z.string(),
    signature: strokesOut,
    answers: answersOut.nullable(),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const people = new Set((await myPeople(ctx)).map((p) => p.personId));
    const row = (await acceptanceRows(ctx)
      .select(["a.typed_name"])
      .where("a.id", "=", input.id)
      .executeTakeFirst()) as (AcceptanceRow & { typed_name: string }) | undefined;
    // Someone else's is as if it did not exist.
    if (!row?.person_id || !people.has(row.person_id)) {
      throw new NotFoundError("acceptance", input.id);
    }
    const version = (await versionsById(ctx, [row.version_id])).get(row.version_id);
    if (!version) throw new NotFoundError("agreement version", row.version_id);
    const facts = await personFacts(ctx.db, row.person_id);
    const { counting } = await standing(ctx, row.person_id, facts);
    const [signature, answers] = await Promise.all([
      ctx.db
        .selectFrom("core_agreement_signature")
        .select("strokes")
        .where("acceptance_id", "=", row.id)
        .executeTakeFirst(),
      ctx.db
        .selectFrom("core_agreement_answer")
        .select("answers")
        .where("acceptance_id", "=", row.id)
        .executeTakeFirst(),
    ]);
    return {
      ...summary(row, counting),
      version,
      typedName: row.typed_name,
      signature: signature ? (JSON.parse(signature.strokes) as Signature) : null,
      answers: answers ? JSON.parse(answers.answers) : null,
    };
  },
});

export const meAgreementsAccept = defineOperation({
  name: "me.agreements.accept",
  description:
    "Agree to a version of a document, as a signed-in customer: for yourself, or with " +
    "forPersonId for a child linked to you. Give the name you type, a signature for a document " +
    "agreed to by drawing, and every answer for a health form. Recorded for good and never " +
    "changed. Refused for yourself when a parent or guardian agrees for you.",
  input: z
    .object({
      versionId: id("The version's id (agv_…), as me.agreements.due gave it"),
      forPersonId: id("A child linked to you (per_…); left out: yourself").optional(),
      typedName: typedNameSchema,
      signature: signatureSchema.optional(),
      answers: answersSchema.optional(),
    })
    .strict(),
  output: z.object({
    id: z.string(),
    documentId: z.string(),
    versionNumber: z.number(),
    acceptedAt: z.string(),
  }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  // What a person typed, drew and answered never reaches the audit log.
  redact: ["typedName", "signature", "answers"],
  auditSummary: (output) => ({
    acceptanceId: output.id,
    documentId: output.documentId,
    versionNumber: output.versionNumber,
  }),
  async handler(input, ctx) {
    const me = customerOf(ctx);
    const forPerson = input.forPersonId ?? me.personId;
    const guardian = forPerson !== me.personId;
    if (guardian && !(await isLiveDependant(ctx.db, me.personId, forPerson))) {
      throw new NotFoundError("person", forPerson);
    }
    const signIn = await ctx.signIn?.();
    const planned = await planAcceptance(
      ctx.db,
      {
        versionId: input.versionId,
        personId: forPerson,
        by: guardian ? "guardian" : "self",
        agentPersonId: guardian ? me.personId : null,
        accountId: me.customerId,
        email: signIn?.email ?? null,
        // A native app's session is a device session (dvs_…); a cookie's is the website's.
        channel: ctx.origin.sessionId?.startsWith("dvs_") ? "app" : "web",
        typedName: input.typedName,
        signature: input.signature,
        answers: input.answers,
      },
      ctx.now,
    );
    ctx.write(...planned.statements);
    return {
      id: planned.id,
      documentId: planned.documentId,
      versionNumber: planned.versionNumber,
      acceptedAt: ctx.now,
    };
  },
});

// --- Staff -------------------------------------------------------------------------------------

export const agreementPerson = defineOperation({
  name: "agreement.person",
  description:
    "A Person's agreements, as the Person page shows them: each document attached anywhere, " +
    "current or due (and why: never agreed, agree again, asked again, a guardian must agree), " +
    "every acceptance (who agreed, how, when; paper marked), and whether they are a minor. " +
    "Titles and dates only: never a name typed, a signature or health answers. Read-only.",
  input: z.object({ personId: id("The Person (per_…)") }),
  output: z.object({
    personId: z.string(),
    minor: z.object({
      marked: z.boolean().describe("Staff marked them a minor (agreement.setMinor)"),
      dependant: z.boolean().describe("A child of a live family link"),
      markedBy: z.string().nullable(),
      markedAt: z.string().nullable(),
    }),
    documents: z.array(documentStatus),
    acceptances: z.array(
      acceptanceSummary.extend({
        agentName: z.string().nullable(),
        recordedByName: z.string().nullable(),
      }),
    ),
    healthNote: z
      .boolean()
      .nullable()
      .describe("A yes on their current health form; null unless a person is asking"),
    can: z.object({
      recordPaper: z.boolean(),
      setMinor: z.boolean(),
      readAnswers: z.boolean(),
    }),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const facts = await personFacts(ctx.db, input.personId);
    if (!facts.exists) throw new NotFoundError("person", input.personId);
    const { documents, counting } = await standing(ctx, input.personId, facts);
    const rows = (await acceptanceRows(ctx)
      .where("a.person_id", "=", input.personId)
      .orderBy("a.accepted_at", "desc")
      .limit(200)
      .execute()) as AcceptanceRow[];
    const [people, users, mark] = await Promise.all([
      namesOf(
        ctx,
        rows.map((r) => r.agent_person_id ?? ""),
      ),
      userNames(
        ctx,
        rows.map((r) => r.recorded_by ?? ""),
      ),
      ctx.db
        .selectFrom("core_agreement_minor")
        .selectAll()
        .where("person_id", "=", input.personId)
        .executeTakeFirst(),
    ]);
    const person = isPerson(ctx);
    const holds = (p: "agreements:paper" | "people:link" | "agreements:health") =>
      person && holdsPermission(ctx.user, ctx.permissionGrants, p);
    return {
      personId: input.personId,
      minor: {
        marked: facts.marked,
        dependant: facts.dependant,
        markedBy: mark ? ((await userNames(ctx, [mark.set_by])).get(mark.set_by) ?? null) : null,
        markedAt: mark?.set_at ?? null,
      },
      documents,
      acceptances: rows.map((row) => ({
        ...summary(row, counting),
        agentName: row.agent_person_id ? (people.get(row.agent_person_id) ?? null) : null,
        recordedByName: row.recorded_by ? (users.get(row.recorded_by) ?? null) : null,
      })),
      // A health mark is for a person on the staff to see, never an AI's read.
      healthNote: person ? (await healthYes(ctx, [input.personId])).has(input.personId) : null,
      can: {
        recordPaper: holds("agreements:paper"),
        setMinor: holds("people:link"),
        readAnswers: holds("agreements:health"),
      },
    };
  },
});

export const agreementAcceptances = defineOperation({
  name: "agreement.acceptances",
  description:
    "The acceptances people made, newest first: by document, version, who agreed (themselves, a " +
    "guardian, paper) and a date range, each with the Person and how and when. Never a name " +
    "typed, a signature or health answers. Read-only.",
  input: z.object({
    documentId: id("Only this document's").optional(),
    versionId: id("Only this version's").optional(),
    by: z.enum(BY).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    before: z.string().optional().describe("Paging: the acceptedAt of the last item seen"),
  }),
  output: z.object({
    items: z.array(acceptanceSummary.extend({ personName: z.string().nullable() })),
    next: z.string().nullable(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = acceptanceRows(ctx);
    if (input.documentId) query = query.where("a.document_id", "=", input.documentId);
    if (input.versionId) query = query.where("a.version_id", "=", input.versionId);
    if (input.by) query = query.where("a.by", "=", input.by);
    if (input.from) query = query.where("a.accepted_at", ">=", new Date(input.from).toISOString());
    if (input.to) query = query.where("a.accepted_at", "<", new Date(input.to).toISOString());
    if (input.before) query = query.where("a.accepted_at", "<", input.before);
    // A guest's, before their order settles, is nobody's yet (step 3).
    query = query.where("a.person_id", "is not", null);
    const rows = (await query
      .orderBy("a.accepted_at", "desc")
      .orderBy("a.id", "desc")
      .limit(input.limit + 1)
      .execute()) as AcceptanceRow[];
    const page = rows.slice(0, input.limit);
    const names = await namesOf(
      ctx,
      page.map((r) => r.person_id ?? ""),
    );
    // Whether each counts now, per Person.
    const counting = new Set<string>();
    for (const personId of new Set(page.map((r) => r.person_id as string))) {
      const facts = await personFacts(ctx.db, personId);
      for (const one of (await standing(ctx, personId, facts)).counting) counting.add(one);
    }
    return {
      items: page.map((row) => ({
        ...summary(row, counting),
        personName: row.person_id ? (names.get(row.person_id) ?? null) : null,
      })),
      next: rows.length > input.limit ? (page.at(-1)?.accepted_at ?? null) : null,
    };
  },
});

export const agreementDueList = defineOperation({
  name: "agreement.due.list",
  description:
    "Who still has to agree to which document: People with a sign-in, a subscription, a family " +
    "link or the minor mark who have something attached due, those with a live subscription " +
    "first. Titles and dates only. Read-only.",
  input: z.object({
    documentId: id("Only this document").optional(),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  output: z.object({
    items: z.array(
      z.object({
        personId: z.string(),
        name: z.string(),
        subscribed: z.boolean(),
        due: z.array(
          z.object({
            documentId: z.string(),
            title: z.string(),
            reason: z.enum(REASONS),
          }),
        ),
      }),
    ),
    more: z.boolean(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const { rows } = await sql<{
      id: string;
      name: string;
      subscribed: number;
    }>`SELECT p.id, p.display_name AS name,
        EXISTS (SELECT 1 FROM core_subscription s WHERE s.holder_person_id = p.id
          AND s.state IN ('trialing', 'active', 'past_due', 'paused')) AS subscribed
      FROM core_person p
      WHERE p.deleted_at IS NULL AND (
        p.id IN (SELECT person_id FROM core_customer WHERE person_id IS NOT NULL)
        OR p.id IN (SELECT holder_person_id FROM core_subscription)
        OR p.id IN (SELECT dependant_id FROM core_person_link WHERE ended_at IS NULL)
        OR p.id IN (SELECT person_id FROM core_agreement_minor))
      ORDER BY subscribed DESC, p.display_name, p.id
      LIMIT 2000`.execute(ctx.db);
    let docs = await attachedDocuments(ctx.db, null);
    if (input.documentId) docs = docs.filter((d) => d.id === input.documentId);
    const accepted = await acceptancesOf(
      ctx.db,
      rows.map((r) => r.id),
      docs.map((d) => d.id),
    );
    const items = [];
    let more = false;
    for (const row of rows) {
      const facts = await personFacts(ctx.db, row.id);
      const due = docs
        .filter((d) => appliesTo(d, facts))
        .flatMap((doc) => {
          const { acceptance, reason } = countingAcceptance(
            doc,
            facts,
            accepted.get(acceptanceKey(row.id, doc.id)) ?? [],
            ctx.now,
          );
          return acceptance ? [] : [{ documentId: doc.id, title: doc.title, reason }];
        });
      if (!due.length) continue;
      if (items.length === input.limit) {
        more = true;
        break;
      }
      items.push({ personId: row.id, name: row.name, subscribed: Boolean(row.subscribed), due });
    }
    return { items, more };
  },
});

export const agreementHealthNotes = defineOperation({
  name: "agreement.healthNotes",
  description:
    "For a class list: which of these People answered yes on their current health form, as a " +
    "yes or no each (a mark, nothing of the form). For a person on the staff, or a pack's tool " +
    "a person called; never an AI. Read-only.",
  input: z.object({ personIds: z.array(id("A Person (per_…)")).max(200) }),
  output: z.object({ notes: z.array(z.object({ personId: z.string(), healthNote: z.boolean() })) }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "extension"],
  mcp: { expose: false },
  async handler(input, ctx) {
    // Pack code only inside a tool a person called (the runtime sets who started it): the
    // assistant calling the same tool gets no mark.
    if (ctx.actor === "extension" && !ctx.extension?.tool?.startedBy) {
      throw new ForbiddenError("A health note is for a person on the staff to see");
    }
    const ids = [...new Set(input.personIds)];
    const yes = await healthYes(ctx, ids);
    return { notes: ids.map((personId) => ({ personId, healthNote: yes.has(personId) })) };
  },
});

export const agreementAcceptanceGet = defineOperation({
  name: "agreement.acceptance.get",
  description:
    "One acceptance in full, for a person on the staff: the version shown, the name typed (beside " +
    "the Person's own name), the signature drawn, and for paper who recorded it. Health answers " +
    "are agreement.answers.get's. Never an AI's read. Read-only.",
  input: z.object({ id: id("The acceptance's id (aga_…)") }),
  output: acceptanceSummary.extend({
    version: versionOut.nullable(),
    personName: z.string().nullable(),
    typedName: z.string(),
    signature: strokesOut,
    agentName: z.string().nullable(),
    recordedByName: z.string().nullable(),
    signedBy: z.string().nullable(),
    note: z.string().nullable(),
    hasAnswers: z.boolean(),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = (await acceptanceRows(ctx)
      .select(["a.typed_name", "a.signed_by", "a.note"])
      .where("a.id", "=", input.id)
      .executeTakeFirst()) as
      | (AcceptanceRow & { typed_name: string; signed_by: string | null; note: string | null })
      | undefined;
    if (!row) throw new NotFoundError("acceptance", input.id);
    const counting = row.person_id
      ? (await standing(ctx, row.person_id, await personFacts(ctx.db, row.person_id))).counting
      : new Set<string>();
    const [version, people, users, signature, answers] = await Promise.all([
      versionsById(ctx, [row.version_id]),
      namesOf(ctx, [row.person_id ?? "", row.agent_person_id ?? ""]),
      userNames(ctx, [row.recorded_by ?? ""]),
      ctx.db
        .selectFrom("core_agreement_signature")
        .select("strokes")
        .where("acceptance_id", "=", row.id)
        .executeTakeFirst(),
      ctx.db
        .selectFrom("core_agreement_answer")
        .select("acceptance_id")
        .where("acceptance_id", "=", row.id)
        .executeTakeFirst(),
    ]);
    return {
      ...summary(row, counting),
      version: version.get(row.version_id) ?? null,
      personName: row.person_id ? (people.get(row.person_id) ?? null) : null,
      typedName: row.typed_name,
      signature: signature ? (JSON.parse(signature.strokes) as Signature) : null,
      agentName: row.agent_person_id ? (people.get(row.agent_person_id) ?? null) : null,
      recordedByName: row.recorded_by ? (users.get(row.recorded_by) ?? null) : null,
      signedBy: row.signed_by,
      note: row.note,
      hasAnswers: Boolean(answers),
    };
  },
});

export const agreementAnswersGet = defineOperation({
  name: "agreement.answers.get",
  description:
    "A health form's answers, for a person on the staff with agreements:health: each question, " +
    "yes or no, and a note. Health information: every read is audited (who read whose), and no " +
    "AI ever reads them. Read-only.",
  input: z.object({ acceptanceId: id("The acceptance's id (aga_…)") }),
  output: z.object({
    acceptanceId: z.string(),
    personId: z.string().nullable(),
    acceptedAt: z.string(),
    enteredByStaff: z.boolean().describe("Typed in by staff from a paper form"),
    answers: z.array(
      z.object({
        key: z.string(),
        text: z.string(),
        yes: z.boolean(),
        note: z.string().nullable(),
      }),
    ),
  }),
  permission: "agreements:health",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  auditReads: true,
  // The audit row says who read whose answers, and nothing of them.
  auditSummary: (output) => ({ acceptanceId: output.acceptanceId, personId: output.personId }),
  redactResult: ["answers"],
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_agreement_answer as n")
      .innerJoin("core_agreement_acceptance as a", "a.id", "n.acceptance_id")
      .innerJoin("core_agreement_version as v", "v.id", "a.version_id")
      .select(["n.answers", "n.entered_by", "a.id", "a.person_id", "a.accepted_at", "v.questions"])
      .where("n.acceptance_id", "=", input.acceptanceId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError("health answers", input.acceptanceId);
    const questions = (row.questions ? JSON.parse(row.questions) : []) as Question[];
    const text = new Map(questions.map((q) => [q.key, q.text]));
    const answers = JSON.parse(row.answers) as { key: string; yes: boolean; note?: string }[];
    return {
      acceptanceId: row.id,
      personId: row.person_id,
      acceptedAt: row.accepted_at,
      enteredByStaff: row.entered_by !== null,
      answers: answers.map((a) => ({
        key: a.key,
        text: text.get(a.key) ?? a.key,
        yes: a.yes,
        note: a.note ?? null,
      })),
    };
  },
});

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A date, YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "A date, YYYY-MM-DD");

export const agreementRecordPaper = defineOperation({
  name: "agreement.recordPaper",
  description:
    "Record that a Person signed a version of a document on paper (printed from that version): " +
    "the name on the form, the date written on it, who signed it for a child (signedBy), a " +
    "note, and for a health form the answers typed in. Shown everywhere as recorded from paper " +
    "by you, never as their own acceptance. A person on the staff with agreements:paper only.",
  input: z
    .object({
      personId: id("Whom it is for (per_…): for a child, the child"),
      versionId: id("The version printed on the form (agv_…)"),
      signedOn: isoDate.describe("The date written on the form"),
      typedName: typedNameSchema.describe("The name as written on the form"),
      signedBy: z.string().trim().min(1).max(200).optional().describe("For a child: who signed"),
      note: z.string().trim().max(1_000).optional(),
      answers: answersSchema.optional(),
    })
    .strict(),
  output: z.object({ id: z.string(), documentId: z.string(), versionNumber: z.number() }),
  permission: "agreements:paper",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  redact: ["typedName", "signedBy", "note", "answers"],
  auditSummary: (output, input) => ({
    acceptanceId: output.id,
    personId: input.personId,
    documentId: output.documentId,
    versionNumber: output.versionNumber,
  }),
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person records a paper form");
    await requirePerson(ctx, input.personId);
    const version = await ctx.db
      .selectFrom("core_agreement_version")
      .select(["published_at"])
      .where("id", "=", input.versionId)
      .executeTakeFirst();
    if (!version) throw new NotFoundError("agreement version", input.versionId);
    // A form printed from a version is signed on or after the day it was published (a day of
    // slack for time zones), and not in the future.
    const published = new Date(Date.parse(version.published_at) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const today = new Date(Date.parse(ctx.now) + 86_400_000).toISOString().slice(0, 10);
    if (input.signedOn < published || input.signedOn > today) {
      throw new ValidationError(
        "The date on the form must be between the day this version was published and today.",
        { rule: "agreement_signed_on", field: "signedOn" },
      );
    }
    const planned = await planAcceptance(
      ctx.db,
      {
        versionId: input.versionId,
        personId: input.personId,
        by: "paper",
        channel: "paper",
        typedName: input.typedName,
        answers: input.answers,
        paper: {
          signedOn: input.signedOn,
          recordedBy: ctx.user.id,
          signedBy: input.signedBy ?? null,
          note: input.note ?? null,
        },
        enteredBy: input.answers ? ctx.user.id : null,
      },
      ctx.now,
    );
    ctx.write(...planned.statements);
    return { id: planned.id, documentId: planned.documentId, versionNumber: planned.versionNumber };
  },
});

export const agreementSetMinor = defineOperation({
  name: "agreement.setMinor",
  description:
    "Mark a Person as a minor, or clear the mark: a parent or guardian agrees for them (or staff " +
    "record paper), never they themselves, and every document attached anywhere is due as for a " +
    "child. The host holds no date of birth: clear it when they come of age. A person on the " +
    "staff with people:link only. Audited.",
  input: z.object({ personId: id("The Person (per_…)"), minor: z.boolean() }),
  output: z.object({ personId: z.string(), minor: z.boolean() }),
  permission: "people:link",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person marks a minor");
    const facts = await requirePerson(ctx, input.personId);
    if (facts.marked === input.minor) {
      return { personId: input.personId, minor: input.minor };
    }
    ctx.write(
      input.minor
        ? ctx.db
            .insertInto("core_agreement_minor")
            .values({ person_id: input.personId, set_by: ctx.user.id, set_at: ctx.now })
            .onConflict((oc) => oc.column("person_id").doNothing())
        : ctx.db.deleteFrom("core_agreement_minor").where("person_id", "=", input.personId),
    );
    return { personId: input.personId, minor: input.minor };
  },
});

export const agreementAcceptanceOperations = [
  meAgreementsDue,
  meAgreementsList,
  meAgreementsGet,
  meAgreementsAccept,
  agreementPerson,
  agreementAcceptances,
  agreementDueList,
  agreementHealthNotes,
  agreementAcceptanceGet,
  agreementAnswersGet,
  agreementRecordPaper,
  agreementSetMinor,
] as const;
