// Journeys' settings (stage 53, ADR 0800): a human admin's, in core_settings under `journeys`.
// Whether journeys send on their own (off on deploy until a human admin turns it on, as ADR 0590's
// D1; read by the send decision in step 4), the cap per Person, and the addresses a journey's
// replies may go to (a journey cannot point replies at an outside address).
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";

export const JOURNEY_SETTING = "journeys";

/** At most this many journey messages a Person gets in 7 days, across journeys (decision 8). */
export const JOURNEY_WEEK_CAP = 3;
/** At most this many a day, across journeys (decision 8). */
export const JOURNEY_DAY_CAP = 1;

export const journeySettingsSchema = z.object({
  sendOnOwn: z.boolean().default(false),
  /** Messages per Person in 7 days: the decision's 3, or fewer. Never more. */
  weekCap: z.number().int().min(1).max(JOURNEY_WEEK_CAP).default(JOURNEY_WEEK_CAP),
  /**
   * The reply-to addresses allowed: each a staff user's own address when the admin allowed it.
   * An organisation address confirmed by a code needs the host to send the code (step 4).
   */
  replyTo: z
    .array(z.object({ address: z.string().max(254), userId: z.string().max(64) }))
    .max(50)
    .default([]),
  updatedAt: z.string().nullable().default(null),
  updatedBy: z.string().nullable().default(null),
});
export type JourneySettings = z.infer<typeof journeySettingsSchema>;

const DEFAULTS: JourneySettings = journeySettingsSchema.parse({});

/** The settings; a missing or unreadable row is the defaults, which send nothing on their own. */
export async function loadJourneySettings(db: Kysely<CoreDatabase>): Promise<JourneySettings> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", JOURNEY_SETTING)
    .executeTakeFirst();
  if (!row) return DEFAULTS;
  try {
    const parsed = journeySettingsSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/**
 * The reply-to addresses a journey may use now: those the admin allowed whose staff account still
 * has that address. An account that left, or changed its address, no longer counts.
 */
export async function allowedReplyTo(
  db: Kysely<CoreDatabase>,
  settings?: JourneySettings,
): Promise<string[]> {
  const list = (settings ?? (await loadJourneySettings(db))).replyTo;
  if (!list.length) return [];
  const users = await db
    .selectFrom("core_user")
    .select(["id", "email"])
    .where(
      "id",
      "in",
      list.map((r) => r.userId),
    )
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .where("support_grant_id", "is", null)
    .execute();
  const current = new Map(users.map((u) => [u.id, u.email.trim().toLowerCase()]));
  return list
    .filter((r) => current.get(r.userId) === r.address.trim().toLowerCase())
    .map((r) => r.address.trim().toLowerCase());
}
