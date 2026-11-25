// The notices of read and understood (stage 38 step 5, ADR 0706). The words are the pack's
// (`acknowledge.notices`); who they go to is the host's, because only the host knows who must read
// a record and who has not confirmed it:
//
//   asked        a version that asks everyone goes live   everyone who must read it, once a version;
//                (or someone comes into "must read" later) and later anyone it asks who was never told
//   reminder     still to read `afterDays` after they     that person, once a version
//                were told
//   outstanding  each week while anyone has not, from     the record's owner when they manage the
//                `afterDays` after the version asked      object, else the admins
//   welcome      a staff account made in the last week    that person, once, listing what to read
//                with records to read
//
// Every notice is the person's only (`human_only`, ADR 0643): no AI actor, automation or extension
// acting for them lists it, counts it, marks it read or reads it in the digest, since it says who
// has or has not confirmed what (the spec: an AI never learns it).
//
// `asked` is written in the publish batch (record.publish, and record.publishDue for a scheduled
// one when it goes live), so a publish that fails tells nobody. The rest is the minute cron's daily
// work (`ack.due`, from 07:00 local), bounded: one read of the staff, a few per acknowledged
// object, one per chunk of the notices it would send (which of them exist already), and at most
// ACK_NOTICES_PER_RUN notices in a run, written a hundred to a statement. A day with more carries
// on at the next tick (what was sent is found and skipped); the day's marker is written with the
// run that finishes it. Nothing here is read by an extension: the pack declares the words and
// never learns who was told.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, sql } from "kysely";
import type { ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { loadGeneralSettings } from "../settings.ts";
import { localParts } from "../time/local.ts";
import { visibleSource } from "../visibility/index.ts";
import {
  type AcknowledgedObject,
  accountManages,
  acknowledgedObject,
  acknowledgedObjects,
  counts,
  dueRecords,
  latestConfirmations,
  liveStaff,
  mustReadIncludes,
  parseMustRead,
  type StaffAccount,
  shippedGrantable,
} from "./acknowledge.ts";

/** The local hour from which the day's notices go out. */
export const ACK_NOTICE_HOUR = 7;
/** The most notices one daily run writes; the rest wait for the next tick. */
export const ACK_NOTICES_PER_RUN = 300;
/** Notices per INSERT statement. */
const PER_STATEMENT = 100;
/** Notices looked up per read when finding which were sent already. */
const LOOKUP_CHUNK = 400;
/** How long after a reminder falls due it may still be sent (a cron that was down catches up). */
const REMINDER_WINDOW_DAYS = 30;
/** A staff account made this recently is welcomed with what it has to read. */
const WELCOME_DAYS = 7;
/** The weekly notice and the reminder wait this long when the object names no reminder. */
const DEFAULT_AFTER_DAYS = 7;
/** The marker of the day's run (core_staff_run: the staff's daily work, one row a job). */
const RUN_NAME = "ack.notices";
const DAY_MS = 86_400_000;

const fill = (text: string, title: string | null) =>
  text.replaceAll("{record}", title?.trim() || "Untitled");

/** The notices an object declares that the daily run sends. */
const dailyNotices = (object: AcknowledgedObject) => {
  const n = object.publishable.acknowledge.notices;
  return n?.reminder || n?.outstanding || n?.welcome || n?.asked ? n : null;
};

/** One notice to one live staff account (the caller has checked the account). */
interface Notice {
  to: string;
  key: string;
  title: string;
  body: string | null;
  link: { object: string; id: string } | null;
}

function words(
  w: { title: string; body?: string | undefined },
  title: string | null,
  extra?: string,
): Pick<Notice, "title" | "body"> {
  const body = [w.body ? fill(w.body, title) : null, extra ?? null]
    .filter((part): part is string => !!part)
    .join("\n\n")
    .slice(0, 2000);
  return { title: fill(w.title, title).slice(0, 200), body: body || null };
}

/**
 * The INSERTs of `notices`, a hundred to a statement, each the person's only (human_only) and
 * keyed so a repeat is ignored. No read: the recipients are live staff accounts already.
 */
export function noticeWrites(
  ctx: Pick<HandlerContext, "now" | "actor" | "user">,
  notices: readonly Notice[],
): CompiledQuery[] {
  const source = JSON.stringify({ actor: ctx.actor, userId: ctx.user.id });
  const out: CompiledQuery[] = [];
  for (let i = 0; i < notices.length; i += PER_STATEMENT) {
    const rows = notices.slice(i, i + PER_STATEMENT).map((n) => ({
      id: newId("notification"),
      to: n.to,
      key: n.key,
      title: n.title,
      body: n.body,
      link: n.link ? JSON.stringify({ kind: "record", ...n.link }) : null,
    }));
    out.push(
      CompiledQuery.raw(
        "INSERT OR IGNORE INTO core_notifications (id, user_id, type, title, body, link, source, dedupe_key, human_only, read_at, created_at) SELECT json_extract(value, '$.id'), json_extract(value, '$.to'), 'system.message', json_extract(value, '$.title'), json_extract(value, '$.body'), json_extract(value, '$.link'), ?, json_extract(value, '$.key'), 1, NULL, ? FROM json_each(?)",
        [source, ctx.now, JSON.stringify(rows)],
      ),
    );
  }
  return out;
}

const askedKey = (object: string, id: string, version: number) =>
  `ack.asked:${object}:${id}:${version}`;

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
): Promise<CompiledQuery[]> {
  const acknowledged = acknowledgedObject(object);
  const w = acknowledged?.publishable.acknowledge.notices?.asked;
  if (!acknowledged || !w || readAgain !== true) return [];
  const must = parseMustRead(values[acknowledged.publishable.acknowledge.who]);
  const raw = values[acknowledged.titleField];
  const title = typeof raw === "string" ? raw : null;
  const to = (await liveStaff(ctx)).filter((a) => mustReadIncludes(must, a));
  return noticeWrites(
    ctx,
    to.map((a) => ({
      to: a.id,
      key: askedKey(object.name, id, version),
      ...words(w, title),
      link: { object: object.name, id },
    })),
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

/** The owner (a user field) of each record, through the visibility seam. */
async function ownersOf(
  ctx: HandlerContext,
  object: AcknowledgedObject,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const field = object.fields.find((f) => f.name === object.publishable.acknowledge.owner);
  if (!field?.column || !ids.length) return new Map();
  const rows = await sql<{ id: string; owner: string | null }>`
    SELECT r.id, ${sql.ref(`r.${field.column}`)} AS owner FROM ${visibleSource(ctx, object, "r")}
    WHERE r.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
  `.execute(ctx.db);
  return new Map(rows.rows.flatMap((r) => (r.owner ? [[r.id, r.owner] as const] : [])));
}

/** When each (account, key) was already written, read a chunk at a time by the dedupe index. */
async function sentAt(
  db: Kysely<CoreDatabase>,
  wanted: readonly { u: string; k: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < wanted.length; i += LOOKUP_CHUNK) {
    const rows = await sql<{ user_id: string; dedupe_key: string; created_at: string }>`
      SELECT n.user_id, n.dedupe_key, n.created_at
      FROM json_each(${JSON.stringify(wanted.slice(i, i + LOOKUP_CHUNK))}) j
      JOIN core_notifications n
        ON n.user_id = json_extract(j.value, '$.u') AND n.dedupe_key = json_extract(j.value, '$.k')
    `.execute(db);
    for (const r of rows.rows) out.set(`${r.user_id}|${r.dedupe_key}`, parseTime(r.created_at));
  }
  return out;
}

type Kind = "asked" | "reminder" | "outstanding" | "welcome";
type Planned = Notice & { kind: Kind };

/**
 * The day's notices, in the caller's batch (`ack.due`, as the host), bounded (see the top of the
 * file). Returns what it wrote, and whether more is left for the next tick.
 */
export async function ackDaily(ctx: HandlerContext): Promise<{
  asked: number;
  reminders: number;
  outstanding: number;
  welcomes: number;
  more: boolean;
}> {
  const out = { asked: 0, reminders: 0, outstanding: 0, welcomes: 0, more: false };
  const { timezone } = await loadGeneralSettings(ctx.db);
  const nowMs = Date.parse(ctx.now);
  const local = localParts(nowMs, timezone);
  const marker = ctx.db
    .insertInto("core_staff_run")
    .values({ name: RUN_NAME, last_date: local.date })
    .onConflict((oc) => oc.column("name").doUpdateSet({ last_date: local.date }));
  const objects = acknowledgedObjects().filter(dailyNotices);
  const staff = objects.length ? await liveStaff(ctx) : [];
  if (!staff.length) {
    ctx.write(marker);
    return out;
  }
  const byId = new Map(staff.map((a) => [a.id, a]));
  const made = new Map(
    (
      await sql<{ id: string; created_at: string }>`
        SELECT id, created_at FROM core_user
        WHERE id IN (SELECT value FROM json_each(${JSON.stringify(staff.map((a) => a.id))}))
      `.execute(ctx.db)
    ).rows.map((r) => [r.id, parseTime(String(r.created_at))]),
  );
  const grantable = await shippedGrantable(ctx);
  const admins = staff.filter((a) => a.role === "admin" && a.packRole === null);
  const week = weekOf(local.date, local.weekday);

  // What each object's due records would send, before knowing what was sent already.
  interface Pair {
    object: AcknowledgedObject;
    record: Awaited<ReturnType<typeof dueRecords>>[number];
    account: StaffAccount;
    isNew: boolean;
  }
  const pairs: Pair[] = [];
  const weekly: Planned[] = [];
  for (const object of objects) {
    const w = object.publishable.acknowledge.notices ?? {};
    const records = await dueRecords(ctx, object);
    if (!records.length) continue;
    const ids = records.map((r) => r.id);
    const latest = new Map(
      (await latestConfirmations(ctx, object.name, { records: ids })).map((c) => [
        `${c.record}:${c.account}`,
        c.version,
      ]),
    );
    const owners = w.outstanding ? await ownersOf(ctx, object, ids) : new Map<string, string>();
    const after = (w.reminder?.afterDays ?? DEFAULT_AFTER_DAYS) * DAY_MS;
    for (const record of records) {
      const notYet = staff.filter(
        (a) =>
          mustReadIncludes(record.must, a) && !counts(record, latest.get(`${record.id}:${a.id}`)),
      );
      if (!notYet.length) continue;
      for (const account of notYet) {
        const joined = made.get(account.id) ?? 0;
        pairs.push({
          object,
          record,
          account,
          isNew: !!w.welcome && nowMs - joined <= WELCOME_DAYS * DAY_MS,
        });
      }
      // The weekly notice, from a week after the version asked: to the owner when they may see who
      // has not (decision 13), else the admins (as the review reminder falls back).
      if (w.outstanding && nowMs - parseTime(record.askedAt) >= after) {
        const owner = byId.get(owners.get(record.id) ?? "");
        const to = owner && accountManages(owner, object, grantable) ? [owner] : admins;
        const shown = notYet.slice(0, 30).map((a) => a.name);
        const body = `Not yet confirmed: ${shown.join(", ")}${notYet.length > 30 ? ` and ${notYet.length - 30} more` : ""}.`;
        for (const a of to) {
          weekly.push({
            kind: "outstanding",
            to: a.id,
            key: `ack.outstanding:${object.name}:${record.id}:${week}`,
            ...words(w.outstanding, record.title, body),
            link: { object: object.name, id: record.id },
          });
        }
      }
    }
  }

  // Which of them were sent already, and when a person was first told of a version.
  const wanted: { u: string; k: string }[] = [];
  for (const p of pairs) {
    const { object, record, account } = p;
    wanted.push({ u: account.id, k: askedKey(object.name, record.id, record.askedVersion) });
    wanted.push({
      u: account.id,
      k: `ack.reminder:${object.name}:${record.id}:${record.askedVersion}`,
    });
    if (p.isNew) wanted.push({ u: account.id, k: `ack.welcome:${object.name}` });
  }
  for (const n of weekly) wanted.push({ u: n.to, k: n.key });
  const seen = new Set<string>();
  const sent = await sentAt(
    ctx.db,
    wanted.filter((x) => {
      const id = `${x.u}|${x.k}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  );
  const has = (u: string, k: string) => sent.get(`${u}|${k}`);

  const planned: Planned[] = [];
  const welcome = new Map<
    string,
    { object: AcknowledgedObject; account: string; titles: string[] }
  >();
  for (const p of pairs) {
    const { object, record, account } = p;
    const w = object.publishable.acknowledge.notices ?? {};
    const asked = askedKey(object.name, record.id, record.askedVersion);
    const welcomeKey = `ack.welcome:${object.name}`;
    const told = [has(account.id, asked), p.isNew ? has(account.id, welcomeKey) : undefined]
      .filter((t): t is number => t !== undefined)
      .sort((a, b) => a - b)[0];
    if (p.isNew && has(account.id, welcomeKey) === undefined) {
      // A new account is welcomed once with every record it has to read.
      const key = `${account.id}|${object.name}`;
      const entry = welcome.get(key) ?? { object, account: account.id, titles: [] };
      entry.titles.push(record.title?.trim() || "Untitled");
      welcome.set(key, entry);
    }
    if (told === undefined) {
      if (p.isNew) {
        // Told by the welcome being written now; the reminder counts from it.
      } else if (w.asked) {
        // Never told of this version (they came into "must read" after it went live): asked
        // first, the reminder a reminder's wait later.
        planned.push({
          kind: "asked",
          to: account.id,
          key: asked,
          ...words(w.asked, record.title),
          link: { object: object.name, id: record.id },
        });
      } else if (w.reminder) {
        // No words to ask with: the reminder counts from when it became theirs.
        const since = Math.max(parseTime(record.askedAt), made.get(account.id) ?? 0);
        reminderIfDue(planned, p, since, nowMs, has);
      }
      continue;
    }
    if (w.reminder) reminderIfDue(planned, p, told, nowMs, has);
  }
  for (const { object, account, titles } of welcome.values()) {
    const w = object.publishable.acknowledge.notices?.welcome;
    if (!w || has(account, `ack.welcome:${object.name}`) !== undefined) continue;
    const list = titles.slice(0, 20).map((t) => `- ${t}`);
    if (titles.length > 20) list.push(`and ${titles.length - 20} more`);
    planned.push({
      kind: "welcome",
      to: account,
      key: `ack.welcome:${object.name}`,
      ...words(w, null, list.join("\n")),
      link: null,
    });
  }
  for (const n of weekly) if (has(n.to, n.key) === undefined) planned.push(n);

  const now = planned.slice(0, ACK_NOTICES_PER_RUN);
  ctx.write(...noticeWrites(ctx, now));
  for (const n of now) {
    if (n.kind === "asked") out.asked += 1;
    else if (n.kind === "reminder") out.reminders += 1;
    else if (n.kind === "outstanding") out.outstanding += 1;
    else out.welcomes += 1;
  }
  out.more = planned.length > ACK_NOTICES_PER_RUN;
  // The day is done only when nothing is left for it.
  if (!out.more) ctx.write(marker);
  return out;
}

function reminderIfDue(
  planned: Planned[],
  p: {
    object: AcknowledgedObject;
    record: { id: string; askedVersion: number; title: string | null };
    account: StaffAccount;
  },
  since: number,
  nowMs: number,
  has: (u: string, k: string) => number | undefined,
) {
  const w = p.object.publishable.acknowledge.notices?.reminder;
  if (!w) return;
  const key = `ack.reminder:${p.object.name}:${p.record.id}:${p.record.askedVersion}`;
  if (has(p.account.id, key) !== undefined) return;
  const late = nowMs - since;
  const after = w.afterDays * DAY_MS;
  if (late < after || late >= after + REMINDER_WINDOW_DAYS * DAY_MS) return;
  planned.push({
    kind: "reminder",
    to: p.account.id,
    key,
    ...words(w, p.record.title),
    link: { object: p.object.name, id: p.record.id },
  });
}
