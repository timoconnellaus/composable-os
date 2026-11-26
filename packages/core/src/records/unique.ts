// Declared uniqueness (stage 31, ADR 0502): among an object's live records in the rule's states,
// no two share the rule's fields (one active booking per Person per class).
//
// The rule is the database's: the reconciler builds a partial unique index per rule on the
// extension's table (extensions/reconciler.ts), so a second record, or a move back into a counted
// state, fails its batch whoever writes it and however many write at once (errors.ts answers it
// as a conflict, `rule: "unique"`). This read before the write only gives the common case a
// clear message, and the approval queue's dry run (whose writes are discarded) its answer.
import { foldUniqueText } from "@composable-os/sdk";
import type { Kysely } from "kysely";
import { ConflictError } from "../errors.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { visibleSource } from "../visibility/index.ts";

/**
 * `values` with the text fields of the object's folded rules (ADR 0864) kept as the host keeps
 * them: trimmed, upper case; one left empty by the trim is cleared. Every create and update of a
 * record passes through this, whoever writes it and by whatever path (a form, MCP, the import).
 */
export function foldUniqueValues(
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const names = new Set((object.unique ?? []).filter((r) => r.fold).flatMap((r) => r.fields));
  if (!names.size) return values;
  let out = values;
  for (const name of names) {
    const value = values[name];
    if (typeof value !== "string") continue;
    const folded = foldUniqueText(value);
    if (folded === value) continue;
    if (out === values) out = { ...values };
    out[name] = folded === "" ? null : folded;
  }
  return out;
}

/** Refuses a write that would leave two live records alike under one of the object's rules. */
export async function assertUnique(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  after: Record<string, unknown>,
  options: { restoring?: boolean } = {},
): Promise<void> {
  const stateField = object.states?.field;
  for (const rule of object.unique ?? []) {
    const state = stateField ? after[stateField] : undefined;
    if (rule.states && !(typeof state === "string" && rule.states.includes(state))) continue;
    const fields = rule.fields.map((name) => object.fields.find((f) => f.name === name));
    const values = rule.fields.map((name) => after[name]);
    if (values.some((v) => v === null || v === undefined || v === "")) continue;
    if (fields.some((f) => !f?.column)) continue;
    // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
    let query = (ctx.db as Kysely<any>)
      .selectFrom(visibleSource(ctx, object))
      .select("id")
      .where("id", "!=", id);
    fields.forEach((field, i) => {
      const value = values[i];
      query = query.where(
        field?.column as string,
        "=",
        typeof value === "boolean" ? (value ? 1 : 0) : value,
      );
    });
    const stateColumn = stateField
      ? object.fields.find((f) => f.name === stateField)?.column
      : undefined;
    if (rule.states && stateColumn) query = query.where(stateColumn, "in", [...rule.states]);
    const existing = (await query.limit(1).executeTakeFirst()) as { id: string } | undefined;
    if (!existing) continue;
    const labels = fields.map((f) => f?.label ?? "").join(" and ");
    const what = object.label.toLowerCase();
    throw new ConflictError(
      options.restoring
        ? `This ${what} cannot come back from the Trash: another ${what} now has the same ${labels}. Change or remove that one first, then restore this one.`
        : `There is already a ${what} for this ${labels}`,
      {
        rule: "unique",
        ...(options.restoring ? { reason: "taken_while_in_trash" } : {}),
        object: object.name,
        fields: [...rule.fields],
        existing: existing.id,
      },
    );
  }
}
