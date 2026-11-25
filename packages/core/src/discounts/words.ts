// Code words as the host keeps them (ADR 0940, amending ADR 0693): a discount's own `code` field
// and a codes object's `word` field are stored folded (`foldCode`, in the SDK: NFKC, no white
// space, upper case), at least CODE_MIN_LENGTH characters, whoever writes the record and by
// whatever path (createRecord and updateRecord fold them, as they make slugs). The reconciler keeps
// a unique index on each such column over the live records (extensions/reconciler.ts), so a code
// is looked up by that index (`codeMatches` in deal.ts) and one word names one live record of an
// object: a second is refused here in words, and by the index when two writes race.
import {
  CODE_MAX_LENGTH,
  CODE_MIN_LENGTH,
  foldCode,
  CODE_ALPHABET as GENERATED_ALPHABET,
} from "@composable-os/sdk";
import type { Kysely } from "kysely";
import { ConflictError, ValidationError } from "../errors.ts";
import { listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { viewColumnOf } from "../records/columns.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";

export { CODE_MAX_LENGTH, CODE_MIN_LENGTH, foldCode, GENERATED_ALPHABET };

/** The fields of `object` that hold code words: its own `code`, and `word` when it is a codes object. */
export function codeWordFields(object: ObjectDefinition): string[] {
  const fields: string[] = [];
  if (object.discount?.code) fields.push(object.discount.code);
  for (const other of listObjects()) {
    const codes = other.discount?.codes;
    if (codes && codes.object === object.name && !fields.includes(codes.word)) {
      fields.push(codes.word);
    }
  }
  return fields;
}

/** Whether a folded word could be a code at all (the lookup reads nothing for one that could not). */
export function possibleCode(folded: string): boolean {
  const length = [...folded].length;
  return length >= CODE_MIN_LENGTH && length <= CODE_MAX_LENGTH;
}

/**
 * `values` with every code word folded, refusing one shorter than CODE_MIN_LENGTH (or longer than
 * CODE_MAX_LENGTH) and one another live record of the object holds. An empty word is left for the
 * field's own rules. Every create and update of a record passes through this.
 */
export async function foldCodeWords(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string | null,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fields = codeWordFields(object).filter((name) => typeof values[name] === "string");
  if (!fields.length) return values;
  const folded = { ...values };
  for (const name of fields) {
    const word = foldCode(values[name] as string);
    if (word === "") {
      folded[name] = null;
      continue;
    }
    if (!possibleCode(word)) {
      throw new ValidationError(
        `A code is ${CODE_MIN_LENGTH} to ${CODE_MAX_LENGTH} letters or digits, so it cannot be guessed easily`,
        { field: name, rule: "code_length", min: CODE_MIN_LENGTH },
      );
    }
    folded[name] = word;
    const field = object.fields.find((f) => f.name === name);
    const column = field ? viewColumnOf(field) : null;
    if (!column) continue;
    // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
    let query = (ctx.db as Kysely<any>)
      .selectFrom(visibleSource(orgReader(ctx.db), object))
      .select("id")
      .where(column, "=", word);
    if (id) query = query.where("id", "!=", id);
    if (await query.limit(1).executeTakeFirst()) {
      throw new ConflictError(`There is already a code ${word}`, {
        field: name,
        rule: "code_taken",
      });
    }
  }
  return folded;
}
