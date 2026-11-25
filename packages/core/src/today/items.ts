// Today (stage 60 step 3, ADR 0874): the items one person may see for the business's local day,
// and the rows behind one of them. The answer `today.get` and `today.rows` give.
//
// Two kinds of item, both computed here, in the host:
//   - **host items**, platform code over host data no `rec_*` view shows (host.ts): takings (from
//     Finance reports' Sales, never summed here), changes waiting for you (the approver rules),
//     shifts with nobody on them and checklists missed (where a pack declares `staffed` and
//     `checklists`, through the staffing and checklist reads), and unread notices;
//   - **pack items**, declared by an installed, active, shipped pack (`todayItems`, ADR 0870):
//     read-only SQL over `rec_*` views, run here through the widget guards (pack.ts).
//
// Every item is gated for the caller by what the caller could already call: a pack item by every
// tool of its gate (`opens`), a host item by the operation that reads the same thing in full
// (`finance.report`, `approval.approve`, `staffing.uncovered`, `checklist.runs`,
// `notification.list`), each judged by the pipeline's own rule (`staffAuthority`: role, grants,
// pack role, restricted permissions), with the caller's actor and MCP scopes. So Today shows
// nothing its viewer could not read another way, a pack role's account included. An AI actor
// gets the pack items and the money items its user's rights allow, never a person's own items
// (approvals, checklists, shifts with nobody on them, the inbox).
//
// "Today" is the organisation's local day (`localDay`, ADR 0871), never the caller's or the
// server's: `:today_from`, `:today_to` and `:now`, and for a comparison the same window a day or
// a week earlier with `:now` at the same local time.
import type { ExtensionManifest } from "@composable-os/sdk";
import { allowsAudience } from "../audiences.ts";
import type { AnyOperation, HandlerContext } from "../operation.ts";
import { loadStaffRights, type StaffRights, staffAuthority } from "../pack-roles.ts";
import { staffPrincipal } from "../principals.ts";
import { loadGeneralSettings } from "../settings.ts";
import { isRosterer } from "../staffing/rosterers.ts";
import { type LocalDay, localDay, localDaysBefore } from "../time/local.ts";

/** At most this many rows behind one item (the spec's 50). */
export const TODAY_ROWS_MAX = 50;

/** How an item's value reads. Money is only ever the host's own items (Finance reports). */
export type TodayFormat = "count" | "percent" | "money";

/** What tapping an item opens. */
export type TodayTarget =
  | { kind: "rows" }
  | { kind: "approvals" }
  | { kind: "notices" }
  | { kind: "screen"; pack: string; screen: string };

/** One number on Today. */
export interface TodayItem {
  key: string;
  label: string;
  format: TodayFormat;
  value: number;
  currency: string | null;
  detail: string | null;
  compare: { against: "yesterday" | "lastWeek"; value: number } | null;
  state: "ok" | "attention";
  target: TodayTarget;
}

/** An item with where it sits (lower first). */
export interface PlacedItem extends TodayItem {
  order: number;
}

/** One row behind an item: a name, a line, and the record it opens, if any. */
export interface TodayRow {
  label: string;
  detail: string | null;
  record: { object: string; id: string } | null;
}

/** A window of the business's day: `[from, to)` and the moment `:now` stands for. */
export interface DayWindow {
  day: LocalDay;
  now: string;
}

/** Today's window and the two it may be compared with. */
export interface Windows {
  today: DayWindow;
  yesterday: DayWindow;
  lastWeek: DayWindow;
}

/** The windows for `now` in `zone`: today, and yesterday and a week ago at the same local time. */
export function windowsOf(now: string, zone: string): Windows {
  const at = Date.parse(now);
  return {
    today: { day: localDay(at, zone), now: new Date(at).toISOString() },
    yesterday: {
      day: localDay(at, zone, -1),
      now: new Date(localDaysBefore(at, 1, zone)).toISOString(),
    },
    lastWeek: {
      day: localDay(at, zone, -7),
      now: new Date(localDaysBefore(at, 7, zone)).toISOString(),
    },
  };
}

/** A shipped, active pack's installed manifest. */
export interface InstalledPack {
  id: string;
  manifest: ExtensionManifest;
}

/** Who is asking, and what the host read once for every item. */
export interface Viewer {
  readonly ctx: HandlerContext;
  readonly rights: StaffRights;
  /** A person at the screen (not the assistant, MCP, an automation or extension code). */
  readonly person: boolean;
  readonly zone: string;
  readonly windows: Windows;
  /** The installed, active, shipped packs. */
  readonly packs: readonly InstalledPack[];
  /** Whether the caller rosters (read at most once a call). */
  rosterer(): Promise<boolean>;
}

/** Reads what every item needs: the zone, the caller's rights and the shipped packs. */
export async function loadViewer(ctx: HandlerContext): Promise<Viewer> {
  const [settings, rights, rows] = await Promise.all([
    loadGeneralSettings(ctx.db),
    loadStaffRights(ctx.db, ctx.user.id),
    ctx.db
      .selectFrom("core_extensions")
      .select(["id", "manifest"])
      .where("status", "=", "active")
      .where("source", "=", "shipped")
      .orderBy("id")
      .execute(),
  ]);
  const packs: InstalledPack[] = [];
  for (const row of rows) {
    try {
      packs.push({ id: row.id, manifest: JSON.parse(row.manifest) as ExtensionManifest });
    } catch {
      // An unreadable row contributes nothing; the others are unaffected.
      console.warn(`today: the installed manifest of ${row.id} could not be read`);
    }
  }
  let rosterer: Promise<boolean> | null = null;
  return {
    ctx,
    rights,
    person: ctx.actor === "human",
    zone: settings.timezone,
    windows: windowsOf(ctx.now, settings.timezone),
    packs,
    rosterer: () => {
      rosterer ??= isRosterer(ctx.db, ctx.user.id);
      return rosterer;
    },
  };
}

/**
 * Whether the caller could call `op` with `input`, by the pipeline's own checks for this call:
 * the operation's audience, its actors, the credential's scopes (an MCP token) and
 * `staffAuthority` (role, grants, pack role, restricted permissions).
 */
export function mayCall(viewer: Viewer, op: AnyOperation, input: unknown = {}): boolean {
  const { ctx } = viewer;
  if (!allowsAudience(op, staffPrincipal(ctx.user))) return false;
  if (op.actors && !op.actors.includes(ctx.actor)) return false;
  if (ctx.grantedPermissions && !ctx.grantedPermissions.includes(op.permission)) return false;
  return staffAuthority(ctx.user, viewer.rights, op, input) !== null;
}

/** The host's order: attention first, then each item's place, then its key. */
export function inOrder(items: readonly PlacedItem[]): TodayItem[] {
  return [...items]
    .sort(
      (a, b) =>
        Number(b.state === "attention") - Number(a.state === "attention") ||
        a.order - b.order ||
        a.key.localeCompare(b.key),
    )
    .map(({ order: _order, ...item }) => item);
}

/** An amount in a currency's minor unit, in words (`A$45.00`), for a row's line. */
export function moneyWords(minor: number, currency: string | null): string {
  if (!currency) return String(minor);
  try {
    const format = new Intl.NumberFormat("en", { style: "currency", currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  } catch {
    return `${currency} ${minor}`;
  }
}

/** A moment as the business reads it: `Tue 24 Nov, 06:00` in its zone. */
export function momentWords(iso: string, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: zone,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
