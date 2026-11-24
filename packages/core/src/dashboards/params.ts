// Dashboard parameters (ADR 0057): dashboard filter values become named SQL parameters, and
// named parameters become the positional `?NNN` the query.sql validator and D1 accept.
//
// Date ranges always bind concrete ISO strings (all time is 0000… to 9999…), never NULL, so
// `created_at >= :date_from AND created_at < :date_to` stays an index range scan. `:now` is
// truncated to the minute so a widget's cache key holds for the 60 s cache window. Date ranges
// and `:today` are the business's, in the organisation's time zone (ADR 0871, issue #306).
import { ValidationError } from "../errors.ts";
import { SqlRejectedError, tokenize } from "../operations/query.ts";
import { localDateStart, localParts, parseLocalDate } from "../time/local.ts";
import {
  allowedParamNames,
  type DashboardFilter,
  type DatePreset,
  type FilterValue,
  type FilterValues,
} from "./spec.ts";

export type ParamValue = string | number | null;
export type ParamValues = Record<string, ParamValue>;

export const ALL_TIME = { from: "0000-01-01T00:00:00.000Z", to: "9999-12-31T23:59:59.999Z" };

export interface DateWindow {
  from: string;
  to: string;
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

/** The first instant of a local date (month and day may overflow), as ISO. */
const startIso = (date: LocalDate, zone: string) =>
  new Date(localDateStart(date, zone)).toISOString();

/** A `{ from, to }` range's `YYYY-MM-DD` end, or a ValidationError. */
function rangeDate(text: string): LocalDate {
  const date = parseLocalDate(text);
  if (!date) {
    throw new ValidationError(`Not a date: ${text}`, { field: "filters" });
  }
  return date;
}

/**
 * The [from, to) window a preset or a { from, to } day range covers, in the business's time zone
 * (`zone`, the organisation's: ADR 0871). Days start at local midnight, so a day across a change
 * of clocks is 23 or 25 hours; "last 7 days" is today and the six local days before it.
 */
export function resolveDateWindow(
  value: FilterValue | undefined,
  now: Date,
  zone = "UTC",
): DateWindow | null {
  if (value && typeof value === "object") {
    const from = rangeDate(value.from);
    const to = rangeDate(value.to);
    if (Date.UTC(to.year, to.month - 1, to.day) < Date.UTC(from.year, from.month - 1, from.day)) {
      throw new ValidationError("A date range must end on or after its start", {
        field: "filters",
      });
    }
    return { from: startIso(from, zone), to: startIso({ ...to, day: to.day + 1 }, zone) };
  }
  const { year: y, month: m, day: d } = localParts(now, zone);
  const lastDays = (n: number) => ({
    from: startIso({ year: y, month: m, day: d - (n - 1) }, zone),
    to: startIso({ year: y, month: m, day: d + 1 }, zone),
  });
  const months = (from: number, to: number) => ({
    from: startIso({ year: y, month: from, day: 1 }, zone),
    to: startIso({ year: y, month: to, day: 1 }, zone),
  });
  switch (value as DatePreset | null | undefined) {
    case "all_time":
    case null:
    case undefined:
      return null;
    case "today":
      return lastDays(1);
    case "last_7_days":
      return lastDays(7);
    case "last_30_days":
      return lastDays(30);
    case "last_90_days":
      return lastDays(90);
    case "last_365_days":
      return lastDays(365);
    case "this_month":
      return months(m, m + 1);
    case "last_month":
      return months(m - 1, m);
    case "this_quarter": {
      const q = Math.floor((m - 1) / 3) * 3 + 1;
      return months(q, q + 3);
    }
    case "this_year":
      return months(1, 13);
    default:
      throw new ValidationError(`Unknown date range "${String(value)}"`, { field: "filters" });
  }
}

/**
 * The window just before `window`, in the same zone: calendar presets step back one unit (this
 * month → last month), rolling and custom ranges step back by their own number of local days
 * (today → yesterday, whatever its length in hours).
 */
export function previousWindow(
  value: FilterValue | undefined,
  window: DateWindow,
  zone = "UTC",
): DateWindow {
  const from = localParts(window.from, zone);
  const back = (date: LocalDate) => ({ from: startIso(date, zone), to: window.from });
  switch (value) {
    case "this_month":
    case "last_month":
      return back({ year: from.year, month: from.month - 1, day: 1 });
    case "this_quarter":
      return back({ year: from.year, month: from.month - 3, day: 1 });
    case "this_year":
      return back({ year: from.year - 1, month: 1, day: 1 });
    default: {
      // The window's length in local days: both ends are local midnights.
      const to = localParts(window.to, zone);
      const days = Math.round(
        (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
          86_400_000,
      );
      return back({ year: from.year, month: from.month, day: from.day - days });
    }
  }
}

export interface ResolvedParams {
  values: ParamValues;
  /** The previous period's values, when the dashboard has a bounded date range. */
  previous: ParamValues | null;
}

/** The value a filter is set to: the caller's, else the filter's default. */
function effectiveValue(filter: DashboardFilter, values: FilterValues): FilterValue {
  if (Object.hasOwn(values, filter.id)) return values[filter.id] ?? null;
  switch (filter.type) {
    case "dateRange":
      return filter.default;
    case "user":
      return filter.default === "me" ? "me" : null;
    default:
      return filter.default ?? null;
  }
}

/**
 * Binds a dashboard's filters (with the caller's values) and the system params. `me` resolves
 * to `userId`; a user filter set to "me" binds the caller's id. Date windows and `:today` are in
 * `zone`, the organisation's time zone (UTC when not given).
 */
export function resolveParams(options: {
  filters: readonly DashboardFilter[];
  values: FilterValues;
  now: Date;
  userId: string;
  recordId?: string | null;
  zone?: string;
}): ResolvedParams {
  const { filters, values, now, userId } = options;
  const zone = options.zone ?? "UTC";
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const bound: ParamValues = {
    now: minute.toISOString(),
    today: localParts(minute.getTime(), zone).date,
    me: userId,
    record_id: options.recordId ?? null,
  };
  let previous: ParamValues | null = null;
  for (const filter of filters) {
    const value = effectiveValue(filter, values);
    if (filter.type === "dateRange") {
      const window = resolveDateWindow(value, now, zone);
      bound[`${filter.id}_from`] = window?.from ?? ALL_TIME.from;
      bound[`${filter.id}_to`] = window?.to ?? ALL_TIME.to;
      if (window) {
        const prev = previousWindow(value, window, zone);
        previous ??= {};
        previous[`${filter.id}_from`] = prev.from;
        previous[`${filter.id}_to`] = prev.to;
      }
      continue;
    }
    if (value !== null && typeof value === "object") {
      throw new ValidationError(`Filter ${filter.id} takes a single value`, { field: "filters" });
    }
    bound[filter.id] = filter.type === "user" && value === "me" ? userId : (value ?? null);
  }
  return { values: bound, previous: previous ? { ...bound, ...previous } : null };
}

export interface BoundSql {
  /** The SQL with every named parameter replaced by `?N`. */
  sql: string;
  /** Positional values for ?1…?N. */
  params: ParamValue[];
  /** The named parameters the SQL uses, in first-use order. */
  names: string[];
}

/**
 * Rewrites named parameters (`:name`, `@name`, `$name`) to `?N` and returns the positional
 * values. Parameters outside `allowed` are refused; positional `?` parameters are refused
 * (widget SQL names its parameters). Strings, comments and quoted identifiers are left alone:
 * the rewrite works on query.sql's SQLite-faithful tokens.
 */
export function bindNamedParams(
  source: string,
  values: ParamValues,
  allowed: readonly string[],
): BoundSql {
  const tokens = tokenize(source);
  const names: string[] = [];
  let out = "";
  let at = 0;
  for (const token of tokens) {
    if (token.kind !== "param") continue;
    if (token.text.startsWith("?")) {
      throw new SqlRejectedError("widget SQL uses named parameters (:name), not ?", {
        at: token.start,
      });
    }
    const name = token.text.slice(1).toLowerCase();
    if (!allowed.includes(name)) {
      throw new SqlRejectedError(`unknown parameter :${name}`, {
        name,
        allowed: [...allowed],
      });
    }
    let index = names.indexOf(name);
    if (index < 0) {
      names.push(name);
      index = names.length - 1;
    }
    out += `${source.slice(at, token.start)}?${index + 1}`;
    at = token.start + token.text.length;
  }
  out += source.slice(at);
  return { sql: out, params: names.map((n) => values[n] ?? null), names };
}

/** The named parameters a widget on a dashboard with `filters` may use. */
export function widgetParamNames(filters: readonly DashboardFilter[]): string[] {
  return allowedParamNames(filters);
}
