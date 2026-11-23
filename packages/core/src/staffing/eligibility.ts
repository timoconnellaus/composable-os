// Who may take a shift (stage 45 step 3, ADR 0623; decision 6: an offer goes only to people who
// can take it). Eligible: an active staff account, qualified for the shift's kind (a row in
// core_staff_qualification: a take is held to the rule, never warned), with a profile the shift's
// person field can name (a class's coach profile), not away over it, and free (no overlapping
// claim). The read is bounded by the people qualified for the kind, never by anyone's history.
import { sql } from "kysely";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import {
  awayOver,
  type Clash,
  claimOf,
  clashWith,
  kindObjectOf,
  personValueFor,
  qualified,
  type StoredShift,
} from "./index.ts";

/** The most qualified people one offer reads (a business's staff is far fewer). */
export const ELIGIBLE_MAX = 100;

export interface Eligibility {
  account: string;
  /** A person's account, not deactivated. */
  active: boolean;
  qualified: boolean;
  /** The value of the shift's person field that names them, or null (no profile). */
  person: string | null;
  away: boolean;
  /** The shift of theirs it would overlap, or null. */
  clash: Clash | null;
}

/** Whether, and why not, `account` may take the stored shift `s`. */
export async function eligibilityOf(
  ctx: HandlerContext,
  s: StoredShift,
  account: string,
): Promise<Eligibility> {
  const user = await ctx.db
    .selectFrom("core_user")
    .select(["id"])
    .where("id", "=", account)
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .executeTakeFirst();
  const kind = s.shift.kind;
  const isQualified = kind ? await qualified(ctx, s.object, account, kind, true) : false;
  const person = await personValueFor(ctx, s.object, account);
  const { starts, ends } = s.shift;
  const away =
    starts !== null && ends !== null && ends > starts
      ? (await awayOver(ctx, account, starts, ends)) !== null
      : false;
  const claim = claimOf({ ...s.shift, covered: true, account, live: true });
  const clash = claim ? await clashWith(ctx, s.object.name, s.id, claim) : null;
  return { account, active: Boolean(user), qualified: isQualified, person, away, clash };
}

/**
 * The accounts an offer of `s` goes to: qualified, active, with a profile, not away, free, and
 * not in `exclude` (the offerer, the shift's person). At most ELIGIBLE_MAX are read.
 */
export async function eligibleAccounts(
  ctx: HandlerContext,
  s: StoredShift,
  exclude: ReadonlySet<string>,
): Promise<string[]> {
  const kindObject = kindObjectOf(s.object);
  const kind = s.shift.kind;
  if (!kindObject || !kind) return [];
  const rows = await ctx.db
    .selectFrom("core_staff_qualification")
    .select("account_id")
    .where("kind_object", "=", kindObject)
    .where("kind_record", "=", kind)
    .orderBy("account_id")
    .limit(ELIGIBLE_MAX)
    .execute();
  const candidates = rows.map((r) => r.account_id).filter((a) => !exclude.has(a));
  if (!candidates.length) return [];
  const active = new Set(
    (
      await ctx.db
        .selectFrom("core_user")
        .select("id")
        .where("id", "in", jsonList(candidates))
        .where("kind", "=", "human")
        .where("deactivated_at", "is", null)
        .execute()
    ).map((r) => r.id),
  );
  // A kind record in the Trash or gone qualifies nobody (one read for every candidate).
  const first = candidates.find((a) => active.has(a));
  if (!first || !(await qualified(ctx, s.object, first, kind, true))) return [];
  const persons = await personValuesFor(ctx, s, [...active]);
  const { starts, ends } = s.shift;
  if (starts === null || ends === null || !(ends > starts)) return [];
  const out: string[] = [];
  // Two indexed reads each: their unavailability that can still overlap, their claims around it.
  for (const account of candidates) {
    if (!active.has(account) || !persons.has(account)) continue;
    if (await awayOver(ctx, account, starts, ends)) continue;
    if (await clashWith(ctx, s.object.name, s.id, { account, starts, ends })) continue;
    out.push(account);
  }
  return out;
}

/** The accounts of `accounts` the shift's person field can name (a profile each), in one read. */
async function personValuesFor(
  ctx: HandlerContext,
  s: StoredShift,
  accounts: readonly string[],
): Promise<Set<string>> {
  const def = s.object.staffed;
  if (!def?.who.account) return new Set(accounts);
  const holder = def.who.object ? getObject(def.who.object) : undefined;
  const table = holder ? objectTableOf(holder.name) : undefined;
  const column = holder?.fields.find((f) => f.name === def.who.account)?.column;
  if (!table || !column || !accounts.length) return new Set();
  const rows = await sql<{ account: string }>`SELECT ${sql.ref(column)} AS account FROM ${sql.table(
    table,
  )} WHERE ${sql.ref(column)} IN ${jsonList(accounts)} AND deleted_at IS NULL`.execute(ctx.db);
  return new Set(rows.rows.map((r) => r.account));
}
