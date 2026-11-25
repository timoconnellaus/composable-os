// What objects declare for the public-write door (stage 29 step 2, ADR 0720), and the check the
// record operations run on every write of a form's questions. Kept apart from the door itself so
// the record operations can import it.
import {
  checkQuestions,
  type IntakeDestinationSpec,
  type IntakeFormSpec,
  type IntakeSubmissionSpec,
} from "@composable-os/sdk";
import { ValidationError } from "../errors.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";

export type FormObject = ObjectDefinition & { intake: IntakeFormSpec };
export type SubmissionObject = ObjectDefinition & {
  intake: IntakeSubmissionSpec & { formObject: string };
};
export type DestinationObject = ObjectDefinition & { intake: IntakeDestinationSpec };

export function formObjectOf(object: ObjectDefinition | undefined): FormObject | null {
  return object?.intake?.role === "form" ? (object as FormObject) : null;
}

/** The one object whose records answer `form` (one per form object, checked at install). */
export function submissionObjectOf(form: ObjectDefinition): SubmissionObject | null {
  const found = listObjects().find(
    (o) => o.intake?.role === "submission" && o.intake.formObject === form.name,
  );
  return (found as SubmissionObject | undefined) ?? null;
}

/** The installed object `name` when it declares itself a destination, else null. */
export function destinationObjectOf(name: unknown): DestinationObject | null {
  if (typeof name !== "string" || !name) return null;
  const object = getObject(name);
  return object?.intake?.role === "destination" ? (object as DestinationObject) : null;
}

/**
 * A submission's fields only the host writes (ADR 0720): what was answered, to which version, how
 * sure the host is of the submitter, which way it came, and whether a "keep me updated" line was
 * ticked (only the person ticks one, decision 10). Its Person stays staff's to set (after
 * a merge, an address several People had) and its state staff's to move.
 */
export function intakeHostFields(object: ObjectDefinition): Set<string> {
  if (object.intake?.role !== "submission") return new Set();
  const i = object.intake;
  return new Set(
    [
      i.form,
      i.version,
      i.answers,
      i.certainty,
      i.via,
      i.rating,
      i.marketing,
      i.about,
      i.aboutObject,
    ].filter((f): f is string => typeof f === "string"),
  );
}

/** Refuses a submission made by anyone but the host's door (ADR 0720): it is the evidence. */
export function assertSubmissionByHost(object: ObjectDefinition, by: string | undefined) {
  if (object.intake?.role === "submission" && by !== "host") {
    throw new ValidationError(
      `${object.label}: made only by the answers someone sends, never written directly`,
      { rule: "intake_host_only" },
    );
  }
}

export const isTrue = (value: unknown) => value === true || value === 1;
const filled = (value: unknown) => value !== undefined && value !== null && value !== "";

/**
 * Checks a form's questions as a write would leave the record (`values`, the whole record): the
 * question schema's own check (`checkQuestions`), with the form's anonymous flag and the fields its
 * destination's intake lists; an anonymous form with a destination; a destination that is not an
 * installed object declaring intake. The record operations call it on every create and update of
 * a form object, for every actor (ADR 0720).
 */
export function assertFormQuestions(object: ObjectDefinition, values: Record<string, unknown>) {
  const intake = formObjectOf(object)?.intake;
  if (!intake) return;
  const anonymous = intake.anonymous ? isTrue(values[intake.anonymous]) : false;
  const destinationName = intake.destination ? values[intake.destination] : null;
  const destination = destinationObjectOf(destinationName);
  if (intake.destination && filled(destinationName)) {
    if (!destination) {
      throw new ValidationError(
        `${String(destinationName)} is not something a form can make: install the pack that has it`,
        { field: intake.destination, rule: "intake_destination" },
      );
    }
    if (anonymous) {
      throw new ValidationError("An anonymous form keeps no Person, so it has no destination", {
        field: intake.destination,
        rule: "intake_destination",
      });
    }
  }
  const questions = values[intake.questions];
  if (questions === null || questions === undefined) return;
  const checked = checkQuestions(questions, {
    anonymous,
    ...(destination ? { destinationFields: destination.intake.fields } : {}),
  });
  if (checked.ok) return;
  const first = checked.issues[0];
  throw new ValidationError(
    `${object.label}: the questions are not right${first ? ` (${first.path.join(".")}: ${first.message})` : ""}`,
    {
      field: intake.questions,
      rule: "questions",
      issues: checked.issues.map((i) => ({
        path: [intake.questions, ...i.path],
        message: i.message,
      })),
    },
  );
}
