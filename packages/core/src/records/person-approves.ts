// A person's own fields and settings (stage 31a, ADR 0507): a field or an extension setting
// declared `personApproves` (a gym's booking rules) is changed by a person. The gate asks this of every
// write before it decides: when the call sets one and its actor is not a person (the assistant,
// an MCP client, an automation, extension code), the call waits for a person's approval, exactly
// as an AI's publish request does (ADR 0480, `ALWAYS_REVIEWED_PUBLISHERS`). A person approving it
// is the change being made by a person.
//
// The same holds for a merge of People where either has a live family link (ADR 0540): who may act
// for whom is identity, and a merge moves, ends or deletes links; and for any change to a discount
// past its first state, live, paused or ended (ADR 0693, amended by ADR 0699): what buyers are
// charged is a person's to change.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { getObject, listObjects } from "../fields/index.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import { viewColumnOf } from "./columns.ts";
import { hasLiveLink } from "./person-links.ts";

type Values = Record<string, unknown>;

const isValues = (value: unknown): value is Values =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether `values` sets a human-only field of `object`. On an update (`changing`), a booked
 * shift's provider (`staffed.open`'s person, an appointment's coach) is one too (ADR 0764): who
 * gives a client's session is changed by a person, by every path, while booking one is not.
 */
function setsPersonApproves(object: unknown, values: unknown, changing = false): boolean {
  if (typeof object !== "string" || !isValues(values)) return false;
  const definition = getObject(object);
  if (!definition) return false;
  const provider = changing && definition.staffed?.open ? definition.staffed.who.field : undefined;
  return Object.keys(values).some(
    (name) =>
      name === provider ||
      definition.fields.find((f) => f.name === name)?.options?.personApproves === true,
  );
}

/**
 * Whether the record is a discount past its first state (ADR 0693, amended for stage 34 step 5):
 * its terms are what buyers are charged, or will be when a person moves it live again (a paused
 * discount resumed, a person's approved terms), so a change to it by anyone but a person
 * (loosening a limit, raising what it takes off) waits for a person. Every state but the
 * object's initial one counts, whatever the pack calls its live states: only a discount never yet
 * past its draft is anyone's to edit, and moving that one live is a person's act that checks its
 * terms (approvals/queue.ts, ADR 0699).
 */
async function isDiscountPastDraft(
  db: Kysely<CoreDatabase>,
  object: unknown,
  id: unknown,
): Promise<boolean> {
  if (typeof object !== "string" || typeof id !== "string") return false;
  const definition = getObject(object);
  const stateField = definition?.states?.field;
  if (!definition?.discount || !stateField) return false;
  const field = definition.fields.find((f) => f.name === stateField);
  const column = field ? viewColumnOf(field) : null;
  if (!column) return false;
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const row = (await (db as Kysely<any>)
    .selectFrom(visibleSource(orgReader(db), definition))
    .select(`${column} as state`)
    .where("id", "=", id)
    .executeTakeFirst()) as { state?: unknown } | undefined;
  if (!row) return false;
  const initial = definition.states?.initial;
  const state = row.state == null || row.state === "" ? initial : String(row.state);
  return state !== initial;
}

/** The record operations that write an extension record named by `input.object`. */
const RECORD_WRITES: ReadonlySet<string> = new Set([
  "record.create",
  "record.createMany",
  "record.update",
  "record.restore",
  "record.restoreVersion",
  "record.import",
]);

/** Whether `object` holds some discount's promo codes (its `codes.object`). */
function isCodeObject(object: string): boolean {
  return listObjects().some((o) => o.discount?.codes?.object === object);
}

/** The fields of `object` a recurring series copies onto it (ADR 0500's `copy` targets). */
function copiedFieldsOf(object: string): string[] {
  return listObjects().flatMap((o) =>
    o.recurring?.generates === object ? Object.keys(o.recurring.copy) : [],
  );
}

/** Whether the call `operation` with `input` sets a human-only field or setting. */
export async function touchesPersonApproves(
  db: Kysely<CoreDatabase>,
  operation: string,
  input: unknown,
): Promise<boolean> {
  if (!isValues(input)) return false;
  // Promo codes (ADR 0693, the review of PR #454): a code is a way into its discount, so any
  // write of one by anyone but a person (a new word, more uses, switched back on, pointed at
  // another discount, restored from the Trash) waits for a person, whatever its discount's state.
  // A discount restored from the Trash may be live again: the same.
  if (RECORD_WRITES.has(operation) && typeof input.object === "string") {
    if (isCodeObject(input.object)) return true;
    if (operation === "record.restore" && getObject(input.object)?.discount) return true;
  }
  switch (operation) {
    case "record.create":
    case "recurring.change":
    case "recurring.close":
      return setsPersonApproves(input.object, input.values);
    case "record.update":
      return (
        setsPersonApproves(input.object, input.values, true) ||
        (await isDiscountPastDraft(db, input.object, input.id))
      );
    // Following the series writes the named fields (default every copied one) from the series
    // (ADR 0620): a human-only field among them is a person's to change.
    case "recurring.follow": {
      if (typeof input.object !== "string") return false;
      const named = Array.isArray(input.fields)
        ? input.fields.filter((f): f is string => typeof f === "string")
        : copiedFieldsOf(input.object);
      return setsPersonApproves(input.object, Object.fromEntries(named.map((f) => [f, null])));
    }
    case "record.createMany":
    case "record.import": {
      const records = Array.isArray(input.records) ? input.records : [];
      return records.some((r) =>
        setsPersonApproves(input.object, isValues(r) && isValues(r.values) ? r.values : r),
      );
    }
    case "extensionSettings.update": {
      if (typeof input.extension !== "string" || !isValues(input.values)) return false;
      const row = await db
        .selectFrom("core_extensions")
        .select("manifest")
        .where("id", "=", input.extension)
        .executeTakeFirst();
      if (!row) return false;
      const settings =
        (JSON.parse(row.manifest) as { settings?: Record<string, { personApproves?: boolean }> })
          .settings ?? {};
      return Object.keys(input.values).some(
        (name) => Object.hasOwn(settings, name) && settings[name]?.personApproves === true,
      );
    }
    case "person.merge": {
      const ids = [input.survivorId, input.mergedId].filter(
        (id): id is string => typeof id === "string",
      );
      return hasLiveLink(db, ids);
    }
    default:
      return false;
  }
}
