// The notices of read and understood (stage 38 step 5, ADR 0706). The words are the pack's
// (`acknowledge.notices`); who they go to is the host's, because only the host knows who must read
// a record and who has not confirmed it:
//
//   asked        a version that asks everyone goes live   everyone who must read it, once a version
//   reminder     still to read `afterDays` after it was   that person, once a version
//                theirs to read
//   outstanding  each week while anyone has not           the record's owner (`acknowledge.owner`)
//   welcome      a staff account made in the last week    that person, once, listing what to read
//                with records to read
//
// `asked` is written in the publish batch (record.publish, and record.publishDue for a scheduled
// one when it goes live), so a publish that fails tells nobody. The other three are the minute
// cron's daily work (`ack.due`, once a local day from 07:00), each keyed so a repeated tick, a
// retried batch or a second day never sends one twice (core_notifications_dedupe_idx). Nothing
// here is read by an extension: the pack declares the words and never learns who was told.
import type { CoreDatabase } from "@composable-os/db";
import { type Compilable, type Kysely, sql } from "kysely";
import type { ObjectDefinition } from "../fields/types.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { loadGeneralSettings } from "../settings.ts";
import { localParts } from "../time/local.ts";
import {
  type AcknowledgedObject,
  acknowledgedObject,
  acknowledgedObjects,
  counts,
  dueRecords,
  latestConfirmations,
  liveStaff,
  mustReadIncludes,
  parseMustRead,
  type StaffAccount,
} from "./acknowledge.ts";

/** The local hour from which the day's notices go out. */
export const ACK_NOTICE_HOUR = 7;
/** How long after a reminder falls due it may still be sent (a cron that was down catches up). */
const REMINDER_WINDOW_DAYS = 30;
/** A staff account made this recently is welcomed with what it has to read. */
const WELCOME_DAYS = 7;
/** The marker of the day's run (core_staff_run: the staff's daily work, one row a job). */
const RUN_NAME = "ack.notices";
const DAY_MS = 86_400_000;

const fill = (text: string, title: string | null) =>
  text.replaceAll("{record}", title?.trim() || "Untitled");

/** The notices an object declares that the daily run sends. */
const dailyNotices = (object: AcknowledgedObject) => {
  const n = object.publishable.acknowledge.notices;
  return n?.reminder || n?.outstanding || n?.welcome ? n : null;
};

async function notice(
  ctx: Pick<HandlerContext, "db" | "now" | "actor" | "user">,
  to: readonly string[],
  words: { title: string; body?: string | undefined },
  title: string | null,
  link: { object: string; id: string } | null,
  dedupeKey: string,
  body?: string,
): Promise<Compilable[]> {
  if (!to.length) return [];
  const plan = await notifyStatements(
    ctx.db,
    {
      to: to.map((userId) => ({ userId })),
      type: "system.message",
      title: fill(words.title, title).slice(0, 200),
      body:
        [words.body ? fill(words.body, title) : null, body ?? null]
          .filter((part): part is string => !!part)
          .join("\n\n")
          .slice(0, 2000) || null,
      link: link ? { kind: "record", ...link } : null,
      dedupeKey,
      source: { actor: ctx.actor, userId: ctx.user.id },
    },
    ctx.now,
  );
  return plan.statements;
}

/**
 * The `asked` notice of a version going live, for the publish batch: to every live staff account
 * the record's "must read" names, when the version asks everyone (`readAgain`; the first always
 * does) and the object declares the words. Nothing otherwise.
 */
export async function askedNoticeWrites(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  version: number,
  values: Record<string, unknown>,
  readAgain: boolean | null,
): Promise<Compilable[]> {
  const acknowledged = acknowledgedObject(object);
  const words = acknowledged?.publishable.acknowledge.notices?.asked;
  if (!acknowledged || !words || readAgain !== true) return [];
  const must = parseMustRead(values[acknowledged.publishable.acknowledge.who]);
  const to = (await liveStaff(ctx)).filter((a) => mustReadIncludes(must, a)).map((a) => a.id);
  const title = values[acknowledged.titleField];
  return notice(
    ctx,
    to,
    words,
    typeof title === "string" ? title : null,
    { object: object.name, id },
    `ack.asked:${object.name}:${id}:${version}`,
  );
}

/** Whether the day's notices are due now (read outside any operation: a quiet minute writes nothing). */
export async function ackNoticesDue(db: Kysely<CoreDatabase>, nowIso: string): Promise<boolean> {
  if (!acknowledgedObjects().some(dailyNotices)) return false;
  const { timezone } = await loadGeneralSettings(db);
  const local = localParts(Date.parse(nowIso), timezone);
  if (local.hour < ACK_NOTICE_HOUR) return false;
  const ran = await db
    .selectFrom("core_staff_run")
    .select("last_date")
    .where("name", "=", RUN_NAME)
    .executeTakeFirst();
  return !ran || ran.last_date < local.date;
}

const parseTime = (value: string | null | undefined): number => {
  if (!value) return 0;
  const ms = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : 0;
};

/** The Monday of the local date's week, as `YYYY-MM-DD`: the weekly notice's key. */
function weekOf(date: string, weekday: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - (weekday - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Whether `account` may read who has confirmed records of `object` (ADR 0702's rule). */
async function manages(
  db: Kysely<CoreDatabase>,
  account: StaffAccount,
  object: AcknowledgedObject,
): Promise<boolean> {
  if (account.packRole !== null) return false;
  if (account.role === "admin") return true;
  const manage = object.publishable.acknowledge.manage;
  if (!account.grants.includes(manage)) return false;
  const rows = await sql<{ grantable: string | null }>`
    SELECT json_extract(manifest, '$.grantable') AS grantable FROM core_extensions
    WHERE id = ${object.extension ?? ""} AND status = 'active' AND source = 'shipped'
  `.execute(db);
  const grantable = rows.rows[0]?.grantable;
  return !!grantable && (JSON.parse(grantable) as unknown[]).includes(manage);
}

/** The owner (a user field) of each record, from the object's rec_* view. */
async function ownersOf(
  db: Kysely<CoreDatabase>,
  object: AcknowledgedObject,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const field = object.fields.find((f) => f.name === object.publishable.acknowledge.owner);
  if (!field?.column || !ids.length) return new Map();
  const rows = await sql<{ id: string; owner: string | null }>`
    SELECT id, ${sql.ref(field.column)} AS owner FROM ${sql.table(object.source)}
    WHERE id IN ${jsonList([...ids])}
  `.execute(db);
  return new Map(rows.rows.flatMap((r) => (r.owner ? [[r.id, r.owner] as const] : [])));
}

/**
 * The day's notices, in the caller's batch (`ack.due`, as the host): reminders, the weekly
 * notice to owners and the welcome of new accounts, for every acknowledged object that declares
 * them. Marks the day as done first, so a second tick the same day sends nothing.
 */
export async function ackDaily(
  ctx: HandlerContext,
): Promise<{ reminders: number; outstanding: number; welcomes: number }> {
  const out = { reminders: 0, outstanding: 0, welcomes: 0 };
  const { timezone } = await loadGeneralSettings(ctx.db);
  const nowMs = Date.parse(ctx.now);
  const local = localParts(nowMs, timezone);
  ctx.write(
    ctx.db
      .insertInto("core_staff_run")
      .values({ name: RUN_NAME, last_date: local.date })
      .onConflict((oc) => oc.column("name").doUpdateSet({ last_date: local.date })),
  );
  const objects = acknowledgedObjects().filter(dailyNotices);
  if (!objects.length) return out;
  const staff = await liveStaff(ctx);
  if (!staff.length) return out;
  const made = new Map(
    (
      await ctx.db
        .selectFrom("core_user")
        .select(["id", "created_at"])
        .where("id", "in", jsonList(staff.map((a) => a.id)))
        .execute()
    ).map((r) => [r.id, parseTime(String(r.created_at))]),
  );
  const week = weekOf(local.date, local.weekday);
  for (const object of objects) {
    const words = object.publishable.acknowledge.notices ?? {};
    const records = await dueRecords(ctx, object);
    if (!records.length) continue;
    const latest = new Map(
      (await latestConfirmations(ctx, object.name, {})).map((c) => [
        `${c.record}:${c.account}`,
        c.version,
      ]),
    );
    const owners = words.outstanding
      ? await ownersOf(
          ctx.db,
          object,
          records.map((r) => r.id),
        )
      : new Map<string, string>();
    const welcome = new Map<string, string[]>();
    for (const record of records) {
      const notYet = staff.filter(
        (a) =>
          mustReadIncludes(record.must, a) && !counts(record, latest.get(`${record.id}:${a.id}`)),
      );
      if (!notYet.length) continue;
      const link = { object: object.name, id: record.id };
      if (words.reminder) {
        const after = words.reminder.afterDays * DAY_MS;
        const due = notYet.filter((a) => {
          // Theirs to read since the version asked, or since they joined if that was later.
          const since = Math.max(parseTime(record.askedAt), made.get(a.id) ?? 0);
          const late = nowMs - since;
          return late >= after && late < after + REMINDER_WINDOW_DAYS * DAY_MS;
        });
        for (const a of due) {
          const writes = await notice(
            ctx,
            [a.id],
            words.reminder,
            record.title,
            link,
            `ack.reminder:${object.name}:${record.id}:${record.askedVersion}`,
          );
          ctx.write(...writes);
          out.reminders += writes.length;
        }
      }
      const owner = owners.get(record.id);
      const ownerAccount = owner ? staff.find((a) => a.id === owner) : undefined;
      if (words.outstanding && ownerAccount) {
        // Who has not is for those who manage the object (decision 13); anyone else is told how
        // many, and opens the record.
        const named = await manages(ctx.db, ownerAccount, object);
        const shown = notYet.slice(0, 30).map((a) => a.name);
        const body = named
          ? `Not yet confirmed: ${shown.join(", ")}${notYet.length > 30 ? ` and ${notYet.length - 30} more` : ""}.`
          : `${notYet.length} ${notYet.length === 1 ? "person has" : "people have"} not yet confirmed version ${record.version}.`;
        const writes = await notice(
          ctx,
          [ownerAccount.id],
          words.outstanding,
          record.title,
          link,
          `ack.outstanding:${object.name}:${record.id}:${week}`,
          body,
        );
        ctx.write(...writes);
        out.outstanding += writes.length;
      }
      if (words.welcome) {
        for (const a of notYet) {
          const joined = made.get(a.id) ?? 0;
          if (nowMs - joined > WELCOME_DAYS * DAY_MS) continue;
          welcome.set(a.id, [...(welcome.get(a.id) ?? []), record.title?.trim() || "Untitled"]);
        }
      }
    }
    if (words.welcome) {
      for (const [account, titles] of welcome) {
        const list = titles.slice(0, 20).map((t) => `- ${t}`);
        if (titles.length > 20) list.push(`and ${titles.length - 20} more`);
        const writes = await notice(
          ctx,
          [account],
          words.welcome,
          null,
          null,
          `ack.welcome:${object.name}`,
          list.join("\n"),
        );
        ctx.write(...writes);
        out.welcomes += writes.length;
      }
    }
  }
  return out;
}
