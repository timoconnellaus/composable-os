// The public-write door (stage 29 step 2, ADRs 0720 to 0722 and 0725): `intake.submit`'s work.
// The one reviewed way the public may create a record. In order (the spec's abuse checks):
//
//   1. The edge rule (per client address, at the zone) has already counted the call.
//   2. The form is published, open, within its dates and open to this caller; else not found.
//   3. A public caller's Turnstile token is verified with the env-only secret; a host with no
//      secret takes no public answers, and admins are told (once a day).
//   4. The honeypot is empty and, for the public, the form was shown at least 3 seconds ago (the
//      host's own shown-time token from `intake.open`). Failing either answers as a real
//      submission does and stores nothing.
//   5. At most 200 submissions an hour per deployment, and the form's own cap per 24 hours;
//      over either, admins are told once and the caller gets "try later".
//   6. The answers check against the version answered (types, required, lengths, at most 3 links
//      in a text): refused naming the question's key, never the value.
//   7. A sixth submission to one form in 24 hours from one mailbox (`mailboxKey`) is kept as spam,
//      and answered as a real submission is.
//
// Then, in the call's one batch, as the host's change: the submitter's Person (made, or its empty
// fields filled), the submission, any destination record, and the notice to staff. No client
// address, user agent or device fingerprint is read or stored: the door is never given one.
import {
  type Answers,
  checkAnswers,
  INTAKE_SOURCE,
  type IntakeVia,
  type Questions,
} from "@composable-os/sdk";
import { type Compilable, sql } from "kysely";
import { usableAddress } from "../customers/address-person.ts";
import { mailboxKey } from "../customers/limits.ts";
import {
  NotFoundError,
  RateLimitedError,
  UnknownOperationError,
  ValidationError,
} from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { notifyStatements } from "../notifications/send.ts";
import { type HandlerContext, type RecordChange, recordHostChange } from "../operation.ts";
import { createRecord } from "../operations/record.ts";
import { extensionSettingValues } from "../records/windows.ts";
import { isLiveDependant } from "../visibility/guardians.ts";
import { orgReader } from "../visibility/index.ts";
import { type Asker, type OpenForm, openForm } from "./forms.ts";
import {
  type LiveLink,
  linkRefused,
  liveLinkById,
  liveLinkByToken,
  useLinkStatement,
} from "./links.ts";
import { linkSubmitter, personAnswers, type Submitter, submitterOf } from "./person.ts";
import { NO_INTAKE_RUNTIME } from "./runtime.ts";

/** A form shown less than this long before it is sent was not filled in by a person. */
export const MIN_FILL_MS = 3000;
/** A shown-time token older than this is refused: the client loads the form again. */
export const SHOWN_MAX_MS = 24 * 60 * 60 * 1000;
/** Submissions an hour per deployment, across every form (the spec's default; a pack's setting). */
export const DEPLOYMENT_HOURLY_CAP = 200;
/** A mailbox's submissions to one form in 24 hours before the next is kept as spam. */
export const MAILBOX_DAILY_LIMIT = 5;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** What every caller is told when their answers were taken, kept as spam, or dropped. */
export const RECEIVED = { received: true as const };

export const TRY_LATER_ANSWERS = "This form is taking a lot of answers just now: try again later";
export const NOT_TAKING_ANSWERS = "This form cannot take answers just now: try again later";

export interface SubmitInput {
  object: string;
  id: string;
  answers: Record<string, unknown>;
  via?: IntakeVia | undefined;
  version?: number | undefined;
  turnstileToken?: string | undefined;
  shown?: string | undefined;
  honeypot?: string | undefined;
  /** A personal link's token, from its email (ADR 0723). */
  link?: string | undefined;
  /** A signed-in customer's own personal link, by its id (their "Needs your attention" item). */
  linkId?: string | undefined;
}

/** Who is calling, from the verified context: never from the input. */
export function askerOf(ctx: HandlerContext): Asker {
  const caller = ctx.onBehalfOf ?? ctx.principal;
  return caller.kind === "staff" ? "staff" : caller.kind === "customer" ? "customer" : "public";
}

/**
 * The live personal link a call names (ADR 0723), or null when it names none; any link that
 * cannot be used is the one refusal (`linkRefused`), whatever was wrong. A token is anyone's who
 * holds it (the public's, or a customer's); a link's id is only for a signed-in customer whose
 * Person it is, or who is a live guardian of that Person. Staff answer by `x.forms.enter`, never
 * by a link.
 */
export async function linkOfCall(
  ctx: HandlerContext,
  input: { link?: string | undefined; linkId?: string | undefined },
  object: string,
): Promise<LiveLink | null> {
  if (input.link === undefined && input.linkId === undefined) return null;
  const asker = askerOf(ctx);
  if (asker === "staff" || (input.link !== undefined && input.linkId !== undefined)) {
    throw linkRefused();
  }
  let link: LiveLink | null;
  if (input.link !== undefined) {
    link = await liveLinkByToken(ctx.db, input.link, ctx.now);
  } else {
    const caller = ctx.onBehalfOf ?? ctx.principal;
    if (caller.kind !== "customer") throw linkRefused();
    link = await liveLinkById(ctx.db, input.linkId as string, ctx.now);
    const theirs =
      link !== null &&
      (link.personId === caller.personId ||
        (await isLiveDependant(ctx.db, caller.personId, link.personId)));
    if (!theirs) link = null;
  }
  if (!link || link.formObject !== object || !link.formId) throw linkRefused();
  return link;
}

/** `openForm` for a personal link: a form that no longer takes answers by link is the refusal. */
export async function openLinkedForm(ctx: HandlerContext, link: LiveLink): Promise<OpenForm> {
  try {
    return await openForm(ctx, link.formObject, link.formId as string, askerOf(ctx), {
      byLink: true,
    });
  } catch (error) {
    if (error instanceof NotFoundError) throw linkRefused();
    throw error;
  }
}

/**
 * The extension whose tool made this call, or a refusal: the door is reached from a pack's own
 * tool only (staff included, ADR 0720), and only for that pack's own forms.
 */
export function assertCalledByOwner(ctx: HandlerContext, operation: string, object: string) {
  const extension = askerOf(ctx) === "staff" ? ctx.extension?.id : ctx.callingTool?.extension;
  if (!extension) throw new UnknownOperationError(operation);
  if (!object.startsWith(`${extension}.`)) throw new UnknownOperationError(operation);
}

/** Runs `statements` now, outside the call's batch: a notice that must outlive a refusal. */
async function commitNow(ctx: HandlerContext, statements: readonly Compilable[]) {
  for (const statement of statements) {
    try {
      await ctx.db.executeQuery(statement.compile());
    } catch (error) {
      console.error("intake notice not written", String((error as Error)?.message ?? error));
    }
  }
}

/** Tells admins once per key (a repeat for the same key is ignored). */
async function tellAdmins(ctx: HandlerContext, title: string, body: string, dedupeKey: string) {
  const plan = await notifyStatements(
    ctx.db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body,
      dedupeKey,
      source: { actor: "system" },
    },
    ctx.now,
  );
  await commitNow(ctx, plan.statements);
}

const columnOf = (object: ObjectDefinition, name: string) =>
  object.fields.find((f) => f.name === name)?.column ?? null;

/**
 * Live submissions of `object` made since `since`, of one form when given. `deleted_at IS NULL`
 * lets the query use the object's indexes, which are all partial on it (the reconciler's).
 */
async function countSince(
  ctx: HandlerContext,
  object: ObjectDefinition,
  formColumn: string,
  since: string,
  form?: string,
): Promise<number> {
  const table = objectTableOf(object.name);
  if (!table) return 0;
  const row = await sql<{ n: number }>`
    SELECT count(*) AS n FROM ${sql.table(table)}
    WHERE deleted_at IS NULL AND created_at > ${since}
      ${form ? sql`AND ${sql.ref(formColumn)} = ${form}` : sql``}
  `.execute(ctx.db);
  return Number(row.rows[0]?.n ?? 0);
}

/**
 * The deployment's hourly cap: the form object's `hourlyCap` setting (one a person approves) when
 * it holds a whole number of at least 1, else the platform's 200.
 */
async function hourlyCapOf(ctx: HandlerContext, form: OpenForm): Promise<number> {
  const setting = form.object.intake.hourlyCap;
  if (!setting || !form.object.extension) return DEPLOYMENT_HOURLY_CAP;
  const value = (await extensionSettingValues(ctx.db, form.object.extension))[setting];
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : DEPLOYMENT_HOURLY_CAP;
}

/** Over the deployment's hourly cap or the form's daily one: admins told once, "try later". */
async function assertUnderCaps(ctx: HandlerContext, form: OpenForm) {
  const { submission, object } = form;
  const formColumn = columnOf(submission, submission.intake.form);
  if (!formColumn) return;
  const now = Date.parse(ctx.now);
  const hourAgo = new Date(now - HOUR_MS).toISOString();
  const day = ctx.now.slice(0, 10);
  // The hourly cap counts every form's submissions, across every submission object.
  const { listObjects } = await import("../fields/index.ts");
  let lastHour = 0;
  for (const other of listObjects()) {
    if (other.intake?.role !== "submission") continue;
    const column = columnOf(other, other.intake.form);
    if (column) lastHour += await countSince(ctx, other, column, hourAgo);
  }
  const hourlyCap = await hourlyCapOf(ctx, form);
  if (lastHour >= hourlyCap) {
    await tellAdmins(
      ctx,
      "Forms are taking more answers than usual",
      `${hourlyCap} answers came in within an hour, so new ones are turned away for ` +
        "now. If this is not a busy day, it may be spam.",
      `intake.hourly_cap:${ctx.now.slice(0, 13)}`,
    );
    throw new RateLimitedError(TRY_LATER_ANSWERS, { rule: "intake_cap" });
  }
  const cap = object.intake.dailyCap ? form.values[object.intake.dailyCap] : null;
  if (typeof cap === "number" && cap >= 0) {
    const dayAgo = new Date(now - DAY_MS).toISOString();
    if ((await countSince(ctx, submission, formColumn, dayAgo, form.id)) >= cap) {
      await tellAdmins(
        ctx,
        "A form reached its daily limit",
        `A form took ${cap} answers in a day, its limit, so new ones are turned away until ` +
          "tomorrow. Raise the limit on the form if they are real.",
        `intake.daily_cap:${form.id}:${day}`,
      );
      throw new RateLimitedError(TRY_LATER_ANSWERS, { rule: "intake_cap" });
    }
  }
}

/** Whether `email`'s mailbox sent this form `MAILBOX_DAILY_LIMIT` submissions in 24 hours. */
async function mailboxOverLimit(ctx: HandlerContext, form: OpenForm, email: string) {
  const { submission } = form;
  const table = objectTableOf(submission.name);
  const formColumn = columnOf(submission, submission.intake.form);
  const answersColumn = columnOf(submission, submission.intake.answers);
  if (!table || !formColumn || !answersColumn) return false;
  const since = new Date(Date.parse(ctx.now) - DAY_MS).toISOString();
  const rows = await sql<{ email: string | null }>`
    SELECT json_extract(j.value, '$.value') AS email
    FROM ${sql.table(table)} AS t, json_each(t.${sql.ref(answersColumn)}, '$.answers') AS j
    WHERE t.deleted_at IS NULL AND t.${sql.ref(formColumn)} = ${form.id} AND t.created_at > ${since}
      AND json_extract(j.value, '$.kind') = 'email'
    LIMIT 5000
  `.execute(ctx.db);
  const mine = mailboxKey(email.toLowerCase());
  let sent = 0;
  for (const row of rows.rows) {
    if (typeof row.email === "string" && mailboxKey(row.email.trim().toLowerCase()) === mine) {
      sent += 1;
      if (sent >= MAILBOX_DAILY_LIMIT) return true;
    }
  }
  return false;
}

/** The answers the destination's listed fields take, from the questions that map to them. */
function destinationValues(
  questions: Questions,
  answers: Answers,
  listed: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of questions.items) {
    const map = "map" in item ? item.map : undefined;
    if (map?.to !== "destination") continue;
    // Only what the destination's intake lists now: never a field no declaration opened (a pack
    // upgrade that lists fewer, a version mapped to another destination's fields).
    if (!listed.includes(map.field)) continue;
    const answer = answers.answers.find((a) => a.key === item.key);
    if (!answer) continue;
    out[map.field] = answer.kind === "choice" ? (answer.values[0] ?? null) : answer.value;
  }
  return out;
}

/** Whether the person ticked a `marketing` consent line of these questions ("keep me updated"). */
function tickedMarketing(questions: Questions, answers: Answers): boolean {
  return questions.items.some(
    (item) =>
      item.kind === "consent" &&
      item.purpose === "marketing" &&
      answers.answers.some((a) => a.key === item.key && "value" in a && a.value === true),
  );
}

/** The first rating answer, in the questions' order (for dashboards). */
function firstRating(answers: Answers): number | null {
  for (const answer of answers.answers) {
    if (answer.kind === "rating" && typeof answer.value === "number") return answer.value;
  }
  return null;
}

/**
 * The host's own view of the context for its writes: org-wide reads, the caller as who they are
 * for, and every change recorded as the host's (ADR 0428). An anonymous submission's records
 * name no account (ADR 0725).
 */
function hostView(ctx: HandlerContext, anonymous: boolean): HandlerContext {
  if (ctx.principal.kind === "staff") return ctx;
  const caller = ctx.principal;
  return Object.create(ctx, {
    principal: { value: orgReader(ctx.db).principal },
    onBehalfOf: { value: caller },
    actor: { value: "automation" },
    user: {
      value: {
        id: caller.kind === "customer" && !anonymous ? caller.customerId : "public",
        email: "",
        name: caller.kind,
        role: "viewer",
      },
    },
    recordChange: { value: (change: RecordChange) => recordHostChange(ctx, change) },
  }) as HandlerContext;
}

/** The door: see the file's comment. Answers the same whether the answers were kept or dropped. */
export async function submitIntake(
  ctx: HandlerContext,
  input: SubmitInput,
): Promise<typeof RECEIVED> {
  const asker = askerOf(ctx);
  assertCalledByOwner(ctx, "intake.submit", input.object);

  // A personal link (ADR 0723): live, for this very form, and the bearer's only say in whose the
  // answers are is the link itself.
  const link = await linkOfCall(ctx, input, input.object);
  if (link && link.formId !== input.id) throw linkRefused();

  // 2. Published, open, within its dates and open to this caller (by the link, any form but a
  // staff form or an anonymous one).
  const form = link
    ? await openLinkedForm(ctx, link)
    : await openForm(ctx, input.object, input.id, asker);
  // Nothing of an anonymous form's call names the account, a refusal's audit row included
  // (ADR 0725).
  if (form.anonymous && asker === "customer") ctx.anonymise?.();
  // The version the caller was shown (intake.open's): a form published again meanwhile, anonymous
  // no longer or asking something else, is loaded again before anything is kept.
  if (input.version !== undefined && input.version !== form.version) {
    throw new ValidationError("This form has changed: load it again and send", {
      rule: "intake_reload",
    });
  }

  // 3. Turnstile, for the public (a personal link skips it: the host sent it to one Person).
  const runtime = ctx.intake ?? NO_INTAKE_RUNTIME;
  if (asker === "public" && !link) {
    if (!runtime.turnstile) {
      await tellAdmins(
        ctx,
        "Forms cannot take answers from the public",
        "The spam check (Turnstile) has no secret on this deployment, so every answer from " +
          "someone not signed in is turned away. Set TURNSTILE_SECRET_KEY (docs/deploying.md).",
        `intake.turnstile_unset:${ctx.now.slice(0, 10)}`,
      );
      throw new ValidationError(NOT_TAKING_ANSWERS, { rule: "intake_unavailable" });
    }
    if (!input.turnstileToken) {
      throw new ValidationError("The spam check did not run: try again", { rule: "turnstile" });
    }
    const verdict = await runtime.verifyTurnstile(input.turnstileToken);
    if (verdict === "unavailable") {
      throw new RateLimitedError("The spam check could not be made just now: try again shortly", {
        rule: "turnstile_unavailable",
      });
    }
    if (verdict !== "ok") {
      throw new ValidationError("The spam check did not pass: try again", { rule: "turnstile" });
    }
  }

  // 4. The honeypot (anyone outside) and the fill time (the public): success, nothing stored.
  if (asker !== "staff") {
    if (input.honeypot) return RECEIVED;
    if (asker === "public" && !link) {
      const shown = input.shown ? await runtime.readShown(form.id, input.shown) : null;
      if (!shown) return RECEIVED;
      const age = Date.parse(ctx.now) - Date.parse(shown);
      if (age < MIN_FILL_MS) return RECEIVED;
      if (age > SHOWN_MAX_MS) {
        throw new ValidationError("This form was open a long time: load it again and send", {
          rule: "intake_reload",
        });
      }
    }
  }

  // 5. The caps.
  if (asker !== "staff") await assertUnderCaps(ctx, form);

  // 6. The answers, against the version answered.
  const checked = checkAnswers(form.questions, input.answers);
  if (!checked.ok) {
    throw new ValidationError("Some answers need another look", {
      rule: "answers",
      issues: checked.issues,
    });
  }
  const answers = checked.answers;
  // A "keep me updated" tick is the person's own (decision 10): staff, and an AI working for
  // staff, never tick one for someone.
  if (asker === "staff") {
    const ticked = form.questions.items.find(
      (item) =>
        item.kind === "consent" &&
        item.purpose === "marketing" &&
        answers.answers.some((a) => a.key === item.key && "value" in a && a.value === true),
    );
    if (ticked) {
      throw new ValidationError("Only the person may tick this", {
        rule: "answers",
        issues: [{ key: ticked.key, fault: "consent", message: "Only the person may tick this" }],
      });
    }
  }
  if (asker !== "staff" && (input.via === "staff" || input.via === "link")) {
    throw new ValidationError("That is not a way in for this call", { field: "via" });
  }
  const via = asker === "staff" ? "staff" : link ? "link" : input.via;

  // 7. The per-mailbox count, then the submitter's Person (none on an anonymous form). Spam makes
  // no Person and fills nothing: it is kept with the caller's own Person or none. A personal
  // link's answers are its Person's, sent once: no mailbox to count.
  const view = hostView(ctx, form.anonymous);
  const given = form.anonymous ? {} : personAnswers(form.questions, answers);
  const typed =
    given.email && asker !== "customer" && !link ? await usableAddress(ctx, given.email) : null;
  const spam =
    asker !== "staff" && !link && given.email
      ? await mailboxOverLimit(ctx, form, given.email)
      : false;
  const caller = ctx.onBehalfOf ?? ctx.principal;
  const submitter: Submitter | null = form.anonymous
    ? null
    : link
      ? await linkSubmitter(view, link.personId, given)
      : spam
        ? caller.kind === "customer"
          ? { personId: caller.personId, certainty: "account", email: null, created: false }
          : { personId: null, certainty: "address", email: typed, created: false }
        : await submitterOf(view, given, asker);

  // The submission, as the host's own change.
  const { submission } = form;
  const declared = submission.intake;
  const states = submission.states;
  const values: Record<string, unknown> = {
    [declared.form]: form.id,
    [declared.version]: form.version,
    [declared.answers]: answers,
    ...(submitter?.personId ? { [declared.person]: submitter.personId } : {}),
    ...(submitter ? { [declared.certainty]: submitter.certainty } : {}),
    ...(declared.via && via ? { [declared.via]: via } : {}),
    ...(declared.rating ? { [declared.rating]: firstRating(answers) } : {}),
    ...(declared.marketing
      ? { [declared.marketing]: tickedMarketing(form.questions, answers) }
      : {}),
    ...(spam && states ? { [states.field]: declared.spam } : {}),
    // What the link was about (a booking): the answers are tied to it (ADR 0723).
    ...(link?.recordId && declared.about && declared.aboutObject
      ? { [declared.about]: link.recordId, [declared.aboutObject]: link.recordObject }
      : {}),
  };
  const created = submitter?.created === true;
  const submissionId = await createRecord(view, submission, values, {
    by: "host",
    // The Person made in this batch cannot be read yet; the form was read above.
    ...(created ? { checkReferences: false } : {}),
  });
  // The link is used up in the answers' own batch, by its id alone: a second answer racing this
  // one fails whole at the database (migration 1010's trigger), keeping nothing.
  if (link) ctx.write(useLinkStatement(ctx.db, link.id, submissionId, ctx.now));

  if (spam) return RECEIVED;

  // A destination record (a Lead), filled from the questions that map to it.
  if (form.destination && submitter?.personId) {
    const target = form.destination;
    await createRecord(
      view,
      target,
      {
        ...destinationValues(form.questions, answers, target.intake.fields),
        [target.intake.person]: submitter.personId,
        ...(target.intake.source ? { [target.intake.source]: INTAKE_SOURCE } : {}),
      },
      { by: "host", ...(created ? { checkReferences: false } : {}) },
    );
  }

  // Staff are told: the form's chosen person, else the admins.
  const chosen = form.object.intake.notify ? form.values[form.object.intake.notify] : null;
  const users = typeof chosen === "string" && chosen ? [chosen] : [];
  const title = form.object.titleField ? form.values[form.object.titleField] : null;
  const plan = await notifyStatements(
    ctx.db,
    {
      to: users.length ? users.map((userId) => ({ userId })) : [{ role: "admin" }],
      type: "system.message",
      title: `New answers to ${typeof title === "string" && title ? title : form.object.label}`,
      body: submitter?.certainty === "address" ? "From an unconfirmed address." : null,
      link: { kind: "record", object: submission.name, id: submissionId },
      source: { actor: "system" },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
  return RECEIVED;
}
