// The inbox's settings (stage 36, ADR 0749): one JSON value in core_settings under `inbox`,
// changed only by `inbox.settings.update` (a human admin's, audited).
//
// Step 3 keeps the admin's categories here. The other settings the spec lists (the inbox address
// and the address replies go from, the reopen window and the auto-acknowledgement: step 2; chat on
// or off: step 4; reply targets, opening hours, closed dates and their time zone: step 5) join
// this value with the steps that read them, each with its default, so a value written before them
// still reads.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";

export const INBOX_SETTING = "inbox";

/** At most this many categories, each at most this long. */
export const MAX_CATEGORIES = 50;
export const MAX_CATEGORY_CHARS = 40;

export const categorySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CATEGORY_CHARS)
  .describe("A category's name, as the admin wrote it");

export const inboxSettingsSchema = z.object({
  /** The admin's list of categories, in the order they are offered. */
  categories: z.array(categorySchema).max(MAX_CATEGORIES).default([]),
});
export type InboxSettings = z.infer<typeof inboxSettingsSchema>;

const DEFAULT_SETTINGS: InboxSettings = { categories: [] };

/** The inbox's settings; a missing or unreadable value is the defaults. */
export async function loadInboxSettings(db: Kysely<CoreDatabase>): Promise<InboxSettings> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", INBOX_SETTING)
    .executeTakeFirst();
  if (!row) return DEFAULT_SETTINGS;
  try {
    const parsed = inboxSettingsSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** The categories, each once (the first spelling kept, compared without case), in order. */
export function distinctCategories(categories: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of categories) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
