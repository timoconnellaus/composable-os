// The host's own Today items (stage 60 step 3, ADR 0874), computed by the host for any product
// from host data no `rec_*` view shows (or must not show). Each reads through the function the
// operation it stands for reads through, never a view and never a second calculation:
//   - `host.takings`: Finance reports' Sales net for the local day (`salesTotal`, the book
//     `finance.report` reads), compared with the same time last week. `finance:read`.
//   - `host.approvals`: the pending actions this person may approve, by the approver rules
//     (approvals/approvers.ts) and the roster's. A person who may approve.
//   - `host.uncovered`: live shifts with nobody on them in the roster's window, and how many start
//     within 24 hours (`uncoveredShifts`, as `staffing.uncovered`). Someone who rosters, where a
//     pack declares `staffed`.
//   - `host.checklists`: runs missed today and runs still open past their end (the runs
//     `checklist.runs` reads). Someone who rosters, where a pack declares `checklists`.
//   - `host.notices`: unread notices (`unreadCount`, as `notification.unreadCount`).
// `host.paymentsFailing` waits for Finance reports' Money owed (stage 52 step 5: a failing
// renewal's amount due kept): it is declared here and listed for nobody until then.
//
// Cost: a bounded number of statements each, whatever the data: one read per item (two for
// takings' windows, through Finance's own reads), one per staffed object for the uncovered
// shifts, and the rosterer's check once a call.

import type { ExtensionManifest } from "@composable-os/sdk";
import { sql } from "kysely";
import { approverRulesAllow, othersPersonalDraft } from "../approvals/approvers.ts";
import { actionTitle } from "../approvals/describe.ts";
import { declaredObjects } from "../checklists/index.ts";
import { cacheApiWidgetCache, widgetCacheKey } from "../dashboards/cache.ts";
import { toolOperation } from "../extensions/tools.ts";
import { getObject, listObjects } from "../fields/index.ts";
import { salesTotal } from "../finance/reports.ts";
import { contactBlockedMany } from "../integrations/consent.ts";
import type { OutboundInput } from "../integrations/outbound.ts";
import { notificationLinkSchema } from "../notifications/types.ts";
import type { AnyOperation } from "../operation.ts";
import { approvalApprove } from "../operations/approval.ts";
import { checklistRuns } from "../operations/checklist.ts";
import { financeReport } from "../operations/finance.ts";
import { notificationList, unreadCount } from "../operations/notification.ts";
import { staffingUncovered } from "../operations/staffing.ts";
import { staffAuthority } from "../pack-roles.ts";
import type { Actor, Origin } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import { touchesRoster } from "../staffing/approvals.ts";
import { uncoveredShifts } from "../staffing/due.ts";
import { setsRosterFields } from "../staffing/index.ts";
import { rosteringDeclared, rosterNumbers } from "../staffing/rosterers.ts";
import {
  type DayWindow,
  mayCall,
  momentWords,
  moneyWords,
  type PlacedItem,
  plural,
  TODAY_ROWS_MAX,
  type TodayRow,
  type Viewer,
} from "./items.ts";

/** A host item: its key, whether it carries money, and how it is read for a viewer. */
export interface HostItem {
  key: string;
  /** Money: `today.rows` of it is audited (who looked), naming the item, never a figure. */
  money: boolean;
  /** Its card, or null when the viewer may not see it (or it does not apply here). */
  item(viewer: Viewer): Promise<PlacedItem | null>;
  /** Its rows, or null when the viewer may not see it. */
  rows(viewer: Viewer): Promise<TodayRow[] | null>;
}

/** The host items Finance reports has not built the figure of yet (stage 52 step 5). */
export const HOST_ITEMS_WAITING = ["host.paymentsFailing"] as const;

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// --- Takings ------------------------------------------------------------------------------------

async function takings(viewer: Viewer) {
  const { ctx, windows, zone } = viewer;
  const cache = ctx.widgetCache ?? cacheApiWidgetCache();
  // The same for every finance:read holder: keyed by the day and zone, kept 60 seconds.
  const key = await widgetCacheKey({
    sql: "host.takings",
    params: [windows.today.day.from, windows.today.day.to],
    maxRows: 0,
    scope: "finance:read",
    zone,
  });
  type Stored = {
    today: Awaited<ReturnType<typeof salesTotal>>;
    lastWeek: number;
  };
  const hit = await cache.get<Stored>(key);
  if (hit) return hit.value;
  const span = (w: DayWindow, ends: string) => ({
    start: w.day.date,
    zone,
    starts: seconds(w.day.from),
    ends: seconds(ends),
  });
  const [today, lastWeek] = await Promise.all([
    salesTotal(ctx, span(windows.today, windows.today.day.to)),
    // The same time last week: from its local midnight to the same local time.
    salesTotal(ctx, span(windows.lastWeek, windows.lastWeek.now)),
  ]);
  const value: Stored = { today, lastWeek: lastWeek.net };
  await cache.put(key, value, new Date().toISOString());
  return value;
}

const takingsItem: HostItem = {
  key: "host.takings",
  money: true,
  async item(viewer) {
    if (!mayCall(viewer, financeReport as AnyOperation)) return null;
    const { today, lastWeek } = await takings(viewer);
    return {
      key: "host.takings",
      label: "Takings today",
      format: "money",
      value: today.net,
      currency: today.currency,
      detail: plural(today.payments, "payment"),
      compare: { against: "lastWeek", value: lastWeek },
      state: "ok",
      target: { kind: "rows" },
      order: 20,
    };
  },
  async rows(viewer) {
    if (!mayCall(viewer, financeReport as AnyOperation)) return null;
    const { today } = await takings(viewer);
    return today.items.slice(0, TODAY_ROWS_MAX).map((r) => {
      const object = typeof r.object === "string" ? r.object : "";
      const id = typeof r.recordId === "string" ? r.recordId : "";
      const category = typeof r.categoryLabel === "string" ? r.categoryLabel : "";
      return {
        label: typeof r.title === "string" && r.title ? r.title : category,
        detail: [moneyWords(Number(r.net ?? 0), today.currency), category]
          .filter(Boolean)
          .join(" · "),
        record: object && id && getObject(object) ? { object, id } : null,
      };
    });
  },
};

// --- Changes waiting for you ----------------------------------------------------------------------

/** At most this many pending actions are read for the count (the queue is a person's to keep). */
export const APPROVALS_READ = 500;

type Waiting = {
  id: string;
  operation: string;
  risk: string;
  connection_id: string | null;
  input: string | null;
  preview: string | null;
  bulk_size: number;
  actor: string;
  origin: string | null;
};

const parse = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

/** Whether a call might say who works a shift, read without the shift (a rosterer's to approve). */
function mightChangeRoster(operation: string, input: unknown): boolean {
  if (touchesRoster(operation, input)) return true;
  if (operation !== "record.update" && operation !== "record.restore") return false;
  const name = (input as { object?: unknown } | null)?.object;
  const object = typeof name === "string" ? getObject(name) : undefined;
  if (!object) return false;
  const every = Object.fromEntries(object.fields.map((f) => [f.name, null]));
  return !!object.staffed || setsRosterFields(object, every);
}

/** The pending actions the viewer may approve and that would apply, oldest first. */
async function mayApprove(viewer: Viewer): Promise<{ waiting: Waiting[]; more: boolean } | null> {
  // Approving is a person's (`approval.approve` is `actors: ["human"]`): an AI gets no item.
  if (!viewer.person || !mayCall(viewer, approvalApprove as AnyOperation)) return null;
  const { ctx } = viewer;
  const read = await ctx.db
    .selectFrom("core_pending_action")
    .select([
      "id",
      "operation",
      "risk",
      "connection_id",
      "input",
      "preview",
      "bulk_size",
      "actor",
      "origin",
    ])
    .where("status", "=", "pending")
    .where("expires_at", ">", ctx.now)
    .orderBy("id")
    .limit(APPROVALS_READ + 1)
    .execute();
  const more = read.length > APPROVALS_READ;
  const rows = read.slice(0, APPROVALS_READ);
  const approver = {
    actor: ctx.actor,
    user: ctx.user,
    grants: viewer.rights.grants,
    // Listed on the phone too, saying "review on a computer" (ADR 0872): counted.
    staffDevice: false,
  };
  // Any installed extension's tool, a runtime one's too, as `assertRosterApprover` resolves it:
  // the shipped packs are read already; the rest, if any action names one, in one statement.
  const known = new Map(
    viewer.packs.map((p) => [p.id, { manifest: p.manifest, source: "shipped" as const }]),
  );
  const others = [
    ...new Set(
      rows
        .filter((r) => r.operation.startsWith("x."))
        .map((r) => r.operation.split(".")[1] ?? "")
        .filter((id) => id && !known.has(id)),
    ),
  ];
  if (others.length) {
    for (const row of await ctx.db
      .selectFrom("core_extensions")
      .select(["id", "manifest", "source"])
      .where("id", "in", jsonList(others))
      .execute()) {
      try {
        known.set(row.id, {
          manifest: JSON.parse(row.manifest) as ExtensionManifest,
          source: row.source as "shipped",
        });
      } catch {
        // Unreadable: its tools resolve to nothing, as `resolveExtensionOperation` would fail.
      }
    }
  }
  const toolOf = (name: string): AnyOperation | null => {
    const [, pack, tool] = name.split(".");
    const found = pack ? known.get(pack) : undefined;
    const spec =
      tool && found && Object.hasOwn(found.manifest.tools ?? {}, tool)
        ? found.manifest.tools[tool]
        : null;
    return spec && found && tool ? toolOperation(found.manifest, tool, spec, found.source) : null;
  };
  let allowed = rows.filter((row) => {
    if (!approverRulesAllow(approver, row)) return false;
    // A restricted pack tool's call (ADR 0625): only someone who could call it approves it.
    if (row.operation.startsWith("x.")) {
      const op = toolOf(row.operation);
      if (op?.packRestricted) {
        const input = parse<unknown>(row.input, {});
        if (staffAuthority(ctx.user, viewer.rights, op, input) === null) return false;
      }
    }
    return true;
  });
  // A message to people that approving would not send (ADR 0678): a recipient who may not be
  // contacted now, asked together as the approvals inbox asks it; and an AI's draft from another
  // person's own mailbox, which only its owner may send (`othersPersonalDraft`, as approving
  // decides it).
  const outbound = allowed.filter((r) => r.connection_id !== null);
  if (outbound.length) {
    const inputs = new Map(outbound.map((r) => [r.id, parse<Partial<OutboundInput>>(r.input, {})]));
    const [blocked, owners] = await Promise.all([
      contactBlockedMany(
        ctx.db,
        outbound.map((r) => ({
          id: r.id,
          input: inputs.get(r.id) ?? {},
          actor: r.actor as Actor,
          origin: parse<Partial<Origin>>(r.origin, {}),
        })),
        ctx.now,
      ),
      outbound.some((r) => inputs.get(r.id)?.contact?.personal)
        ? connectionOwners(
            ctx,
            outbound.flatMap((r) => (r.connection_id ? [r.connection_id] : [])),
          )
        : Promise.resolve(new Map<string, string | null>()),
    ]);
    allowed = allowed.filter(
      (r) =>
        r.connection_id === null ||
        (!blocked.has(r.id) &&
          !othersPersonalDraft(
            inputs.get(r.id) ?? {},
            owners.get(r.connection_id) ?? null,
            ctx.user.id,
          )),
    );
  }
  // A roster change (ADR 0626) is a rosterer's, where a pack declares who rosters. Without the
  // shift's own read, an update or restore of a staffed object might be one: a non-rosterer's
  // count leaves it out (`approval.approve` decides it on the record either way).
  const roster = allowed.filter((r) => mightChangeRoster(r.operation, parse(r.input, {})));
  if (roster.length && ctx.user.role !== "admin") {
    if ((await rosteringDeclared(ctx.db)) && !(await viewer.rosterer())) {
      const out = new Set(roster.map((r) => r.id));
      return { waiting: allowed.filter((r) => !out.has(r.id)), more };
    }
  }
  return { waiting: allowed, more };
}

/** The owner of each connection (a person's own mailbox), in one statement. */
async function connectionOwners(viewer: Viewer["ctx"], ids: readonly string[]) {
  const rows = await viewer.db
    .selectFrom("core_integration_connection")
    .select(["id", "owner_user_id"])
    .where("id", "in", jsonList([...new Set(ids)]))
    .execute();
  return new Map(rows.map((r) => [r.id, r.owner_user_id]));
}

/** "500+" when more are waiting than were read: never a silently smaller number. */
const atLeast = (more: boolean, cap: number) =>
  more ? `${cap}+ waiting: the oldest ${cap} counted` : null;

const approvalsItem: HostItem = {
  key: "host.approvals",
  money: false,
  async item(viewer) {
    const found = await mayApprove(viewer);
    if (!found) return null;
    const { waiting, more } = found;
    return {
      key: "host.approvals",
      label: "Waiting for you",
      format: "count",
      value: waiting.length,
      currency: null,
      detail: atLeast(more, APPROVALS_READ),
      compare: null,
      state: waiting.length > 0 ? "attention" : "ok",
      target: { kind: "approvals" },
      order: 10,
    };
  },
  async rows(viewer) {
    const found = await mayApprove(viewer);
    if (!found) return null;
    return found.waiting.slice(0, TODAY_ROWS_MAX).map((row) => ({
      label: actionTitle(
        row.operation,
        parse(row.preview, []),
        parse(row.input, {}),
        Number(row.bulk_size ?? 1),
      ),
      detail: row.risk === "extension" || row.risk === "schema" ? "Review on a computer" : null,
      record: null,
    }));
  },
};

// --- Shifts with nobody on them ---------------------------------------------------------------------

async function uncovered(viewer: Viewer) {
  if (!viewer.person || !mayCall(viewer, staffingUncovered as AnyOperation)) return null;
  if (!listObjects().some((o) => o.staffed)) return null;
  if (!(await viewer.rosterer())) return null;
  const now = seconds(viewer.ctx.now);
  const { uncoveredDays } = await rosterNumbers(viewer.ctx.db);
  const shifts = await uncoveredShifts(viewer.ctx, now, now + uncoveredDays * 86_400);
  const soon = shifts.filter((s) => seconds(s.startsAt) < now + 86_400).length;
  return { shifts, soon };
}

const uncoveredItem: HostItem = {
  key: "host.uncovered",
  money: false,
  async item(viewer) {
    const found = await uncovered(viewer);
    if (!found) return null;
    return {
      key: "host.uncovered",
      label: "Shifts with nobody on them",
      format: "count",
      value: found.shifts.length,
      currency: null,
      detail: `${found.soon} in the next 24 hours`,
      compare: null,
      state: found.soon > 0 ? "attention" : "ok",
      target: { kind: "rows" },
      order: 40,
    };
  },
  async rows(viewer) {
    const found = await uncovered(viewer);
    if (!found) return null;
    return found.shifts.slice(0, TODAY_ROWS_MAX).map((s) => ({
      label: s.title,
      detail: momentWords(s.startsAt, viewer.zone),
      record: { object: s.object, id: s.id },
    }));
  },
};

// --- Checklists -----------------------------------------------------------------------------------

type RunRow = {
  id: string;
  object_type: string;
  record_id: string;
  name: string;
  state: "missed" | "open";
  opens: number;
  person: string | null;
};

async function checklistRunsOf(viewer: Viewer): Promise<RunRow[] | null> {
  // A run is read by its person and those who roster only, never by an AI (ADR 0650).
  if (!viewer.person || !mayCall(viewer, checklistRuns as AnyOperation)) return null;
  if (!declaredObjects().length) return null;
  if (!(await viewer.rosterer())) return null;
  const { day } = viewer.windows.today;
  const now = seconds(viewer.ctx.now);
  // Shifts' runs only, as `checklist.runs`: a checklist done on its own is its managers'.
  const result = await sql<RunRow>`
    SELECT * FROM (
      SELECT r.id, r.object_type, r.record_id, r.name, r.state, r.opens, u.name AS person
      FROM core_checklist_run r LEFT JOIN core_user u ON u.id = r.account_id
      WHERE r.state = 'missed' AND r.opens >= ${seconds(day.from)} AND r.opens < ${seconds(day.to)}
        AND r.object_type != 'checklist.day'
      UNION ALL
      SELECT r.id, r.object_type, r.record_id, r.name, r.state, r.opens, u.name AS person
      FROM core_checklist_run r LEFT JOIN core_user u ON u.id = r.account_id
      WHERE r.state = 'open' AND r.closes < ${now} AND r.object_type != 'checklist.day'
    ) ORDER BY opens, id LIMIT ${CHECKLISTS_READ + 1}
  `.execute(viewer.ctx.db);
  return result.rows;
}

/** At most this many runs are counted; more are said to be more ("200+"). */
export const CHECKLISTS_READ = 200;

const checklistsItem: HostItem = {
  key: "host.checklists",
  money: false,
  async item(viewer) {
    const read = await checklistRunsOf(viewer);
    if (!read) return null;
    const more = read.length > CHECKLISTS_READ;
    const runs = read.slice(0, CHECKLISTS_READ);
    const missed = runs.filter((r) => r.state === "missed").length;
    return {
      key: "host.checklists",
      label: "Checklists missed",
      format: "count",
      value: runs.length,
      currency: null,
      detail: more
        ? `${CHECKLISTS_READ}+: the first ${CHECKLISTS_READ} counted, ${missed} of them missed`
        : `${missed} missed, ${runs.length - missed} still open`,
      compare: null,
      state: missed > 0 ? "attention" : "ok",
      target: { kind: "rows" },
      order: 50,
    };
  },
  async rows(viewer) {
    const runs = await checklistRunsOf(viewer);
    if (!runs) return null;
    return runs.slice(0, TODAY_ROWS_MAX).map((r) => ({
      label: r.name,
      detail: [r.state === "missed" ? "Missed" : "Still open", r.person]
        .filter(Boolean)
        .join(" · "),
      record: getObject(r.object_type) ? { object: r.object_type, id: r.record_id } : null,
    }));
  },
};

// --- Notices --------------------------------------------------------------------------------------

const noticesVisible = (viewer: Viewer) =>
  viewer.person && mayCall(viewer, notificationList as AnyOperation);

const noticesItem: HostItem = {
  key: "host.notices",
  money: false,
  async item(viewer) {
    if (!noticesVisible(viewer)) return null;
    const unread = await unreadCount(viewer.ctx.db, viewer.ctx.user.id, true);
    return {
      key: "host.notices",
      label: "Unread notices",
      format: "count",
      value: unread,
      currency: null,
      detail: null,
      compare: null,
      state: "ok",
      target: { kind: "notices" },
      order: 900,
    };
  },
  async rows(viewer) {
    if (!noticesVisible(viewer)) return null;
    const rows = await viewer.ctx.db
      .selectFrom("core_notifications")
      .select(["title", "body", "link"])
      .where("user_id", "=", viewer.ctx.user.id)
      .where("read_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(TODAY_ROWS_MAX)
      .execute();
    return rows.map((row) => {
      const link = notificationLinkSchema.safeParse(parse<unknown>(row.link, null));
      return {
        label: row.title,
        detail: row.body,
        record:
          link.success && link.data.kind === "record"
            ? { object: link.data.object, id: link.data.id }
            : null,
      };
    });
  },
};

/** Every host item built, in the host's order. */
export const HOST_ITEMS: readonly HostItem[] = [
  approvalsItem,
  takingsItem,
  uncoveredItem,
  checklistsItem,
  noticesItem,
];
