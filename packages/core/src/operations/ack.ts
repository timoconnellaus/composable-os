// Read and understood (stage 38 step 3, ADR 0702): a staff account confirms it has read the
// current version of a record of an acknowledged object, and who manages them sees who has.
//
//   ack.confirm    the person themselves       confirm the current version, once
//   ack.mine       the person themselves       what I must read and have not, what I confirmed
//   ack.status     manage permission, a person  one record: who must read, confirmed, not yet
//   ack.overview   manage permission, a person  every published record: how many of how many
//
// The rules (who must read, which confirmation counts, who manages) are records/acknowledge.ts.
// A confirmation is a row nobody changes (migration 0971's triggers): only for the record's
// current version, by a live person's account, once. No AI actor confirms, lists, or reads who
// has confirmed: the operations are a person's (`actors`). An extension's call of ack.confirm or
// ack.mine counts only from a person-only tool of the shipped pack that owns the object, called
// by the person (its verified caller, never its input); ack.status and ack.overview are a
// person's own calls only. Pack-role
// accounts (a coach, a cleaner) reach ack.confirm and ack.mine (pack-roles.ts), nothing else.
// The rows are in no `rec_*` view, so no dashboard, query or export reads them.
import { CompiledQuery } from "kysely";
import { z } from "zod";
import { ConflictError, ForbiddenError, OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  type AcknowledgedObject,
  acknowledgedObject,
  acknowledgedObjects,
  assertManages,
  counts,
  type DueRecord,
  dueRecords,
  latestConfirmations,
  liveStaff,
  managedObjects,
  mustReadIncludes,
  personCalling,
  staffAccount,
} from "../records/acknowledge.ts";

const objectName = z
  .string()
  .min(1)
  .max(80)
  .describe("An object staff confirm they have read (see schema.objects, acknowledge)");
const recordId = z.string().min(1).max(64).describe("Record id");

async function requirePerson(ctx: HandlerContext, owner?: string): Promise<string> {
  const person = await personCalling(ctx, owner);
  if (!person) {
    throw new ForbiddenError(
      "Only the person themselves does this, or a person-only tool of the pack that owns it",
      { actor: ctx.actor },
    );
  }
  return person;
}

/** The one answer for what is not a published record of an acknowledged object. */
const notFound = (object: string, id: string) =>
  new OperationError("not_found", `No published ${object} with id ${id}`, { object, id });

function requireAcknowledged(name: string): AcknowledgedObject {
  const object = acknowledgedObject(name);
  if (!object) {
    throw new OperationError("not_found", `${name} asks nobody to confirm`, { object: name });
  }
  return object;
}

const confirmationOut = z.object({ version: z.number().int(), confirmedAt: z.string() });

export const ackConfirm = defineOperation({
  name: "ack.confirm",
  description:
    "Confirm that I have read and understood the current version of a record staff must read " +
    "(a procedure): one tap, by the person themselves. Refused for a version that is not the " +
    "current one, a record I am not asked to read, and a second time for the same version. A " +
    "confirmation is never changed or deleted. Not for an AI actor.",
  input: z.object({
    object: objectName,
    id: recordId,
    version: z.number().int().min(1).describe("The version I read: the current one"),
  }),
  output: confirmationOut.extend({ object: z.string(), id: z.string() }),
  permission: "records:read",
  risk: "write",
  actors: ["human", "extension"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const object = requireAcknowledged(input.object);
    const person = await requirePerson(ctx, object.extension);
    const [record] = await dueRecords(ctx, object, input.id);
    const account = await staffAccount(ctx, person);
    // A record the caller is not asked to read is one that is not there: nothing about it (not
    // even its current version) is told to someone it does not ask.
    if (!record || !account?.live || !mustReadIncludes(record.must, account)) {
      throw notFound(object.name, input.id);
    }
    if (record.version !== input.version) {
      throw new ConflictError(
        `Version ${input.version} is not the current one: read version ${record.version} and confirm that`,
        { reason: "not_current", current: record.version },
      );
    }
    const [mine] = await latestConfirmations(ctx, object.name, {
      account: person,
      record: record.id,
    });
    if (mine?.version === record.version) {
      throw new ConflictError("You have already confirmed this version", {
        reason: "already_confirmed",
      });
    }
    ctx.write(
      CompiledQuery.raw(
        "INSERT INTO core_publish_ack (object_type, record_id, version, account_id, confirmed_at, how) VALUES (?, ?, ?, ?, ?, 'self')",
        [object.name, record.id, record.version, person, ctx.now],
      ),
    );
    return { object: object.name, id: record.id, version: record.version, confirmedAt: ctx.now };
  },
});

const dueOut = z.object({
  object: z.string(),
  id: z.string(),
  title: z.string().nullable(),
  version: z.number().int().describe("The current version: confirm this one"),
  publishedAt: z.string(),
  since: z.string().describe("When it became mine to read: the version that asked everyone"),
});

export const ackMine = defineOperation({
  name: "ack.mine",
  description:
    "What I must read and have not confirmed (each published record that asks me, with its " +
    "current version), and what I have confirmed and when. For the person themselves; not for " +
    "an AI actor. Read-only.",
  input: z.object({}),
  output: z.object({
    toRead: z.array(dueOut),
    confirmed: z.array(dueOut.omit({ since: true }).extend({ confirmedAt: z.string() })),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "extension"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    // A pack's person-only tool lists only its own objects' records.
    const own = ctx.actor === "extension" ? ctx.extension?.id : undefined;
    const person = await requirePerson(ctx, own);
    const account = await staffAccount(ctx, person);
    const toRead: z.infer<typeof dueOut>[] = [];
    const confirmed: (Omit<z.infer<typeof dueOut>, "since"> & { confirmedAt: string })[] = [];
    if (!account?.live) return { toRead, confirmed };
    for (const object of acknowledgedObjects()) {
      if (own !== undefined && object.extension !== own) continue;
      const records = (await dueRecords(ctx, object)).filter((r) =>
        mustReadIncludes(r.must, account),
      );
      if (!records.length) continue;
      const mine = new Map(
        (await latestConfirmations(ctx, object.name, { account: person })).map((c) => [
          c.record,
          c,
        ]),
      );
      for (const r of records) {
        const base = {
          object: r.object,
          id: r.id,
          title: r.title,
          version: r.version,
          publishedAt: r.publishedAt,
        };
        const c = mine.get(r.id);
        if (counts(r, c?.version)) confirmed.push({ ...base, confirmedAt: c?.confirmedAt ?? "" });
        else toRead.push({ ...base, since: r.askedAt });
      }
    }
    toRead.sort((a, b) => a.since.localeCompare(b.since));
    return { toRead, confirmed };
  },
});

const personOut = z.object({
  account: z.string(),
  name: z.string(),
  email: z.string(),
  confirmed: confirmationOut
    .nullable()
    .describe("The confirmation that counts for the current version, if any"),
  lastConfirmed: confirmationOut
    .nullable()
    .describe("Their latest confirmation, of any version (an older one no longer counts)"),
  since: z.string().nullable().describe("Not confirmed: since when it has been theirs to read"),
});

/** Who must read one record, who confirmed what counts and when, and who has not. */
async function statusOf(ctx: HandlerContext, object: AcknowledgedObject, record: DueRecord) {
  const staff = (await liveStaff(ctx)).filter((a) => mustReadIncludes(record.must, a));
  const latest = new Map(
    (await latestConfirmations(ctx, object.name, { record: record.id })).map((c) => [c.account, c]),
  );
  return staff.map((a) => {
    const c = latest.get(a.id);
    const last = c ? { version: c.version, confirmedAt: c.confirmedAt } : null;
    const ok = counts(record, c?.version);
    return {
      account: a.id,
      name: a.name,
      email: a.email,
      confirmed: ok ? last : null,
      lastConfirmed: last,
      since: ok ? null : record.askedAt,
    };
  });
}

export const ackStatus = defineOperation({
  name: "ack.status",
  description:
    "For one published record staff must read (a procedure), its current version: everyone " +
    "who must read it, who has confirmed it (and when), and who has not (and since when). For " +
    "admins and people granted the object's manage permission; never for an AI actor. " +
    "Read-only.",
  input: z.object({ object: objectName, id: recordId }),
  output: z.object({
    object: z.string(),
    id: z.string(),
    title: z.string().nullable(),
    version: z.number().int(),
    publishedAt: z.string(),
    askedVersion: z.number().int().describe("The version from which confirmations count"),
    everyone: z.boolean().describe("Every staff account must read it"),
    roles: z.array(z.string()).describe("Otherwise: the roles, pack roles and grants that must"),
    people: z.array(personOut),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const object = requireAcknowledged(input.object);
    await assertManages(ctx, object);
    const [record] = await dueRecords(ctx, object, input.id);
    if (!record) throw notFound(object.name, input.id);
    return {
      object: object.name,
      id: record.id,
      title: record.title,
      version: record.version,
      publishedAt: record.publishedAt,
      askedVersion: record.askedVersion,
      everyone: record.must.everyone,
      roles: [...record.must.roles],
      people: await statusOf(ctx, object, record),
    };
  },
});

export const ackOverview = defineOperation({
  name: "ack.overview",
  description:
    "Every published record staff must read, of the objects the caller manages: its current " +
    "version, how many must read it and how many have confirmed what counts. For admins and " +
    "people granted an object's manage permission; never for an AI actor. Read-only.",
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({
        object: z.string(),
        id: z.string(),
        title: z.string().nullable(),
        version: z.number().int(),
        publishedAt: z.string(),
        mustRead: z.number().int(),
        confirmed: z.number().int(),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const objects = await managedObjects(ctx);
    if (!objects.length) {
      throw new ForbiddenError(
        "Reading who has confirmed needs an object's manage permission (or an admin), and a person",
        { reason: "not_manager" },
      );
    }
    const staff = await liveStaff(ctx);
    const items = [];
    for (const object of objects) {
      const latest = await latestConfirmations(ctx, object.name, {});
      const by = new Map(latest.map((c) => [`${c.record}:${c.account}`, c.version]));
      for (const record of await dueRecords(ctx, object)) {
        const asked = staff.filter((a) => mustReadIncludes(record.must, a));
        items.push({
          object: object.name,
          id: record.id,
          title: record.title,
          version: record.version,
          publishedAt: record.publishedAt,
          mustRead: asked.length,
          confirmed: asked.filter((a) => counts(record, by.get(`${record.id}:${a.id}`))).length,
        });
      }
    }
    return { items };
  },
});

export const ackOperations = [ackConfirm, ackMine, ackStatus, ackOverview] as const;
