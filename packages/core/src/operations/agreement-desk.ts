// Signing at the desk (stage 44 step 6, decision 22, ADR 0649): a member signs on the business's
// own enrolled tablet, in a session a person on the staff started for them. agreements/desk.ts
// holds the session's rules; these are its operations.
//
// Staff (agreements:desk, a person only; grantable, also to a fixed-role account: a coach at the
// desk, ADR 0600 amended):
//   agreement.desk.find      people by name, to choose whom a session is for (no record beyond)
//   agreement.desk.prepare   for one Person: the titles of what they and their children have due
//   agreement.desk.devices   the devices enrolled for desk signing, to choose one
//   agreement.desk.start     starts a session: the code to type on the tablet
//   agreement.desk.get       the session's state, for the staff screen: waiting, claimed on which
//                            device and when, ended and why
//   agreement.desk.end       ends it
// The tablet (the desk origin's handler only, `deskOnly`): desk.claim, desk.documents,
// desk.accept, desk.heartbeat, desk.finish. Each needs the enrolled device's credential and, but
// for the claim, the session token bound to it, both from the request's cookies.
//
// Nothing here is for an AI: the staff operations are `actors: ["human"]` and not on MCP, and the
// desk calls are open only to the desk origin's own handler.
import { sql } from "kysely";
import { z } from "zod";
import { planAcceptance } from "../agreements/accept.ts";
import { answersSchema, signatureSchema, typedNameSchema } from "../agreements/capture.ts";
import { businessName, paperCopyAddress, sendCopiesNow } from "../agreements/copy.ts";
import {
  CODE_MS,
  claimSession,
  endStatement,
  endsAt,
  maskedAddress,
  openSession,
  parseIds,
  sessionById,
} from "../agreements/desk.ts";
import { deskMarks } from "../agreements/desk-marks.ts";
import { isMinor, personFacts } from "../agreements/due.ts";
import { adminNotice, deskRequestOf, lapsed } from "../devices/devices.ts";
import { randomCode, SESSION_CODE_LENGTH, secretHash } from "../devices/secret.ts";
import { personNameKey } from "../duplicates/normalise.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { dependantsSql, isLiveDependant } from "../visibility/guardians.ts";
import { standing, versionOut, versionsById } from "./agreement-acceptance.ts";

const id = (what: string) => z.string().min(1).max(64).describe(what);

const person = (ctx: HandlerContext) => {
  if (ctx.actor !== "human")
    throw new ForbiddenError("Only a person starts or ends a desk session");
};

/** The desk's secret and origin, or why there is no desk signing here. */
function deskOf(ctx: HandlerContext): { secret: string; origin: string } {
  if (!ctx.desk?.secret || !ctx.desk.origin) {
    throw new ConflictError(
      "Signing at the desk needs the desk hostname and the DESK_SECRET secret on this deployment.",
      { rule: "desk_not_configured" },
    );
  }
  return { secret: ctx.desk.secret, origin: ctx.desk.origin };
}

/** A Person's given name, as the tablet greets them (never their full name or anything else). */
async function givenNames(ctx: HandlerContext, ids: readonly string[]) {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return new Map<string, string>();
  const rows = await ctx.db
    .selectFrom("core_person")
    .select(["id", "given_name", "display_name"])
    .where("id", "in", wanted)
    .execute();
  return new Map(
    rows.map((r) => [r.id, (r.given_name ?? "").trim() || (r.display_name.split(/\s+/)[0] ?? "")]),
  );
}

async function liveDependants(ctx: HandlerContext, personId: string) {
  const { rows } = await sql<{ id: string; display_name: string }>`
    SELECT p.id, p.display_name FROM core_person p
    WHERE p.id IN (${dependantsSql(personId)}) ORDER BY p.display_name LIMIT 20`.execute(ctx.db);
  return rows;
}

/** Titles of what one Person has due now (nothing else of their record). */
async function dueTitles(ctx: HandlerContext, personId: string): Promise<string[]> {
  const facts = await personFacts(ctx.db, personId);
  const { documents } = await standing(ctx, personId, facts);
  return documents.filter((d) => d.status === "due").map((d) => d.title);
}

/**
 * The copy goes to the address pinned at the start, and the spec's second copy to the previous
 * address is not built (ADR 0649, the owner to decide). Meanwhile, a session started for a Person
 * whose primary address changed in the 30 days before tells every admin at once, so "change the
 * address to one I control, then sign" is not left to a mark nobody is told of. Names nobody.
 */
async function changedAddressNotice(ctx: HandlerContext, personId: string) {
  const marks = await deskMarks(ctx.db, [
    { id: "start", personId, email: null, acceptedAt: ctx.now },
  ]);
  if (!marks.get("start")?.some((m) => m.kind === "changed_recently")) return [];
  return adminNotice(ctx.db, ctx.now, {
    title: "A desk signing session was started for someone whose address changed recently",
    body:
      "Their primary email address changed in the last 30 days, and the copy of what they sign " +
      "goes to the new one. Check it was them: Settings, Agreements, Acceptances, the mark " +
      '"address changed recently".',
  });
}

// --- Staff ---------------------------------------------------------------------------------------

export const agreementDeskFind = defineOperation({
  name: "agreement.desk.find",
  description:
    "Find the Person a desk signing session is for: by their full name exactly (as a name is " +
    "compared for duplicates: case, accents and middle initials folded) or by one of their email " +
    "addresses exactly. Never a partial match or a list to page through: up to 5 people with that " +
    "very name. Names and ids only. Every search is audited. agreements:desk, a person. Read-only.",
  input: z.object({ query: z.string().trim().min(3).max(200) }).strict(),
  output: z.object({ people: z.array(z.object({ personId: z.string(), name: z.string() })) }),
  permission: "agreements:desk",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  // After the review of PR #390: a fixed-role account holding agreements:desk must not get a
  // directory of the members (stage 44: "nothing of their record beyond that"). An exact name or
  // address names whom the staff member already has in front of them; each search is on record.
  auditReads: true,
  redact: ["query"],
  auditSummary: (output) => ({ found: output.people.length }),
  async handler(input, ctx) {
    const query = input.query.trim();
    if (query.includes("@")) {
      const rows = await ctx.db
        .selectFrom("core_person_emails as e")
        .innerJoin("core_person as p", "p.id", "e.person_id")
        .select(["p.id", "p.display_name"])
        .where("e.email", "=", query.toLowerCase())
        .where("p.deleted_at", "is", null)
        .limit(5)
        .execute();
      return { people: rows.map((r) => ({ personId: r.id, name: r.display_name })) };
    }
    const key = personNameKey(query);
    // A full name: at least a given and a family name.
    if (!key || !key.includes(" ")) return { people: [] };
    const rows = await ctx.db
      .selectFrom("core_person")
      .select(["id", "display_name"])
      .where("name_key", "=", key)
      .where("deleted_at", "is", null)
      .orderBy("id")
      .limit(5)
      .execute();
    return { people: rows.map((r) => ({ personId: r.id, name: r.display_name })) };
  },
});

export const agreementDeskPrepare = defineOperation({
  name: "agreement.desk.prepare",
  description:
    "Before starting a desk signing session for a Person: the titles of what they have due, their " +
    "live children and what each has due, where the copy goes (masked), and whether a session can " +
    "start (and why not). Nothing else of their record. agreements:desk. Read-only.",
  input: z.object({ personId: id("The Person who will sign (per_…)") }).strict(),
  output: z.object({
    personId: z.string(),
    name: z.string(),
    due: z.array(z.string()),
    dependants: z
      .array(z.object({ personId: z.string(), name: z.string(), due: z.array(z.string()) }))
      .describe("The live children, by given name only"),
    copyTo: z.string().nullable().describe("Where the copy goes, masked (s•••@e•••.com)"),
    refused: z
      .enum(["minor", "no_address"])
      .nullable()
      .describe(
        "minor: a parent or guardian signs for them; no_address: the copy has nowhere to go",
      ),
  }),
  permission: "agreements:desk",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (_output, input) => ({ personId: input.personId }),
  async handler(input, ctx) {
    const facts = await personFacts(ctx.db, input.personId);
    if (!facts.exists || facts.inTrash) throw new NotFoundError("person", input.personId);
    const row = await ctx.db
      .selectFrom("core_person")
      .select("display_name")
      .where("id", "=", input.personId)
      .executeTakeFirstOrThrow();
    const children = await liveDependants(ctx, input.personId);
    const given = await givenNames(
      ctx,
      children.map((c) => c.id),
    );
    const address = await paperCopyAddress(ctx.db, input.personId);
    return {
      personId: input.personId,
      name: row.display_name,
      due: await dueTitles(ctx, input.personId),
      dependants: await Promise.all(
        children.map(async (c) => ({
          personId: c.id,
          name: given.get(c.id) ?? "",
          due: await dueTitles(ctx, c.id),
        })),
      ),
      copyTo: maskedAddress(address),
      refused: isMinor(facts) ? ("minor" as const) : address ? null : ("no_address" as const),
    };
  },
});

export const agreementDeskDevices = defineOperation({
  name: "agreement.desk.devices",
  description:
    "The devices an admin enrolled for desk signing, to choose the tablet a session is signed on: " +
    "name and when last seen. agreements:desk. Read-only.",
  input: z.object({}).strict(),
  output: z.object({
    configured: z.boolean(),
    devices: z.array(
      z.object({ id: z.string(), name: z.string(), lastSeenAt: z.string().nullable() }),
    ),
  }),
  permission: "agreements:desk",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_device")
      .select(["id", "name", "last_seen_at", "claimed_at", "enrolled_at"])
      .where("use", "=", "signing")
      .where("revoked_at", "is", null)
      .where("claimed_at", "is not", null)
      .orderBy("name")
      .limit(50)
      .execute();
    return {
      configured: Boolean(ctx.desk?.secret && ctx.desk.origin),
      // A device unused for 30 days is refused at its next call: it is not offered.
      devices: rows
        .filter((r) => !lapsed(r, ctx.now))
        .map((r) => ({ id: r.id, name: r.name, lastSeenAt: r.last_seen_at })),
    };
  },
});

const sessionState = z.object({
  id: z.string(),
  state: z.enum(["waiting", "claimed", "ended"]),
  personId: z.string().nullable(),
  device: z.object({ id: z.string(), name: z.string() }),
  claimedOn: z
    .object({ id: z.string(), name: z.string() })
    .nullable()
    .describe("The device a claim came from: the one chosen, or another that ended it"),
  startedAt: z.string(),
  codeExpiresAt: z.string(),
  claimedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  endReason: z.string().nullable(),
  signed: z.number().int().describe("Acceptances made in it"),
});

async function sessionOut(ctx: HandlerContext, sessionId: string) {
  const s = await sessionById(ctx.db, sessionId);
  // A session is its starter's to watch and end, and an admin's (after the review of PR #390):
  // anyone else is told there is no such session.
  if (!s || (s.started_by !== ctx.user.id && ctx.user.role !== "admin")) {
    throw new NotFoundError("desk session", sessionId);
  }
  const ids = [s.device_id, s.claimed_device_id].filter((x): x is string => Boolean(x));
  const devices = await ctx.db
    .selectFrom("core_device")
    .select(["id", "name"])
    .where("id", "in", ids)
    .execute();
  const nameOf = (deviceId: string) => devices.find((d) => d.id === deviceId)?.name ?? "A device";
  const signed = await ctx.db
    .selectFrom("core_agreement_acceptance")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("desk_session_id", "=", s.id)
    .executeTakeFirst();
  // An unclaimed code that ran out reads as ended, whatever the row says yet.
  const expired =
    !s.ended_at && !s.claimed_at && Date.parse(s.code_expires_at) <= Date.parse(ctx.now);
  return {
    id: s.id,
    state:
      s.ended_at || expired
        ? ("ended" as const)
        : s.claimed_at
          ? ("claimed" as const)
          : ("waiting" as const),
    personId: s.person_id,
    device: { id: s.device_id, name: nameOf(s.device_id) },
    claimedOn: s.claimed_device_id
      ? { id: s.claimed_device_id, name: nameOf(s.claimed_device_id) }
      : null,
    startedAt: s.started_at,
    codeExpiresAt: s.code_expires_at,
    claimedAt: s.claimed_at,
    endedAt: s.ended_at ?? (expired ? s.code_expires_at : null),
    endReason: s.end_reason ?? (expired ? "unclaimed" : null),
    signed: Number(signed?.n ?? 0),
  };
}

export const agreementDeskStart = defineOperation({
  name: "agreement.desk.start",
  description:
    "Start a desk signing session: the named Person signs what they have due on the enrolled " +
    "tablet chosen, and for a parent, for the live children listed. Answers an 8-character code, " +
    "single use, good for 2 minutes, to type on that tablet. Refused for a Person in the Trash, a " +
    "minor for themselves (start it for their parent or guardian), a signer with no email " +
    "address (the copy goes there every time), a child not linked to them now, and a revoked " +
    "device. Records no acceptance: the member signs. A person on the staff with agreements:desk.",
  input: z
    .object({
      personId: id("Who signs (per_…)"),
      deviceId: id("The enrolled tablet (dev_…)"),
      dependantIds: z.array(id("A live child of theirs (per_…)")).max(10).optional(),
    })
    .strict(),
  output: z.object({
    session: sessionState,
    code: z.string().describe("Shown once on the staff screen; stored only as its HMAC"),
    deskUrl: z.string().describe("Where the tablet is (the desk origin)"),
  }),
  permission: "agreements:desk",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  redactResult: ["code"],
  auditSummary: (output, input) => ({
    sessionId: output.session.id,
    personId: input.personId,
    deviceId: input.deviceId,
    dependants: input.dependantIds?.length ?? 0,
  }),
  async handler(input, ctx) {
    person(ctx);
    const desk = deskOf(ctx);
    const facts = await personFacts(ctx.db, input.personId);
    if (!facts.exists || facts.inTrash) throw new NotFoundError("person", input.personId);
    if (isMinor(facts)) {
      throw new ForbiddenError(
        "A parent or guardian signs for them: start the session for their parent or guardian.",
        { rule: "agreement_minor" },
      );
    }
    const dependants = [...new Set(input.dependantIds ?? [])];
    for (const child of dependants) {
      if (!(await isLiveDependant(ctx.db, input.personId, child))) {
        throw new NotFoundError("person", child);
      }
    }
    const email = await paperCopyAddress(ctx.db, input.personId);
    if (!email) {
      throw new ValidationError(
        "They have no email address, and the copy goes there every time: add one, or they sign on paper or on their own phone.",
        { rule: "desk_no_address" },
      );
    }
    const device = await ctx.db
      .selectFrom("core_device")
      .select(["id", "name", "use", "revoked_at", "claimed_at", "last_seen_at", "enrolled_at"])
      .where("id", "=", input.deviceId)
      .executeTakeFirst();
    if (!device) throw new NotFoundError("device", input.deviceId);
    if (
      device.revoked_at ||
      !device.claimed_at ||
      device.use !== "signing" ||
      lapsed(device, ctx.now)
    ) {
      throw new ConflictError("That device is not enrolled for desk signing now.", {
        rule: "device_use",
      });
    }
    const code = randomCode(SESSION_CODE_LENGTH);
    const sessionId = newId("agreementDeskSession");
    const expiresAt = new Date(Date.parse(ctx.now) + CODE_MS).toISOString();
    ctx.write(
      ctx.db.insertInto("core_agreement_desk_session").values({
        id: sessionId,
        person_id: input.personId,
        dependant_ids: JSON.stringify(dependants),
        device_id: device.id,
        started_by: ctx.user.id,
        started_at: ctx.now,
        email,
        code_hash: await secretHash(desk.secret, "code", code),
        code_expires_at: expiresAt,
      }),
      ...(await changedAddressNotice(ctx, input.personId)),
    );
    return {
      session: {
        id: sessionId,
        state: "waiting" as const,
        personId: input.personId,
        device: { id: device.id, name: device.name },
        claimedOn: null,
        startedAt: ctx.now,
        codeExpiresAt: expiresAt,
        claimedAt: null,
        endedAt: null,
        endReason: null,
        signed: 0,
      },
      code,
      deskUrl: desk.origin,
    };
  },
});

export const agreementDeskGet = defineOperation({
  name: "agreement.desk.get",
  description:
    "A desk signing session's state, for the staff screen that started it: waiting for its code, " +
    "claimed on which device and when, or ended and why (finished, ended by staff, run out, " +
    "claimed on another device, a wrong code, the device revoked), and how many acceptances it " +
    "made. agreements:desk. Read-only.",
  input: z.object({ sessionId: id("The session (ads_…)") }).strict(),
  output: z.object({ session: sessionState }),
  permission: "agreements:desk",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    return { session: await sessionOut(ctx, input.sessionId) };
  },
});

export const agreementDeskEnd = defineOperation({
  name: "agreement.desk.end",
  description:
    "End a desk signing session now: the tablet's next call is refused. What was signed in it " +
    "stays. agreements:desk, a person.",
  input: z.object({ sessionId: id("The session (ads_…)") }).strict(),
  output: z.object({ session: sessionState }),
  permission: "agreements:desk",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    person(ctx);
    const before = await sessionOut(ctx, input.sessionId);
    if (before.state === "ended") return { session: before };
    ctx.write(endStatement(ctx.db, input.sessionId, "staff", ctx.now));
    return {
      session: { ...before, state: "ended" as const, endedAt: ctx.now, endReason: "staff" },
    };
  },
});

// --- The tablet (the desk origin's own handler) --------------------------------------------------

const deskCall = {
  permission: "records:write",
  risk: "write",
  audiences: ["public"],
  hostInternal: true,
  deskOnly: true,
  mcp: { expose: false },
} as const;

const greeting = z.object({
  business: z.string(),
  signer: z.string().describe("The signer's given name"),
  children: z.array(z.string()).describe("The given names of the children they sign for"),
  endsAt: z.string().describe("When the session is refused next, unless there is activity"),
});

async function greetingOf(
  ctx: HandlerContext,
  session: { person_id: string | null; dependant_ids: string },
) {
  const children = parseIds(session.dependant_ids);
  const names = await givenNames(ctx, [session.person_id ?? "", ...children]);
  return {
    business: (await businessName(ctx.db)).name,
    signer: names.get(session.person_id ?? "") ?? "",
    children: children.map((c) => names.get(c) ?? "").filter(Boolean),
  };
}

export const deskClaim = defineOperation({
  ...deskCall,
  name: "desk.claim",
  description:
    "On the enrolled desk tablet: type the code a person on the staff was given. Binds their " +
    "session to this device and sets its token in a cookie (never in the answer); the device's " +
    "credential is replaced in the same answer. Answers the business, the signer's given name and " +
    "their children's. Wrong codes: five in a minute lock the device for five minutes.",
  input: z.object({ code: z.string().min(1).max(40) }).strict(),
  output: greeting,
  redact: ["code"],
  auditSummary: () => ({}),
  async handler(input, ctx) {
    const { desk, request } = deskRequestOf(ctx.desk);
    const claim = await claimSession(ctx.db, desk, request, input.code, ctx.now);
    ctx.write(...claim.statements);
    return {
      ...(await greetingOf(ctx, claim.session)),
      endsAt: endsAt(claim.session, ctx.now),
    };
  },
});

const deskItem = z.object({
  forPersonId: z.string().nullable().describe("A child the signer agrees for; null: the signer"),
  forName: z.string().describe("Whose it is, by given name"),
  documentId: z.string(),
  title: z.string(),
  reason: z.enum(["never", "agree_again", "ask_again", "guardian"]),
  version: versionOut,
});

/** What is due now for the session's signer and the children still linked to them. */
async function sessionDue(
  ctx: HandlerContext,
  session: { person_id: string | null; dependant_ids: string },
) {
  const signer = session.person_id;
  if (!signer) return [];
  const children: string[] = [];
  for (const child of parseIds(session.dependant_ids)) {
    if (await isLiveDependant(ctx.db, signer, child)) children.push(child);
  }
  const names = await givenNames(ctx, [signer, ...children]);
  const items: z.infer<typeof deskItem>[] = [];
  for (const whom of [signer, ...children]) {
    const facts = await personFacts(ctx.db, whom);
    if (!facts.exists || facts.inTrash) continue;
    const { documents } = await standing(ctx, whom, facts);
    const due = documents.filter((d) => d.status === "due");
    const versions = await versionsById(
      ctx,
      due.map((d) => d.versionId),
    );
    for (const d of due) {
      const version = versions.get(d.versionId);
      if (!version) continue;
      items.push({
        forPersonId: whom === signer ? null : whom,
        forName: names.get(whom) ?? "",
        documentId: d.documentId,
        title: d.title,
        reason: d.reason ?? "never",
        version,
      });
    }
  }
  return items;
}

export const deskDocuments = defineOperation({
  ...deskCall,
  name: "desk.documents",
  description:
    "On the enrolled desk tablet, in a claimed session: what the signer (and each child they sign " +
    "for) has due now, each document's version in effect to read and agree to, and where the copy " +
    "goes, masked. Nothing else of anyone's record. Counts as activity.",
  input: z.object({}).strict(),
  output: greeting.extend({ items: z.array(deskItem), copyTo: z.string().nullable() }),
  auditSummary: (output) => ({ items: output.items.length }),
  async handler(_input, ctx) {
    const { desk, request } = deskRequestOf(ctx.desk);
    const open = await openSession(ctx.db, desk, request, ctx.now, "activity");
    ctx.write(...open.statements);
    return {
      ...(await greetingOf(ctx, open.session)),
      endsAt: endsAt(open.session, ctx.now),
      items: await sessionDue(ctx, open.session),
      copyTo: maskedAddress(open.session.email),
    };
  },
});

export const deskAccept = defineOperation({
  ...deskCall,
  name: "desk.accept",
  description:
    "On the enrolled desk tablet, in a claimed session: the signer agrees to a version due now, " +
    "for themselves or (forPersonId) for a child the session lists and who is still linked to " +
    "them. Recorded as their own acceptance at the desk, with the session (who started it, the " +
    "device); the copy is emailed to the address pinned at the start. Refused for anything not " +
    "due for them now.",
  input: z
    .object({
      versionId: id("The version (agv_…), as desk.documents gave it"),
      forPersonId: id("A child the session lists (per_…); left out: the signer").optional(),
      typedName: typedNameSchema,
      signature: signatureSchema.optional(),
      answers: answersSchema.optional(),
    })
    .strict(),
  output: z.object({ acceptedAt: z.string(), documentId: z.string(), versionNumber: z.number() }),
  redact: ["typedName", "signature", "answers"],
  auditSummary: (output) => ({
    documentId: output.documentId,
    versionNumber: output.versionNumber,
  }),
  async handler(input, ctx) {
    const { desk, request } = deskRequestOf(ctx.desk);
    const open = await openSession(ctx.db, desk, request, ctx.now, "activity");
    const signer = open.session.person_id;
    if (!signer) throw new NotFoundError("person", "");
    const forPerson = input.forPersonId ?? signer;
    const guardian = forPerson !== signer;
    // Only the session's own people, and a child only while still linked (the batch's link guard
    // checks it again at commit).
    if (guardian && !parseIds(open.session.dependant_ids).includes(forPerson)) {
      throw new NotFoundError("person", forPerson);
    }
    const due = await sessionDue(ctx, open.session);
    const item = due.find(
      (d) => d.version.id === input.versionId && (d.forPersonId ?? signer) === forPerson,
    );
    if (!item) {
      throw new ValidationError("This document is not due for them now.", {
        rule: "agreement_not_asked",
      });
    }
    const planned = await planAcceptance(
      ctx.db,
      {
        versionId: input.versionId,
        personId: forPerson,
        by: guardian ? "guardian" : "self",
        agentPersonId: guardian ? signer : null,
        accountId: null,
        email: open.session.email,
        channel: "desk",
        deskSessionId: open.session.id,
        typedName: input.typedName,
        signature: input.signature,
        answers: input.answers,
      },
      ctx.now,
    );
    ctx.write(...open.statements, ...planned.statements);
    const output = {
      acceptedAt: planned.acceptedAt,
      documentId: planned.documentId,
      versionNumber: planned.versionNumber,
    };
    // The copy (ADR 0645): queued with the acceptance by migration 0854, sent after the commit.
    const integrations = ctx.integrations;
    return ctx.afterCommit(async () => {
      await sendCopiesNow({ db: ctx.db, integrations }, [planned.id]);
      return output;
    });
  },
});

export const deskHeartbeat = defineOperation({
  ...deskCall,
  name: "desk.heartbeat",
  description:
    "On the enrolled desk tablet, while the person reads or touches the page (at most every 30 " +
    "seconds): keeps the session from its 3-minute idle limit. A heartbeat less than 20 seconds " +
    "after the last one does not extend it, and none passes the 20-minute limit.",
  input: z.object({}).strict(),
  output: z.object({ endsAt: z.string() }),
  auditSummary: () => ({}),
  async handler(_input, ctx) {
    const { desk, request } = deskRequestOf(ctx.desk);
    const open = await openSession(ctx.db, desk, request, ctx.now, "heartbeat");
    ctx.write(...open.statements);
    return {
      endsAt: endsAt(
        open.session,
        open.active ? ctx.now : (open.session.last_activity_at ?? ctx.now),
      ),
    };
  },
});

export const deskFinish = defineOperation({
  ...deskCall,
  name: "desk.finish",
  description:
    'On the enrolled desk tablet: "All done". Ends the session at once; the token answers nothing ' +
    "again and its cookie is cleared.",
  input: z.object({}).strict(),
  output: z.object({ ended: z.boolean() }),
  auditSummary: () => ({}),
  async handler(_input, ctx) {
    const { desk, request } = deskRequestOf(ctx.desk);
    const open = await openSession(ctx.db, desk, request, ctx.now, "none");
    ctx.write(...open.statements, endStatement(ctx.db, open.session.id, "finished", ctx.now));
    request.issue({ token: null });
    return { ended: true };
  },
});

export const agreementDeskOperations = [
  agreementDeskFind,
  agreementDeskPrepare,
  agreementDeskDevices,
  agreementDeskStart,
  agreementDeskGet,
  agreementDeskEnd,
  deskClaim,
  deskDocuments,
  deskAccept,
  deskHeartbeat,
  deskFinish,
] as const;
