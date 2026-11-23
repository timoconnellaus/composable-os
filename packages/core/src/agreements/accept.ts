// Every acceptance goes through here (stage 44 step 2, ADR 0642): it checks the version (intact,
// of a live document, current or scheduled), the capture (a typed name; strokes for a drawn
// document; a health form's answers), and who may agree for whom (never a minor themselves; a
// guardian only over a live link), then returns the statements for the caller's batch: the guard
// on the agreements counter, the row, the signature, the answers, a guardian's link guard and,
// for a health "yes", the notice to staff who may read health answers. The database checks the
// same rules again at commit (migration 0851), so a raw writer cannot record what this refuses.
//
// Nothing here puts a typed name, a signature or an answer in an error, a log or the audit: the
// operations redact them (`redact`), and every message names the rule only.
import type { CoreDatabase } from "@composable-os/db";
import { type Compilable, type CompiledQuery, type Kysely, sql } from "kysely";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import { isLiveDependant, linkGuardStatement } from "../visibility/guardians.ts";
import { type Answer, AnswersError, checkAnswers, type Signature } from "./capture.ts";
import { type Question, readRev, versionIntact } from "./documents.ts";
import { agreementsGuard, isMinor, personFacts } from "./due.ts";

type Db = Kysely<CoreDatabase>;

export interface AcceptRequest {
  versionId: string;
  /** Whom it is for. */
  personId: string;
  by: "self" | "guardian" | "paper";
  /** A guardian's own Person (by: guardian). */
  agentPersonId?: string | null;
  /** The customer account that agreed (self or guardian), or null. */
  accountId?: string | null;
  email?: string | null;
  channel: "web" | "app" | "paper";
  typedName: string;
  signature?: Signature | undefined;
  answers?: readonly Answer[] | undefined;
  /** Paper only. */
  paper?: {
    signedOn: string;
    recordedBy: string;
    signedBy?: string | null;
    note?: string | null;
  };
  /** The staff user who typed in a paper form's answers. */
  enteredBy?: string | null;
}

export interface PlannedAcceptance {
  id: string;
  documentId: string;
  kind: string;
  title: string;
  versionNumber: number;
  anyYes: boolean;
  statements: (Compilable | CompiledQuery)[];
}

/** The staff users who may read health answers: admins, and anyone granted agreements:health. */
async function healthReaders(db: Db): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`SELECT id FROM core_user
    WHERE kind = 'human' AND deactivated_at IS NULL AND pack_role IS NULL
      AND (role = 'admin' OR EXISTS (SELECT 1 FROM json_each(coalesce(granted_permissions, '[]'))
        WHERE value = 'agreements:health'))
    ORDER BY id`.execute(db);
  return rows.map((r) => r.id);
}

/**
 * The notice a health "yes" sends (decision 19): to staff who may read the answers, saying only
 * that a form needs a look. No name, question or answer: a notice may go out by email or Slack.
 */
export async function healthYesNotice(
  db: Db,
  personId: string,
  acceptanceId: string,
  now: string,
): Promise<Compilable[]> {
  const readers = await healthReaders(db);
  if (!readers.length) return [];
  const plan = await notifyStatements(
    db,
    {
      to: readers.map((userId) => ({ userId })),
      type: "system.message",
      title: "A member's health form needs a look",
      body: "Someone answered yes to a health question. Open their Agreements tab to read it.",
      link: { kind: "record", object: "person", id: personId },
      dedupeKey: `agreement-health:${acceptanceId}`,
      source: { actor: "system" },
    },
    now,
  );
  return plan.statements;
}

export async function planAcceptance(
  db: Db,
  request: AcceptRequest,
  now: string,
): Promise<PlannedAcceptance> {
  // The counter first: anything that changes what is due after this read fails the batch.
  const rev = await readRev(db);
  const version = await db
    .selectFrom("core_agreement_version as v")
    .innerJoin("core_agreement_document as d", "d.id", "v.document_id")
    .select([
      "v.id",
      "v.document_id",
      "v.number",
      "v.title",
      "v.body",
      "v.tick_label",
      "v.questions",
      "v.how",
      "v.who",
      "v.for_whom",
      "v.ask_again_months",
      "v.hash",
      "v.published_at",
      "d.kind",
      "d.state",
      "d.current_version_id",
    ])
    .where("v.id", "=", request.versionId)
    .executeTakeFirst();
  if (!version) throw new NotFoundError("agreement version", request.versionId);
  if (!(await versionIntact(version, version.kind))) {
    throw new ConflictError(
      "This version's stored text does not match its fingerprint, so it cannot be agreed to. Tell the business.",
      { rule: "agreement_not_intact" },
    );
  }
  const current = version.current_version_id
    ? await db
        .selectFrom("core_agreement_version")
        .select("number")
        .where("id", "=", version.current_version_id)
        .executeTakeFirst()
    : undefined;
  if (version.state !== "live" || !current || version.number < current.number) {
    throw new ConflictError(
      "This is not the version in effect: read the current one and agree to that.",
      { rule: "agreement_version_replaced" },
    );
  }

  const facts = await personFacts(db, request.personId);
  if (!facts.exists || facts.inTrash) throw new NotFoundError("person", request.personId);
  if (request.by === "self" && isMinor(facts)) {
    throw new ForbiddenError("A parent or guardian agrees for you.", { rule: "agreement_minor" });
  }
  if (request.by === "guardian") {
    const guardian = request.agentPersonId ?? "";
    if (!(await isLiveDependant(db, guardian, request.personId))) {
      // As if the Person were not there: a link is shown only to its own people (ADR 0540).
      throw new NotFoundError("person", request.personId);
    }
  }

  // How they agree is the version's.
  if (request.by !== "paper") {
    if (version.how === "drawn" && !request.signature) {
      throw new ValidationError("This document is agreed to with a drawn signature.", {
        rule: "agreement_signature",
        field: "signature",
      });
    }
    if (version.how === "typed" && request.signature) {
      throw new ValidationError("This document is agreed to by typing your name only.", {
        rule: "agreement_signature",
        field: "signature",
      });
    }
  } else if (request.signature) {
    throw new ValidationError("A paper form's signature is on the paper.", {
      rule: "agreement_signature",
      field: "signature",
    });
  }

  // A health form's answers, checked against its questions; every other kind takes none.
  let answers: { answers: Answer[]; anyYes: boolean } | null = null;
  if (version.kind === "health") {
    const questions = (version.questions ? JSON.parse(version.questions) : []) as Question[];
    if (!request.answers) {
      if (request.by !== "paper") {
        throw new ValidationError("Answer every question.", {
          rule: "agreement_answers",
          field: "answers",
        });
      }
    } else {
      try {
        answers = checkAnswers(questions, request.answers);
      } catch (error) {
        if (error instanceof AnswersError) {
          throw new ValidationError(error.message, { rule: "agreement_answers", field: "answers" });
        }
        throw error;
      }
    }
  } else if (request.answers) {
    throw new ValidationError("Only a health form has answers.", {
      rule: "agreement_answers",
      field: "answers",
    });
  }

  const id = newId("agreementAcceptance");
  const statements: (Compilable | CompiledQuery)[] = [
    agreementsGuard(rev),
    db.insertInto("core_agreement_acceptance").values({
      id,
      document_id: version.document_id,
      version_id: version.id,
      shown_hash: version.hash,
      person_id: request.personId,
      by: request.by,
      agent_person_id: request.by === "guardian" ? (request.agentPersonId ?? null) : null,
      account_id: request.accountId ?? null,
      email: request.email ?? null,
      how: request.by === "paper" ? "paper" : version.how,
      typed_name: request.typedName,
      channel: request.channel,
      accepted_at: now,
      signed_on: request.paper?.signedOn ?? null,
      recorded_by: request.paper?.recordedBy ?? null,
      signed_by: request.paper?.signedBy ?? null,
      note: request.paper?.note ?? null,
    }),
  ];
  if (request.signature) {
    statements.push(
      db.insertInto("core_agreement_signature").values({
        acceptance_id: id,
        strokes: JSON.stringify(request.signature),
      }),
    );
  }
  if (answers) {
    statements.push(
      db.insertInto("core_agreement_answer").values({
        acceptance_id: id,
        answers: JSON.stringify(answers.answers),
        any_yes: answers.anyYes ? 1 : 0,
        entered_by: request.enteredBy ?? null,
      }),
    );
  }
  if (request.by === "guardian" && request.agentPersonId) {
    statements.push(linkGuardStatement(request.agentPersonId, request.personId));
  }
  if (answers?.anyYes) {
    statements.push(...(await healthYesNotice(db, request.personId, id, now)));
  }
  return {
    id,
    documentId: version.document_id,
    kind: version.kind,
    title: version.title,
    versionNumber: version.number,
    anyYes: answers?.anyYes ?? false,
    statements,
  };
}
