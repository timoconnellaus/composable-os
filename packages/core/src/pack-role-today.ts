// A pack role limited to today (stage 31a step 7, ADR 0553): a role may declare, by object, a
// datetime its holder's reach is limited to (`today: { "bookings.class": "startsAt" }`). An
// account holding it reaches a record of such an object only when that datetime falls on the
// organisation's local today: on the role's own record reads, and on every record a tool reads
// or changes while that account called it (the extension's run carries the caller's role). The
// coach sees today's classes and lists, and ticks today's names; nobody else is limited.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { NotFoundError } from "./errors.ts";
import { getObject } from "./fields/index.ts";
import type { HandlerContext } from "./operation.ts";
import type { HeldPackRole } from "./pack-roles.ts";
import { pathReader } from "./records/windows.ts";
import { loadGeneralSettings } from "./settings.ts";
import { localParts } from "./time/local.ts";
import { orgReader } from "./visibility/index.ts";

/** The operations a today limit holds: reads by id or list, and a write to one record. */
const LIMITED = new Set(["record.get", "record.list", "record.update"]);

type Values = Record<string, unknown>;

/** Whether `role` limits `operation` on the object its input names. */
export function roleTodayPath(
  role: Pick<HeldPackRole, "today"> | null | undefined,
  operation: string,
  input: unknown,
): { object: string; path: string } | null {
  if (!role?.today || !LIMITED.has(operation)) return null;
  const object = (input as { object?: unknown } | null)?.object;
  if (typeof object !== "string" || !Object.hasOwn(role.today, object)) return null;
  return { object, path: role.today[object] as string };
}

const dayOf = (at: number | string, zone: string) => {
  const p = localParts(at, zone);
  return `${p.year}-${p.month}-${p.day}`;
};

/** A checker of "on the organisation's local today" for records of one object. */
async function todayChecker(
  db: Kysely<CoreDatabase>,
  objectName: string,
  path: string,
  now: number,
) {
  const object = getObject(objectName);
  const zone = (await loadGeneralSettings(db)).timezone;
  const today = dayOf(now, zone);
  // The host's own read of what the path names (a booking's class), org-wide.
  const ctx = { ...orgReader(db), now: new Date(now).toISOString() } as unknown as HandlerContext;
  return async (values: Values): Promise<boolean> => {
    if (!object) return false;
    const at = await pathReader(ctx, object, values).read(path);
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return false;
    return dayOf(at, zone) === today;
  };
}

/** A record's values as `record.get` and `record.list` return them. */
const valuesOf = (record: unknown): Values =>
  ((record as { values?: Values } | null)?.values ?? {}) as Values;

/**
 * Before a limited write (`record.update`): refused as not found unless the record is today's.
 * `load` reads the record as the caller would.
 */
export async function assertRoleTodayWrite(
  db: Kysely<CoreDatabase>,
  role: Pick<HeldPackRole, "today"> | null | undefined,
  operation: string,
  input: unknown,
  load: (object: string, id: string) => Promise<unknown>,
  now = Date.now(),
): Promise<void> {
  if (operation !== "record.update") return;
  const limit = roleTodayPath(role, operation, input);
  if (!limit) return;
  const id = String((input as { id?: unknown }).id ?? "");
  const check = await todayChecker(db, limit.object, limit.path, now);
  if (!(await check(valuesOf(await load(limit.object, id))))) {
    throw new NotFoundError(limit.object, id);
  }
}

/**
 * After a limited read: `record.get` of a record that is not today's is not found;
 * `record.list` keeps today's only.
 */
export async function holdRoleTodayRead<T>(
  db: Kysely<CoreDatabase>,
  role: Pick<HeldPackRole, "today"> | null | undefined,
  operation: string,
  input: unknown,
  result: T,
  now = Date.now(),
): Promise<T> {
  if (operation === "record.update") return result;
  const limit = roleTodayPath(role, operation, input);
  if (!limit) return result;
  const check = await todayChecker(db, limit.object, limit.path, now);
  if (operation === "record.get") {
    if (!(await check(valuesOf(result)))) {
      throw new NotFoundError(limit.object, String((input as { id?: unknown }).id ?? ""));
    }
    return result;
  }
  const page = result as { items?: unknown[] } | null;
  if (!page?.items) return result;
  const kept: unknown[] = [];
  for (const item of page.items) if (await check(valuesOf(item))) kept.push(item);
  return { ...page, items: kept } as T;
}
