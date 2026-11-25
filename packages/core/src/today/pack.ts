// A shipped pack's Today items (stage 60 step 3, ADR 0874): which the caller may see, their
// values, and the rows behind one. The SQL is the pack's, checked at install (ADR 0870) and again
// here with the widget guards (`validateReadOnlySql`: one SELECT or WITH over rec_* views, writing
// nothing), and run only through `runReadOnlySql` with its row and time limits.
//
// Cost: every visible item is one column of one statement (`json_array` of its value today and,
// when it compares, at the same time yesterday or a week ago), so the statement count does not
// grow with the items or the records: a statement holds up to ITEM_COLUMNS items and
// MAX_COMBINED_SQL_LENGTH characters (D1 allows 100 columns and 100,000 bytes), and binds the
// same nine parameters (the three windows' `:today_from`, `:today_to`, `:now`) whatever it holds.
// A statement's answer is cached 60 seconds by its SQL (which names exactly the items its caller
// may see), the windows, the zone and the caller's visibility scope.
//
// The gate (the spec's "as stage 47's opens", ADR 0870): the caller could call every tool in
// `opens`, by the pipeline's own rule. For an account holding a pack role, SQL cannot carry the
// role's limits, so more rules hold (`roleReach`): a tool every staff account may call
// (`anyStaff`, ADR 0652) opens nothing; an item the role opens reads only views of objects the
// role reads; whatever opened it (the role or a grant), an item over an object the role reaches
// only for some People is hidden, one over an object it reaches only on today is read in today's
// window with no comparison; and its rows are given only over objects the role reads.
//
// An item that fails when read is left out for FAILED_ITEM_MS (in the isolate), its error logged
// once, and listed for admins (`host.unreadable`): one bad item costs one failed statement.
import type { ExtensionManifest } from "@composable-os/sdk";
import { cacheApiWidgetCache, visibilityScope, widgetCacheKey } from "../dashboards/cache.ts";
import { schemaNames, WIDGET_LIMITS } from "../dashboards/run.ts";
import { viewOf } from "../extensions/naming.ts";
import { toolOperation } from "../extensions/tools.ts";
import {
  MAX_COMBINED_SQL_LENGTH,
  runReadOnlySql,
  SqlRejectedError,
  tokenize,
  validateReadOnlySql,
} from "../operations/query.ts";
import { mayOpenScreen } from "../operations/screens.ts";
import { staffAuthority } from "../pack-roles.ts";
import {
  type DayWindow,
  mayCall,
  type PlacedItem,
  TODAY_ROWS_MAX,
  type TodayRow,
  type Viewer,
} from "./items.ts";

/** At most this many items in one statement (D1: 100 result columns). */
export const ITEM_COLUMNS = 90;

/** The windows' parameter slots: `?1`–`?3` today, `?4`–`?6` yesterday, `?7`–`?9` a week ago. */
const SLOT = { today: 0, yesterday: 3, lastWeek: 6 } as const;
type Slot = keyof typeof SLOT;
const PARAM_INDEX: Record<string, number> = { today_from: 1, today_to: 2, now: 3 };

/** One item as the installed manifest holds it. */
type TodayItemSpec = NonNullable<ExtensionManifest["todayItems"]>[string];

/** A pack item as declared, with its key (`<pack>.<item>`). */
export interface PackItem {
  key: string;
  pack: string;
  name: string;
  manifest: ExtensionManifest;
  spec: TodayItemSpec;
}

/** Every item the installed, active, shipped packs declare. */
export function packItemsOf(viewer: Viewer): PackItem[] {
  return viewer.packs.flatMap(({ id, manifest }) =>
    Object.entries(manifest.todayItems ?? {}).map(([name, spec]) => ({
      key: `${id}.${name}`,
      pack: id,
      name,
      manifest,
      spec,
    })),
  );
}

/**
 * `source` with Today's named parameters as the numbered ones of `slot`'s window, and the highest
 * number it uses. Any other parameter is refused (the install's check refused it already).
 */
export function bindWindow(source: string, slot: Slot): { sql: string; uses: number } {
  let out = "";
  let at = 0;
  let uses = 0;
  for (const token of tokenize(source)) {
    if (token.kind !== "param") continue;
    const index = PARAM_INDEX[token.text.slice(1).toLowerCase()];
    if (!token.text.startsWith(":") || index === undefined) {
      throw new SqlRejectedError(`unknown parameter ${token.text}`, { name: token.text });
    }
    const n = SLOT[slot] + index;
    uses = Math.max(uses, n);
    out += `${source.slice(at, token.start)}?${n}`;
    at = token.start + token.text.length;
  }
  return { sql: out + source.slice(at), uses };
}

/** The nine parameters, in slot order. */
function paramsOf(windows: Viewer["windows"]): string[] {
  const of = (w: DayWindow) => [w.day.from, w.day.to, w.now];
  return [...of(windows.today), ...of(windows.yesterday), ...of(windows.lastWeek)];
}

/** The view of an object, lower-cased, or null when the registry does not know it. */
function viewName(object: string): string | null {
  try {
    return viewOf(object).toLowerCase();
  } catch {
    return null;
  }
}
const viewsOf = (objects: Iterable<string>) =>
  new Set([...objects].flatMap((o) => viewName(o) ?? []));

/** Whether `source` binds the whole of today's window (`:today_from` and `:today_to`). */
function boundToToday(source: string): boolean {
  const names = new Set(
    tokenize(source)
      .filter((t) => t.kind === "param")
      .map((t) => t.text.slice(1).toLowerCase()),
  );
  return names.has("today_from") && names.has("today_to");
}

/** What a pack role's account gets of one item whose gate it passes. */
export interface RoleReach {
  /** Its comparison (another day) is shown. */
  compare: boolean;
  /** Its rows are given (names of records the role reads). */
  rows: boolean;
}

/**
 * What an account holding `role` gets of an item (ADR 0874), from the views its SQL reads (SQL
 * cannot carry a role's limits, so the host decides from the views), or null: hidden.
 *   - A view of an object the role reaches only for the People its holder looks after (ADR 0889)
 *     or through the records naming it (ADR 0755): hidden.
 *   - A view of an object the role reaches only on today (ADR 0553): shown only when its SQL binds
 *     today's window (`:today_from` and `:today_to`), and never with its comparison, which reads
 *     another day; its rows only when their SQL binds it too.
 *   - Opened by the role itself (`byRole`): it reads only views of objects the role reads (its
 *     `read`); any other view hides it.
 *   - Its rows are given only when they name records of an object the role reads and read only
 *     views of objects it reads; otherwise the item is its count alone.
 * The limits hold whatever opened the item, the role or a grant (a limited role's grant is held
 * to the limit too, as the pipeline holds a tool's nested calls); the read list binds what the
 * role itself opens.
 */
export function roleReach(
  role: NonNullable<Viewer["rights"]["packRole"]>,
  byRole: boolean,
  item: {
    sql: string;
    views: readonly string[];
    rows: { sql: string; views: readonly string[]; object: string } | null;
  },
): RoleReach | null {
  const limited = viewsOf([
    ...Object.keys(role.looksAfter?.reach ?? {}),
    ...Object.keys(role.mine ?? {}),
  ]);
  const todays = viewsOf(Object.keys(role.today ?? {}));
  const reads = viewsOf(role.read);
  const value = item.views.map((v) => v.toLowerCase());
  const rowViews = (item.rows?.views ?? []).map((v) => v.toLowerCase());
  if ([...value, ...rowViews].some((v) => limited.has(v))) return null;
  if (byRole && value.some((v) => !reads.has(v))) return null;
  const today = value.some((v) => todays.has(v));
  if (today && !boundToToday(item.sql)) return null;
  const rows =
    item.rows !== null &&
    role.read.includes(item.rows.object) &&
    rowViews.every((v) => reads.has(v)) &&
    (!rowViews.some((v) => todays.has(v)) || boundToToday(item.rows.sql));
  return { compare: !today, rows };
}

/** A visible pack item: its checked SQL, and what of it the caller gets. */
export interface VisiblePackItem extends PackItem {
  today: string;
  compare: { against: "yesterday" | "lastWeek"; sql: string } | null;
  uses: number;
  /** Its rows are given (to a pack role's account, only names of records the role reads). */
  rows: boolean;
  screen: string | null;
}

/** `sql`'s numbered parameters of today's window moved to `slot`'s. */
function shiftWindow(sql: string, slot: Slot): { sql: string; uses: number } {
  let out = "";
  let at = 0;
  let uses = 0;
  for (const token of tokenize(sql)) {
    if (token.kind !== "param") continue;
    const n = Number(token.text.slice(1)) + SLOT[slot];
    uses = Math.max(uses, n);
    out += `${sql.slice(at, token.start)}?${n}`;
    at = token.start + token.text.length;
  }
  return { sql: out + sql.slice(at), uses };
}

/** Whether the caller passes the item's gate, and what its SQL is when they do. */
export function visiblePackItem(
  viewer: Viewer,
  item: PackItem,
  names: ReadonlySet<string>,
): VisiblePackItem | null {
  const { spec, manifest } = item;
  const opens = spec.opens ?? [];
  if (!opens.length) return null;
  const role = viewer.rights.packRole;
  let byRole = false;
  for (const name of opens) {
    const tool = Object.hasOwn(manifest.tools ?? {}, name) ? manifest.tools[name] : undefined;
    if (!tool) return null;
    const op = toolOperation(manifest, name, tool, "shipped");
    if (role && op.packAnyStaff === true) return null;
    if (!mayCall(viewer, op)) return null;
    if (role && staffAuthority(viewer.ctx.user, viewer.rights, op, {}) === "packRole") {
      byRole = true;
    }
  }
  try {
    const today = bindWindow(spec.sql, "today");
    const checked = validateReadOnlySql(today.sql, names);
    const rowsChecked = spec.rows
      ? validateReadOnlySql(bindWindow(spec.rows.sql, "today").sql, names)
      : null;
    const reach = role
      ? roleReach(role, byRole, {
          sql: spec.sql,
          views: checked.views,
          rows:
            spec.rows && rowsChecked
              ? { sql: spec.rows.sql, views: rowsChecked.views, object: spec.rows.record.object }
              : null,
        })
      : { compare: true, rows: true };
    if (!reach) return null;
    const declared = spec.compare ?? "yesterday";
    const against = declared === "none" || !reach.compare ? null : declared;
    // From the checked SQL (trailing semicolons and comments gone), as today's half is.
    const compare = against
      ? shiftWindow(checked.sql, against === "lastWeek" ? "lastWeek" : "yesterday")
      : null;
    const screens = manifest.screens ?? {};
    const declaredScreen =
      spec.web?.screen && Object.hasOwn(screens, spec.web.screen)
        ? screens[spec.web.screen]
        : undefined;
    const screen =
      spec.web?.screen &&
      declaredScreen &&
      viewer.person &&
      mayOpenScreen(manifest, declaredScreen, viewer.ctx.user, viewer.rights)
        ? spec.web.screen
        : null;
    return {
      ...item,
      today: checked.sql,
      compare: compare && against ? { against, sql: compare.sql } : null,
      uses: Math.max(today.uses, compare?.uses ?? 0),
      rows: !!spec.rows && reach.rows,
      screen,
    };
  } catch (error) {
    // An item whose SQL no longer passes (a view it reads is gone) shows nothing.
    if (error instanceof SqlRejectedError) return null;
    throw error;
  }
}

/** The pack items the caller may see, with their checked SQL. */
export async function visiblePackItems(viewer: Viewer): Promise<VisiblePackItem[]> {
  const items = packItemsOf(viewer);
  if (!items.length) return [];
  const names = await schemaNames(viewer.ctx.db);
  return items.flatMap((item) => {
    const visible = visiblePackItem(viewer, item, names);
    return visible ? [visible] : [];
  });
}

const scalarOf = (query: string) => `(SELECT value FROM (\n${query}\n) LIMIT 1)`;

const columnOf = (item: VisiblePackItem, index: number) =>
  `json_array(${scalarOf(item.today)}${item.compare ? `, ${scalarOf(item.compare.sql)}` : ""}) AS c${index}`;

/** The items as statements: at most ITEM_COLUMNS columns and MAX_COMBINED_SQL_LENGTH each. */
export function chunksOf(items: readonly VisiblePackItem[]): VisiblePackItem[][] {
  const chunks: VisiblePackItem[][] = [];
  let current: VisiblePackItem[] = [];
  let length = 0;
  for (const item of items) {
    const size = columnOf(item, ITEM_COLUMNS).length + 2;
    if (
      current.length &&
      (current.length >= ITEM_COLUMNS || length + size > MAX_COMBINED_SQL_LENGTH - 16)
    ) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const numberOf = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** One statement's values, `[today, compared]` per item; cached 60 seconds. */
async function runChunk(
  viewer: Viewer,
  chunk: readonly VisiblePackItem[],
  names: ReadonlySet<string>,
): Promise<[number, number | null][]> {
  const { ctx } = viewer;
  const sql = `SELECT ${chunk.map(columnOf).join(", ")}`;
  const uses = Math.max(...chunk.map((i) => i.uses));
  const params = paramsOf(viewer.windows).slice(0, uses);
  const cache = ctx.widgetCache ?? cacheApiWidgetCache();
  const key = await widgetCacheKey({
    sql,
    // `:now` moves every call: the windows' days key the entry, and it lives 60 seconds.
    params: params.map((p, i) => (i % 3 === 2 ? "now" : p)),
    maxRows: 1,
    scope: `today:${visibilityScope(ctx.user)}`,
    zone: viewer.zone,
  });
  type Stored = [number, number | null][];
  const hit = await cache.get<Stored>(key);
  if (hit) return hit.value;
  const result = await runReadOnlySql(
    ctx.db,
    sql,
    params,
    { maxRows: 1, timeoutMs: WIDGET_LIMITS.timeoutMs, maxLength: MAX_COMBINED_SQL_LENGTH },
    names,
  );
  const row = result.rows[0] ?? {};
  const values: Stored = chunk.map((item, i) => {
    const raw = row[`c${i}`];
    let pair: unknown[] = [];
    try {
      pair = typeof raw === "string" ? (JSON.parse(raw) as unknown[]) : [];
    } catch {
      pair = [];
    }
    return [numberOf(pair[0]), item.compare ? numberOf(pair[1]) : null];
  });
  await cache.put(key, values, new Date().toISOString());
  return values;
}

/** How long an item that failed at run time is left out before it is tried again. */
export const FAILED_ITEM_MS = 60_000;

/**
 * Items that failed at run time, by their key and SQL, until when they are left out: kept in the
 * isolate (the widget cache is a no-op on some hostnames, and a failure must not be paid for on
 * every call). One failed statement then costs nothing more for FAILED_ITEM_MS; its error is
 * logged once, and admins see the item listed as unreadable (`host.unreadable`).
 */
const failed = new Map<string, number>();
const logged = new Set<string>();
const failureKey = (item: VisiblePackItem) => `${item.key}\u0000${item.today}`;

/** Whether `item` failed within FAILED_ITEM_MS. */
export function itemFailed(item: VisiblePackItem, now = Date.now()): boolean {
  const until = failed.get(failureKey(item));
  if (until === undefined) return false;
  if (until > now) return true;
  failed.delete(failureKey(item));
  return false;
}

/** Forgets the failed items (tests). */
export function forgetFailedItems(): void {
  failed.clear();
  logged.clear();
}

function markFailed(item: VisiblePackItem, error: unknown): void {
  const key = failureKey(item);
  failed.set(key, Date.now() + FAILED_ITEM_MS);
  if (logged.has(key)) return;
  logged.add(key);
  console.error(`today: the item ${item.key} could not be read; it is left out`, error);
}

/**
 * The visible pack items with their values, in statements of many items each, and those left out
 * because they failed at run time (`unreadable`).
 */
export async function packItemValues(
  viewer: Viewer,
): Promise<{ items: PlacedItem[]; unreadable: VisiblePackItem[] }> {
  const visible = await visiblePackItems(viewer);
  const items = visible.filter((item) => !itemFailed(item));
  const unreadable = () => visible.filter((item) => itemFailed(item));
  if (!items.length) return { items: [], unreadable: unreadable() };
  const names = await schemaNames(viewer.ctx.db);
  const out: PlacedItem[] = [];
  const results = await Promise.all(
    chunksOf(items).map(async (chunk) => {
      try {
        return { chunk, values: await runChunk(viewer, chunk, names) };
      } catch {
        // One item that fails at run time never takes the others away: each is read alone once,
        // and the one that fails is left out (and not tried again) for FAILED_ITEM_MS.
        const alone = await Promise.all(
          chunk.map(async (item) => {
            try {
              return (await runChunk(viewer, [item], names))[0] ?? null;
            } catch (error) {
              markFailed(item, error);
              return null;
            }
          }),
        );
        return { chunk, values: alone };
      }
    }),
  );
  for (const { chunk, values } of results) {
    for (const [i, item] of chunk.entries()) {
      const pair = values[i];
      if (!pair) continue;
      const [value, compared] = pair;
      const { spec } = item;
      const attention =
        spec.attention &&
        ("above" in spec.attention ? value > spec.attention.above : value < spec.attention.below);
      out.push({
        key: item.key,
        label: spec.label,
        // Never money: a pack's item is a count or a percent (ADR 0870).
        format: spec.format === "percent" ? "percent" : "count",
        value,
        currency: null,
        detail: null,
        compare:
          item.compare && compared !== null
            ? { against: item.compare.against, value: compared }
            : null,
        state: attention ? "attention" : "ok",
        target: item.screen
          ? { kind: "screen", pack: item.pack, screen: item.screen }
          : { kind: "rows" },
        order: spec.order ?? 100,
      });
    }
  }
  return { items: out, unreadable: unreadable() };
}

/** The rows behind one visible pack item, at most TODAY_ROWS_MAX, through the widget guards. */
export async function packItemRows(viewer: Viewer, item: VisiblePackItem): Promise<TodayRow[]> {
  const rows = item.spec.rows;
  if (!rows || !item.rows) return [];
  const bound = bindWindow(rows.sql, "today");
  const result = await runReadOnlySql(
    viewer.ctx.db,
    bound.sql,
    paramsOf(viewer.windows).slice(0, bound.uses),
    { maxRows: TODAY_ROWS_MAX, timeoutMs: WIDGET_LIMITS.timeoutMs },
    await schemaNames(viewer.ctx.db),
  );
  const pick = (row: Record<string, unknown>, column: string) => {
    const key = Object.keys(row).find((k) => k.toLowerCase() === column.toLowerCase());
    return key === undefined ? undefined : row[key];
  };
  return result.rows.map((row) => {
    const label = pick(row, rows.label);
    const detail = rows.detail ? pick(row, rows.detail) : null;
    const id = pick(row, rows.record.id);
    return {
      label: label === null || label === undefined ? "" : String(label),
      detail: detail === null || detail === undefined ? null : String(detail),
      record: typeof id === "string" && id ? { object: rows.record.object, id } : null,
    };
  });
}
