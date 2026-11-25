// Acceptances (stage 44 step 2, ADRs 0642 and 0643): a person agrees to a published version, for
// themselves or as a guardian for a dependant; staff record a paper form; staff mark a minor;
// staff read a Person's agreements, the acceptances and who still has something due; staff with
// agreements:health read a health form's answers, every read audited.
//
//   me.agreements.due / list / get     a signed-in customer: their own and their live dependants'
//   me.agreements.accept               a signed-in customer, for themselves or a live dependant
//   agreement.guestVersions            the public: the words of what a visitor is asked (step 5)
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
import { businessName, localTime, sendCopiesNow } from "../agreements/copy.ts";
import { deskWords } from "../agreements/desk.ts";
import { DESK_MARKS, deskMarks } from "../agreements/desk-marks.ts";
import { type Question, versionIntact } from "../agreements/documents.ts";
import {
  acceptanceKey,
  acceptancesOf,
  appliesTo,
  attachedDocuments,
  countingAcceptance,
  type DueReason,
  isMinor,
  NO_PERSON,
  type PersonFacts,
  peopleFacts,
  personFacts,
} from "../agreements/due.ts";
import { healthListOf } from "../agreements/health-list.ts";
import { ForbiddenError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { type CustomerPrincipal, holdsPermission } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import { isLiveDependant } from "../visibility/guardians.ts";
import { requireVisible } from "./agreement-copy.ts";

const id = (what: string) => z.string().min(1).max(64).describe(what);
const BY = ["self", "guardian", "guest", "paper"] as const;
const HOW = ["typed", "drawn", "paper"] as const;
const CHANNEL = ["web", "app", "paper", "desk"] as const;
const REASONS = ["never", "agree_again", "ask_again", "guardian"] as const;

const questionOut = z.object({ key: z.string(), text: z.string(), noteOnYes: z.boolean() });

/** A version as a person reads it before agreeing. */
export const versionOut = z.object({
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
  desk_session_id?: string | null;
  email?: string | null;
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
      "a.desk_session_id",
      "a.email",
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
export async function versionsById(
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
    .where("v.id", "in", jsonList([...new Set(ids)]))
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

interface Standing {
  documents: DocumentStatus[];
  counting: Set<string>;
}

/** Where one Person stands on every document attached anywhere (spec 44, the Person tab). */
export async function standing(
  ctx: HandlerContext,
  personId: string,
  facts: PersonFacts,
): Promise<Standing> {
  const one = (await standings(ctx, new Map([[personId, facts]]))).get(personId);
  return one ?? { documents: [], counting: new Set() };
}

/** `standing` for many People at once: the documents and the acceptances are read once. */
async function standings(
  ctx: HandlerContext,
  people: ReadonlyMap<string, PersonFacts>,
): Promise<Map<string, Standing>> {
  const attached = await attachedDocuments(ctx.db, null);
  const accepted = await acceptancesOf(
    ctx.db,
    [...people.keys()],
    attached.map((d) => d.id),
  );
  const out = new Map<string, Standing>();
  for (const [personId, facts] of people) {
    const counting = new Set<string>();
    const documents = attached
      .filter((d) => appliesTo(d, facts))
      .map((doc) => {
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
    out.set(personId, { documents, counting });
  }
  return out;
}

/** Every acceptance that counts now for any of these People. */
async function countingOf(ctx: HandlerContext, personIds: readonly string[]): Promise<Set<string>> {
  const all = await standings(ctx, await peopleFacts(ctx.db, personIds));
  return new Set([...all.values()].flatMap((one) => [...one.counting]));
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
  const facts = await peopleFacts(ctx.db, personIds);
  const counting: string[] = [];
  for (const personId of personIds) {
    for (const doc of health) {
      const { acceptance } = countingAcceptance(
        doc,
        facts.get(personId) ?? NO_PERSON,
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
    .where("n.acceptance_id", "in", jsonList(counting))
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
    .where("id", "in", jsonList(wanted))
    .execute();
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

async function userNames(ctx: HandlerContext, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Map();
  const rows = await ctx.db
    .selectFrom("core_user")
    .select(["id", "name"])
    .where("id", "in", jsonList(wanted))
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
    const counting = await countingOf(
      ctx,
      people.map((p) => p.personId),
    );
    const rows = (await acceptanceRows(ctx)
      .where(
        "a.person_id",
        "in",
        people.map((p) => p.personId),
      )
      .orderBy("a.accepted_at", "desc")
      .limit(500)
      .execute()) as AcceptanceRow[];
    const me = customerOf(ctx).personId;
    // Which guardian agreed is that guardian's: another guardian, or the child, sees only that a
    // parent or guardian agreed (the second review of PR #274).
    return {
      items: rows.map((row) => {
        const one = summary(row, counting);
        return one.agentPersonId && one.agentPersonId !== me
          ? { ...one, agentPersonId: null }
          : one;
      }),
    };
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
    "were shown it, a health form's answers, and the name typed and the signature drawn when " +
    "you are the one who agreed (another guardian's are not shown). Read-only.",
  input: z.object({ id: id("The acceptance's id (aga_…)") }),
  output: acceptanceSummary.extend({
    version: versionOut,
    typedName: z.string().nullable(),
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
      .executeTakeFirst()) as (AcceptanceRow & { typed_name: string | null }) | undefined;
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
    // The name and the signature are whoever agreed's: shown to them (a guardian, or the person
    // for their own), never to another guardian or to the child a guardian agreed for.
    const me = customerOf(ctx).personId;
    const mine = row.by === "guardian" ? row.agent_person_id === me : row.person_id === me;
    const one = summary(row, counting);
    return {
      ...one,
      agentPersonId: one.agentPersonId === me ? me : null,
      version,
      typedName: mine ? row.typed_name : null,
      signature: mine && signature ? (JSON.parse(signature.strokes) as Signature) : null,
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
    copyTo: z
      .string()
      .nullable()
      .describe("The address the copy is emailed to (your sign-in address), or null for none"),
  }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  // What a person typed, drew and answered never reaches the audit log (nor the copy's address:
  // the summary below names ids only).
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
    // Only a document asked of them: attached somewhere and applying to that Person.
    const asked = await ctx.db
      .selectFrom("core_agreement_version")
      .select("document_id")
      .where("id", "=", input.versionId)
      .executeTakeFirst();
    const facts = await personFacts(ctx.db, forPerson);
    const { documents } = await standing(ctx, forPerson, facts);
    if (!asked || !documents.some((d) => d.documentId === asked.document_id)) {
      throw new ValidationError("This document is not asked of you.", {
        rule: "agreement_not_asked",
      });
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
        idempotent: true,
      },
      ctx.now,
    );
    const output = {
      id: planned.id,
      documentId: planned.documentId,
      versionNumber: planned.versionNumber,
      acceptedAt: planned.acceptedAt,
      // The Agree block says "a copy is on its way to [address]" (stage 44 step 5): the caller's
      // own sign-in address, which the copy goes to (migration 0854). A repeat records and sends
      // nothing, so it names none.
      copyTo: planned.existing || !planned.statements.length ? null : (signIn?.email ?? null),
    };
    if (!planned.statements.length || planned.existing) return output;
    ctx.write(...planned.statements);
    // The copy (step 4, ADR 0645): migration 0854 queued it with the acceptance; it goes now,
    // after the commit, and the minute cron sends what did not.
    const integrations = ctx.integrations;
    return ctx.afterCommit(async () => {
      await sendCopiesNow({ db: ctx.db, integrations }, [planned.id]);
      return output;
    });
  },
});

// --- A visitor buying without an account -------------------------------------------------------

export const agreementGuestVersions = defineOperation({
  name: "agreement.guestVersions",
  description:
    "The words a visitor buying without an account is asked to agree to: each version named " +
    "(by the versionId of an agreements_due refusal from a buying call), as it will be " +
    "recorded: its title, body, tick label, health questions and how it is agreed to. Only the " +
    "version in effect of a live document attached somewhere and asked of everyone; any other " +
    "id (an older version, one scheduled for later) is left out. The business's text, never anyone's personal data. " +
    "Read-only.",
  input: z
    .object({
      versionIds: z
        .array(id("A version's id (agv_…), as an agreements_due refusal named it"))
        .min(1)
        .max(20),
    })
    .strict(),
  output: z.object({ versions: z.array(versionOut) }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer", "public"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    // What a guest is asked (`guestDue`): a live document attached somewhere, for everyone, its
    // version in effect. Nothing here reads a Person.
    const askable = new Set<string>();
    for (const doc of await attachedDocuments(ctx.db, null)) {
      if (doc.forWhom === "everyone") askable.add(doc.current.id);
    }
    const wanted = [...new Set(input.versionIds)].filter((v) => askable.has(v));
    const found = await versionsById(ctx, wanted);
    return { versions: wanted.flatMap((v) => found.get(v) ?? []) };
  },
});

// --- Staff -------------------------------------------------------------------------------------

/** By mark: desk acceptances are read this many at a time, and at most MARK_SCAN_ROWS a call. */
const MARK_CHUNK = 200;
const MARK_SCAN_ROWS = 1_000;

/** What an acceptance made at the desk says of its session (ADR 0649), and its marks. */
const deskOut = z.object({
  sessionId: z.string(),
  device: z.object({ id: z.string().nullable(), name: z.string() }),
  startedBy: z.object({ id: z.string(), name: z.string() }),
  startedAt: z.string(),
  words: z.string().describe("How it was made, as every screen and the PDF say it"),
  marks: z.array(
    z.object({
      kind: z.enum(DESK_MARKS),
      at: z.string().optional(),
      by: z.string().optional(),
      how: z.string().optional(),
    }),
  ),
});

/** The desk part of each acceptance on a page made at the desk: two reads, then the marks. */
async function deskOf(
  ctx: HandlerContext,
  page: readonly AcceptanceRow[],
): Promise<Map<string, z.infer<typeof deskOut>>> {
  const out = new Map<string, z.infer<typeof deskOut>>();
  const atDesk = page.filter((r) => r.channel === "desk" && r.desk_session_id);
  if (!atDesk.length) return out;
  const sessions = jsonList([...new Set(atDesk.map((r) => r.desk_session_id as string))]);
  const rows = await ctx.db
    .selectFrom("core_agreement_desk_session as s")
    .leftJoin("core_device as d", "d.id", "s.claimed_device_id")
    .leftJoin("core_user as e", "e.id", "d.enrolled_by")
    .leftJoin("core_user as u", "u.id", "s.started_by")
    .select([
      "s.id",
      "s.started_by",
      "s.started_at",
      "s.claimed_device_id",
      "d.name as device",
      "d.enrolled_at",
      "e.name as enrolled_by",
      "u.name as started_by_name",
    ])
    .where("s.id", "in", sessions)
    .execute();
  const { timezone } = await businessName(ctx.db);
  const marks = await deskMarks(
    ctx.db,
    atDesk.map((r) => ({
      id: r.id,
      personId: r.person_id,
      email: r.email ?? null,
      acceptedAt: r.accepted_at,
    })),
  );
  for (const row of atDesk) {
    const s = rows.find((x) => x.id === row.desk_session_id);
    if (!s) continue;
    const evidence = {
      device: s.device ?? "a device",
      enrolledBy: s.enrolled_by ?? "an admin",
      enrolledOn: (s.enrolled_at ?? "").slice(0, 10),
      startedBy: s.started_by_name ?? "a member of staff",
      startedAt: s.started_at,
    };
    out.set(row.id, {
      sessionId: s.id,
      device: { id: s.claimed_device_id, name: evidence.device },
      startedBy: { id: s.started_by, name: evidence.startedBy },
      startedAt: s.started_at,
      words: deskWords(evidence, (iso) => `${localTime(iso, timezone)} (${timezone})`),
      marks: marks.get(row.id) ?? [],
    });
  }
  return out;
}

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
        desk: deskOut.nullable().describe("At the desk: its session, the device and the marks"),
      }),
    ),
    healthNote: z
      .boolean()
      .nullable()
      .describe("A yes on their current health form; null unless the caller may read answers"),
    can: z.object({
      recordPaper: z.boolean(),
      setMinor: z.boolean(),
      readAnswers: z.boolean(),
      signAtDesk: z.boolean().describe("May start a desk signing session for them"),
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
    const holds = (
      p: "agreements:paper" | "people:link" | "agreements:health" | "agreements:desk",
    ) => person && holdsPermission(ctx.user, ctx.permissionGrants, p);
    const desk = await deskOf(ctx, rows);
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
        desk: desk.get(row.id) ?? null,
      })),
      // A health mark is for a person on the staff who may read health answers, never an AI's.
      healthNote: holds("agreements:health")
        ? (await healthYes(ctx, [input.personId])).has(input.personId)
        : null,
      can: {
        recordPaper: holds("agreements:paper"),
        setMinor: holds("people:link"),
        readAnswers: holds("agreements:health"),
        signAtDesk: holds("agreements:desk"),
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
    channel: z.enum(CHANNEL).optional().describe("Only those made this way: desk is at the desk"),
    deviceId: id("At the desk: only those made on this enrolled device (dev_…)").optional(),
    startedBy: id("At the desk: only those in sessions this staff user started (usr_…)").optional(),
    mark: z.enum(DESK_MARKS).optional().describe("At the desk: only those with this mark"),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    before: z.string().optional().describe("Paging: the acceptedAt of the last item seen"),
  }),
  output: z.object({
    items: z.array(
      acceptanceSummary.extend({ personName: z.string().nullable(), desk: deskOut.nullable() }),
    ),
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
    const deskOnly = input.channel === "desk" || input.deviceId || input.startedBy || input.mark;
    if (input.channel) query = query.where("a.channel", "=", input.channel);
    if (deskOnly) query = query.where("a.channel", "=", "desk");
    if (input.deviceId || input.startedBy) {
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom("core_agreement_desk_session as s")
            .select("s.id")
            .whereRef("s.id", "=", "a.desk_session_id")
            .$if(Boolean(input.deviceId), (q) =>
              q.where("s.claimed_device_id", "=", input.deviceId ?? ""),
            )
            .$if(Boolean(input.startedBy), (q) =>
              q.where("s.started_by", "=", input.startedBy ?? ""),
            ),
        ),
      );
    }
    if (input.from) query = query.where("a.accepted_at", ">=", new Date(input.from).toISOString());
    if (input.to) query = query.where("a.accepted_at", "<", new Date(input.to).toISOString());
    if (input.before) query = query.where("a.accepted_at", "<", input.before);
    // A guest's, before their order settles, is nobody's yet (step 3).
    query = query.where("a.person_id", "is not", null);
    // By mark (after the review of PR #390): marks are worked out from the records, not stored,
    // so the list reads desk acceptances in chunks until it has a page of marked ones, or has read
    // MARK_SCAN_ROWS; `next` then continues from the last one read.
    let rows: AcceptanceRow[];
    let next: string | null;
    if (input.mark) {
      rows = [];
      next = null;
      let before = input.before;
      for (let read = 0; read < MARK_SCAN_ROWS && rows.length <= input.limit; ) {
        const chunk = (await (before ? query.where("a.accepted_at", "<", before) : query)
          .orderBy("a.accepted_at", "desc")
          .orderBy("a.id", "desc")
          .limit(MARK_CHUNK)
          .execute()) as AcceptanceRow[];
        read += chunk.length;
        const marks = await deskMarks(
          ctx.db,
          chunk.map((r) => ({
            id: r.id,
            personId: r.person_id,
            email: r.email ?? null,
            acceptedAt: r.accepted_at,
          })),
        );
        for (const row of chunk) {
          if (rows.length > input.limit) break;
          before = row.accepted_at;
          if (marks.get(row.id)?.some((m) => m.kind === input.mark)) rows.push(row);
        }
        if (chunk.length < MARK_CHUNK) {
          before = undefined;
          break;
        }
      }
      next =
        rows.length > input.limit ? (rows[input.limit - 1]?.accepted_at ?? null) : (before ?? null);
    } else {
      rows = (await query
        .orderBy("a.accepted_at", "desc")
        .orderBy("a.id", "desc")
        .limit(input.limit + 1)
        .execute()) as AcceptanceRow[];
      next = rows.length > input.limit ? (rows[input.limit - 1]?.accepted_at ?? null) : null;
    }
    const page = rows.slice(0, input.limit);
    const names = await namesOf(
      ctx,
      page.map((r) => r.person_id ?? ""),
    );
    // Whether each counts now, per Person.
    const counting = await countingOf(ctx, [...new Set(page.map((r) => r.person_id as string))]);
    const desk = await deskOf(ctx, page);
    const items = page.map((row) => ({
      ...summary(row, counting),
      personName: row.person_id ? (names.get(row.person_id) ?? null) : null,
      desk: desk.get(row.id) ?? null,
    }));
    return { items, next };
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
    const people = await peopleFacts(
      ctx.db,
      rows.map((r) => r.id),
    );
    const items = [];
    let more = false;
    for (const row of rows) {
      const facts = people.get(row.id) ?? NO_PERSON;
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

const notesOut = z.object({
  notes: z.array(z.object({ personId: z.string(), healthNote: z.boolean() })),
});

export const agreementHealthNotes = defineOperation({
  name: "agreement.healthNotes",
  description:
    "Which of these People answered yes on their current health form, as a yes or no each (a " +
    "mark, nothing of the form). A person on the staff with agreements:health only; every read " +
    "is audited. Read-only.",
  input: z.object({ personIds: z.array(id("A Person (per_…)")).max(200) }),
  output: notesOut,
  permission: "agreements:health",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (_output, input) => ({ personIds: input.personIds }),
  redactResult: ["notes"],
  async handler(input, ctx) {
    const ids = [...new Set(input.personIds)];
    const yes = await healthYes(ctx, ids);
    return { notes: ids.map((personId) => ({ personId, healthNote: yes.has(personId) })) };
  },
});

export const agreementListHealthNotes = defineOperation({
  name: "agreement.listHealthNotes",
  description:
    "For a list a pack declares (healthNotes on its object: a class's bookings): the host reads " +
    "the People on the records of that list's own record (value, the class) and says which " +
    "answered yes on their current health form (a mark only). Pack code inside a tool a person " +
    "called themselves only; every call is audited. Read-only.",
  input: z.object({
    // Not `object`: a pack role's today limits read that key as a record operation's (ADR 0553);
    // `value` is held to them as a record of the list's own object (pack-role-today.ts).
    records: z
      .string()
      .min(1)
      .max(80)
      .describe("The calling pack's object that declares healthNotes (bookings.booking)"),
    value: z.string().min(1).max(64).describe("The list's own record (the class's id)"),
  }),
  output: notesOut,
  permission: "records:read",
  risk: "read",
  actors: ["extension"],
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (output, input) => ({
    records: input.records,
    value: input.value,
    count: output.notes.length,
  }),
  redactResult: ["notes"],
  async handler(input, ctx) {
    // A person called the tool themselves (the runner sets startedBy, from the installed tool
    // and the caller, never from input); not the assistant, and not an approval of an AI's call.
    const caller = ctx.extension;
    if (!caller?.tool?.startedBy || caller.tool.startedByApproval) {
      throw new ForbiddenError("A health note is for a person on the staff to see");
    }
    // The pack's own object, which declares the list (checked at install: a relation to the
    // list's own object, and one to the Person).
    const target = healthListOf(input.records);
    if (!target || target.object.extension !== caller.id) {
      throw new ForbiddenError("A health note is read for a list the calling pack declares only");
    }
    // The list's own record must exist and be out of the Trash (views hold live records only).
    const parent = await sql<{
      one: number;
    }>`SELECT 1 AS one FROM ${sql.table(target.parent.source)} WHERE id = ${input.value}`.execute(
      ctx.db,
    );
    if (!parent.rows.length) throw new NotFoundError(target.parent.name, input.value);
    const { rows } = await sql<{
      p: string | null;
    }>`SELECT DISTINCT ${sql.ref(target.personColumn)} AS p FROM ${sql.table(target.object.source)} WHERE ${sql.ref(target.listColumn)} = ${input.value} LIMIT 200`.execute(
      ctx.db,
    );
    const ids = rows.map((r) => r.p).filter((p): p is string => typeof p === "string" && !!p);
    const yes = await healthYes(ctx, ids);
    return { notes: ids.map((personId) => ({ personId, healthNote: yes.has(personId) })) };
  },
});

export const agreementHealthReviews = defineOperation({
  name: "agreement.healthReviews",
  description:
    "The People whose current health form has a yes, newest first, for staff with " +
    "agreements:health to look at (where a health notice sends them). Every read is audited. " +
    "Read-only.",
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({
        acceptanceId: z.string(),
        personId: z.string(),
        name: z.string().nullable(),
        title: z.string(),
        acceptedAt: z.string(),
      }),
    ),
  }),
  permission: "agreements:health",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (output) => ({ count: output.items.length }),
  redactResult: ["items"],
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_agreement_answer as n")
      .innerJoin("core_agreement_acceptance as a", "a.id", "n.acceptance_id")
      .innerJoin("core_agreement_version as v", "v.id", "a.version_id")
      .select(["a.id", "a.person_id", "a.accepted_at", "v.title"])
      .where("n.any_yes", "=", 1)
      .where("a.person_id", "is not", null)
      .where("a.erased_at", "is", null)
      .orderBy("a.accepted_at", "desc")
      .limit(500)
      .execute();
    const people = [...new Set(rows.map((r) => r.person_id as string))];
    const yes = await healthYes(ctx, people);
    const names = await namesOf(ctx, people);
    const seen = new Set<string>();
    const items = [];
    for (const row of rows) {
      const personId = row.person_id as string;
      if (!yes.has(personId) || seen.has(personId)) continue;
      seen.add(personId);
      items.push({
        acceptanceId: row.id,
        personId,
        name: names.get(personId) ?? null,
        title: row.title,
        acceptedAt: row.accepted_at,
      });
    }
    return { items };
  },
});

export const agreementAcceptanceGet = defineOperation({
  name: "agreement.acceptance.get",
  description:
    "One acceptance in full, for a person on the staff: the version shown, the name typed (beside " +
    "the Person's own name), the signature drawn, and for paper who recorded it. Health answers " +
    "are agreement.answers.get's. Never an AI's read. Who signed a paper form and its " +
    "note are shown only with agreements:manage, as is an acceptance kept after an erase. Every " +
    "read is audited (which acceptance, never what it says). Read-only.",
  input: z.object({ id: id("The acceptance's id (aga_…)") }),
  output: acceptanceSummary.extend({
    version: versionOut.nullable(),
    personName: z.string().nullable(),
    typedName: z.string().nullable().describe("Null once the guardian who typed it was erased"),
    signature: strokesOut,
    agentName: z.string().nullable(),
    recordedByName: z.string().nullable(),
    signedBy: z
      .string()
      .nullable()
      .describe("Paper: who signed it; null without agreements:manage"),
    note: z.string().nullable().describe("Paper: staff's note; null without agreements:manage"),
    hasAnswers: z.boolean(),
    kept: z.boolean().describe("Kept after its Person, or the guardian who made it, was erased"),
    copy: z
      .object({
        state: z.enum(["queued", "sending", "sent", "waiting", "failed", "cancelled"]),
        sentAt: z.string().nullable(),
      })
      .nullable()
      .describe("The emailed copy (step 4): whether it went; paper has none until Email a copy"),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  // Who opened which acceptance, a kept one above all, can be reconstructed (the review of
  // PR #288): the row names the acceptance, never a value read.
  auditReads: true,
  auditSummary: (output, input) => ({ acceptanceId: input.id, kept: output.kept }),
  async handler(input, ctx) {
    const row = (await acceptanceRows(ctx)
      .select(["a.typed_name", "a.signed_by", "a.note", "a.erased_at"])
      .where("a.id", "=", input.id)
      .executeTakeFirst()) as
      | (AcceptanceRow & {
          typed_name: string | null;
          signed_by: string | null;
          note: string | null;
          erased_at: string | null;
        })
      | undefined;
    if (!row) throw new NotFoundError("acceptance", input.id);
    // Whose it is decides who reads it, as for the PDF (ADR 0646): a Person staff may see through
    // the seam; one kept after an erase, or a buyer's not yet settled, the manager's only.
    await requireVisible(ctx, row.erased_at ? null : row.person_id);
    const freeText = holdsPermission(ctx.user, ctx.permissionGrants, "agreements:manage");
    const counting = row.person_id
      ? (await standing(ctx, row.person_id, await personFacts(ctx.db, row.person_id))).counting
      : new Set<string>();
    const [version, people, users, signature, answers, copy] = await Promise.all([
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
      ctx.db
        .selectFrom("core_agreement_copy")
        .select(["state", "sent_at"])
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
      signedBy: freeText ? row.signed_by : null,
      note: freeText ? row.note : null,
      hasAnswers: Boolean(answers),
      kept: row.erased_at !== null,
      copy: copy ? { state: copy.state, sentAt: copy.sent_at } : null,
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
  agreementGuestVersions,
  agreementPerson,
  agreementAcceptances,
  agreementDueList,
  agreementHealthNotes,
  agreementListHealthNotes,
  agreementHealthReviews,
  agreementAcceptanceGet,
  agreementAnswersGet,
  agreementRecordPaper,
  agreementSetMinor,
] as const;
