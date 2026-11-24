// A birthday on Person (stage 53 step 7, ADR 0803): day and month only, optional, given by the
// member (`me.birthday.set`) or by staff (`person.setBirthday`). No year is kept, so a birthday
// says nothing of a member's age: a minor is what the family link or the Minor mark says.
//
// It is a field like any other for the write path: a change is recorded under `birthday`, so the
// audit diff and its value mark (ADR 0590) follow; it is in no `rec_*` view, export or dashboard
// (migration 1171). Erase deletes it with the Person's row; a merge keeps the survivor's unless it
// has none (`mergedBirthday`). The birthday entry rule reads it through one indexed query a page
// (`birthdayPeople`), for the daily scan to enter (step 4).
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ForbiddenError } from "../errors.ts";
import type { HandlerContext } from "../operation.ts";
import { valueHash } from "../routine-mail/marks.ts";
import { localParts } from "../time/local.ts";
import { orgReader, visibleTable } from "../visibility/index.ts";

/** The field a birthday is recorded and marked under. */
export const BIRTHDAY_FIELD = "birthday";

/** The most days each month has (29 for February: a birthday on 29 February is one). */
export const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export const birthdaySchema = z
  .object({
    day: z.number().int().min(1).max(31).describe("Day of the month, 1 to 31"),
    month: z.number().int().min(1).max(12).describe("Month, 1 (January) to 12 (December)"),
  })
  .strict()
  .refine((b) => b.day <= (DAYS_IN_MONTH[b.month - 1] ?? 0), {
    message: "That month has no such day",
    path: ["day"],
  })
  .describe("A birthday: day and month only, never a year");
export type Birthday = z.infer<typeof birthdaySchema>;

/** A Person row's birthday, or null. */
export function birthdayOf(row: {
  birth_day: number | null;
  birth_month: number | null;
}): Birthday | null {
  return row.birth_day !== null && row.birth_month !== null
    ? { day: row.birth_day, month: row.birth_month }
    : null;
}

const same = (a: Birthday | null, b: Birthday | null) =>
  a === b || (a !== null && b !== null && a.day === b.day && a.month === b.month);

/**
 * Queues setting a Person's birthday (null clears it) and records the change under `birthday`,
 * so its audit diff and value mark are written in the same batch. Nothing when it is unchanged.
 * `record` is `ctx.recordChange`, or `recordHostChange` for a customer's own (`me.birthday.set`).
 */
export function queueSetBirthday(
  ctx: Pick<HandlerContext, "db" | "write" | "now">,
  record: HandlerContext["recordChange"],
  personId: string,
  before: Birthday | null,
  after: Birthday | null,
): boolean {
  if (same(before, after)) return false;
  ctx.write(
    // Written over the value read: a birthday set meanwhile (the member's own) fails this batch.
    birthdayGuard(ctx, personId, before),
    ctx.db
      .updateTable("core_person")
      .set({
        birth_day: after?.day ?? null,
        birth_month: after?.month ?? null,
        updated_at: ctx.now,
      })
      .where("id", "=", personId),
  );
  record({
    object: "person",
    id: personId,
    action: "update",
    before: { [BIRTHDAY_FIELD]: before },
    after: { [BIRTHDAY_FIELD]: after },
  });
  return true;
}

/**
 * The statement that fails its batch (`core_birthday_changed`, a conflict) unless the Person's
 * birthday is still `expected`, the value the write was planned from (migration 1171's guard).
 */
export function birthdayGuard(
  ctx: Pick<HandlerContext, "db">,
  personId: string,
  expected: Birthday | null,
) {
  return ctx.db.insertInto("core_birthday_guard").values({
    person_id: personId,
    birth_day: expected?.day ?? null,
    birth_month: expected?.month ?? null,
  });
}

/** Whether the member gave `current`: the current value's mark is the customer's. */
async function memberGave(
  db: HandlerContext["db"],
  personId: string,
  current: Birthday | null,
): Promise<boolean> {
  if (current === null) return false;
  const mark = await db
    .selectFrom("core_value_mark")
    .select(["standing", "value_hash"])
    .where("object_type", "=", "person")
    .where("record_id", "=", personId)
    .where("field", "=", BIRTHDAY_FIELD)
    .executeTakeFirst();
  return mark?.standing === "customer" && mark.value_hash === (await valueHash(current));
}

const memberBirthday = (what: string) =>
  new ForbiddenError(`The member gave this birthday: only a person may ${what}`, {
    rule: "member_birthday",
  });

/**
 * Refuses an AI's change of a birthday the member gave (stage 53: the assistant may not change a
 * birthday a member gave). A person on the staff may change it; an AI may set one the member did
 * not give.
 */
export async function assertMayChangeBirthday(
  ctx: Pick<HandlerContext, "db" | "actor">,
  personId: string,
  current: Birthday | null,
): Promise<void> {
  if (ctx.actor === "human") return;
  if (await memberGave(ctx.db, personId, current)) throw memberBirthday("change it");
}

/** A merge's birthday: the survivor's, unless it has none (stage 53). */
export function mergedBirthday(survivor: Birthday | null, merged: Birthday | null) {
  return survivor ?? merged;
}

/**
 * Refuses an AI's merge that would drop the duplicate's member-given birthday (the survivor's
 * wins) or carry it to the survivor (the copy would be the AI's): either changes the member's own
 * word, which only a person may do (the review of PR #431). A merge that leaves it as it was,
 * the survivor holding the same day, goes on.
 */
export async function assertMergeKeepsMemberBirthday(
  ctx: Pick<HandlerContext, "db" | "actor">,
  survivor: { id: string; birthday: Birthday | null },
  merged: { id: string; birthday: Birthday | null },
): Promise<void> {
  if (ctx.actor === "human" || same(survivor.birthday, merged.birthday)) return;
  if (await memberGave(ctx.db, merged.id, merged.birthday)) throw memberBirthday("merge it away");
}

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * Whose birthday the local day `now` falls on in `zone` is: that month, and its day. On 28
 * February of a year with no 29th, a birthday on 29 February is kept that day too.
 */
export function birthdaysOn(
  now: number | Date | string,
  zone: string,
): { date: string; month: number; days: number[] } {
  const today = localParts(now, zone);
  const days =
    today.month === 2 && today.day === 28 && !isLeap(today.year) ? [28, 29] : [today.day];
  return { date: today.date, month: today.month, days };
}

/** People read a page by the birthday entry rule. */
export const BIRTHDAY_PAGE = 500;

/**
 * The live People whose birthday is today in `zone` (`birthdaysOn`), by id, a page at a time:
 * one statement per page through the birthday index (migration 1171), whatever the number of
 * People. Pass the last page's `next` as `after` for the next. A Person with no birthday is never
 * among them. Who of these a journey enters (its conditions, re-entry, exclusions) is the entry
 * code's (`entryCandidates`).
 */
export async function birthdayPeople(
  db: Kysely<CoreDatabase>,
  input: { now: number | Date | string; zone: string; after?: string | null; limit?: number },
): Promise<{ ids: string[]; next: string | null }> {
  const { month, days } = birthdaysOn(input.now, input.zone);
  const limit = Math.min(Math.max(input.limit ?? BIRTHDAY_PAGE, 1), BIRTHDAY_PAGE);
  // Work with no caller (the daily scan): the org's view of People, through the seam.
  const rows = await db
    .selectFrom(visibleTable(orgReader(db), "person"))
    .select("id")
    .where("birth_month", "=", month)
    .where("birth_day", "in", days)
    .where("deleted_at", "is", null)
    .where("merged_into_id", "is", null)
    .where("id", ">", input.after ?? "")
    .orderBy("id")
    .limit(limit)
    .execute();
  const ids = rows.map((r) => r.id);
  return { ids, next: ids.length === limit ? (ids[ids.length - 1] ?? null) : null };
}
