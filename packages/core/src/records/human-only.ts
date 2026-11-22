// A person's own fields and settings (stage 31a, ADR 0507): a field or an extension setting
// declared `humanOnly` (a gym's booking rules) is changed by a person. The gate asks this of every
// write before it decides: when the call sets one and its actor is not a person (the assistant,
// an MCP client, an automation, extension code), the call waits for a person's approval, exactly
// as an AI's publish request does (ADR 0480, `ALWAYS_REVIEWED_PUBLISHERS`). A person approving it
// is the change being made by a person.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { getObject } from "../fields/index.ts";

type Values = Record<string, unknown>;

const isValues = (value: unknown): value is Values =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `values` sets a human-only field of `object`. */
function setsHumanOnly(object: unknown, values: unknown): boolean {
  if (typeof object !== "string" || !isValues(values)) return false;
  const definition = getObject(object);
  if (!definition) return false;
  return Object.keys(values).some(
    (name) => definition.fields.find((f) => f.name === name)?.options?.humanOnly === true,
  );
}

/** Whether the call `operation` with `input` sets a human-only field or setting. */
export async function touchesHumanOnly(
  db: Kysely<CoreDatabase>,
  operation: string,
  input: unknown,
): Promise<boolean> {
  if (!isValues(input)) return false;
  switch (operation) {
    case "record.create":
    case "record.update":
    case "recurring.change":
    case "recurring.close":
      return setsHumanOnly(input.object, input.values);
    case "record.createMany":
    case "record.import": {
      const records = Array.isArray(input.records) ? input.records : [];
      return records.some((r) =>
        setsHumanOnly(input.object, isValues(r) && isValues(r.values) ? r.values : r),
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
        (JSON.parse(row.manifest) as { settings?: Record<string, { humanOnly?: boolean }> })
          .settings ?? {};
      return Object.keys(input.values).some(
        (name) => Object.hasOwn(settings, name) && settings[name]?.humanOnly === true,
      );
    }
    default:
      return false;
  }
}
