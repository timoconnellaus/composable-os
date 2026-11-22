// Time windows and staff-only rules on moves and creates (stage 31, ADR 0503). A `states`
// declaration may say when a customer may make a move (`window`), when they may create a record
// (`create.window`), and that while a boolean is true only staff and the host may (`staffOnly`).
// The transition engine (records/states.ts) checks them for a customer's write, against the
// host's clock in the write (`ctx.now`): the same rule for a customer on the web, in the app,
// through their own AI client or a pack's tool. Staff and the host are not bound.
//
// A window's ends are moments worked out from fields: a datetime of the record, or of the record
// one of its relations points to (`class.startsAt`), less whole local days in a zone (the same
// time of day, across a clock change) and then minutes. Each part may be a number or a number
// field, so the pack decides where the numbers come from (a class type's override over the
// organisation's default, copied by the host onto the class).
import type { Kysely } from "kysely";
import { registryFieldName } from "../extensions/naming.ts";
import { getObject } from "../fields/index.ts";
import type {
  ObjectDefinition,
  WindowBoundDefinition,
  WindowDefinition,
  WindowNumberDefinition,
} from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { loadGeneralSettings } from "../settings.ts";
import { localDaysBefore } from "../time/local.ts";
import { visibleSource } from "../visibility/index.ts";

/**
 * Reads the values a record's paths name: its own fields, or through up to two relations
 * (ADR 0505), and the declaring extension's settings.
 */
export interface PathReader {
  read(path: string): Promise<unknown>;
  /** The declaring extension's setting: its stored value, else its declared default. */
  setting(name: string): Promise<unknown>;
}

/**
 * A reader over `after` (the record as the write leaves it) for `object`, reading each record
 * once. Every field a path names is the declaring extension's (the SDK checks it): on another
 * extension's object, the field this extension adds to it (`<extension>.<field>` in the registry).
 */
export function pathReader(
  ctx: HandlerContext,
  object: ObjectDefinition,
  after: Record<string, unknown>,
): PathReader {
  const ext = object.extension;
  const records = new Map<string, Promise<Record<string, unknown> | null>>();
  const load = (target: ObjectDefinition, id: string) => {
    const key = `${target.name}:${id}`;
    const cached = records.get(key);
    if (cached) return cached;
    const promise = (async () => {
      // The host's own read (on a customer's call its principal is the organisation's).
      // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
      const stored = (await (ctx.db as Kysely<any>)
        .selectFrom(visibleSource(ctx, target))
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst()) as Record<string, unknown> | undefined;
      if (!stored) return null;
      const values: Record<string, unknown> = {};
      for (const field of target.fields) {
        if (field.column && Object.hasOwn(stored, field.column)) {
          values[field.name] = stored[field.column];
        }
      }
      return values;
    })();
    records.set(key, promise);
    return promise;
  };
  /** A field's registry name on `on`: this extension's own name there. */
  const nameOn = (on: ObjectDefinition, local: string) =>
    ext ? registryFieldName(ext, on.name, local) : local;
  let settings: Promise<Record<string, unknown>> | undefined;
  const loadSettings = () => {
    settings ??= (async () => {
      if (!ext) return {};
      const [stored, declared] = await Promise.all([
        ctx.db
          .selectFrom("core_extension_settings")
          .select("value")
          .where("extension_id", "=", ext)
          .executeTakeFirst(),
        ctx.db
          .selectFrom("core_extensions")
          .select("manifest")
          .where("id", "=", ext)
          .executeTakeFirst(),
      ]);
      const defaults = Object.fromEntries(
        Object.entries(
          (declared
            ? (JSON.parse(declared.manifest) as {
                settings?: Record<string, { default?: unknown }>;
              })
            : {}
          ).settings ?? {},
        ).map(([name, s]) => [name, s.default ?? null]),
      );
      return {
        ...defaults,
        ...(stored ? (JSON.parse(stored.value) as Record<string, unknown>) : {}),
      };
    })();
    return settings;
  };
  return {
    async read(path) {
      const parts = path.split(".");
      let values: Record<string, unknown> | null = after;
      let on: ObjectDefinition = object;
      for (const [i, part] of parts.entries()) {
        if (!values) return null;
        const name = i === 0 ? part : nameOn(on, part);
        const value = values[name] ?? null;
        if (i === parts.length - 1) return value;
        const to = on.fields.find((f) => f.name === name)?.options?.to;
        const target = to ? getObject(to) : undefined;
        if (typeof value !== "string" || !value || !target) return null;
        values = await load(target, value);
        // Set but not readable (in Trash, gone): not an empty rule (ADR 0507).
        if (!values) return UNREADABLE;
        on = target;
      }
      return null;
    },
    async setting(name) {
      return (await loadSettings())[name] ?? null;
    },
  };
}

/**
 * What a path reads when a relation on the way is set but its record cannot be read (a class type
 * in Trash): never taken for an empty value, so a rule falls to no default. A window it names
 * cannot be worked out, and a staff-only or closed flag it names counts as set (ADR 0507).
 */
export const UNREADABLE: unique symbol = Symbol("unreadable");

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** A bound's moment (ms), or null when one of the values it is worked out from is empty. */
async function boundMoment(
  ctx: HandlerContext,
  reader: PathReader,
  bound: WindowBoundDefinition,
): Promise<number | null> {
  const b = typeof bound === "string" ? { at: bound } : bound;
  const at = await reader.read(b.at);
  const instant = typeof at === "string" ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(instant)) return null;
  const part = async (value: WindowNumberDefinition | undefined): Promise<number | null> => {
    if (value === undefined) return 0;
    if (typeof value === "number") return value;
    if (typeof value === "string") return asNumber(await reader.read(value));
    // A field's value, else the extension's setting (ADR 0505).
    const raw = value.field === undefined ? null : await reader.read(value.field);
    if (raw === UNREADABLE) return null;
    const own = asNumber(raw);
    if (own !== null || value.setting === undefined) return own;
    return asNumber(await reader.setting(value.setting));
  };
  const days = await part(b.daysBefore);
  const minutes = await part(b.minutesBefore);
  if (days === null || minutes === null) return null;
  let moment = instant;
  if (days !== 0) {
    const zoneValue = b.zone ? await reader.read(b.zone) : null;
    // An empty zone is the organisation's (ADR 0507); an unreadable one is not known.
    if (zoneValue === UNREADABLE) return null;
    const zone =
      typeof zoneValue === "string" && zoneValue
        ? zoneValue
        : (await loadGeneralSettings(ctx.db)).timezone;
    moment = localDaysBefore(instant, Math.trunc(days), zone);
  }
  return moment - Math.round(minutes * 60_000);
}

/** Why a customer is outside a window now, or null when they are inside it. */
export interface WindowRefusal {
  rule: "window_not_open" | "window_closed" | "window_unknown";
  message: string;
  opensAt?: string;
  closesAt?: string;
}

/**
 * Whether `ctx.now` is inside `window` (from inclusive, until exclusive) for the record as the
 * write leaves it. Null inside; the refusal otherwise.
 */
export async function windowRefusal(
  ctx: HandlerContext,
  reader: PathReader,
  window: WindowDefinition | undefined,
  what: string,
): Promise<WindowRefusal | null> {
  if (!window) return null;
  const now = Date.parse(ctx.now);
  const from = window.from === undefined ? undefined : await boundMoment(ctx, reader, window.from);
  const until =
    window.until === undefined ? undefined : await boundMoment(ctx, reader, window.until);
  if (from === null || until === null) {
    return {
      rule: "window_unknown",
      message: `${what} cannot be done now: when it is allowed cannot be worked out`,
    };
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const times = {
    ...(from !== undefined ? { opensAt: iso(from) } : {}),
    ...(until !== undefined ? { closesAt: iso(until) } : {}),
  };
  if (from !== undefined && now < from) {
    return { rule: "window_not_open", message: `${what} opens at ${iso(from)}`, ...times };
  }
  if (until !== undefined && now >= until) {
    return { rule: "window_closed", message: `${what} closed at ${iso(until)}`, ...times };
  }
  return null;
}

/** Whether a `staffOnly` flag (any of them, ADR 0505) is set for the record as the write leaves it. */
export async function staffOnlySet(
  reader: PathReader,
  paths: string | readonly string[] | undefined,
): Promise<boolean> {
  for (const path of paths === undefined ? [] : typeof paths === "string" ? [paths] : paths) {
    const value = await reader.read(path);
    if (value === UNREADABLE) return true;
    if (value === true || value === 1 || value === "1" || value === "true") return true;
  }
  return false;
}

/** A refusal for a customer outside a staff-only rule. */
export function staffOnlyMessage(what: string): string {
  return `${what} is made by staff only`;
}
