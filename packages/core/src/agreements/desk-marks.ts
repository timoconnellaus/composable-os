// The marks on an acceptance made at the desk (stage 44 step 6, decision 22, ADR 0649): shown on
// the Acceptances list and the Person's tab, so a pattern of staff signing for members is visible
// to an admin. They are marks, not alerts: nobody is notified, and a busy desk's walk-ins do not
// become noise. Worked out when the list is read, from the records and the audit, so a change
// made, signed under and changed back is still caught.
//
//   changed_recently  the Person's primary address changed in the 30 days before the signing, or
//                     in the 30 after, by any path the audit records (a staff edit, adding a
//                     second address and making it primary, a merge, an import); the mark says
//                     who changed it and with which operation
//   created_that_day  the Person was created within 24 hours before the signing (a walk-in:
//                     expected and common)
//   staff_address     the address the copy went to is also a staff account's, compared by mailbox
//                     (`mailboxKey`: case folded, a plus-tag removed, dots only where the
//                     platform already folds them)
//
// Three bounded reads for a page of up to 200 acceptances, whatever is on it, each with a handful
// of bound values (the people go as one JSON list).
import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, sql } from "kysely";
import { mailboxKey } from "../customers/limits.ts";

type Db = Kysely<CoreDatabase>;

export const DESK_MARKS = ["changed_recently", "created_that_day", "staff_address"] as const;
export type DeskMarkKind = (typeof DESK_MARKS)[number];

export interface DeskMark {
  kind: DeskMarkKind;
  /** changed_recently: when, by whom (a staff name, or the host) and with which operation. */
  at?: string;
  by?: string;
  how?: string;
}

const DAY_MS = 24 * 60 * 60_000;
const WINDOW_MS = 30 * DAY_MS;
/** The most email changes read for one page (each is one audit row of a Person's emails). */
const CHANGES_LIMIT = 2_000;

/** The primary address in an audited `emails` value, whatever shape it was recorded in. */
function primaryOf(value: unknown): string | null {
  if (!Array.isArray(value) || !value.length) return null;
  const items = value as unknown[];
  const flagged = items.find(
    (e) => typeof e === "object" && e !== null && (e as { primary?: unknown }).primary === true,
  );
  const first = flagged ?? items[0];
  if (typeof first === "string") return first.toLowerCase();
  const email = (first as { email?: unknown } | null)?.email;
  return typeof email === "string" ? email.toLowerCase() : null;
}

export interface MarkedRow {
  id: string;
  personId: string | null;
  email: string | null;
  acceptedAt: string;
}

/** Each desk acceptance's marks, by acceptance id. */
export async function deskMarks(
  db: Db,
  rows: readonly MarkedRow[],
): Promise<Map<string, DeskMark[]>> {
  const out = new Map<string, DeskMark[]>();
  const live = rows.filter((r) => r.personId);
  if (!live.length) return out;
  const people = [...new Set(live.map((r) => r.personId as string))];
  // One bound value however many people: D1 allows 100 per statement.
  const ids = JSON.stringify(people);
  const times = live.map((r) => Date.parse(r.acceptedAt));
  const from = new Date(Math.min(...times) - WINDOW_MS).toISOString();
  const to = new Date(Math.max(...times) + WINDOW_MS).toISOString();
  const [created, staff, changes] = await Promise.all([
    db
      .selectFrom("core_person")
      .select(["id", "created_at"])
      .where(sql<boolean>`id IN (SELECT value FROM json_each(${ids}))`)
      .execute(),
    db.selectFrom("core_user").select("email").where("kind", "=", "human").execute(),
    db
      .selectFrom("core_audit_changes as c")
      .innerJoin("core_audit as a", "a.id", "c.audit_id")
      .leftJoin("core_user as u", "u.id", "a.user_id")
      .select(["c.record_id", "c.at", "c.diff", "a.operation", "a.actor", "u.name"])
      // The address a Person was made with is not a change of it.
      .where("c.action", "!=", "create")
      .where("c.object_type", "=", "person")
      .where(sql<boolean>`c.record_id IN (SELECT value FROM json_each(${ids}))`)
      .where("c.at", ">=", from)
      .where("c.at", "<=", to)
      .where("c.diff", "like", '%"emails"%')
      .orderBy("c.at")
      .limit(CHANGES_LIMIT)
      .execute(),
  ]);
  const createdAt = new Map(created.map((p) => [p.id, Date.parse(p.created_at)]));
  const staffBoxes = new Set(staff.map((u) => mailboxKey(u.email.trim().toLowerCase())));
  const primaryChanges = changes.flatMap((c) => {
    try {
      const diff = JSON.parse(c.diff) as { emails?: { before?: unknown; after?: unknown } };
      if (!diff.emails || primaryOf(diff.emails.before) === primaryOf(diff.emails.after)) return [];
      return [
        {
          personId: c.record_id,
          at: c.at,
          by: c.name ?? (c.actor === "human" ? "a member of staff" : c.actor),
          how: c.operation,
        },
      ];
    } catch {
      return [];
    }
  });
  for (const row of live) {
    const at = Date.parse(row.acceptedAt);
    const marks: DeskMark[] = [];
    const change = primaryChanges.find(
      (c) => c.personId === row.personId && Math.abs(Date.parse(c.at) - at) <= WINDOW_MS,
    );
    if (change)
      marks.push({ kind: "changed_recently", at: change.at, by: change.by, how: change.how });
    const made = createdAt.get(row.personId as string);
    if (made !== undefined && at - made >= 0 && at - made <= DAY_MS) {
      marks.push({ kind: "created_that_day" });
    }
    if (row.email && staffBoxes.has(mailboxKey(row.email.trim().toLowerCase()))) {
      marks.push({ kind: "staff_address" });
    }
    out.set(row.id, marks);
  }
  return out;
}
