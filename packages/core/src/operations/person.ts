// person.* operations. The reference implementation of the operation pattern: read with ctx.db,
// queue writes with ctx.write, record before/after snapshots with ctx.recordChange, and return
// the record (reading it after commit where that is simpler). See ../../README.md.

import type { CoreDatabase } from "@composable-os/db";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import {
  agreementAddresses,
  mergeMovesAgreements,
  queueMergeAgreements,
} from "../agreements/people.ts";
import { queueMergeAllowances } from "../allowance/people.ts";
import { assignOwner, recordAssignment } from "../assignment/index.ts";
import { queueMergeCustomers } from "../customers/merge.ts";
import { checkPerson } from "../duplicates/check.ts";
import { personNameKey } from "../duplicates/normalise.ts";
import { queueClosePairs } from "../duplicates/pairs.ts";
import { possibleDuplicatesSchema } from "../duplicates/rules.ts";
import { assertRecordCapacity } from "../entitlements.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { personObject } from "../fields/person.ts";
import { newId } from "../ids.ts";
import {
  assertMayChangeBirthday,
  assertMergeKeepsMemberBirthday,
  BIRTHDAY_FIELD,
  birthdayGuard,
  birthdayOf,
  birthdaySchema,
  mergedBirthday,
  queueSetBirthday,
} from "../journeys/birthday.ts";
import { queueMergeSignals } from "../journeys/signals.ts";
import { listInputSchema, pageSchema, runListQuery, selectFields } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { queueMergeOrders } from "../orders/merge.ts";
import { matchPersonAddresses } from "../outside/match.ts";
import { queueMergePersonCodes } from "../people-codes/people.ts";
import { queueMergePractitioners } from "../practitioners/merge.ts";
import { holdsPermission } from "../principals.ts";
import { bulkTagListSchema, queueBulkTags } from "../records/bulk-tags.ts";
import {
  assertUserExists,
  BATCH_MAX,
  blankToNull,
  chunk,
  restorableUntil,
  TRASH_RETENTION_DAYS,
  uniqueIds,
  withPrimary,
} from "../records/common.ts";
import {
  afterErase,
  countRedactions,
  eraseCountsOutput,
  queueErase,
  withMergedRecords,
} from "../records/erase.ts";
import { personSubject } from "../records/erase-subject.ts";
import { countLinks, queueClearTags, queueMoveLinks } from "../records/links.ts";
import {
  dependantsLeftAlone,
  planMergeLinks,
  queueEraseLinks,
  queueMergeLinks,
} from "../records/person-links.ts";
import { queueRepointRelations } from "../records/relations.ts";
import { loadTags, queueSetTags, tagsInputSchema } from "../records/tags.ts";
import { endErasedSubscriptions } from "../subscriptions/erase.ts";
import { queueMergeSubscriptions } from "../subscriptions/merge.ts";
import { type Reader, visibleTable } from "../visibility/index.ts";
import { setCoreWriter } from "../visibility/writes.ts";
import {
  type Affiliation,
  affiliationSchema,
  affiliationSnapshot,
  calendarDate,
  loadPrimaryAffiliation,
  queueInsertAffiliation,
  requireAffiliation,
  requireLiveOrganisation,
  today,
} from "./affiliation.ts";

export { TRASH_RETENTION_DAYS } from "../records/common.ts";

// --- Schemas -----------------------------------------------------------------------------------

const personId = z.string().startsWith("per_").max(64).describe("Person id (per_…)");
const userId = z.string().min(1).max(64).describe("User id (usr_…)");
const shortText = (max: number) => z.string().trim().max(max);

export const emailInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  label: shortText(50).nullish().describe("e.g. work, personal"),
  primary: z.boolean().optional().describe("Exactly one email is primary; default the first."),
});

export const phoneInputSchema = z.object({
  number: shortText(50).min(1),
  label: shortText(50).nullish().describe("e.g. mobile, work"),
  primary: z.boolean().optional().describe("Exactly one phone is primary; default the first."),
});

export const socialProfileSchema = z.object({
  network: shortText(50).min(1).describe("e.g. linkedin, x, github"),
  url: z.url().max(500),
  handle: shortText(100).optional(),
});

export const personWritableFields = {
  givenName: shortText(100).nullish(),
  familyName: shortText(100).nullish(),
  displayName: shortText(200)
    .min(1)
    .optional()
    .describe("Shown name. Defaults to given + family name, or the primary email."),
  emails: z.array(emailInputSchema).max(20).optional(),
  phones: z.array(phoneInputSchema).max(20).optional(),
  location: shortText(200).nullish().describe("Free text, e.g. 'Sydney, Australia'"),
  timezone: shortText(64).nullish().describe("IANA timezone, e.g. Australia/Sydney"),
  socialProfiles: z.array(socialProfileSchema).max(20).optional(),
  avatarKey: shortText(500).nullish().describe("R2 object key of an uploaded avatar"),
  ownerId: userId.nullish().describe("The user who owns this person"),
  description: z.string().max(50_000).nullish().describe("Markdown"),
  tags: tagsInputSchema.optional(),
};

const emailSchema = z.object({
  email: z.string(),
  label: z.string().nullable(),
  primary: z.boolean(),
});
const phoneSchema = z.object({
  number: z.string(),
  label: z.string().nullable(),
  primary: z.boolean(),
});

export const personSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  givenName: z.string().nullable(),
  familyName: z.string().nullable(),
  emails: z.array(emailSchema),
  phones: z.array(phoneSchema),
  location: z.string().nullable(),
  timezone: z.string().nullable(),
  socialProfiles: z.array(socialProfileSchema),
  avatarKey: z.string().nullable(),
  ownerId: z.string().nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  /** Day and month only (stage 53, ADR 0803); null when none is recorded. */
  birthday: birthdaySchema.nullable(),
  /** Derived from the primary affiliation. */
  jobTitle: z.string().nullable(),
  primaryAffiliation: z
    .object({
      id: z.string(),
      organisationId: z.string(),
      organisationName: z.string().nullable(),
      title: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  mergedIntoId: z.string().nullable(),
});
export type Person = z.infer<typeof personSchema>;

export const personListItemSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  givenName: z.string().nullable(),
  familyName: z.string().nullable(),
  primaryEmail: z.string().nullable(),
  emails: z.array(z.string()),
  primaryPhone: z.string().nullable(),
  jobTitle: z.string().nullable(),
  organisationId: z.string().nullable(),
  organisationName: z.string().nullable(),
  location: z.string().nullable(),
  timezone: z.string().nullable(),
  ownerId: z.string().nullable(),
  avatarKey: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PersonListItem = z.infer<typeof personListItemSchema>;
const PERSON_LIST_FIELDS = Object.keys(personListItemSchema.shape);

// --- Reading -----------------------------------------------------------------------------------

/** Loads a person with emails, phones, tags and primary affiliation. Null when absent. */
export async function loadPerson(
  reader: Reader,
  id: string,
  { includeDeleted = false } = {},
): Promise<Person | null> {
  const { db } = reader;
  let query = db.selectFrom(visibleTable(reader, "person")).selectAll().where("id", "=", id);
  if (!includeDeleted) query = query.where("deleted_at", "is", null);
  const row = await query.executeTakeFirst();
  if (!row) return null;

  const [emails, phones, tags, affiliation] = await Promise.all([
    db
      .selectFrom("core_person_emails")
      .select(["email", "label", "is_primary"])
      .where("person_id", "=", id)
      .orderBy("position")
      .execute(),
    db
      .selectFrom("core_person_phones")
      .select(["number", "label", "is_primary"])
      .where("person_id", "=", id)
      .orderBy("position")
      .execute(),
    loadTags(db, "person", [id]),
    db
      .selectFrom("core_affiliation as a")
      .leftJoin("core_organisation as o", "o.id", "a.organisation_id")
      .select(["a.id", "a.organisation_id", "a.title", "o.name as organisation_name"])
      .where("a.person_id", "=", id)
      .where("a.is_primary", "=", 1)
      .where("a.deleted_at", "is", null)
      .executeTakeFirst(),
  ]);

  return {
    id: row.id,
    displayName: row.display_name,
    givenName: row.given_name,
    familyName: row.family_name,
    emails: emails.map((e) => ({ email: e.email, label: e.label, primary: e.is_primary === 1 })),
    phones: phones.map((p) => ({ number: p.number, label: p.label, primary: p.is_primary === 1 })),
    location: row.location,
    timezone: row.timezone,
    socialProfiles: JSON.parse(row.social_profiles) as Person["socialProfiles"],
    avatarKey: row.avatar_key,
    ownerId: row.owner_id,
    description: row.description,
    tags: tags.get(id) ?? [],
    birthday: birthdayOf(row),
    jobTitle: affiliation?.title ?? null,
    primaryAffiliation: affiliation
      ? {
          id: affiliation.id,
          organisationId: affiliation.organisation_id,
          organisationName: affiliation.organisation_name,
          title: affiliation.title,
        }
      : null,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    mergedIntoId: row.merged_into_id,
  };
}

async function requirePerson(
  reader: Reader,
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<Person> {
  const person = await loadPerson(reader, id, options);
  if (!person) throw new NotFoundError("person", id);
  return person;
}

/** What a snapshot reads: a Person, or the same fields assembled by a bulk writer. */
export type PersonSnapshotSource = Pick<
  Person,
  | "displayName"
  | "givenName"
  | "familyName"
  | "emails"
  | "phones"
  | "location"
  | "timezone"
  | "socialProfiles"
  | "avatarKey"
  | "ownerId"
  | "description"
  | "tags"
>;

/**
 * The fields audit diffs and timeline tracking compare (field-registry names). Every writer of
 * people (person.*, import.csv.commit) records changes in this shape, so the History tab sees one
 * format.
 */
export function personSnapshot(person: PersonSnapshotSource): Record<string, unknown> {
  return {
    displayName: person.displayName,
    givenName: person.givenName,
    familyName: person.familyName,
    emails: person.emails,
    phones: person.phones,
    location: person.location,
    timezone: person.timezone,
    socialProfiles: person.socialProfiles,
    avatarKey: person.avatarKey,
    ownerId: person.ownerId,
    description: person.description,
    tags: person.tags,
  };
}

// --- Writing helpers ---------------------------------------------------------------------------

export function normaliseEmails(emails: z.output<typeof emailInputSchema>[]) {
  const list = withPrimary(emails, "email").map((e) => ({
    email: e.email,
    label: e.label ?? null,
    primary: e.primary,
  }));
  const seen = new Set<string>();
  for (const { email } of list) {
    if (seen.has(email)) throw new ValidationError(`Email ${email} is listed twice`);
    seen.add(email);
  }
  return list;
}

function normalisePhones(phones: z.output<typeof phoneInputSchema>[]) {
  return withPrimary(phones, "phone").map((p) => ({
    number: p.number,
    label: p.label ?? null,
    primary: p.primary,
  }));
}

/** Digits with an optional leading +, for phone matching. */
export function normalisePhoneNumber(number: string): string {
  const trimmed = number.trim();
  return (trimmed.startsWith("+") ? "+" : "") + trimmed.replace(/\D/g, "");
}

/** Fails with ConflictError when any email belongs to another live person. */
async function assertEmailsFree(
  db: Kysely<CoreDatabase>,
  emails: readonly string[],
  exceptPersonId?: string,
): Promise<void> {
  if (!emails.length) return;
  let query = db
    .selectFrom("core_person_emails")
    .select(["email", "person_id"])
    .where("live", "=", 1)
    .where("email", "in", emails);
  if (exceptPersonId) query = query.where("person_id", "<>", exceptPersonId);
  const taken = await query.execute();
  if (taken.length) {
    throw new ConflictError(
      `Email already belongs to another person: ${taken.map((t) => t.email).join(", ")}`,
      { field: "emails", taken: taken.map((t) => ({ email: t.email, personId: t.person_id })) },
    );
  }
}

/** Email rows per insert: seven bound variables each, under D1's 100 per statement. */
const EMAIL_ROWS_PER_INSERT = 14;

function queueEmails(ctx: HandlerContext, personId: string, emails: Person["emails"]) {
  ctx.write(ctx.db.deleteFrom("core_person_emails").where("person_id", "=", personId));
  const rows = emails.map((e, position) => ({
    id: newId("email"),
    person_id: personId,
    email: e.email,
    label: e.label,
    is_primary: e.primary ? 1 : 0,
    position,
    created_at: ctx.now,
  }));
  for (let at = 0; at < rows.length; at += EMAIL_ROWS_PER_INSERT) {
    ctx.write(
      ctx.db.insertInto("core_person_emails").values(rows.slice(at, at + EMAIL_ROWS_PER_INSERT)),
    );
  }
}

function queuePhones(ctx: HandlerContext, personId: string, phones: Person["phones"]) {
  ctx.write(ctx.db.deleteFrom("core_person_phones").where("person_id", "=", personId));
  if (phones.length) {
    ctx.write(
      ctx.db.insertInto("core_person_phones").values(
        phones.map((p, position) => ({
          id: newId("phone"),
          person_id: personId,
          number: p.number,
          number_normalised: normalisePhoneNumber(p.number),
          label: p.label,
          is_primary: p.primary ? 1 : 0,
          position,
          created_at: ctx.now,
        })),
      ),
    );
  }
}

function deriveDisplayName(
  given: string | null | undefined,
  family: string | null | undefined,
  emails: Person["emails"],
): string | null {
  const name = [given, family].filter(Boolean).join(" ").trim();
  if (name) return name;
  return emails.find((e) => e.primary)?.email ?? null;
}

// --- Operations --------------------------------------------------------------------------------

export const personCreate = defineOperation({
  name: "person.create",
  description:
    "Create a person (a contact) with optional names, emails, phones, location, owner, tags and " +
    "description. Use it after checking with person.list or search that the person does not " +
    "already exist: emails must be unique across live people, and a taken email fails with a " +
    "conflict. Returns the created person. Unknown tags are created. Check possibleDuplicates " +
    "in the result: existing people this one may duplicate by plain rules (same name and " +
    "organisation, same name and email domain, same phone number, same name only), each with " +
    "its reason. If one is the same person, merge them with person.merge.",
  input: z.object(personWritableFields),
  output: personSchema.extend({ possibleDuplicates: possibleDuplicatesSchema.default([]) }),
  permission: "records:write",
  risk: "write",
  mcp: { curated: true },
  async handler(input, ctx) {
    const emails = normaliseEmails(input.emails ?? []);
    const phones = normalisePhones(input.phones ?? []);
    const givenName = blankToNull(input.givenName) ?? null;
    const familyName = blankToNull(input.familyName) ?? null;
    const displayName = input.displayName ?? deriveDisplayName(givenName, familyName, emails);
    if (!displayName) {
      throw new ValidationError("A person needs a name or an email", { field: "displayName" });
    }
    await assertEmailsFree(
      ctx.db,
      emails.map((e) => e.email),
    );
    await assertUserExists(ctx.db, input.ownerId);
    await assertRecordCapacity(ctx.db, 1);
    const { warnings: possibleDuplicates } = await checkPerson(ctx.db, {
      displayName,
      emails: emails.map((e) => e.email),
      phones: phones.map((p) => p.number),
    });

    const id = newId("person");
    const row = {
      id,
      given_name: givenName,
      family_name: familyName,
      display_name: displayName,
      name_key: personNameKey(displayName),
      location: blankToNull(input.location) ?? null,
      timezone: blankToNull(input.timezone) ?? null,
      social_profiles: JSON.stringify(input.socialProfiles ?? []),
      avatar_key: blankToNull(input.avatarKey) ?? null,
      owner_id: input.ownerId ?? null,
      description: blankToNull(input.description) ?? null,
      created_at: ctx.now,
      created_by: ctx.user.id,
      updated_at: ctx.now,
    };
    // No owner given: assignment rules choose one, in this same insert (ADR 0246).
    const assignment = row.owner_id
      ? null
      : await assignOwner(ctx, getObject("person") ?? personObject, {
          get: (field) => newPersonValue(field, row, emails, phones),
        });
    if (assignment?.ownerId) row.owner_id = assignment.ownerId;
    ctx.write(ctx.db.insertInto("core_person").values(row));
    queueEmails(ctx, id, emails);
    // An unlinked outside person with one of these addresses is linked now (stage 65, ADR 0922).
    if (emails.length) {
      await matchPersonAddresses(ctx, [
        { personId: id, emails: emails.map((e) => e.email), complete: true },
      ]);
    }
    queuePhones(ctx, id, phones);
    const tags = await queueSetTags(ctx, "person", id, input.tags ?? []);

    const person: Person = {
      id,
      displayName,
      givenName,
      familyName,
      emails,
      phones,
      location: row.location,
      timezone: row.timezone,
      socialProfiles: input.socialProfiles ?? [],
      avatarKey: row.avatar_key,
      ownerId: row.owner_id,
      description: row.description,
      tags,
      birthday: null,
      jobTitle: null,
      primaryAffiliation: null,
      createdAt: ctx.now,
      createdBy: ctx.user.id,
      updatedAt: ctx.now,
      deletedAt: null,
      mergedIntoId: null,
    };
    const assigned = assignment
      ? recordAssignment(ctx, getObject("person") ?? personObject, id, assignment)
      : undefined;
    ctx.recordChange({
      object: "person",
      id,
      action: "create",
      after: personSnapshot(person),
      assignment: assigned,
    });
    return { ...person, possibleDuplicates };
  },
});

/** A new person's value of a registry field, for assignment rule conditions. */
export function newPersonValue(
  field: string,
  row: {
    display_name: string;
    given_name: string | null;
    family_name: string | null;
    location: string | null;
    timezone: string | null;
  },
  emails: readonly { email: string; primary: boolean }[],
  phones: readonly { number: string; primary: boolean }[],
): unknown {
  switch (field) {
    case "displayName":
      return row.display_name;
    case "givenName":
      return row.given_name;
    case "familyName":
      return row.family_name;
    case "location":
      return row.location;
    case "timezone":
      return row.timezone;
    case "primaryEmail":
      return (emails.find((e) => e.primary) ?? emails[0])?.email ?? null;
    case "primaryPhone":
      return (phones.find((p) => p.primary) ?? phones[0])?.number ?? null;
    default:
      return null;
  }
}

export const personGet = defineOperation({
  name: "person.get",
  description:
    "Get one person by id, with all emails, phones, tags, social profiles, owner, description " +
    "and current primary affiliation (job title and organisation). Deleted people are not found " +
    "unless includeDeleted is true. Read-only.",
  input: z.object({
    id: personId,
    includeDeleted: z.boolean().default(false).describe("Also find people in Trash"),
  }),
  output: personSchema,
  permission: "records:read",
  risk: "read",
  mcp: { curated: true, idempotent: true },
  async handler(input, ctx) {
    return requirePerson(ctx, input.id, { includeDeleted: input.includeDeleted });
  },
});

// --- Updating ---------------------------------------------------------------------------------

const personUpdateInput = z.object({
  id: personId,
  ...personWritableFields,
  // A birthday is set with person.setBirthday (stage 53): refused here, never silently dropped.
  birthday: z
    .unknown()
    .optional()
    .refine((value) => value === undefined, "Set a birthday with person.setBirthday")
    .describe("Not set here: use person.setBirthday"),
});

/** What `updatePerson` changes: person.update's input without the id. */
export type PersonChanges = Omit<z.output<typeof personUpdateInput>, "id" | "birthday"> & {
  /**
   * The primary phone number alone (a customer's `me.update`): replaces the primary phone's
   * number, keeping the others; null removes it. Ignored when `phones` is given.
   */
  primaryPhone?: string | null | undefined;
};

/**
 * The code person.update runs, shared with the visibility seam's Person writer (`me.update`,
 * ADR 0413): uniqueness, search, the audit diff and timeline tracking behave the same whoever
 * calls it. It reads `ctx.db`, `ctx.now`, `ctx.write` and `ctx.recordChange` only, never
 * `ctx.actor` or `ctx.user`, so it also runs in the host context of a customer's call. Nothing
 * here writes a user id column (core_person has no updated_by; owner and tags, which do check
 * users, are not a customer's to set).
 */
export async function updatePerson(
  ctx: HandlerContext,
  id: string,
  input: PersonChanges,
): Promise<void> {
  const before = await requirePerson(ctx, id);
  const after: Person = { ...before, updatedAt: ctx.now };
  const set: Record<string, unknown> = {};

  const scalar = <K extends keyof Person & keyof typeof input>(key: K, column: string) => {
    const value = blankToNull(input[key] as string | null | undefined);
    if (value === undefined) return;
    (after as Record<string, unknown>)[key] = value;
    set[column] = value;
  };
  scalar("givenName", "given_name");
  scalar("familyName", "family_name");
  scalar("location", "location");
  scalar("timezone", "timezone");
  scalar("avatarKey", "avatar_key");
  scalar("description", "description");
  if (input.displayName !== undefined) {
    after.displayName = input.displayName;
    set.display_name = input.displayName;
    set.name_key = personNameKey(input.displayName);
  }
  if (input.ownerId !== undefined) {
    await assertUserExists(ctx.db, input.ownerId);
    after.ownerId = input.ownerId ?? null;
    set.owner_id = after.ownerId;
  }
  if (input.socialProfiles !== undefined) {
    after.socialProfiles = input.socialProfiles;
    set.social_profiles = JSON.stringify(input.socialProfiles);
  }

  ctx.write(
    ctx.db
      .updateTable("core_person")
      .set({ ...set, updated_at: ctx.now })
      .where("id", "=", id),
  );
  if (input.emails !== undefined) {
    after.emails = normaliseEmails(input.emails);
    await assertEmailsFree(
      ctx.db,
      after.emails.map((e) => e.email),
      id,
    );
    queueEmails(ctx, id, after.emails);
    await matchPersonAddresses(ctx, [
      { personId: id, emails: after.emails.map((e) => e.email), complete: true },
    ]);
  }
  if (input.phones !== undefined) {
    after.phones = normalisePhones(input.phones);
    queuePhones(ctx, id, after.phones);
  } else if (input.primaryPhone !== undefined) {
    after.phones = withPrimaryPhone(before.phones, blankToNull(input.primaryPhone) ?? null);
    queuePhones(ctx, id, after.phones);
  }
  if (input.tags !== undefined) {
    after.tags = await queueSetTags(ctx, "person", id, input.tags);
  }

  ctx.recordChange({
    object: "person",
    id: id,
    action: "update",
    before: personSnapshot(before),
    after: personSnapshot(after),
  });
}

/** `phones` with the primary phone's number set to `number` (added when none), or removed. */
function withPrimaryPhone(phones: Person["phones"], number: string | null): Person["phones"] {
  const primary = phones.findIndex((p) => p.primary);
  const rest = phones.filter((_, i) => i !== primary);
  const label = primary >= 0 ? (phones[primary]?.label ?? null) : null;
  const list = number === null ? rest : [{ number, label, primary: true }, ...rest];
  return normalisePhones(list.map((p, i) => ({ ...p, primary: i === 0 })));
}

const personCoreChanges = z
  .object({
    givenName: personWritableFields.givenName,
    familyName: personWritableFields.familyName,
    displayName: personWritableFields.displayName,
    primaryPhone: shortText(50).nullish(),
  })
  .strict();

// The seam writes a customer's own Person with this code (`me.update` → ctx.records.update).
// The seam has already checked the caller may set each field; this checks the values.
setCoreWriter("person", {
  async update(ctx, _object, id, values) {
    const parsed = personCoreChanges.safeParse(values);
    if (!parsed.success) {
      throw new ValidationError("A value is not allowed", { issues: parsed.error.issues });
    }
    await updatePerson(ctx, id, parsed.data);
    return true;
  },
});

export const personUpdate = defineOperation({
  name: "person.update",
  description:
    "Update a person's fields. Only the fields you pass change; pass null to clear a field. " +
    "emails, phones, socialProfiles and tags replace the whole list when given. Changing the " +
    "owner posts a system activity on the person's timeline. Fails with a conflict if an email " +
    "belongs to another live person. Returns the updated person.",
  input: personUpdateInput,
  output: personSchema,
  permission: "records:write",
  risk: "write",
  mcp: { curated: true },
  async handler(input, ctx) {
    const { id, birthday: _refused, ...changes } = input;
    await updatePerson(ctx, id, changes);
    return ctx.afterCommit(() => requirePerson(ctx, input.id));
  },
});

export const personList = defineOperation({
  name: "person.list",
  description:
    "List live people, one page at a time. Filter with structured filter JSON over person " +
    "fields (e.g. { and: [{ field: 'organisationName', op: 'contains', value: 'acme' }, " +
    "{ field: 'tags', op: 'eq', value: 'VIP' }] }); 'emails', 'phones' and 'tags' match any " +
    "value. Sort by a sortable field (default displayName). Pass nextCursor back as cursor for " +
    "the next page. Use fields to return only some columns. Read-only.",
  input: listInputSchema,
  output: pageSchema(personListItemSchema.partial().required({ id: true })),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const page = await runListQuery<Selectable<CoreDatabase["rec_person"]>>(
      ctx,
      getObject("person") ?? personObject,
      input,
    );
    const items: PersonListItem[] = page.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      givenName: row.given_name,
      familyName: row.family_name,
      primaryEmail: row.primary_email,
      emails: JSON.parse(row.emails) as string[],
      primaryPhone: row.primary_phone,
      jobTitle: row.job_title,
      organisationId: row.organisation_id,
      organisationName: row.organisation_name,
      location: row.location,
      timezone: row.timezone,
      ownerId: row.owner_id,
      avatarKey: row.avatar_key,
      tags: JSON.parse(row.tags) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return {
      items: selectFields(items, input.fields, PERSON_LIST_FIELDS),
      nextCursor: page.nextCursor,
    };
  },
});

export const personDelete = defineOperation({
  name: "person.delete",
  description:
    "Move a person to Trash (soft delete). They disappear from lists, search and views, and " +
    "their emails become free for other people. They can be restored with person.restore for " +
    `${TRASH_RETENTION_DAYS} days, after which they are purged. Activities and tasks linked to ` +
    "them are kept.",
  input: z.object({ id: personId }),
  output: z.object({ id: z.string(), deletedAt: z.string(), restorableUntil: z.string() }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    await requirePerson(ctx, input.id);
    ctx.write(
      ctx.db
        .updateTable("core_person")
        .set({ deleted_at: ctx.now, deleted_by: ctx.user.id, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "person",
      id: input.id,
      action: "delete",
      diff: { deletedAt: { before: null, after: ctx.now } },
    });
    return { id: input.id, deletedAt: ctx.now, restorableUntil: restorableUntil(ctx.now) };
  },
});

export const personRestore = defineOperation({
  name: "person.restore",
  description:
    "Restore a person from Trash, including one that was merged away (they come back without " +
    "what the merge moved to the survivor). Fails with a conflict if one of their emails now " +
    "belongs to another live person (edit or delete that person first). Returns the restored " +
    "person.",
  input: z.object({ id: personId }),
  output: personSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const person = await requirePerson(ctx, input.id, { includeDeleted: true });
    if (!person.deletedAt) throw new ValidationError("This person is not in Trash");
    await assertRecordCapacity(ctx.db, 1);
    await assertEmailsFree(
      ctx.db,
      person.emails.map((e) => e.email),
      input.id,
    );
    ctx.write(
      ctx.db
        .updateTable("core_person")
        .set({ deleted_at: null, deleted_by: null, merged_into_id: null, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    // Their addresses are live again: an unlinked outside person with one is linked now (ADR 0922).
    await matchPersonAddresses(ctx, [
      { personId: input.id, emails: person.emails.map((e) => e.email), complete: true },
    ]);
    ctx.recordChange({
      object: "person",
      id: input.id,
      action: "restore",
      diff: {
        deletedAt: { before: person.deletedAt, after: null },
        ...(person.mergedIntoId
          ? { mergedIntoId: { before: person.mergedIntoId, after: null } }
          : {}),
      },
    });
    return ctx.afterCommit(() => requirePerson(ctx, input.id));
  },
});

// --- Job change --------------------------------------------------------------------------------

export const personChangeJob = defineOperation({
  name: "person.changeJob",
  description:
    "Record that a person changed jobs: their current primary affiliation ends (it stays in " +
    "their job history), a new current affiliation at organisationId starts and becomes " +
    "primary, so their job title and organisation follow it. Posts a 'Job change' system " +
    "activity on the person's, the old organisation's and the new organisation's timelines. " +
    "Works for a promotion within the same organisation too. Returns the person, the ended " +
    "and the started affiliation.",
  input: z.object({
    personId,
    organisationId: z.string().startsWith("org_").max(64).describe("The new organisation"),
    title: shortText(200).nullish().describe("The new job title"),
    role: shortText(200).nullish().describe("Role in the relationship, e.g. Decision maker"),
    startedOn: calendarDate.optional().describe("Start of the new job; default today"),
    previousEndedOn: calendarDate
      .optional()
      .describe("End of the previous job; default the new start date"),
  }),
  output: z.object({
    person: personSchema,
    ended: affiliationSchema.nullable(),
    started: affiliationSchema,
    activityId: z.string(),
  }),
  permission: "records:write",
  risk: "write",
  mcp: { curated: true },
  async handler(input, ctx) {
    const person = await requirePerson(ctx, input.personId);
    const organisation = await requireLiveOrganisation(ctx.db, input.organisationId);
    const previous = await loadPrimaryAffiliation(ctx.db, person.id);
    const startedOn = input.startedOn ?? today(ctx);
    const endedOn = input.previousEndedOn ?? startedOn;

    if (previous) {
      if (previous.startedOn && endedOn < previous.startedOn) {
        throw new ValidationError("The previous job would end before it started", {
          field: "previousEndedOn",
        });
      }
      const ended: Affiliation = { ...previous, current: false, primary: false, endedOn };
      ctx.write(
        ctx.db
          .updateTable("core_affiliation")
          .set({ is_current: 0, is_primary: 0, ended_on: endedOn, updated_at: ctx.now })
          .where("id", "=", previous.id),
      );
      ctx.recordChange({
        object: "affiliation",
        id: previous.id,
        action: "update",
        before: affiliationSnapshot(previous),
        after: affiliationSnapshot(ended),
      });
    }
    const title = blankToNull(input.title) ?? null;
    const startedId = queueInsertAffiliation(ctx, {
      personId: person.id,
      organisationId: organisation.id,
      title,
      role: blankToNull(input.role) ?? null,
      startedOn,
      endedOn: null,
      current: true,
      primary: true,
    });

    const from = previous
      ? {
          affiliationId: previous.id,
          organisationId: previous.organisationId,
          organisationName: previous.organisationName,
          title: previous.title,
          endedOn,
        }
      : null;
    const to = {
      affiliationId: startedId,
      organisationId: organisation.id,
      organisationName: organisation.name,
      title,
      startedOn,
    };
    const subject = previous
      ? `Job change: ${person.displayName} moved from ${previous.organisationName ?? "an organisation"} to ${organisation.name}`
      : `Job change: ${person.displayName} joined ${organisation.name}`;
    const activityId = ctx.postActivity({
      subject,
      payload: { kind: "job_change", personId: person.id, from, to },
      links: [
        { object: "person", id: person.id },
        ...(previous ? [{ object: "organisation", id: previous.organisationId }] : []),
        { object: "organisation", id: organisation.id },
      ],
    });

    return ctx.afterCommit(async () => ({
      person: await requirePerson(ctx, person.id),
      ended: previous ? await requireAffiliation(ctx.db, previous.id) : null,
      started: await requireAffiliation(ctx.db, startedId),
      activityId,
    }));
  },
});

// --- Batch variants ----------------------------------------------------------------------------

const batchIds = z
  .array(personId)
  .min(1)
  .max(BATCH_MAX)
  .describe(`Person ids, at most ${BATCH_MAX} per call`);

const BATCH_NOTE =
  `At most ${BATCH_MAX} people per call, applied atomically (all or none). For more, call ` +
  "again with the next ids: separate calls are separate transactions, each audited and gated " +
  "on its own, so a later call can fail after earlier ones applied.";

/** Live people by id (chunked reads); fails if any id is missing or deleted. */
async function requireLivePeople(db: Kysely<CoreDatabase>, ids: readonly string[]) {
  const parts = await Promise.all(
    chunk(ids).map((part) =>
      db
        .selectFrom("core_person")
        .select(["id", "owner_id", "location", "timezone"])
        .where("id", "in", part)
        .where("deleted_at", "is", null)
        .execute(),
    ),
  );
  const rows = parts.flat();
  const found = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.find((id) => !found.has(id));
  if (missing) throw new NotFoundError("person", missing);
  return rows;
}

export const personUpdateMany = defineOperation({
  name: "person.updateMany",
  description:
    "Set the same fields on many people at once: owner, location, timezone, and tags to add " +
    "or remove. Fields you leave out are untouched; pass null to clear owner, location or " +
    `timezone. Owner changes post a system activity on each person's timeline. ${BATCH_NOTE} ` +
    "Returns the ids updated.",
  input: z.object({
    ids: batchIds,
    set: z
      .object({
        ownerId: userId.nullish(),
        location: shortText(200).nullish(),
        timezone: shortText(64).nullish(),
      })
      .default({}),
    addTags: bulkTagListSchema.optional().describe("Tag names to add (created if unknown)"),
    removeTags: bulkTagListSchema.optional().describe("Tag names to remove"),
  }),
  output: z.object({ ids: z.array(z.string()), count: z.number() }),
  permission: "records:write",
  risk: "bulk-write",
  bulkSize: (input) => input.ids.length,
  async handler(input, ctx) {
    const ids = uniqueIds(input.ids);
    const rows = await requireLivePeople(ctx.db, ids);
    const set: Record<string, string | null> = {};
    if (input.set.ownerId !== undefined) {
      await assertUserExists(ctx.db, input.set.ownerId);
      set.owner_id = input.set.ownerId ?? null;
    }
    if (input.set.location !== undefined) set.location = blankToNull(input.set.location) ?? null;
    if (input.set.timezone !== undefined) set.timezone = blankToNull(input.set.timezone) ?? null;
    if (Object.keys(set).length) {
      for (const part of chunk(ids)) {
        ctx.write(
          ctx.db
            .updateTable("core_person")
            .set({ ...set, updated_at: ctx.now })
            .where("id", "in", part),
        );
      }
    }
    const tags = await queueBulkTags(
      ctx,
      "person",
      ids,
      input.addTags ?? [],
      input.removeTags ?? [],
    );
    for (const row of rows) {
      const pick = (column: "owner_id" | "location" | "timezone") =>
        column in set ? set[column] : row[column];
      ctx.recordChange({
        object: "person",
        id: row.id,
        action: "update",
        before: {
          ownerId: row.owner_id,
          location: row.location,
          timezone: row.timezone,
          tags: tags.before.get(row.id) ?? [],
        },
        after: {
          ownerId: pick("owner_id"),
          location: pick("location"),
          timezone: pick("timezone"),
          tags: tags.after.get(row.id) ?? [],
        },
      });
    }
    return { ids, count: ids.length };
  },
});

export const personDeleteMany = defineOperation({
  name: "person.deleteMany",
  description:
    "Move many people to Trash at once (soft delete), like person.delete for each: their " +
    `emails become free, and they can be restored one by one for ${TRASH_RETENTION_DAYS} ` +
    `days. Fails, deleting none, if any id is not a live person. ${BATCH_NOTE}`,
  input: z.object({ ids: batchIds }),
  output: z.object({
    ids: z.array(z.string()),
    count: z.number(),
    deletedAt: z.string(),
    restorableUntil: z.string(),
  }),
  permission: "records:write",
  risk: "destructive",
  bulkSize: (input) => input.ids.length,
  async handler(input, ctx) {
    const ids = uniqueIds(input.ids);
    await requireLivePeople(ctx.db, ids);
    for (const part of chunk(ids)) {
      ctx.write(
        ctx.db
          .updateTable("core_person")
          .set({ deleted_at: ctx.now, deleted_by: ctx.user.id, updated_at: ctx.now })
          .where("id", "in", part),
      );
    }
    for (const id of ids) {
      ctx.recordChange({
        object: "person",
        id,
        action: "delete",
        diff: { deletedAt: { before: null, after: ctx.now } },
      });
    }
    return {
      ids,
      count: ids.length,
      deletedAt: ctx.now,
      restorableUntil: restorableUntil(ctx.now),
    };
  },
});

// --- Merge -------------------------------------------------------------------------------------

const PERSON_MERGE_FIELDS = [
  "displayName",
  "givenName",
  "familyName",
  "location",
  "timezone",
  "avatarKey",
  "ownerId",
  "description",
] as const;
type PersonMergeField = (typeof PERSON_MERGE_FIELDS)[number];

export const personMerge = defineOperation({
  name: "person.merge",
  description:
    "Merge a duplicate person (mergedId) into another (survivorId). The survivor keeps its own " +
    "values unless fields says to take the duplicate's (per field: 'survivor' or 'merged'); " +
    "empty survivor fields are filled from the duplicate (the birthday too: the survivor's is " +
    "kept unless it has none). Emails, phones, social profiles and " +
    "tags are combined, and the duplicate's affiliations, activity links and task links move " +
    "to the survivor (the survivor keeps its primary affiliation if it has one). The " +
    "duplicate goes to Trash pointing at the survivor, and can be restored from there " +
    "(without what moved). A customer account moves to the survivor; when both people have " +
    "one, the merge is refused until staff disable one (the disabled one is then deleted). " +
    "Returns the survivor.",
  input: z.object({
    survivorId: personId.describe("The person who remains"),
    mergedId: personId.describe("The duplicate that is merged away into Trash"),
    fields: z
      .partialRecord(z.enum(PERSON_MERGE_FIELDS), z.enum(["survivor", "merged"]))
      .default({})
      .describe("Which record's value to keep for each field (default survivor)"),
  }),
  output: personSchema.extend({
    moved: z.object({
      affiliations: z.number(),
      activities: z.number(),
      tasks: z.number(),
    }),
    familyLinks: z
      .object({
        moved: z.number().describe("Live family links that moved to the survivor"),
        ended: z
          .number()
          .describe("Live links ended: a duplicate, or one whose other way round is linked"),
        deleted: z.number().describe("Links between the two People, deleted"),
        history: z.number().describe("Links that had already ended, moved as history"),
      })
      .optional()
      .describe("What happened to the duplicate's family links (guardians and children)"),
  }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    if (input.survivorId === input.mergedId) {
      throw new ValidationError("Cannot merge a person into themselves");
    }
    const survivor = await requirePerson(ctx, input.survivorId);
    const merged = await requirePerson(ctx, input.mergedId);

    const after: Person = { ...survivor, updatedAt: ctx.now };
    for (const field of PERSON_MERGE_FIELDS) {
      const choice = input.fields[field];
      const take = choice === "merged" || (choice === undefined && survivor[field] === null);
      if (take) (after as Record<PersonMergeField, unknown>)[field] = merged[field];
    }
    if (after.ownerId) await assertUserExists(ctx.db, after.ownerId);
    // A birthday: the survivor's, unless it has none (stage 53, ADR 0803).
    await assertMergeKeepsMemberBirthday(ctx, survivor, merged);
    after.birthday = mergedBirthday(survivor.birthday, merged.birthday);
    const birthdayMoved = after.birthday !== survivor.birthday;
    // Both birthdays as read: one set meanwhile fails the merge (a conflict), never lost.
    ctx.write(
      birthdayGuard(ctx, survivor.id, survivor.birthday),
      birthdayGuard(ctx, merged.id, merged.birthday),
    );
    // Customer accounts move to the survivor; refused while both people have an active one.
    await queueMergeCustomers(ctx, survivor.id, merged.id, [
      ...new Set([...survivor.emails, ...merged.emails].map((e) => e.email)),
    ]);
    // A practitioner account moves to the survivor; refused while both people have one (ADR 0581).
    await queueMergePractitioners(ctx, survivor.id, merged.id);
    // Orders, subscriptions, their checkouts and trials follow the Person (stage 32a, #221).
    await queueMergeOrders(ctx, survivor.id, merged.id);
    await queueMergeSubscriptions(ctx, survivor.id, merged.id);
    // Passes' and memberships' terms and uses follow the Person too (stage 32b, ADR 0494).
    queueMergeAllowances(ctx, survivor.id, merged.id);
    // Journey signals: the survivor keeps the later of each (stage 53, ADR 0802).
    queueMergeSignals(ctx, survivor.id, merged.id);
    // Cards follow the Person; the survivor's PIN is kept (stage 51, ADR 0783).
    queueMergePersonCodes(ctx, survivor.id, merged.id);
    // Family links follow the Person; one between the two is deleted, a duplicate or one that
    // would become two-way is ended (ADR 0540).
    const plan = await planMergeLinks(ctx.db, survivor.id, merged.id);
    // Moving a live link moves who may act for whom: as making or ending one, it needs
    // people:link (ADR 0540).
    if (plan.movesLive && !holdsPermission(ctx.user, ctx.permissionGrants, "people:link")) {
      throw new ForbiddenError(
        `${merged.displayName} has family links (a parent or a child), which a merge would move: merging them needs people:link`,
        { permission: "people:link" },
      );
    }
    // Moving what someone agreed to (acceptances, a health form, the minor mark) is a person's act
    // with agreements:manage, never an AI's or one an AI asks for (stage 44, ADR 0642).
    if (await mergeMovesAgreements(ctx, merged.id)) {
      if (ctx.actor !== "human") {
        throw new ForbiddenError(
          `${merged.displayName} has agreements, which a merge would move: only a person merges them`,
          { rule: "agreements_merge" },
        );
      }
      if (!holdsPermission(ctx.user, ctx.permissionGrants, "agreements:manage")) {
        throw new ForbiddenError(
          `${merged.displayName} has agreements, which a merge would move: merging them needs agreements:manage`,
          { permission: "agreements:manage" },
        );
      }
    }
    queueMergeLinks(ctx, survivor.id, merged.id, plan);
    const familyLinks = {
      moved: plan.moved,
      ended: plan.ended,
      deleted: plan.deleted,
      history: plan.history,
    };

    const emailSet = new Set(survivor.emails.map((e) => e.email));
    after.emails = [
      ...survivor.emails,
      ...merged.emails
        .filter((e) => !emailSet.has(e.email))
        .map((e) => ({ ...e, primary: survivor.emails.length ? false : e.primary })),
    ];
    const phoneSet = new Set(survivor.phones.map((p) => normalisePhoneNumber(p.number)));
    after.phones = [
      ...survivor.phones,
      ...merged.phones
        .filter((p) => !phoneSet.has(normalisePhoneNumber(p.number)))
        .map((p) => ({ ...p, primary: survivor.phones.length ? false : p.primary })),
    ];
    const profileSet = new Set(survivor.socialProfiles.map((p) => p.url));
    after.socialProfiles = [
      ...survivor.socialProfiles,
      ...merged.socialProfiles.filter((p) => !profileSet.has(p.url)),
    ];

    const [affiliations, links] = await Promise.all([
      ctx.db
        .selectFrom("core_affiliation")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("person_id", "=", merged.id)
        .where("deleted_at", "is", null)
        .executeTakeFirst(),
      countLinks(ctx, "person", merged.id),
    ]);

    // The duplicate leaves first, so its emails stop being live before the survivor takes them.
    ctx.write(
      ctx.db
        .updateTable("core_person")
        .set({
          deleted_at: ctx.now,
          deleted_by: ctx.user.id,
          merged_into_id: survivor.id,
          updated_at: ctx.now,
        })
        .where("id", "=", merged.id),
      ctx.db.deleteFrom("core_person_emails").where("person_id", "=", merged.id),
      ctx.db.deleteFrom("core_person_phones").where("person_id", "=", merged.id),
      ctx.db
        .updateTable("core_person")
        .set({ merged_into_id: survivor.id })
        .where("merged_into_id", "=", merged.id),
    );
    // Acceptances follow the Person, after merged_into_id is set (the trigger checks it, ADR 0642).
    queueMergeAgreements(ctx, survivor.id, merged.id);
    // One primary affiliation per person: the survivor's wins.
    if (survivor.primaryAffiliation) {
      ctx.write(
        ctx.db
          .updateTable("core_affiliation")
          .set({ is_primary: 0, updated_at: ctx.now })
          .where("person_id", "=", merged.id)
          .where("is_primary", "=", 1),
      );
    }
    ctx.write(
      ctx.db
        .updateTable("core_affiliation")
        .set({ person_id: survivor.id, updated_at: ctx.now })
        .where("person_id", "=", merged.id),
      ctx.db
        .updateTable("core_person")
        .set({
          display_name: after.displayName,
          name_key: personNameKey(after.displayName),
          given_name: after.givenName,
          family_name: after.familyName,
          location: after.location,
          timezone: after.timezone,
          avatar_key: after.avatarKey,
          owner_id: after.ownerId,
          description: after.description,
          social_profiles: JSON.stringify(after.socialProfiles),
          birth_day: after.birthday?.day ?? null,
          birth_month: after.birthday?.month ?? null,
          updated_at: ctx.now,
        })
        .where("id", "=", survivor.id),
    );
    queueEmails(ctx, survivor.id, after.emails);
    queuePhones(ctx, survivor.id, after.phones);
    after.tags = await queueSetTags(ctx, "person", survivor.id, [...survivor.tags, ...merged.tags]);
    queueClearTags(ctx, "person", merged.id);
    queueMoveLinks(ctx, "person", merged.id, survivor.id);
    // Their conversations follow the Person (stage 36, ADR 0740); a concurrent inbox write
    // that read the old version fails, not this.
    ctx.write(
      ctx.db
        .updateTable("core_conversation")
        .set((eb) => ({
          person_id: survivor.id,
          updated_at: ctx.now,
          version: eb("version", "+", 1),
        }))
        .where("person_id", "=", merged.id),
    );
    await queueRepointRelations(ctx, "person", merged.id, survivor.id);
    queueClosePairs(ctx, "person", survivor.id, merged.id);

    ctx.recordChange({
      object: "person",
      id: survivor.id,
      action: "merge",
      // Family links (ADR 0540): before, the two People's live links as read; after, what the
      // merge does to them. Shown in the approval card, and an approval is held to the before: a
      // link made or ended after the preview makes applying it a conflict, never a surprise.
      before: { ...personSnapshot(survivor), familyLinks: plan.live, birthday: survivor.birthday },
      after: {
        ...personSnapshot(after),
        birthday: after.birthday,
        absorbedId: merged.id,
        familyLinks: `${plan.moved} moved, ${plan.ended} ended, ${plan.deleted} deleted${plan.history ? `, ${plan.history} past moved` : ""}`,
      },
      // ADR 0590: the merged addresses and name carry both People's marks, never a fresh one.
      marks: {
        copied: {
          ...Object.fromEntries(
            (["emails", "displayName", "givenName", "familyName"] as const).map((field) => [
              field,
              [
                {
                  object: "person",
                  id: survivor.id,
                  field,
                  value: personSnapshot(survivor)[field],
                },
                { object: "person", id: merged.id, field, value: personSnapshot(merged)[field] },
              ],
            ]),
          ),
          // A birthday taken from the duplicate keeps the mark of whoever gave it there.
          ...(birthdayMoved
            ? {
                [BIRTHDAY_FIELD]: [
                  {
                    object: "person",
                    id: merged.id,
                    field: BIRTHDAY_FIELD,
                    value: merged.birthday,
                  },
                ],
              }
            : {}),
        },
      },
    });
    ctx.recordChange({
      object: "person",
      id: merged.id,
      action: "merge",
      before: { ...personSnapshot(merged), deletedAt: null, mergedIntoId: null },
      after: { deletedAt: ctx.now, mergedIntoId: survivor.id },
    });
    ctx.postActivity({
      subject: `Merged ${merged.displayName} into ${after.displayName}`,
      payload: {
        kind: "merge",
        object: "person",
        survivorId: survivor.id,
        mergedId: merged.id,
        mergedName: merged.displayName,
      },
      links: [
        { object: "person", id: survivor.id },
        { object: "person", id: merged.id },
      ],
    });
    const moved = {
      affiliations: Number(affiliations?.n ?? 0),
      activities: links.activities,
      tasks: links.tasks,
    };
    return ctx.afterCommit(async () => ({
      ...(await requirePerson(ctx, survivor.id)),
      moved,
      familyLinks,
    }));
  },
});

// --- Birthday ----------------------------------------------------------------------------------

export const personSetBirthday = defineOperation({
  name: "person.setBirthday",
  description:
    "Record a person's birthday: day and month only, never a year (null removes it). A " +
    "birthday journey starts on it, in the business's time zone. Only a person on the staff may " +
    "change a birthday the member gave themselves. Returns the person.",
  input: z.object({
    id: personId,
    birthday: birthdaySchema.nullable().describe("Day and month, or null to remove it"),
  }),
  output: personSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const person = await requirePerson(ctx, input.id);
    await assertMayChangeBirthday(ctx, person.id, person.birthday);
    queueSetBirthday(ctx, (c) => ctx.recordChange(c), person.id, person.birthday, input.birthday);
    return ctx.afterCommit(() => requirePerson(ctx, input.id));
  },
});

// --- Erase -------------------------------------------------------------------------------------

export const personErase = defineOperation({
  name: "person.erase",
  description:
    "Permanently delete a person now, for GDPR erasure requests (admins only). Works on live " +
    "people and people in Trash, and also erases anyone merged into them. Emails, phones, " +
    "affiliations and tags go; activities and tasks linked only to them are deleted; system " +
    "activities about them (field changes, job changes, merges) are removed from every " +
    "timeline. Audit-log content that mentions them (their id, emails or phone numbers) is " +
    'replaced with "[erased]"; who did what and when is kept. In-app assistant conversations ' +
    "that referenced them are redacted the same way (tool calls and results that mention them " +
    "lose their content; their ids, emails, phone numbers and names in text become " +
    '"[erased]"). Former emails and phones count too. Synced email bodies, suggested contacts, ' +
    "signatures, extension data related to them, automation run history and notifications about " +
    "them are deleted or redacted, and their addresses are added to the erased-address list so " +
    "mail sync does not collect them again. Their customer account, its sessions and sign-in " +
    "codes, invites for their addresses and their erase requests are deleted (an open request " +
    "is closed as erased). Their birthday, health answers and minor mark are deleted; what they agreed to is " +
    "kept, no longer theirs, as the business's evidence until the retention period ends " +
    "(agreement.retention, counted from the erase), then deleted: agreementsKept says how many " +
    "and until when. Every subscription they pay for or hold that still runs is asked at the " +
    "payment provider to end when the period already paid for ends (one paused, unpaid or " +
    "waiting for its first payment ends at once): nothing is refunded and nothing more is " +
    "charged; admins are told of one that could not be asked, and of one another person is " +
    "still on. Cannot be undone; use person.delete for a reversible delete.",
  input: z.object({ id: personId }),
  output: z.object({
    id: z.string(),
    erased: z.array(z.string()),
    activitiesDeleted: z.number(),
    tasksDeleted: z.number(),
    auditRowsRedacted: z.number(),
    conversationsScrubbed: z.number(),
    ...eraseCountsOutput,
    dependantsWithoutGuardian: z
      .array(z.string())
      .optional()
      .describe(
        "People this person was the only live guardian of (ADR 0540): they stay, with no guardian " +
          "linked, and a note on their timeline",
      ),
    subscriptionsEnding: z
      .object({
        atPeriodEnd: z.number().describe("Asked to end when the period already paid for ends"),
        now: z
          .number()
          .describe("Asked to end at once (past due, paused, unpaid, or waiting for a payment)"),
        leftForStaff: z
          .number()
          .describe("Could not be asked at the provider: the admins are told to end them"),
      })
      .describe(
        "Their subscriptions, as payer or holder (issue #293, ADR 0533): nothing is refunded",
      ),
  }),
  permission: "records:erase",
  risk: "destructive",
  mcp: { expose: false },
  async handler(input, ctx) {
    await requirePerson(ctx, input.id, { includeDeleted: true });
    const ids = await withMergedRecords(ctx, "person", input.id);
    const subject = await personSubject(ctx.db, ids);
    // The addresses their agreements were sent to are theirs too (an earlier sign-in address, the
    // address a purchase was made with): redacted from the audit and approvals as any of theirs,
    // and their unsettled purchases' acceptances found by them (ADR 0646).
    for (const address of await agreementAddresses(ctx, ids)) {
      if (!subject.addresses.includes(address)) subject.addresses.push(address);
      if (!subject.terms.includes(address)) subject.terms.push(address);
    }
    // Their family links go with them; a child left with no guardian stays, and staff are told.
    const leftAlone = await dependantsLeftAlone(ctx, ids);
    queueEraseLinks(ctx, ids, leftAlone);
    const counts = await queueErase(ctx, {
      object: "person",
      recordId: input.id,
      recordIds: ids,
      terms: subject.terms,
      names: subject.names,
      addresses: subject.addresses,
    });
    // Their subscriptions end as a member's own deletion ends them (ADR 0533): asked at the
    // provider now, once nothing else of the erase can refuse, and before the commit clears who
    // is on them; a checkout of theirs confirmed meanwhile is asked after the commit.
    const subscriptions = await endErasedSubscriptions(ctx, ids);
    for (const id of ids) ctx.recordChange({ object: "person", id, action: "erase", diff: {} });
    return ctx.afterCommit(async () => {
      // The erase has committed: a failure here must not report it as failed.
      await subscriptions.afterCommit().catch(() => {});
      return {
        id: input.id,
        erased: ids,
        activitiesDeleted: counts.activities,
        tasksDeleted: counts.tasks,
        auditRowsRedacted: await countRedactions(ctx.db, "person", input.id),
        conversationsScrubbed: counts.conversations,
        ...(await afterErase(ctx, counts)),
        dependantsWithoutGuardian: leftAlone,
        subscriptionsEnding: subscriptions.counts,
      };
    });
  },
});

export const personOperations = [
  personCreate,
  personGet,
  personUpdate,
  personList,
  personDelete,
  personRestore,
  personChangeJob,
  personUpdateMany,
  personDeleteMany,
  personMerge,
  personSetBirthday,
  personErase,
] as const;
