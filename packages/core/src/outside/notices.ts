// The members list's age, told (stage 65 step 4, ADR 0923): the minute cron tells the holders of
// bookingSystem:manage, once each, when the current members list is 3 days from the largest age
// and when it passes it and stops counting for members' prices and programs; and removes the
// lists' log rows (replaced or removed lists, counts only) past 30 days.
//
// Bounded: a quiet minute is two reads (the current members list with the settings, and whether
// a log row is due) and no write. A notice is one batch: the notifications (one a holder, at most
// 500 holders) and the list's `told_*_at`, guarded by `IS NULL` and by a dedupe key per list, so
// a list is told each thing once whatever the ticks do. The notices name no person.
import type { CrmDb } from "@composable-os/db";
import { sql } from "kysely";
import { notifyStatements } from "../notifications/send.ts";
import {
  businessToday,
  DEFAULT_LARGEST_AGE_DAYS,
  daysBetween,
  LIST_LOG_DAYS,
  listAge,
  TOO_OLD_NOTICE_DAYS,
} from "./settings.ts";

const MAX_HOLDERS = 500;

/** The active people who hold bookingSystem:manage: admins, and those granted it. */
async function managers(db: CrmDb["query"]): Promise<string[]> {
  const rows = await db
    .selectFrom("core_user")
    .select("id")
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .where("pack_role", "is", null)
    .where("support_grant_id", "is", null)
    .where((eb) =>
      eb.or([
        eb("role", "=", "admin"),
        sql<boolean>`json_valid(granted_permissions) AND EXISTS (SELECT 1 FROM json_each(granted_permissions) g WHERE g.value = 'bookingSystem:manage')`,
      ]),
    )
    .orderBy("id")
    .limit(MAX_HOLDERS)
    .execute();
  return rows.map((r) => r.id);
}

export interface ListNotices {
  /** "Too old in 3 days" sent now. */
  soon: boolean;
  /** "Stopped counting" sent now. */
  old: boolean;
  /** Log rows removed. */
  logRows: number;
}

/** One minute's step. */
export async function runOutsideListsDue(db: CrmDb, at: Date): Promise<ListNotices> {
  const now = at.toISOString();
  const out: ListNotices = { soon: false, old: false, logRows: 0 };
  const [list, logDue] = await Promise.all([
    db.query
      .selectFrom("core_outside_list as l")
      .leftJoin("core_outside_settings as s", (j) => j.on("s.id", "=", 1))
      .select([
        "l.id",
        "l.exported_on",
        "l.told_soon_at",
        "l.told_old_at",
        "s.largest_age_days",
        "s.enabled",
      ])
      .where("l.kind", "=", "members")
      .where("l.state", "=", "current")
      .where((eb) => eb.or([eb("l.told_soon_at", "is", null), eb("l.told_old_at", "is", null)]))
      // Only once it may be due: within 3 days of the largest age by UTC's day, a day early for
      // the business's zone. Before then a quiet minute reads nothing more (the review, M5).
      .where(
        sql<boolean>`l.exported_on <= date(${now}, '+1 day', '-' || (coalesce(s.largest_age_days, ${DEFAULT_LARGEST_AGE_DAYS}) - ${TOO_OLD_NOTICE_DAYS}) || ' days')`,
      )
      .executeTakeFirst(),
    db.query
      .selectFrom("core_outside_list")
      .select("id")
      .where("state", "!=", "current")
      .where("ended_at", "<", new Date(at.getTime() - LIST_LOG_DAYS * 86_400_000).toISOString())
      .limit(1)
      .executeTakeFirst(),
  ]);
  if (logDue) {
    const deleted = await db.query
      .deleteFrom("core_outside_list")
      .where("state", "!=", "current")
      .where("ended_at", "<", new Date(at.getTime() - LIST_LOG_DAYS * 86_400_000).toISOString())
      .executeTakeFirst();
    out.logRows = Number(deleted.numDeletedRows ?? 0);
  }
  // Nothing to tell, or the copy is off (nothing reads it, so nothing stops counting).
  if (!list || list.enabled === 0) return out;
  const largest = list.largest_age_days ?? DEFAULT_LARGEST_AGE_DAYS;
  const today = await businessToday(db.query, now);
  const age = listAge(list.exported_on, today, largest);
  const left = daysBetween(today, age.countsUntil);
  const tellOld = age.tooOld && list.told_old_at === null;
  // A list already past the largest age is told it stopped, not that it soon will.
  const tellSoon = !age.tooOld && left <= TOO_OLD_NOTICE_DAYS && list.told_soon_at === null;
  if (!tellOld && !tellSoon) return out;
  const to = (await managers(db.query)).map((userId) => ({ userId }));
  const date = list.exported_on;
  const notice = tellOld
    ? {
        title: "The booking system's members list is too old to count",
        body: `Members' prices and programs from the booking system's list of ${date} have stopped: it is past the largest age of ${largest} days. Load a new list (Settings → Booking system).`,
        key: `outside.list.old:${list.id}`,
      }
    : {
        title: "The booking system's members list stops counting soon",
        body: `The booking system's list of ${date} counts until ${age.countsUntil} (the largest age is ${largest} days). Load a new list before then, or members' prices and programs from it stop.`,
        key: `outside.list.soon:${list.id}`,
      };
  const plan = to.length
    ? await notifyStatements(
        db.query,
        {
          to,
          type: "system.message",
          title: notice.title,
          body: notice.body,
          dedupeKey: notice.key,
          source: { actor: "system" },
        },
        now,
      )
    : { statements: [] };
  await db.batch([
    tellOld
      ? db.query
          .updateTable("core_outside_list")
          .set({ told_old_at: now, told_soon_at: list.told_soon_at ?? now })
          .where("id", "=", list.id)
          .where("told_old_at", "is", null)
      : db.query
          .updateTable("core_outside_list")
          .set({ told_soon_at: now })
          .where("id", "=", list.id)
          .where("told_soon_at", "is", null),
    ...plan.statements,
  ]);
  out.soon = tellSoon;
  out.old = tellOld;
  return out;
}
