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
  /** Whom it is for. Null only for a guest's, which has no Person until settlement (step 3). */
  personId: string | null;
  by: "self" | "guardian" | "paper" | "guest";
  /**
   * A guest's only (stage 44 step 3, ADR 0644): what it is taken with, an order or a subscription
   * checkout, which the insert trigger requires to exist at commit (so its statements go after the
   * order's or the checkout's in the batch).
   */
  guest?: { orderId?: string | null; subscriptionCheckout?: string | null };
  /** A guardian's own Person (by: guardian). */
  agentPersonId?: string | null;
  /** The customer account that agreed (self or guardian), or null. */
  accountId?: string | null;
  email?: string | null;
  channel: "web" | "app" | "paper" | "desk";
  /**
   * At the desk (stage 44 step 6, ADR 0649): the session it was made in, which names the staff
   * account that started it and the enrolled device. The database requires it, claimed and
   * open, on every `desk` acceptance and on no other (migration 0858).
   */
  deskSessionId?: string | null;
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
  /**
   * The same person agreeing to the same version again (with the same answers) records nothing
   * and sends nothing: the existing acceptance is the answer (review of PR #274, 7b).
   */
  idempotent?: boolean;
}

export interface PlannedAcceptance {
  id: string;
  documentId: string;
  kind: string;
  title: string;
  versionNumber: number;
  anyYes: boolean;
  /** True when an identical acceptance already stood: `id` is it, and nothing is written. */
  existing: boolean;
  acceptedAt: string;
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
 * that a form needs a look. No Person (no name, no id, no link to them), question or answer: an
 * AI acting for a recipient can read their notices (notification.list), and a notice may go out
 * by email or Slack. It sends them to Settings → Agreements → Health forms, which only a person
 * with agreements:health opens (agreement.healthReviews, every read audited).
 */
export async function healthYesNotice(
  db: Db,
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
      body: "Someone answered yes to a health question. Open Settings, Agreements, Health forms.",
      link: null,
      // Not shown by notification.list; one notice per acceptance.
      dedupeKey: `agreement-health:${acceptanceId}`,
      // Its time matches the acceptance's: an AI acting for the reader never sees it at all.
      humanOnly: true,
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

  // A guest's has no Person until its order is paid (or its subscription confirmed): nobody's
  // standing is read for it, so its answer says nothing about who has the address.
  if (request.by === "guest") {
    if (
      request.personId !== null ||
      (!request.guest?.orderId && !request.guest?.subscriptionCheckout)
    ) {
      throw new ValidationError("A guest's acceptance is taken with an order", {
        rule: "agreement_guest",
      });
    }
  } else if (request.personId === null) {
    throw new NotFoundError("person", "");
  }
  const facts = request.personId === null ? null : await personFacts(db, request.personId);
  if (facts && (!facts.exists || facts.inTrash)) {
    throw new NotFoundError("person", request.personId ?? "");
  }
  if (facts && request.by === "self" && isMinor(facts)) {
    throw new ForbiddenError("A parent or guardian agrees for you.", { rule: "agreement_minor" });
  }
  if (request.by === "guardian") {
    const guardian = request.agentPersonId ?? "";
    // A minor never agrees for anyone (review of PR #274, 7a).
    if (isMinor(await personFacts(db, guardian))) {
      throw new ForbiddenError("A parent or guardian agrees for you.", { rule: "agreement_minor" });
    }
    if (!request.personId || !(await isLiveDependant(db, guardian, request.personId))) {
      // As if the Person were not there: a link is shown only to its own people (ADR 0540).
      throw new NotFoundError("person", request.personId ?? "");
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

  if (request.idempotent && request.personId !== null) {
    const same = await db
      .selectFrom("core_agreement_acceptance as a")
      .leftJoin("core_agreement_answer as n", "n.acceptance_id", "a.id")
      .select(["a.id", "a.accepted_at", "n.answers"])
      .where("a.person_id", "=", request.personId as string)
      .where("a.version_id", "=", version.id)
      .where("a.by", "=", request.by)
      .where("a.erased_at", "is", null)
      .where((eb) =>
        request.by === "guardian"
          ? eb("a.agent_person_id", "=", request.agentPersonId ?? "")
          : eb("a.agent_person_id", "is", null),
      )
      .orderBy("a.accepted_at", "desc")
      .execute();
    const wanted = answers ? JSON.stringify(answers.answers) : null;
    const match = same.find((row) => (row.answers ?? null) === wanted);
    if (match) {
      return {
        id: match.id,
        documentId: version.document_id,
        kind: version.kind,
        title: version.title,
        versionNumber: version.number,
        anyYes: answers?.anyYes ?? false,
        existing: true,
        acceptedAt: match.accepted_at,
        statements: [],
      };
    }
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
      order_id: request.by === "guest" ? (request.guest?.orderId ?? null) : null,
      subscription_checkout:
        request.by === "guest" ? (request.guest?.subscriptionCheckout ?? null) : null,
      email: request.email ?? null,
      how: request.by === "paper" ? "paper" : version.how,
      typed_name: request.typedName,
      channel: request.channel,
      desk_session_id: request.channel === "desk" ? (request.deskSessionId ?? null) : null,
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
  if (request.by === "guardian" && request.agentPersonId && request.personId) {
    statements.push(linkGuardStatement(request.agentPersonId, request.personId));
  }
  if (answers?.anyYes) {
    statements.push(...(await healthYesNotice(db, id, now)));
  }
  return {
    id,
    documentId: version.document_id,
    kind: version.kind,
    title: version.title,
    versionNumber: version.number,
    anyYes: answers?.anyYes ?? false,
    existing: false,
    acceptedAt: now,
    statements,
  };
}
