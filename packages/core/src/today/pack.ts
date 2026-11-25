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
// `opens`, by the pipeline's own rule. For an account holding a pack role two more rules hold,
// because SQL cannot carry a role's limits:
//   - a tool every staff account may call (`anyStaff`, ADR 0652) opens nothing: its host
//     operation decides who may do what by its own rule, so calling it says nothing about reach;
//   - an item allowed by the role (not by a grant) that reads the view of an object the role
//     reaches only for the People its holder looks after (ADR 0889) or through the records naming
//     it (ADR 0755) is not shown;
// and a row's record is linked only when the role reads that object (`record.get`).
import type { ExtensionManifest } from "@composable-os/sdk";
import { cacheApiWidgetCache, visibilityScope, widgetCacheKey } from "../dashboards/cache.ts";
import { schemaNames, WIDGET_LIMITS } from "../dashboards/run.ts";
import { viewOf } from "../extensions/naming.ts";
import { toolOperation } from "../extensions/tools.ts";
import { getObject } from "../fields/index.ts";
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

/** The views of objects a pack role reaches only for some People (ADRs 0889, 0755). */
function personLimitedViews(viewer: Viewer): Set<string> {
  const role = viewer.rights.packRole;
  const objects = [...Object.keys(role?.looksAfter?.reach ?? {}), ...Object.keys(role?.mine ?? {})];
  const views = new Set<string>();
  for (const object of objects) {
    try {
      views.add(viewOf(object).toLowerCase());
    } catch {
      // An object the registry does not know has no view to read.
    }
  }
  return views;
}

/** A visible pack item: its checked SQL, and whether its rows may link their records. */
export interface VisiblePackItem extends PackItem {
  today: string;
  compare: { against: "yesterday" | "lastWeek"; sql: string } | null;
  uses: number;
  linkRecords: boolean;
  screen: string | null;
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
    const declared = spec.compare ?? "yesterday";
    const against = declared === "none" ? null : declared;
    const compare = against
      ? bindWindow(spec.sql, against === "lastWeek" ? "lastWeek" : "yesterday")
      : null;
    const rowsViews = spec.rows
      ? validateReadOnlySql(bindWindow(spec.rows.sql, "today").sql, names).views
      : [];
    if (role && byRole) {
      const limited = personLimitedViews(viewer);
      if ([...checked.views, ...rowsViews].some((v) => limited.has(v.toLowerCase()))) return null;
    }
    const object = spec.rows?.record.object;
    const linkRecords =
      !object || !role ? true : role.read.includes(object) && getObject(object) !== undefined;
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
      linkRecords,
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

/** The visible pack items with their values, in statements of many items each. */
export async function packItemValues(viewer: Viewer): Promise<PlacedItem[]> {
  const items = await visiblePackItems(viewer);
  if (!items.length) return [];
  const names = await schemaNames(viewer.ctx.db);
  const out: PlacedItem[] = [];
  const results = await Promise.all(
    chunksOf(items).map(async (chunk) => {
      try {
        return { chunk, values: await runChunk(viewer, chunk, names) };
      } catch {
        // One item that fails at run time never takes the others away: each is read alone, and
        // only the one that fails is left out.
        const alone = await Promise.all(
          chunk.map(async (item) => {
            try {
              return (await runChunk(viewer, [item], names))[0] ?? null;
            } catch (error) {
              console.warn(`today: the item ${item.key} could not be read`, error);
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
  return out;
}

/** The rows behind one visible pack item, at most TODAY_ROWS_MAX, through the widget guards. */
export async function packItemRows(viewer: Viewer, item: VisiblePackItem): Promise<TodayRow[]> {
  const rows = item.spec.rows;
  if (!rows) return [];
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
      record:
        item.linkRecords && typeof id === "string" && id
          ? { object: rows.record.object, id }
          : null,
    };
  });
}
