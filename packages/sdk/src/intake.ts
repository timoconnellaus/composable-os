// The `intake` behaviour (stage 29 step 2, ADR 0720): the one reviewed way the public may create
// a record. An object of a shipped pack opts in, and the host's one door, `intake.submit`, writes
// it. Its declaration, its manifest schema and its contract checks live here; the host's side (the
// door, the submitter's Person and the abuse checks) is packages/core/src/intake/.
//
// Three roles, each on an object of its own:
//
//   - `form`: what is answered (a Forms form). A publishable record whose questions are a
//     document field with the platform's QUESTIONS_SCHEMA, in its published content, with the
//     fields the host reads to decide whether it takes answers now and from whom.
//   - `submission`: one set of answers (a Forms submission). The host makes it, and nobody else:
//     it points at the form and the version answered, the submitter's Person and how sure the host
//     is of them, and holds the answers (ANSWERS_SCHEMA).
//   - `destination`: another pack's record a form may also make (a Lead), with the fields a
//     form's questions may fill.
//
// Only shipped packs and the org's own extensions declare it: it opens a write to the public.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";
import { ANSWERS_SCHEMA, QUESTIONS_SCHEMA } from "./questions.ts";

/**
 * How sure the host is whose a submission is (ADR 0721): `account`, a signed-in customer;
 * `link`, a personal link; `staff`, entered by staff; `address`, an address a visitor typed,
 * unconfirmed. An anonymous submission has none.
 */
export const INTAKE_CERTAINTIES = ["account", "link", "staff", "address"] as const;
export type IntakeCertainty = (typeof INTAKE_CERTAINTIES)[number];

/** Who may answer a form: anyone, signed-in customers, a personal link's holder, or staff. */
export const INTAKE_ANSWERED_BY = ["public", "customers", "links", "staff"] as const;
export type IntakeAnsweredBy = (typeof INTAKE_ANSWERED_BY)[number];

/** Which way a submission came in. */
export const INTAKE_VIAS = ["site", "app", "page", "link", "staff"] as const;
export type IntakeVia = (typeof INTAKE_VIAS)[number];

/** What the host writes in a destination's `source` field. */
export const INTAKE_SOURCE = "website";

/**
 * What is answered (ADR 0720). Every name is a field of this object.
 *
 * - `questions`: a document field with `QUESTIONS_SCHEMA`, one of `publishable.content`: answers
 *   are checked against the published version, and the host checks the questions on every write
 *   (`checkQuestions`, with the form's anonymous flag and its destination's fields).
 * - `answeredBy`: a select whose options are among `INTAKE_ANSWERED_BY`.
 * - `openIn`: the states of the object's `states` in which it takes answers.
 * - `anonymous` (a boolean field), `destination` (a text or select field holding an object's
 *   registry name), `opensAt` and `closesAt` (datetime fields), `dailyCap` (a number field: at
 *   most so many in 24 hours) and `notify` (a user field: who is told; left empty, the admins)
 *   are optional.
 */
export interface IntakeFormSpec {
  role: "form";
  questions: string;
  answeredBy: string;
  openIn: readonly string[];
  anonymous?: string;
  destination?: string;
  opensAt?: string;
  closesAt?: string;
  dailyCap?: string;
  notify?: string;
}

/**
 * One set of answers to one version of a form (ADR 0720). The host makes it in the call's batch;
 * no customer or public declaration may make it readable outside the org.
 *
 * - `form`: a relation (one record) to another of this extension's objects that declares
 *   `intake` with the role `form`. One submission object per form object.
 * - `version`: a number field: the form's published version answered.
 * - `answers`: a document field with `ANSWERS_SCHEMA`.
 * - `person`: a relation to `person`: the submitter's (none on an anonymous form).
 * - `certainty`: a select with exactly the options `INTAKE_CERTAINTIES`.
 * - `spam`: a state of the object's `states` the host may move to from its initial state: what a
 *   submission the host keeps as spam is created in.
 * - `via` (a select among `INTAKE_VIAS`) and `rating` (a number field: the first rating answer,
 *   for dashboards) are optional.
 */
export interface IntakeSubmissionSpec {
  role: "submission";
  form: string;
  version: string;
  answers: string;
  person: string;
  certainty: string;
  spam: string;
  via?: string;
  rating?: string;
}

/**
 * A record a form may also make (ADR 0720): its `person` (a relation to `person`), the `fields`
 * a form's questions may fill, and `source` (optional: a text or select field the host sets to
 * `website`). Its owner comes from assignment rules, as for any create.
 */
export interface IntakeDestinationSpec {
  role: "destination";
  person: string;
  fields: readonly string[];
  source?: string;
}

export type IntakeSpec = IntakeFormSpec | IntakeSubmissionSpec | IntakeDestinationSpec;

const fieldName = z.string().min(1).max(40);

export const intakeManifestSchema = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("form"),
      questions: fieldName,
      answeredBy: fieldName,
      openIn: z.array(z.string().min(1).max(100)).min(1).max(20),
      anonymous: fieldName.optional(),
      destination: fieldName.optional(),
      opensAt: fieldName.optional(),
      closesAt: fieldName.optional(),
      dailyCap: fieldName.optional(),
      notify: fieldName.optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("submission"),
      form: fieldName,
      version: fieldName,
      answers: fieldName,
      person: fieldName,
      certainty: fieldName,
      spam: z.string().min(1).max(100),
      via: fieldName.optional(),
      rating: fieldName.optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("destination"),
      person: fieldName,
      fields: z.array(fieldName).min(1).max(40),
      source: fieldName.optional(),
    })
    .strict(),
]);
export type IntakeManifest = z.infer<typeof intakeManifestSchema>;

/** Whether a document field's declared schema is exactly `schema` (one the platform owns). */
export function isPlatformSchema(field: FieldManifest | undefined, schema: unknown): boolean {
  return (
    field?.type === "document" &&
    field.schema !== undefined &&
    JSON.stringify(field.schema) === JSON.stringify(schema)
  );
}

/** Reports problems with `objects.<name>.intake` through `contract`. */
export function checkObjectIntake(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const intake = object.intake;
  if (!intake) return;
  const at = `objects.${name}.intake`;
  const own = (local: string): FieldManifest | undefined =>
    Object.hasOwn(object.fields, local) ? object.fields[local] : undefined;
  const single = (local: string | undefined, types: readonly string[]) => {
    const field = local === undefined ? undefined : own(local);
    return field !== undefined && types.includes(field.type) && !field.many;
  };
  const need = (key: string, local: string | undefined, types: readonly string[], what: string) => {
    if (local !== undefined && !single(local, types)) {
      contract(`${at}.${key}`, `"${local}" must be ${what} field of ${name}`);
    }
  };
  const options = (local: string) => (own(local)?.options ?? []).map((o) => o.value);
  const states = object.states;
  const stateValues = new Set(states ? options(states.field) : []);

  if (intake.role === "form") {
    const questions = own(intake.questions);
    if (!isPlatformSchema(questions, QUESTIONS_SCHEMA)) {
      contract(
        `${at}.questions`,
        `"${intake.questions}" must be a document field of ${name} with the platform's QUESTIONS_SCHEMA`,
      );
    }
    if (!object.publishable?.content.includes(intake.questions)) {
      contract(
        `${at}.questions`,
        `${name} must be publishable with "${intake.questions}" in its content: answers are checked against the published version`,
      );
    }
    need("answeredBy", intake.answeredBy, ["select"], "a select");
    const answeredBy = options(intake.answeredBy);
    if (
      !answeredBy.length ||
      answeredBy.some((o) => !(INTAKE_ANSWERED_BY as readonly string[]).includes(o))
    ) {
      contract(
        `${at}.answeredBy`,
        `The options of "${intake.answeredBy}" are among ${INTAKE_ANSWERED_BY.join(", ")}`,
      );
    }
    if (!states) {
      contract(`${at}.openIn`, `${name} must declare states: a form takes answers in some`);
    } else {
      for (const state of intake.openIn) {
        if (!stateValues.has(state))
          contract(`${at}.openIn`, `"${state}" is not a state of ${name}`);
      }
    }
    need("anonymous", intake.anonymous, ["boolean"], "a boolean");
    need("destination", intake.destination, ["text", "select"], "a text or select");
    need("opensAt", intake.opensAt, ["datetime"], "a datetime");
    need("closesAt", intake.closesAt, ["datetime"], "a datetime");
    need("dailyCap", intake.dailyCap, ["number"], "a number");
    need("notify", intake.notify, ["user"], "a user");
    if (object.customer || object.customerVia) {
      contract(at, "A form is read by the public through its published version: no customer");
    }
    return;
  }

  if (intake.role === "submission") {
    const form = own(intake.form);
    const target = form?.type === "relation" && !form.many ? form.to : undefined;
    const local = target?.startsWith(`${m.id}.`) ? target.slice(m.id.length + 1) : undefined;
    const formObject = local && Object.hasOwn(m.objects, local) ? m.objects[local] : undefined;
    if (!formObject || local === name || formObject.intake?.role !== "form") {
      contract(
        `${at}.form`,
        `"${intake.form}" must be a relation field (one record) to another of this extension's objects that declares intake with the role form`,
      );
    } else {
      const others = Object.entries(m.objects).filter(
        ([other, o]) =>
          other !== name &&
          o.intake?.role === "submission" &&
          o.fields[o.intake.form]?.to === target,
      );
      if (others.length) {
        contract(`${at}.form`, `${target} is answered by ${others[0]?.[0]} already: one each`);
      }
    }
    need("version", intake.version, ["number"], "a number");
    if (!isPlatformSchema(own(intake.answers), ANSWERS_SCHEMA)) {
      contract(
        `${at}.answers`,
        `"${intake.answers}" must be a document field of ${name} with the platform's ANSWERS_SCHEMA`,
      );
    }
    const person = own(intake.person);
    if (person?.type !== "relation" || person.many || person.to !== "person") {
      contract(`${at}.person`, `"${intake.person}" must be a relation field (one) to person`);
    }
    need("certainty", intake.certainty, ["select"], "a select");
    const certainty = options(intake.certainty);
    if (
      certainty.length !== INTAKE_CERTAINTIES.length ||
      INTAKE_CERTAINTIES.some((c) => !certainty.includes(c))
    ) {
      contract(
        `${at}.certainty`,
        `The options of "${intake.certainty}" are exactly ${INTAKE_CERTAINTIES.join(", ")}`,
      );
    }
    if (!states) {
      contract(`${at}.spam`, `${name} must declare states: spam is one of them`);
    } else if (!stateValues.has(intake.spam)) {
      contract(`${at}.spam`, `"${intake.spam}" is not a state of ${name}`);
    } else if (
      intake.spam !== states.initial &&
      !states.create?.in?.[intake.spam]?.includes("host") &&
      !states.moves.some(
        (move) =>
          move.to === intake.spam &&
          (move.from === states.initial ||
            (Array.isArray(move.from) && move.from.includes(states.initial))) &&
          move.by.includes("host"),
      )
    ) {
      contract(
        `${at}.spam`,
        `The host must be able to create ${name} in "${intake.spam}" (create.in, or a host move from "${states.initial}")`,
      );
    }
    if (intake.via !== undefined) {
      need("via", intake.via, ["select"], "a select");
      if (options(intake.via).some((o) => !(INTAKE_VIAS as readonly string[]).includes(o))) {
        contract(`${at}.via`, `The options of "${intake.via}" are among ${INTAKE_VIAS.join(", ")}`);
      }
    }
    need("rating", intake.rating, ["number"], "a number");
    // Nobody outside the org reads a submission, not even its submitter (ADR 0720).
    if (object.customer || object.customerVia || object.public || object.signedIn) {
      contract(at, "A submission is read by staff only: no customer, public or signedIn");
    }
    return;
  }

  const person = own(intake.person);
  if (person?.type !== "relation" || person.many || person.to !== "person") {
    contract(`${at}.person`, `"${intake.person}" must be a relation field (one) to person`);
  }
  intake.fields.forEach((local, i) => {
    const field = own(local);
    if (!field || field.type === "formula" || field.readOnly) {
      contract(`${at}.fields.${i}`, `"${local}" must be a writable field of ${name}`);
    } else if (local === intake.person || local === intake.source || local === states?.field) {
      contract(`${at}.fields.${i}`, `"${local}" is the host's to set`);
    }
  });
  if (new Set(intake.fields).size !== intake.fields.length) {
    contract(`${at}.fields`, "List each field once");
  }
  if (intake.source !== undefined) {
    need("source", intake.source, ["text", "select"], "a text or select");
    const source = own(intake.source);
    if (source?.type === "select" && !options(intake.source).includes(INTAKE_SOURCE)) {
      contract(`${at}.source`, `"${intake.source}" must have the option "${INTAKE_SOURCE}"`);
    }
  }
}
