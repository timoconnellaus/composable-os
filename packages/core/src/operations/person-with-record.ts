// person.createWith (stage 31a, ADR 0507): a new Person and one record of an extension object that
// points at them, in one batch, refused whole. A gym's front desk books a walk-in: the Person and
// the booking are made together, so a booking the host refuses (a full class, a closed one)
// leaves no Person behind. It runs the platform's duplicate check first and never ignores it: an
// email that already belongs to someone is a refusal naming them, and possible duplicates are a
// refusal listing them unless the caller says they looked (`allowDuplicates`).
import { checkGrant } from "@composable-os/sdk";
import { z } from "zod";
import { checkPerson } from "../duplicates/check.ts";
import { duplicateMatchSchema } from "../duplicates/rules.ts";
import { ConflictError, ForbiddenError, ValidationError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { normaliseEmails, personCreate, personWritableFields } from "./person.ts";
import { checkRecordValues, createRecord, requireExtensionObject } from "./record.ts";

export const personCreateWith = defineOperation({
  name: "person.createWith",
  description:
    "Create a new person and one record of an extension object that points at them (its " +
    "`field`, a relation to person), in one batch: if the record is refused (for example a " +
    "booking into a full class), the person is not created either. The platform's duplicate " +
    "check runs first: an email that already belongs to a live person is refused (conflict, " +
    "rule person_exists, naming them), and possible duplicates (same name, same phone…) are " +
    "refused (conflict, rule possible_duplicates, listing them) unless allowDuplicates is true " +
    "because you checked they are different people. Returns both ids.",
  input: z.object({
    person: z.object(personWritableFields),
    object: z.string().min(1).max(81).describe("The extension object, e.g. bookings.booking"),
    field: z.string().min(1).max(40).describe("Its relation to person, e.g. person"),
    values: z.record(z.string().max(80), z.unknown()).default({}),
    allowDuplicates: z.boolean().default(false),
  }),
  output: z.object({ personId: z.string(), id: z.string() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const object = requireExtensionObject(input.object);
    const relation = object.fields.find((f) => f.name === input.field);
    if (relation?.fieldType !== "relation" || relation.options?.to !== "person") {
      throw new ValidationError(`${input.object}.${input.field} is not a relation to person`, {
        field: "field",
      });
    }
    // Extension code: its grant covers the record's object as well as the person (ADR 0025).
    if (ctx.extension) {
      const grant = checkGrant(ctx.extension.id, ctx.extension.permissions, {
        operation: "record.create",
        risk: "write",
        object: object.name,
      });
      if (!grant.ok) throw new ForbiddenError(grant.reason, { operation: "record.create" });
    }
    const emails = normaliseEmails(input.person.emails ?? []).map((e) => e.email);
    const checked = await checkPerson(ctx.db, {
      ...(input.person.displayName ? { displayName: input.person.displayName } : {}),
      ...(input.person.givenName ? { givenName: input.person.givenName } : {}),
      ...(input.person.familyName ? { familyName: input.person.familyName } : {}),
      emails,
      phones: (input.person.phones ?? []).map((p) => p.number),
    });
    if (checked.conflicts.length) {
      throw new ConflictError("Someone already has that email address", {
        rule: "person_exists",
        people: z.array(duplicateMatchSchema).parse(checked.conflicts),
      });
    }
    if (checked.warnings.length && !input.allowDuplicates) {
      throw new ConflictError("This may be someone already on file", {
        rule: "possible_duplicates",
        people: z.array(duplicateMatchSchema).parse(checked.warnings),
      });
    }
    // The record's own relations are checked now (the person is not stored until the batch).
    const { [input.field]: _given, ...rest } = input.values;
    await checkRecordValues(ctx, object, rest, "update");
    // Its handler only queues writes, and returns the person it made (no afterCommit).
    const person = (await personCreate.handler(input.person, ctx)) as {
      id: string;
      displayName: string;
    };
    const id = await createRecord(
      ctx,
      object,
      {
        ...(object.titleField && rest[object.titleField] === undefined
          ? { [object.titleField]: person.displayName }
          : {}),
        ...rest,
        [input.field]: person.id,
      },
      { checkReferences: false },
    );
    return { personId: person.id, id };
  },
});

export const personWithRecordOperations = [personCreateWith] as const;
