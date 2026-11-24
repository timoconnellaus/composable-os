// The copy and the signed PDF (stage 44 step 4, ADR 0645).
//
// - What the PDF says (`versionDocument`, `acceptanceDocument`): the values the email gatekeeper's
//   PDF writer draws, built here from the stored version and acceptance, never stored as a file.
//   The same values give the same bytes, whether the gatekeeper attaches the file to the copy or
//   the host's download route serves it. Who sees what follows step 2's rules: a name typed and a
//   signature drawn are shown to whoever agreed (and to staff, a person); health answers to the
//   person and their guardian in a download, to staff only with agreements:health, and never in
//   the copy (decision 21: "your answers are in the app").
// - The copy (`sendAgreementCopies`): the host's own mail, one per acceptance by a person, to the
//   address the host's records hold (migration 0854 writes the row and checks the address; no
//   caller names one). It goes through `callAsHost` with purpose `agreements`, the only queue the
//   gatekeeper attaches a signed agreement for, with the idempotency key `agreement-copy:<id>`
//   (ADR 0574): a row is claimed by one sender at a time, a sender that crashed is retried with
//   the same key (the gatekeeper answers the first send again), and a new key is used only after
//   a try the gatekeeper proved was not sent. A try whose outcome is unknown is never retried.
//
// Nothing here puts a name typed, a signature or an answer in a log, an error or the approval
// card; the error column holds a category, never the gatekeeper's or the provider's words.

import type { CoreDatabase } from "@composable-os/db";
import type { AgreementPdf } from "@composable-os/pdf";
// The PDF's page estimate only (a few hundred bytes); the writer is the gatekeeper's and the
// download route's, never core's.
import { AGREEMENT_PDF_PAGE_LIMIT, fitsAgreementPdf } from "@composable-os/pdf/estimate";
import { productName } from "@composable-os/product";
import { product } from "@composable-os/products/active";
import { type Kysely, sql } from "kysely";
import { NotFoundError, OperationError } from "../errors.ts";
import type { IntegrationRuntime } from "../integrations/runtime.ts";
import { resolveChannelTarget } from "../notifications/channels.ts";
import { loadDeliverySettings } from "../notifications/preferences.ts";
import { notifyStatements } from "../notifications/send.ts";
import { loadGeneralSettings } from "../settings.ts";
import { GUARDIAN_LINK } from "../visibility/guardians.ts";
import type { Signature } from "./capture.ts";
import { deskEvidence, deskWords } from "./desk.ts";
import { type Question, versionIntact } from "./documents.ts";
import { isMinor, personFacts } from "./due.ts";

type Db = Kysely<CoreDatabase>;

/** A health form's answer, as the PDF lists it. */
export interface DocumentAnswer {
  key: string;
  yes: boolean;
  note?: string;
}

/** What the signed PDF says: the gatekeeper's `agreement` values, and the download's. */
export interface AgreementDocument {
  business: string;
  title: string;
  versionNumber: number;
  versionHash: string;
  body: { blocks: unknown[] };
  tickLabel: string;
  questions?: { key: string; text: string }[];
  answers?: DocumentAnswer[] | "in-app" | "withheld";
  record?: { label: string; value: string }[];
  signature?: Signature;
  acceptanceId?: string;
  blank?: boolean;
}

/** The idempotency key of an acceptance's copy (ADR 0574): the first try's. */
export const copyKey = (acceptanceId: string) => `agreement-copy:${acceptanceId}`;

/** The business's name, as its copies and files say it. */
export async function businessName(db: Db): Promise<{ name: string; timezone: string }> {
  const settings = await loadGeneralSettings(db);
  return { name: settings.orgName ?? productName(product), timezone: settings.timezone };
}

/** `2026-11-23 19:05`, in `timeZone`. */
export function localTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const utcTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** A version's words as the PDF draws them, checked against its hash. */
export async function versionDocument(db: Db, versionId: string): Promise<AgreementDocument> {
  const v = await db
    .selectFrom("core_agreement_version as v")
    .innerJoin("core_agreement_document as d", "d.id", "v.document_id")
    .selectAll("v")
    .select("d.kind")
    .where("v.id", "=", versionId)
    .executeTakeFirst();
  if (!v) throw new NotFoundError("agreement version", versionId);
  // A version whose stored text does not match its hash is never drawn as what was agreed.
  if (!(await versionIntact(v, v.kind))) {
    throw new OperationError("conflict", "This version's text does not match its hash.", {
      rule: "agreement_version_not_intact",
    });
  }
  const { name } = await businessName(db);
  const questions = v.questions ? (JSON.parse(v.questions) as Question[]) : null;
  return {
    business: name,
    title: v.title,
    versionNumber: v.number,
    versionHash: v.hash,
    body: JSON.parse(v.body) as { blocks: unknown[] },
    tickLabel: v.tick_label,
    ...(questions?.length
      ? { questions: questions.map((q) => ({ key: q.key, text: q.text })) }
      : {}),
  };
}

export const AGREEMENT_PDF_MAX_PAGES = AGREEMENT_PDF_PAGE_LIMIT;

/**
 * Whether a version with these words surely fits the signed PDF, with the longest record and
 * answers an acceptance of it may carry: every question answered yes with the longest note, a
 * full record and a signature (after the reviews of PR #283). A cheap upper bound
 * (`@composable-os/pdf/estimate`), never below what the writer draws: the host's core
 * does not carry the writer.
 */
export function fitsSignedPdf(draft: {
  title: string;
  body: unknown;
  tickLabel: string;
  questions: readonly Question[] | null;
}): boolean {
  const long = (n: number) => "W".repeat(n);
  return fitsAgreementPdf({
    business: long(200),
    title: draft.title,
    versionNumber: 1_000_000,
    versionHash: "0".repeat(64),
    body: (draft.body ?? { blocks: [] }) as AgreementPdf["body"],
    tickLabel: draft.tickLabel,
    ...(draft.questions?.length
      ? {
          questions: draft.questions.map((q) => ({ key: q.key, text: q.text })),
          answers: draft.questions.map((q) => ({ key: q.key, yes: true, note: long(1_000) })),
        }
      : {}),
    record: Array.from({ length: 12 }, (_, i) => ({ label: `Line ${i}`, value: long(300) })),
    signature: { width: 1000, height: 400, strokes: [[[0, 0]]] },
    acceptanceId: `aga_${"0".repeat(26)}`,
  });
}

/** The blank form of a version, to print and sign on paper. */
export async function blankDocument(db: Db, versionId: string): Promise<AgreementDocument> {
  return { ...(await versionDocument(db, versionId)), blank: true };
}

/**
 * Whose eyes a PDF is for:
 * - `person`: a person's own file (the copy, emailed to whoever agreed, and `me.agreements.pdf`),
 *   as `me` sees it: the name typed and the signature only when `me` is who agreed (a guardian's
 *   are theirs alone, step 2's second review); `answers` says whether the answers are drawn (a
 *   download) or "in the app" (the copy).
 * - `staff`: a person on the staff (`agreement.acceptance.pdf`): everything, answers only with
 *   agreements:health.
 */
export type DocumentView =
  | { kind: "person"; me: string | null; answers: "include" | "in-app" }
  | {
      kind: "staff";
      answers: boolean /** Paper free text (who signed, the note): agreements:manage only. */;
      freeText?: boolean;
    };

export interface AcceptanceFacts {
  id: string;
  personId: string | null;
  by: "self" | "guardian" | "guest" | "paper";
  agentPersonId: string | null;
  erased: boolean;
  hasAnswers: boolean;
  email: string | null;
}

/** The facts of one acceptance an operation checks before it builds the file. */
export async function acceptanceFacts(db: Db, id: string): Promise<AcceptanceFacts | null> {
  const row = await db
    .selectFrom("core_agreement_acceptance as a")
    .leftJoin("core_agreement_answer as n", "n.acceptance_id", "a.id")
    .select(["a.id", "a.person_id", "a.by", "a.agent_person_id", "a.erased_at", "a.email"])
    .select(sql<number>`n.acceptance_id IS NOT NULL`.as("has_answers"))
    .where("a.id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    personId: row.person_id,
    by: row.by,
    agentPersonId: row.agent_person_id,
    erased: row.erased_at !== null,
    hasAnswers: Boolean(row.has_answers),
    email: row.email,
  };
}

const CHANNEL_WORDS: Record<string, string> = {
  web: "on the website",
  app: "in the app",
  desk: "at the desk",
  paper: "on paper",
};

/** What one acceptance's PDF says, for `view`. */
export async function acceptanceDocument(
  db: Db,
  acceptanceId: string,
  view: DocumentView,
): Promise<AgreementDocument> {
  const a = await db
    .selectFrom("core_agreement_acceptance")
    .selectAll()
    .where("id", "=", acceptanceId)
    .executeTakeFirst();
  if (!a) throw new NotFoundError("acceptance", acceptanceId);
  const base = await versionDocument(db, a.version_id);
  const { timezone } = await businessName(db);
  const ids = [a.person_id, a.agent_person_id].filter((x): x is string => Boolean(x));
  const people = ids.length
    ? await db
        .selectFrom("core_person")
        .select(["id", "display_name"])
        .where("id", "in", ids)
        .execute()
    : [];
  const nameOf = (id: string | null) =>
    (id && people.find((p) => p.id === id)?.display_name) || null;
  // Whether the name typed and the signature are this view's to see (step 2's rule: only
  // whoever agreed). A paper form's name is whoever signed it: shown to the Person it is for
  // when they are an adult; for a minor the host cannot tell which parent signed, so only staff
  // see it (after the review of PR #283).
  const agreedBy = a.by === "guardian" ? a.agent_person_id : a.person_id;
  const paperForMinor =
    a.by === "paper" && a.person_id !== null && isMinor(await personFacts(db, a.person_id));
  const theirs =
    view.kind === "staff" || (view.me !== null && view.me === agreedBy && !paperForMinor);
  const record: { label: string; value: string }[] = [];
  record.push({
    label: "For",
    value:
      // A guest's copy goes to the address the purchase was made with, which more than one
      // Person may share: it names the buyer as they typed it, never the Person staff matched.
      a.by === "guest" && view.kind === "person" && a.typed_name
        ? `${a.typed_name} (as typed when buying)`
        : (nameOf(a.person_id) ??
          (a.erased_at
            ? "A person whose record was erased"
            : a.by === "guest"
              ? "A visitor buying without an account"
              : "Unknown")),
  });
  if (a.by === "paper") {
    const staff = a.recorded_by
      ? await db
          .selectFrom("core_user")
          .select("name")
          .where("id", "=", a.recorded_by)
          .executeTakeFirst()
      : undefined;
    record.push({
      label: "Agreed by",
      value: `Recorded from paper by ${staff?.name ?? "a member of staff"} on ${a.accepted_at.slice(0, 10)}; signed on ${a.signed_on ?? "an unknown date"}`,
    });
    if (view.kind === "staff" && view.freeText && a.signed_by)
      record.push({ label: "Signed by", value: a.signed_by });
  } else if (a.channel === "desk") {
    // At the desk (ADR 0649): what the session records, and no more.
    const guardian = a.by === "guardian" && theirs ? nameOf(a.agent_person_id) : null;
    const evidence = await deskEvidence(db, a.desk_session_id);
    record.push({
      label: "Agreed by",
      value:
        a.by === "guardian"
          ? `A parent or guardian${guardian ? `, ${guardian}` : ""}`
          : "Themselves",
    });
    if (evidence) {
      record.push({
        label: "How it was made",
        value: deskWords(evidence, (iso) => `${localTime(iso, timezone)} (${timezone})`),
      });
    }
  } else if (a.by === "guardian") {
    const guardian = theirs ? nameOf(a.agent_person_id) : null;
    record.push({
      label: "Agreed by",
      value:
        `A parent or guardian${guardian ? `, ${guardian}` : ""}, signed in ${CHANNEL_WORDS[a.channel] ?? ""}`.trim(),
    });
  } else if (a.by === "guest") {
    record.push({
      label: "Agreed by",
      value: "The buyer, without an account, with their purchase",
    });
  } else {
    record.push({
      label: "Agreed by",
      value: `Themselves, signed in ${CHANNEL_WORDS[a.channel] ?? ""}`.trim(),
    });
  }
  record.push({
    label: "How",
    value:
      a.how === "paper"
        ? "Signed a printed form of this version"
        : a.how === "drawn"
          ? "Ticked the box, typed their name and drew their signature"
          : "Ticked the box and typed their name",
  });
  if (theirs && a.typed_name) {
    record.push({
      label: a.by === "paper" ? "Name on the form" : "Name typed",
      value: a.typed_name,
    });
  }
  record.push({
    label: a.by === "paper" ? "Recorded at" : "Agreed at",
    value: `${localTime(a.accepted_at, timezone)} (${timezone}); ${utcTime(a.accepted_at)}`,
  });
  if (view.kind === "staff" && view.freeText && a.note)
    record.push({ label: "Note", value: a.note });
  record.push({ label: "Acceptance", value: a.id });

  let signature: Signature | undefined;
  if (theirs && a.how === "drawn") {
    const row = await db
      .selectFrom("core_agreement_signature")
      .select("strokes")
      .where("acceptance_id", "=", a.id)
      .executeTakeFirst();
    if (row) signature = JSON.parse(row.strokes) as Signature;
  }

  let answers: AgreementDocument["answers"];
  if (base.questions) {
    const wantAnswers = view.kind === "staff" ? view.answers : view.answers === "include";
    if (view.kind === "person" && view.answers === "in-app") answers = "in-app";
    else if (!wantAnswers) {
      const has = await db
        .selectFrom("core_agreement_answer")
        .select("acceptance_id")
        .where("acceptance_id", "=", a.id)
        .executeTakeFirst();
      if (has) answers = "withheld";
    } else {
      const row = await db
        .selectFrom("core_agreement_answer")
        .select("answers")
        .where("acceptance_id", "=", a.id)
        .executeTakeFirst();
      if (row) answers = JSON.parse(row.answers) as DocumentAnswer[];
    }
  }
  return {
    ...base,
    ...(answers !== undefined ? { answers } : {}),
    record,
    ...(signature ? { signature } : {}),
    acceptanceId: a.id,
  };
}

// --- The copy ------------------------------------------------------------------------------------

const BY_WORDS = {
  self: "You agreed to it yourself, signed in.",
  guardian:
    "You agreed to it as a parent or guardian, for someone linked to you: the attached file names who it is for.",
  guest: "You agreed to it when you bought without an account.",
  paper: "It was recorded from a paper form.",
} as const;

/** The copy's subject, text and the gatekeeper's `agreement` values. */
export async function copyMessage(
  db: Db,
  acceptanceId: string,
): Promise<{ subject: string; text: string; agreement: AgreementDocument & { summary: string } }> {
  const a = await db
    .selectFrom("core_agreement_acceptance")
    .select([
      "id",
      "by",
      "person_id",
      "agent_person_id",
      "accepted_at",
      "signed_on",
      "channel",
      "desk_session_id",
    ])
    .where("id", "=", acceptanceId)
    .executeTakeFirst();
  if (!a) throw new NotFoundError("acceptance", acceptanceId);
  // A child's paper form sent to the parent or guardian staff picked (ADR 0648): drawn as the
  // guardian's own download of the child's paper form is (no name on the form, no signer, no
  // note: the host cannot tell which parent signed), and naming the child only in the file.
  const toGuardian =
    a.by === "paper" &&
    Boolean(
      (
        await db
          .selectFrom("core_agreement_copy")
          .select("guardian_id")
          .where("acceptance_id", "=", acceptanceId)
          .executeTakeFirst()
      )?.guardian_id,
    );
  const me = toGuardian ? null : a.by === "guardian" ? a.agent_person_id : a.person_id;
  const document = await acceptanceDocument(db, acceptanceId, {
    kind: "person",
    me,
    answers: "in-app",
  });
  const { timezone } = await businessName(db);
  const when = `${localTime(a.accepted_at, timezone)} (${timezone}); ${utcTime(a.accepted_at)}`;
  const paperLine =
    a.by === "paper" && a.signed_on
      ? `It was recorded from a paper form signed on ${a.signed_on}`
      : "It was recorded from a paper form";
  // At the desk (ADR 0649): what was accepted, where, on which device, in whose session; and that
  // they should say so if it was not them. Neither the copy nor the file claims the email proves
  // who signed: it is the deterrent against staff signing for a member, not proof of presence.
  const desk = a.channel === "desk" ? await deskEvidence(db, a.desk_session_id) : null;
  if (desk) {
    const started = `${localTime(desk.startedAt, timezone)} (${timezone})`;
    const deskLines = [
      `Version ${document.versionNumber} of "${document.title}" was accepted ${a.by === "guardian" ? "by you as a parent or guardian, for someone linked to you (the attached file names who it is for)," : "for you"} at ${document.business}'s desk, on the device enrolled as ${desk.device}, in a session started by ${desk.startedBy} at ${started}.`,
      `Accepted: ${when}.`,
      "",
      "The signed agreement is attached as a PDF. You can see it at any time under My agreements, in the app or on the website.",
    ];
    if (document.questions) {
      deskLines.push(
        "",
        "The answers to the health questions are not in this email or the attached file: they are in the app.",
      );
    }
    deskLines.push("", `If this was not you, reply to this email or tell ${document.business}.`);
    return {
      subject: `${document.business}: your copy of ${document.title}`.replace(/[\r\n]+/g, " "),
      text: deskLines.join("\n"),
      agreement: {
        ...document,
        summary: `agreed ${a.by === "guardian" ? "by a parent or guardian" : "by the person"} at the desk, ${utcTime(a.accepted_at)}`,
      },
    };
  }
  const lines = [
    // The guardian's copy never says they agreed (the review of PR #301): it is a copy of a form
    // recorded from paper for a child linked to them.
    toGuardian
      ? `This is a copy of "${document.title}", version ${document.versionNumber}.`
      : `This is your copy of "${document.title}", version ${document.versionNumber}.`,
    "",
    toGuardian
      ? `${paperLine}, for someone linked to you as their parent or guardian: the attached file names who it is for.`
      : a.by === "paper"
        ? `${paperLine}.`
        : BY_WORDS[a.by],
    `${a.by === "paper" ? "Recorded" : "Agreed"}: ${when}.`,
    "",
    toGuardian
      ? "The signed form is attached as a PDF. You can see it at any time under My agreements, in the app or on the website."
      : "The signed agreement is attached as a PDF. You can see it at any time under My agreements, in the app or on the website.",
  ];
  if (document.questions) {
    lines.push(
      "",
      toGuardian
        ? "The answers to the health questions are not in this email or the attached file: they are in the app."
        : "Your answers to the health questions are not in this email or the attached file: they are in the app.",
    );
  }
  lines.push(
    "",
    toGuardian
      ? `If you think this was sent to you by mistake, reply to this email or tell ${document.business}.`
      : `If you did not agree to this, reply to this email or tell ${document.business}.`,
  );
  const summary =
    a.by === "paper"
      ? `recorded from paper, ${utcTime(a.accepted_at)}`
      : `agreed ${a.by === "guardian" ? "by a parent or guardian" : a.by === "guest" ? "by a buyer without an account" : "by the person"}, ${utcTime(a.accepted_at)}`;
  return {
    subject: `${document.business}: ${toGuardian ? "a" : "your"} copy of ${document.title}`.replace(
      /[\r\n]+/g,
      " ",
    ),
    text: lines.join("\n"),
    agreement: { ...document, summary },
  };
}

export interface CopyDeps {
  db: Db;
  integrations?: IntegrationRuntime | undefined;
  clock?: (() => Date) | undefined;
}

export interface CopyRun {
  sent: number;
  waiting: number;
  failed: number;
  retrying: number;
  /** No email channel is set, or the integration host is not reachable: nothing was tried. */
  notSetUp: string | null;
}

/** A claim may be taken again once it has been "sending" this long (a sender that crashed). */
const STALE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 8;
const SWEEP = 25;
/** The states the sender still has work for, each read in its own index range. */
const OPEN_STATES = ["queued", "sending", "waiting"] as const;

const later = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();
/** After a refusal it may be tried again: 2, 4, 8 … minutes, at most an hour. */
const retryAt = (attempts: number, now: Date) => later(now, Math.min(60, 2 ** attempts) * 60_000);
/** A copy held for a person is asked about again: 15, 30, 60 … minutes, at most a day. */
const askAgainAt = (attempts: number, now: Date) =>
  later(now, Math.min(1_440, 15 * 2 ** Math.max(0, attempts - 1)) * 60_000);

/** How long a copy waits when the sender's queue is full of other sends. */
const QUEUE_FULL_WAIT_MS = 15 * 60_000;

/**
 * Tells admins, once, that copies are waiting for an email channel (after the review of PR #283).
 * The notice names no one: how many, and where to set it.
 */
async function adminNotice(
  db: Db,
  now: string,
  notice: { title: string; body: string; dedupeKey: string },
): Promise<void> {
  const admins = await db
    .selectFrom("core_user")
    .select("id")
    .where("kind", "=", "human")
    .where("role", "=", "admin")
    .where("deactivated_at", "is", null)
    .execute();
  if (!admins.length) return;
  const plan = await notifyStatements(
    db,
    {
      to: admins.map((a) => ({ userId: a.id })),
      type: "system.message",
      title: notice.title,
      body: notice.body,
      link: null,
      dedupeKey: notice.dedupeKey,
      source: { actor: "system" },
    },
    now,
  );
  for (const statement of plan.statements) await db.executeQuery(statement.compile());
}

/**
 * Sends the copies that are due: those of `acceptanceIds` (right after they were recorded), or
 * what the minute cron finds. It reads nothing until a channel and the integration host are there;
 * then each open state's due rows in index order, stopping at the limit. Each row is claimed by
 * one sender; a claim left by a sender that crashed is taken again after ten minutes, with the
 * same idempotency key, and a copy held for a person is asked about again until it is sent or
 * turned down.
 */
export async function sendAgreementCopies(
  deps: CopyDeps,
  options: { acceptanceIds?: readonly string[] } = {},
): Promise<CopyRun> {
  const run: CopyRun = { sent: 0, waiting: 0, failed: 0, retrying: 0, notSetUp: null };
  const db = deps.db;
  const now = deps.clock?.() ?? new Date();
  const at = now.toISOString();
  if (options.acceptanceIds && !options.acceptanceIds.length) return run;

  const call = deps.integrations?.callAsHost?.bind(deps.integrations);
  if (!call) {
    run.notSetUp = "the integration host is not reachable here";
    return run;
  }
  // What the gatekeepers still hold of erased acceptances' copies, scrubbed first (a sweep
  // only), each where it went: whatever channel is current, or none.
  if (!options.acceptanceIds) await scrubErasedCopies(deps, { at, now });
  const settings = await loadDeliverySettings(db);
  const resolved = settings.email
    ? await resolveChannelTarget(db, "email", settings.email)
    : { problem: "no email channel is set in Settings, Notification delivery" };
  if ("problem" in resolved) {
    run.notSetUp = resolved.problem;
    const anyQueued = await db
      .selectFrom("core_agreement_copy")
      .select("acceptance_id")
      .where("state", "=", "queued")
      .limit(1)
      .executeTakeFirst();
    if (anyQueued) {
      await adminNotice(db, at, {
        title: "Copies of signed agreements are waiting to be emailed",
        body:
          "No email channel is set, so the copies people are owed of what they agreed to wait. " +
          "Set one in Settings, Notification delivery; they go out once it is set.",
        dedupeKey: "agreement-copy:no-channel",
      });
    }
    return run;
  }

  const due: string[] = [];
  for (const state of OPEN_STATES) {
    if (due.length >= SWEEP) break;
    let query = db
      .selectFrom("core_agreement_copy")
      .select("acceptance_id")
      .where("state", "=", state)
      .where("next_at", "<=", at)
      .orderBy("next_at")
      .limit(SWEEP - due.length);
    if (options.acceptanceIds) {
      query = query.where("acceptance_id", "in", [...options.acceptanceIds]);
    }
    for (const row of await query.execute()) due.push(row.acceptance_id);
  }

  // A child's paper copy goes only while its guardian's link is live (ADR 0648, the review of PR
  // #301): one whose link ended, or whose guardian or child went to the Trash, is cancelled
  // before any send or re-ask (migration 0857's triggers do the same the moment the link ends).
  await cancelUnlinkedGuardianCopies(db, at, due);

  for (const id of due) {
    // One sender per row: the claim either takes it or finds it taken. A guardian copy is
    // claimed only while the link is live, in the same statement.
    const { rows } = await sql<{ send_key: string; attempts: number; to_address: string | null }>`
      UPDATE core_agreement_copy
      SET state = 'sending', claimed_at = ${at}, next_at = ${later(now, STALE_MS)},
        attempts = attempts + 1,
        -- The gatekeeper this try goes to: an erase scrubs it there, whatever channel is current
        -- by then (the review of PR #288).
        via = CASE
          WHEN via IS NULL THEN json_array(${viaOf(resolved.target)})
          WHEN EXISTS (SELECT 1 FROM json_each(via) WHERE value = ${viaOf(resolved.target)})
            THEN via
          ELSE json_insert(via, '$[#]', ${viaOf(resolved.target)}) END
      WHERE acceptance_id = ${id} AND state IN ('queued', 'sending', 'waiting')
        AND next_at <= ${at}
        AND (guardian_id IS NULL OR ${liveGuardianLink("core_agreement_copy")})
      RETURNING send_key, attempts, to_address`.execute(db);
    const claimed = rows[0];
    if (!claimed) continue;
    // Settles the claim. A row erased while its send was in flight is no longer "sending" (the
    // erase cancelled it): what the gatekeeper did with the send is then scrubbed after it, so
    // the scrub always follows the last send (migration 0855, ADR 0646).
    let reached = false;
    const settle = async (set: {
      state: "queued" | "sent" | "waiting" | "failed" | "cancelled";
      error?: CopyError | null;
      attempts?: number;
      next_at: string | null;
      send_key?: string;
      pending_action_id?: string | null;
      sent_at?: string | null;
    }) => {
      const [result] = await db
        .updateTable("core_agreement_copy")
        .set({ claimed_at: null, ...set })
        .where("acceptance_id", "=", id)
        .where("state", "=", "sending")
        .execute();
      if (reached && !Number(result?.numUpdatedRows ?? 0)) await owesScrub(db, id, at);
    };

    // Erased since it was queued (a claim taken over from a crashed sender included): never sent.
    const facts = await acceptanceFacts(db, id);
    if (!facts || facts.erased || !facts.personId || !claimed.to_address) {
      await settle({ state: "cancelled", next_at: null });
      continue;
    }
    let message: Awaited<ReturnType<typeof copyMessage>>;
    try {
      message = await copyMessage(db, id);
    } catch (error) {
      await settle({ state: "failed", error: "not_drawable", next_at: null });
      run.failed += 1;
      continue;
    }
    let result: Awaited<ReturnType<NonNullable<IntegrationRuntime["callAsHost"]>>>;
    reached = true;
    try {
      result = await call({
        connectionId: resolved.target.connectionId,
        resource: resolved.target.resource,
        method: "send",
        args: [
          {
            to: [claimed.to_address],
            subject: message.subject,
            text: message.text,
            agreement: message.agreement,
            idempotencyKey: claimed.send_key,
          },
        ],
        purpose: "agreements",
      });
    } catch (error) {
      // Refused before it was queued, or a send the gatekeeper says was turned down or failed:
      // final. Anything else (the queue full, a send with this key in flight, the host
      // unreachable) is tried again later with the same key.
      const category = errorCategory(errorText(error));
      if (category === "queue_full") {
        // The sender's queue is full of other sends: like a missing channel, not this copy's
        // fault. It waits (capped), the try is not counted, and admins are told once.
        await settle({
          state: "queued",
          error: category,
          next_at: later(now, QUEUE_FULL_WAIT_MS),
          attempts: claimed.attempts - 1,
        });
        await adminNotice(db, at, {
          title: "Copies of signed agreements are waiting behind other email",
          body:
            "The email connection has too many emails waiting for approval, so copies of " +
            "signed agreements wait too. Approve or reject what waits in Approvals.",
          dedupeKey: "agreement-copy:queue-full",
        });
        run.retrying += 1;
      } else if (
        category === "invalid" ||
        category === "turned_down" ||
        claimed.attempts >= MAX_ATTEMPTS
      ) {
        await settle({ state: "failed", error: category, next_at: null });
        run.failed += 1;
      } else {
        await settle({ state: "queued", error: category, next_at: retryAt(claimed.attempts, now) });
        run.retrying += 1;
      }
      continue;
    }
    const pending = result.pending[0];
    const failed = result.failed?.[0];
    const receipt = result.value as { status?: unknown } | null;
    if (result.applied.length || receipt?.status === "sent") {
      await settle({ state: "sent", sent_at: at, error: null, next_at: null });
      run.sent += 1;
    } else if (result.denied?.length) {
      // The deploy-time floor refused it: never sent, and not asked about again.
      await settle({
        state: "failed",
        error: "floor_denied",
        next_at: null,
      });
      run.failed += 1;
    } else if (pending) {
      // A person must approve it: asked about again until it is sent or turned down.
      await settle({
        state: "waiting",
        pending_action_id: pending.actionId,
        error: null,
        next_at: askAgainAt(claimed.attempts, now),
      });
      run.waiting += 1;
    } else if (failed?.outcome === "retryable" && claimed.attempts < MAX_ATTEMPTS) {
      // Known not sent (a rate limit): a new key, since this one now names a send that failed.
      await settle({
        state: "queued",
        error: "rate_limited",
        next_at: retryAt(claimed.attempts, now),
        send_key: `${copyKey(id)}:${claimed.attempts + 1}`,
      });
      run.retrying += 1;
    } else if (failed) {
      // Refused for good, or the outcome is unknown: never tried again, so never sent twice.
      await settle({
        state: "failed",
        error: failed.outcome === "unknown" ? "outcome_unknown" : "refused",
        next_at: null,
      });
      run.failed += 1;
    } else {
      // Neither sent nor waiting on a decision the host can see: asked about again later.
      await settle({
        state: "waiting",
        error: "not_decided",
        next_at: askAgainAt(claimed.attempts, now),
      });
      run.waiting += 1;
    }
  }
  return run;
}

/** A gatekeeper a send reached, as `via` lists it: `<connection id> <resource key>`. */
const viaOf = (target: { connectionId: string; resource: string }) =>
  `${target.connectionId} ${target.resource}`;

/** A scrub is owed again, from now: the sender's send outlived the erase. */
async function owesScrub(db: Db, acceptanceId: string, at: string): Promise<void> {
  await sql`UPDATE core_agreement_copy
    SET scrub_due_at = ${at}, scrub_owed_since = coalesce(scrub_owed_since, ${at})
    WHERE acceptance_id = ${acceptanceId} AND to_address IS NULL`.execute(db);
}

/** How many owed scrubs one sweep asks for. */
const SCRUB_SWEEP = 25;
/** A scrub the gatekeeper could not finish is asked again after this. */
const SCRUB_RETRY_MS = 15 * 60_000;

/** What one sweep of owed scrubs did. */
export interface ScrubRun {
  /** Scrubbed on every gatekeeper the copy reached. */
  scrubbed: number;
  /** Of those, every gatekeeper said it held nothing for the copy's key. */
  nothingHeld: number;
  /** Still owed: a gatekeeper is gone, needs re-authorising, or failed. */
  owed: number;
}

/** One gatekeeper a copy reached, and whether the host can ask it now. */
interface ScrubTarget {
  /** As `via` names it: `<connection id> <resource key>`. */
  via: string;
  /** `ready`: ask it; `gone`: its connection or sender is no longer there; `inactive`: it is
   * there but cannot be used now (it needs re-authorising). */
  state: "ready" | "gone" | "inactive";
  target: { connectionId: string; resource: string } | null;
}

/**
 * Asks each email gatekeeper an erased acceptance's copy reached (`via`) to scrub what it still
 * holds of it (stage 44 step 8, ADR 0646): a send still waiting is dropped (never sent), a later
 * send under the copy's key is refused, and its recipients and subject leave the sent history.
 * Only the host's own agreements mail can ask it (`callAsHost`, purpose `agreements`, method
 * `scrubAgreementCopy`), by the copy's key alone; the gatekeeper answers whether it held anything,
 * never what. The scrub goes where the copy went, not to whichever channel is current.
 *
 * Every gatekeeper is asked each time, whatever another answered (the second review of PR #288);
 * those that finished are recorded (`scrub_done`), and the row is scrubbed only when all have.
 * What is left is recorded: `unreachable` when every gatekeeper left is gone, `inactive` when one
 * still exists but needs re-authorising, `failed` otherwise; admins are told once per connection
 * in question, naming nobody. Only a gatekeeper gone for 30 days lets the retention purge delete
 * the record anyway (`scrub_gone_since`, `retention.ts`). A copy row from before `via` was kept
 * is asked on the current channel.
 */
export async function scrubErasedCopies(
  deps: CopyDeps,
  options: { acceptanceIds?: readonly string[]; at?: string; now?: Date } = {},
): Promise<ScrubRun> {
  const db = deps.db;
  const now = options.now ?? deps.clock?.() ?? new Date();
  const at = options.at ?? now.toISOString();
  const run: ScrubRun = { scrubbed: 0, nothingHeld: 0, owed: 0 };
  const call = deps.integrations?.callAsHost?.bind(deps.integrations);
  if (!call) return run;
  if (options.acceptanceIds && !options.acceptanceIds.length) return run;
  let query = db
    .selectFrom("core_agreement_copy")
    .select(["acceptance_id", "via", "scrub_gone_since"])
    .where("scrub_due_at", "is not", null)
    .where("scrub_due_at", "<=", at)
    .orderBy("scrub_due_at")
    .limit(SCRUB_SWEEP);
  if (options.acceptanceIds) {
    query = query.where("acceptance_id", "in", [...options.acceptanceIds]);
  }
  const owed = await query.execute();
  if (!owed.length) return run;
  const notices = new Map<string, "gone" | "inactive">();
  for (const { acceptance_id: id, via, scrub_gone_since: goneSince } of owed) {
    const targets = await scrubTargets(db, via);
    const done: string[] = [];
    let found = false;
    let failed = false;
    for (const t of targets) {
      if (t.state !== "ready" || !t.target) {
        notices.set(t.via.split(" ")[0] ?? "", t.state === "inactive" ? "inactive" : "gone");
        continue;
      }
      try {
        const result = await call({
          connectionId: t.target.connectionId,
          resource: t.target.resource,
          method: "scrubAgreementCopy",
          args: [{ key: copyKey(id) }],
          purpose: "agreements",
        });
        const value = result.value as { done?: unknown; found?: unknown } | null;
        if (value?.done === true) {
          done.push(t.via);
          if (value.found !== false) found = true;
        } else {
          failed = true;
        }
      } catch (error) {
        // The error's kind only: nothing of the copy.
        console.error("agreement copy scrub not done; asked again later", errorKind(error));
        failed = true;
      }
    }
    const left = targets.filter((t) => !done.includes(t.via));
    if (!left.length) {
      await db
        .updateTable("core_agreement_copy")
        .set({
          scrub_due_at: null,
          scrubbed_at: at,
          scrub_error: null,
          scrub_done: JSON.stringify(done),
          scrub_gone_since: null,
        })
        .where("acceptance_id", "=", id)
        .execute();
      run.scrubbed += 1;
      if (!found) run.nothingHeld += 1;
      continue;
    }
    // Every gatekeeper left is gone: the purge's 30 days count from the first time it was so.
    const allGone = !failed && left.every((t) => t.state === "gone");
    const error = allGone
      ? ("unreachable" as const)
      : left.some((t) => t.state === "inactive")
        ? ("inactive" as const)
        : ("failed" as const);
    await db
      .updateTable("core_agreement_copy")
      .set({
        scrub_due_at: later(now, SCRUB_RETRY_MS),
        scrub_error: error,
        scrub_done: JSON.stringify(done),
        scrub_gone_since: allGone ? (goneSince ?? at) : null,
      })
      .where("acceptance_id", "=", id)
      .where("scrub_due_at", "is not", null)
      .execute();
    run.owed += 1;
  }
  for (const [connection, why] of notices) {
    await adminNotice(db, at, {
      title:
        why === "gone"
          ? "Erased people's agreement copies could not be scrubbed: a connection is gone"
          : "Erased people's agreement copies wait for an email connection to be reconnected",
      body:
        why === "gone"
          ? `The email connection ${connection} that sent copies of signed agreements is gone, so ` +
            "what it held of copies sent to people since erased cannot be scrubbed. After 30 days " +
            "the retention purge deletes the records anyway, and its audit names the connection."
          : `The email connection ${connection} that sent copies of signed agreements needs to be ` +
            "reconnected before what it holds of copies sent to people since erased can be " +
            "scrubbed. Until then the records are kept, and the scrub is asked again.",
      dedupeKey: `agreement-copy:scrub-${why}:${connection}`,
    });
  }
  return run;
}

/**
 * The gatekeepers to scrub: each `via` names, with whether it can be asked now. A connection that
 * no longer exists, or no longer has that sender bound, is gone; one that exists but is not
 * active (it needs re-authorising) is inactive, never gone. A row from before `via` was kept: the
 * current channel.
 */
async function scrubTargets(db: Db, via: string | null): Promise<ScrubTarget[]> {
  let listed: string[] = [];
  try {
    listed = via ? (JSON.parse(via) as string[]) : [];
  } catch {}
  if (!listed.length) {
    const settings = await loadDeliverySettings(db);
    if (!settings.email) return [{ via: "current channel", state: "gone", target: null }];
    listed = [`${settings.email} `];
  }
  const out: ScrubTarget[] = [];
  for (const entry of listed) {
    const [connectionId = "", resource = ""] = String(entry).split(" ");
    const resolved = await resolveChannelTarget(db, "email", connectionId);
    if (!("problem" in resolved)) {
      const same = !resource || resolved.target.resource === resource;
      out.push(
        same
          ? { via: entry, state: "ready", target: resolved.target }
          : { via: entry, state: "gone", target: null },
      );
      continue;
    }
    const row = await db
      .selectFrom("core_integration_connection")
      .select(["status"])
      .where("id", "=", connectionId)
      .executeTakeFirst();
    out.push({
      via: entry,
      state: row && row.status !== "disconnected" ? "inactive" : "gone",
      target: null,
    });
  }
  return out;
}

const errorKind = (error: unknown) => (error instanceof Error ? error.name : "error");

/**
 * Sends the copies of acceptances just recorded, right after the commit. Best effort: what does
 * not go now is the minute cron's (`sendAgreementCopies` with no ids), and a failure never fails
 * the call that recorded the acceptance.
 */
export async function sendCopiesNow(
  deps: CopyDeps,
  acceptanceIds: readonly string[],
): Promise<void> {
  try {
    await sendAgreementCopies(deps, { acceptanceIds });
  } catch (error) {
    // The error's kind only: its message may name the gatekeeper's view of the message.
    console.error(
      "agreement copy not sent now; the minute cron tries again",
      error instanceof Error ? error.name : "error",
    );
  }
}

/**
 * What went wrong, as a category: never the provider's or the gatekeeper's own words, which may
 * name the recipient (after the second review of PR #283). Staff and the audit see only this.
 */
export type CopyError =
  | "queue_full"
  | "invalid"
  | "turned_down"
  | "refused"
  | "rate_limited"
  | "outcome_unknown"
  | "floor_denied"
  | "not_decided"
  | "not_drawable"
  | "unreachable";

function errorCategory(text: string): CopyError {
  if (/Too many pending/.test(text)) return "queue_full";
  if (/Invalid email/.test(text)) return "invalid";
  if (/Refused:/.test(text)) return "turned_down";
  return "unreachable";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the copy row `alias` (a trusted table name or alias, never input) still has a live link
 * from its guardian to the Person its acceptance is for: the link not ended, both out of the
 * Trash, as the seam reads it and as migration 0857 checks it.
 */
function liveGuardianLink(alias: string) {
  const c = sql.raw(alias);
  return sql`EXISTS (SELECT 1 FROM core_agreement_acceptance a
    JOIN core_person_link l ON l.dependant_id = a.person_id AND l.guardian_id = ${c}.guardian_id
      AND l.kind = ${GUARDIAN_LINK} AND l.ended_at IS NULL
    JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
    JOIN core_person d ON d.id = l.dependant_id AND d.deleted_at IS NULL
    WHERE a.id = ${c}.acceptance_id)`;
}

/**
 * Cancels the guardian copies of `ids` still open (queued, sending, or waiting for a person's
 * approval) whose guardian's link to the child is no longer live (the review of PR #301), as
 * migration 0857's triggers do when the link ends: the pending approval turned down and redacted
 * first, so nobody can release the held send; the address cleared and the end recorded
 * (`guardian_ended_at`); the scrub owed if a try ever reached the email gatekeeper.
 */
export async function cancelUnlinkedGuardianCopies(
  db: Db,
  at: string,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const these = sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  const open = sql`c.guardian_id IS NOT NULL AND c.state IN ('queued', 'sending', 'waiting')
    AND c.acceptance_id IN ${these} AND NOT ${liveGuardianLink("c")}`;
  await db.executeQuery(
    sql`UPDATE core_pending_action SET
        input = ${JSON.stringify("[erased]")}, reason = ${"[erased]"}, preview = '[]',
        simulated = ${JSON.stringify({ output: null, records: [] })},
        status_reason = CASE WHEN status = 'pending'
          THEN 'Rejected: the parent or guardian it was for is no longer linked to the child'
          ELSE status_reason END,
        decided_at = CASE WHEN status = 'pending' THEN ${at} ELSE decided_at END,
        status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END
      WHERE id IN (SELECT c.pending_action_id FROM core_agreement_copy c
        WHERE c.pending_action_id IS NOT NULL AND ${open})`.compile(db),
  );
  await db.executeQuery(
    sql`UPDATE core_agreement_copy SET
        scrub_due_at = CASE WHEN attempts > 0 THEN ${at} ELSE scrub_due_at END,
        scrub_owed_since = CASE WHEN attempts > 0 THEN coalesce(scrub_owed_since, ${at})
          ELSE scrub_owed_since END,
        to_address = NULL, next_at = NULL, error = NULL, pending_action_id = NULL,
        state = 'cancelled', guardian_ended_at = ${at}
      WHERE acceptance_id IN (SELECT c.acceptance_id FROM core_agreement_copy c WHERE ${open})`.compile(
      db,
    ),
  );
}

/** A live parent or guardian of a child a paper form's copy may go to, and their address. */
export interface PaperCopyGuardian {
  personId: string;
  name: string;
  /** The address the host holds for them (`paperCopyAddress`), or none. */
  to: string | null;
}

/**
 * Where a paper form's copy goes, or why it does not: the one place that decides it.
 *
 * - For a Person who is a minor (marked, or a live dependant): never to the child. It goes to the
 *   live parent or guardian staff pick (the owner's decision of 2026-11-24, ADR 0648): `guardians`
 *   lists each live guardian of the child (the link not ended, both out of the Trash) with the
 *   address the host holds for them, by the same rule as an adult's own. None of them with an
 *   address: not sent (staff give the guardian the PDF download).
 * - Otherwise the Person's own sign-in address (an active, linked account's), or their primary
 *   address; none: not sent.
 *
 * Which guardians a member of staff may see is the seam's, asked by the operation; migration
 * 0857 checks the address and the live link again in the batch that queues the copy.
 */
export async function paperCopyRecipient(
  db: Db,
  personId: string,
): Promise<
  | { to: string }
  | { guardians: PaperCopyGuardian[] }
  | { refused: "minor"; guardians: PaperCopyGuardian[] }
  | { refused: "no_address" }
> {
  if (isMinor(await personFacts(db, personId))) {
    const guardians = await paperCopyGuardians(db, personId);
    return guardians.some((g) => g.to) ? { guardians } : { refused: "minor", guardians };
  }
  const to = await paperCopyAddress(db, personId);
  return to ? { to } : { refused: "no_address" };
}

/** The child's live parents and guardians, as the seam reads a live link, each with an address. */
async function paperCopyGuardians(db: Db, childId: string): Promise<PaperCopyGuardian[]> {
  const rows = await db
    .selectFrom("core_person_link as l")
    .innerJoin("core_person as g", "g.id", "l.guardian_id")
    .innerJoin("core_person as d", "d.id", "l.dependant_id")
    .select(["g.id", "g.display_name"])
    .where("l.dependant_id", "=", childId)
    .where("l.kind", "=", GUARDIAN_LINK)
    .where("l.ended_at", "is", null)
    .where("g.deleted_at", "is", null)
    .where("d.deleted_at", "is", null)
    .orderBy("g.display_name")
    .orderBy("g.id")
    .execute();
  const out: PaperCopyGuardian[] = [];
  for (const g of rows) {
    out.push({ personId: g.id, name: g.display_name, to: await paperCopyAddress(db, g.id) });
  }
  return out;
}

/** The address the host holds for a Person: their sign-in address, or their primary one. */
/**
 * The address the host holds for a Person, as a copy is sent to it: their active, linked customer
 * account's sign-in address, else their primary address (a paper form's copy, and the address a
 * desk session pins at its start, ADR 0649).
 */
export async function paperCopyAddress(db: Db, personId: string): Promise<string | null> {
  const account = await db
    .selectFrom("core_customer")
    .select("email")
    .where("person_id", "=", personId)
    .where("status", "=", "active")
    .where("link_state", "=", "linked")
    .executeTakeFirst();
  if (account?.email) return account.email;
  const email = await db
    .selectFrom("core_person_emails")
    .select("email")
    .where("person_id", "=", personId)
    .orderBy("is_primary", "desc")
    .orderBy("position")
    .executeTakeFirst();
  return email?.email ?? null;
}
