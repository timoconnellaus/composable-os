// Stage 58 step 4 (ADR 0853): leave. Types the business sets, requests with the amounts the host
// proposes from the roster, approval in one batch (the balance entry, stage 45's unavailability
// row and the person taken off the shifts it covers, each offered), declining and cancelling, the
// balance ledger, `staffing.away` and `staffing.back` amended, leaving, and who sees what.
// Acceptance criteria 10, 11 and 12 for leave.
//
// The fixture: Sydney in June 2026 (standard time, +10:00 all month), duty shifts of a cleaning
// kind, and a class of a coach profile. Every operation is called as a shipped pack's tool run
// would call it (the extension's account as `ctx.user`, the person as the verified caller). Every
// clock is injected.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke, invokeByName } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser } from "./helpers.ts";

/**
 * A database whose first batch waits until released: a call made through it reads, plans its
 * batch, and then commits only after whatever the test runs meanwhile (a race forced, not hoped
 * for).
 */
function heldDb() {
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let reached = () => {};
  const waiting = new Promise<void>((r) => {
    reached = r;
  });
  const held = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          reached();
          await gate;
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: createCrmDb(held), release, waiting };
}

const ext = extId("stlv");
const COACH = `${ext}.coach`;
const KIND = `${ext}.kind`;
const KLASS = `${ext}.klass`;
const DUTY = `${ext}.duty`;
const ZONE = "Australia/Sydney";

const fixture = manifest(ext, {
  objects: {
    coach: {
      label: "Coach",
      plural: "Coaches",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        user: { type: "user", label: "Staff account" },
      },
      unique: [{ fields: ["user"] }],
    },
    kind: {
      label: "Kind",
      plural: "Kinds",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    klass: {
      label: "Class",
      plural: "Classes",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        kind: { type: "relation", label: "Kind", to: `${ext}.kind` },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        timezone: { type: "timezone", label: "Time zone" },
        coach: { type: "relation", label: "Coach", to: `${ext}.coach` },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [{ from: "scheduled", to: "cancelled", by: ["staff"] }],
      },
      staffed: {
        who: { field: "coach", account: "user" },
        starts: "startsAt",
        ends: "endsAt",
        zone: "timezone",
        kind: "kind",
        live: ["scheduled"],
      },
    },
    duty: {
      label: "Duty shift",
      plural: "Duty shifts",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        kind: { type: "relation", label: "Duty", to: `${ext}.kind` },
        staff: { type: "user", label: "Staff" },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [{ from: "scheduled", to: "cancelled", by: ["staff"] }],
      },
      staffed: {
        who: { field: "staff" },
        starts: "startsAt",
        ends: "endsAt",
        kind: "kind",
        live: ["scheduled"],
      },
    },
  },
});

/** The installed manifest's parts the host reads: who rosters and who handles pay. */
const installed = {
  grantable: [`${ext}:manage`, `${ext}:pay`],
  restricted: [`${ext}:manage`, `${ext}:pay`],
  staffing: { rosters: `${ext}:manage`, pays: `${ext}:pay` },
};

const NOW = "2026-06-01T00:00:00.000Z"; // 10:00 Monday 1 June in Sydney
/** A local Sydney wall-clock time in June as an ISO instant. */
const sydney = (local: string) => new Date(`${local}:00+10:00`).toISOString();

const LEAVE = [
  "staffing.leave.types",
  "staffing.leave.saveType",
  "staffing.leave.request",
  "staffing.leave.requestFor",
  "staffing.leave.cancel",
  "staffing.leave.mine",
  "staffing.leave.pending",
  "staffing.leave.approve",
  "staffing.leave.decline",
  "staffing.leave.cancelApproved",
  "staffing.leave.balances",
  "staffing.leave.setBalance",
  "staffing.leave.adjust",
];
const STAFFING = [
  ...LEAVE,
  "staffing.away",
  "staffing.back",
  "staffing.awayList",
  "staffing.check",
  "staffing.assign",
];

let admin: ActingUser;
let extUser: ActingUser;
/** Granted the rosterers' permission: approves leave. */
let manager: ActingUser;
/** Granted the pay permission: sets types and balances. */
let payer: ActingUser;
/** An hourly cleaner on duty shifts. */
let di: ActingUser;
/** Another cleaner, qualified: the offers go to her. */
let eve: ActingUser;
/** Anyone else on the team. */
let fay: ActingUser;
/** A coach on a class. */
let bo: ActingUser;
let boProfile: string;
let cleaning: string;
let annual: string;
let personal: string;
let unpaid: string;

type ToolFlags = { humanOnly?: boolean; personApproves?: boolean; actor?: string };
const tool = (user: ActingUser, flags: ToolFlags = { humanOnly: true }, now = NOW) =>
  context(extUser, {
    actor: "extension",
    clock: () => new Date(now),
    extension: {
      id: ext,
      permissions: { operations: STAFFING, objects: {} } as never,
      tool: {
        name: "leave",
        humanOnly: flags.humanOnly ?? false,
        ...(flags.personApproves ? { personApproves: true } : {}),
        permission: `${ext}:team`,
        calledBy: { account: user.id, actor: flags.actor ?? "human" },
      },
    },
  });
const call = <T = Record<string, unknown>>(
  name: string,
  input: unknown,
  user: ActingUser,
  now = NOW,
) => invokeByName(name, input, tool(user, { humanOnly: true }, now)) as Promise<T>;
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeTruthy();
  return error as { code: string; message: string; details?: Record<string, unknown> };
}
const as = (user: ActingUser, now = NOW) => context(user, { clock: () => new Date(now) });
async function create(object: string, values: Record<string, unknown>) {
  return ((await invoke("record.create", { object, values }, as(admin))) as { id: string }).id;
}
async function duty(name: string, staff: string | null, from: string, to: string) {
  return create(DUTY, { name, kind: cleaning, staff, startsAt: sydney(from), endsAt: sydney(to) });
}
async function claim(object: string, id: string) {
  return (
    (await env.DB.prepare(
      "SELECT account_id FROM core_staff_time WHERE object_type = ? AND record_id = ?",
    )
      .bind(object, id)
      .first<{ account_id: string }>()) ?? null
  );
}
async function openOffer(object: string, id: string) {
  return env.DB.prepare(
    "SELECT id, from_account, made_by FROM core_staff_offer WHERE object_type = ? AND record_id = ? AND state = 'open'",
  )
    .bind(object, id)
    .first<{ id: string; from_account: string | null; made_by: string }>();
}
async function noticesOf(user: string) {
  const { results } = await env.DB.prepare(
    "SELECT title, body, human_only FROM core_notifications WHERE user_id = ? ORDER BY created_at, id",
  )
    .bind(user)
    .all<{ title: string; body: string | null; human_only: number }>();
  return results;
}
async function balance(account: string, type: string) {
  const row = await env.DB.prepare(
    "SELECT coalesce(sum(amount), 0) AS n FROM core_leave_balance_entry WHERE account_id = ? AND type_id = ?",
  )
    .bind(account, type)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

type Asked = {
  request: {
    id: string;
    state: string;
    total: number;
    days: { date: string; asked: number }[];
  } | null;
  proposed: { date: string; amount: number }[];
  balance: number | null;
  balanceAfter: number | null;
  shifts: { id: string }[];
  shiftCount: number;
  warnings: { code: string }[];
};
type Approved = {
  request: { id: string; state: string; total: number; decidedBy: string };
  warnings: { code: string }[];
  offered: { id: string; told: number }[];
  uncovered: { id: string }[];
};

beforeAll(async () => {
  admin = await createUser("admin");
  extUser = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extUser.id)
    .run();
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(ZONE), NOW)
    .run();
  await reconcile(fixture, NOW);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify(installed), admin.id, NOW, NOW)
    .run();
  const named = async (name: string, grants: string[] = []) => {
    const user = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET name = ?, granted_permissions = ? WHERE id = ?")
      .bind(name, grants.length ? JSON.stringify(grants) : null, user.id)
      .run();
    return { ...user, name };
  };
  manager = await named("Manager Mo", [`${ext}:manage`]);
  payer = await named("Payer Pat", [`${ext}:pay`]);
  di = await named("Cleaner Di");
  eve = await named("Cleaner Eve");
  fay = await named("Front Fay");
  bo = await named("Coach Bo");
  boProfile = await create(COACH, { name: "Coach Bo", user: bo.id });
  cleaning = await create(KIND, { name: "Cleaning" });
  await invoke(
    "staffing.qualify" as never,
    { account: eve.id, kind: { object: KIND, id: cleaning } } as never,
    context(extUser, {
      actor: "extension",
      clock: () => new Date(NOW),
      extension: {
        id: ext,
        permissions: { operations: ["staffing.qualify"], objects: {} } as never,
        tool: {
          name: "qualify",
          humanOnly: true,
          permission: `${ext}:manage`,
          calledBy: { account: admin.id, actor: "human" },
        },
      },
    }),
  );
}, 60_000);

describe("before the business has a leave type", () => {
  it("none ship, and staffing.away still makes kind leave", async () => {
    expect((await call<{ items: unknown[] }>("staffing.leave.types", {}, fay)).items).toEqual([]);
    const away = await call<{ id: string }>(
      "staffing.away",
      { kind: "leave", startsAt: "2026-07-01T00:00", endsAt: "2026-07-02T00:00" },
      fay,
    );
    expect(away.id).toMatch(/^saw_/);
  });
});

describe("leave types (a pay holder's)", () => {
  it("only a pay holder saves one; an AI's draft is allowed through a tool a person approves", async () => {
    const input = {
      name: "Annual",
      unit: "hours",
      keepsBalance: true,
      belowZero: "warn",
      paid: true,
    };
    expect((await refusal(call("staffing.leave.saveType", input, manager))).details?.rule).toBe(
      "pay",
    );
    expect((await refusal(call("staffing.leave.saveType", input, di))).details?.rule).toBe("pay");
    // A tool an AI may call outright is refused: saving a type is applied by a person.
    const ai = invokeByName("staffing.leave.saveType", input, tool(payer, { actor: "assistant" }));
    expect((await refusal(ai)).details?.rule).toBe("person_applies");
    annual = (
      (await invokeByName(
        "staffing.leave.saveType",
        input,
        tool(payer, { personApproves: true, actor: "assistant" }),
      )) as { type: { id: string } }
    ).type.id;
    personal = (
      await call<{ type: { id: string } }>(
        "staffing.leave.saveType",
        { name: "Personal", unit: "days", keepsBalance: true, belowZero: "refuse", paid: true },
        payer,
      )
    ).type.id;
    unpaid = (
      await call<{ type: { id: string } }>(
        "staffing.leave.saveType",
        { name: "Unpaid", unit: "days", keepsBalance: false, paid: false, position: 9 },
        admin,
      )
    ).type.id;
    const dup = await refusal(call("staffing.leave.saveType", { ...input, name: "annual" }, payer));
    expect(dup.details?.rule).toBe("leave_type_name");
    const types = await call<{ items: { name: string; unit: string; keepsBalance: boolean }[] }>(
      "staffing.leave.types",
      {},
      fay,
    );
    expect(types.items.map((t) => t.name)).toEqual(["Annual", "Personal", "Unpaid"]);
  });

  it("once a type exists, staffing.away no longer makes kind leave; other and regular stay", async () => {
    const e = await refusal(
      call(
        "staffing.away",
        { kind: "leave", startsAt: "2026-07-03T00:00", endsAt: "2026-07-04T00:00" },
        fay,
      ),
    );
    expect(e.details?.rule).toBe("leave_is_asked_for");
    await call(
      "staffing.away",
      { kind: "other", startsAt: "2026-07-03T00:00", endsAt: "2026-07-04T00:00" },
      fay,
    );
  });
});

describe("balances (criterion 11)", () => {
  it("only a pay holder sets or adjusts; the balance is the ledger's sum; nothing accrues", async () => {
    const set = { account: di.id, type: annual, amount: 600, note: "Opening balance" };
    expect((await refusal(call("staffing.leave.setBalance", set, manager))).details?.rule).toBe(
      "pay",
    );
    expect((await refusal(call("staffing.leave.setBalance", set, di))).details?.rule).toBe("pay");
    await call("staffing.leave.setBalance", set, payer);
    await call("staffing.leave.adjust", { ...set, amount: 174, note: "This fortnight" }, payer);
    expect(await balance(di.id, annual)).toBe(774);
    // A set is the difference from the sum: setting it again lands on the amount, not on top.
    await call("staffing.leave.setBalance", { ...set, amount: 900, note: "Corrected" }, payer);
    expect(await balance(di.id, annual)).toBe(900);
    const none = await refusal(
      call("staffing.leave.adjust", { ...set, type: unpaid, note: "x" }, payer),
    );
    expect(none.details?.rule).toBe("leave_no_balance");
    // Di reads her own, with every type that keeps one; history with a type.
    const mine = await call<{
      items: { type: { name: string }; balance: number }[];
      history: { why: string; amount: number }[] | null;
    }>("staffing.leave.balances", { type: annual }, di);
    expect(mine.items).toMatchObject([{ type: { name: "Annual" }, balance: 900 }]);
    expect(mine.history?.map((h) => h.why)).toEqual(["set", "adjust", "set"]);
    // Di is told, never the amount.
    const told = (await noticesOf(di.id)).filter((n) => n.title.includes("balance"));
    expect(told.length).toBe(3);
    for (const n of told) expect(`${n.title} ${n.body}`).not.toMatch(/900|774|600|174/);
  });

  it("nothing in the ledger is changed, removed or replaced, by any statement", async () => {
    const row = await env.DB.prepare(
      "SELECT id FROM core_leave_balance_entry WHERE account_id = ? LIMIT 1",
    )
      .bind(di.id)
      .first<{ id: string }>();
    for (const statement of [
      "UPDATE core_leave_balance_entry SET amount = 1 WHERE id = ?",
      "DELETE FROM core_leave_balance_entry WHERE id = ?",
      "INSERT OR REPLACE INTO core_leave_balance_entry (id, account_id, type_id, amount, why, made_by, made_at) SELECT id, account_id, type_id, 1, 'adjust', made_by, made_at FROM core_leave_balance_entry WHERE id = ?",
      "UPDATE OR REPLACE core_leave_balance_entry SET note = 'x' WHERE id = ?",
    ]) {
      await expect(env.DB.prepare(statement).bind(row?.id).run(), statement).rejects.toThrow(
        /core_leave_balance_fixed/,
      );
    }
  });
});

describe("asking (criterion 10)", () => {
  it("proposes amounts from the roster, answers the balance after and the shifts covered", async () => {
    await duty("Morning clean", di.id, "2026-06-08T08:00", "2026-06-08T12:00");
    await duty("Afternoon clean", di.id, "2026-06-08T13:00", "2026-06-08T15:00");
    await duty("Wednesday clean", di.id, "2026-06-10T06:00", "2026-06-10T10:00");
    const preview = await call<Asked>(
      "staffing.leave.request",
      { type: annual, startDate: "2026-06-08", endDate: "2026-06-10", preview: true },
      di,
    );
    expect(preview.request).toBeNull();
    expect(preview.proposed).toEqual([
      { date: "2026-06-08", amount: 360 },
      { date: "2026-06-09", amount: 0 },
      { date: "2026-06-10", amount: 240 },
    ]);
    expect(preview).toMatchObject({ balance: 900, balanceAfter: 300, shiftCount: 3 });
    // Part of one day counts the rostered minutes inside it only.
    const part = await call<Asked>(
      "staffing.leave.request",
      {
        type: annual,
        startDate: "2026-06-08",
        startTime: "11:00",
        endTime: "14:00",
        preview: true,
      },
      di,
    );
    expect(part.proposed).toEqual([{ date: "2026-06-08", amount: 120 }]);
    // A days type proposes a day each.
    const days = await call<Asked>(
      "staffing.leave.request",
      { type: personal, startDate: "2026-06-08", endDate: "2026-06-09", preview: true },
      di,
    );
    expect(days.proposed.map((p) => p.amount)).toEqual([100, 100]);
    // Nothing was written by a preview.
    expect((await call<{ items: unknown[] }>("staffing.leave.mine", {}, di)).items).toEqual([]);
  });

  it("is refused below zero for a type that refuses it, into a locked period, over other leave", async () => {
    const e = await refusal(
      call("staffing.leave.request", { type: personal, startDate: "2026-06-15" }, di),
    );
    expect(e.details?.rule).toBe("leave_below_zero");
    expect(e.message).not.toMatch(/\d{3}/);
    // A locked pay period over May.
    await env.DB.prepare(
      "INSERT INTO core_pay_period (id, start_date, end_date, zone, starts, ends, version, state, locked_by, locked_at) VALUES ('ppe_may', '2026-05-18', '2026-05-31', ?, 0, 1, 1, 'locking', ?, ?)",
    )
      .bind(ZONE, admin.id, NOW)
      .run();
    await env.DB.prepare("UPDATE core_pay_period SET state = 'locked' WHERE id = 'ppe_may'").run();
    const locked = await refusal(
      call(
        "staffing.leave.request",
        { type: unpaid, startDate: "2026-05-30", endDate: "2026-06-02" },
        di,
      ),
    );
    expect(locked.details?.rule).toBe("pay_period_locked");
    const asked = await call<Asked>(
      "staffing.leave.request",
      { type: unpaid, startDate: "2026-07-20" },
      di,
    );
    const over = await refusal(
      call(
        "staffing.leave.request",
        { type: unpaid, startDate: "2026-07-19", endDate: "2026-07-21" },
        di,
      ),
    );
    expect(over.details?.rule).toBe("leave_overlap");
    await call("staffing.leave.cancel", { id: asked.request?.id }, di);
    const amounts = await refusal(
      call(
        "staffing.leave.request",
        { type: unpaid, startDate: "2026-07-20", amounts: [{ date: "2026-07-20", amount: 101 }] },
        di,
      ),
    );
    expect(amounts.code).toBe("invalid_input");
  });
});

describe("approving (criterion 10)", () => {
  let request: string;
  const shifts: string[] = [];

  it("an approver approves in one batch: balance, away row, shifts taken off and offered", async () => {
    const asked = await call<Asked>(
      "staffing.leave.request",
      {
        type: annual,
        startDate: "2026-06-08",
        endDate: "2026-06-10",
        note: "Family wedding interstate",
      },
      di,
    );
    request = asked.request?.id as string;
    expect(asked.request).toMatchObject({ state: "requested", total: 600 });
    // The approvers are told who and when, never the note.
    const toManager = (await noticesOf(manager.id)).filter((n) =>
      n.title.includes("asks for annual"),
    );
    expect(toManager.length).toBe(1);
    expect(JSON.stringify(toManager)).not.toContain("wedding");
    expect(toManager[0]?.human_only).toBe(1);
    // Eve (anyone else on the team) cannot approve it, or read it.
    expect(
      (await refusal(call("staffing.leave.approve", { id: request }, eve))).details?.rule,
    ).toBe("rostering");
    for (const { rows } of [
      {
        rows: await env.DB.prepare("SELECT record_id FROM core_staff_time WHERE account_id = ?")
          .bind(di.id)
          .all<{ record_id: string }>(),
      },
    ]) {
      for (const r of rows.results) shifts.push(r.record_id);
    }
    expect(shifts.length).toBe(3);
    const done = await call<Approved>(
      "staffing.leave.approve",
      { id: request, amounts: [{ date: "2026-06-10", amount: 200 }] },
      manager,
    );
    expect(done.request).toMatchObject({ state: "approved", total: 560, decidedBy: manager.id });
    expect(done.warnings).toEqual([]);
    expect(done.offered.map((o) => o.told)).toEqual([1, 1, 1]);
    expect(done.uncovered).toEqual([]);
    expect(await balance(di.id, annual)).toBe(340);
    for (const id of shifts) {
      expect(await claim(DUTY, id)).toBeNull();
      expect(await openOffer(DUTY, id)).toMatchObject({ from_account: null });
    }
    const away = await env.DB.prepare(
      "SELECT kind, note, starts_at, ends_at FROM core_staff_away WHERE leave_request = ?",
    )
      .bind(request)
      .first();
    expect(away).toEqual({
      kind: "leave",
      note: null,
      starts_at: sydney("2026-06-08T00:00"),
      ends_at: sydney("2026-06-11T00:00"),
    });
    // Di is told; the rosterers get stage 45's notice with the shifts offered.
    expect((await noticesOf(di.id)).some((n) => n.title.includes("leave is approved"))).toBe(true);
    const toAdmin = (await noticesOf(admin.id)).filter((n) => n.title.includes("is on leave"));
    expect(toAdmin.length).toBe(1);
    expect(toAdmin[0]?.body).toContain("Offered to everyone who can take it");
    // Eve is offered each, in one notice.
    const offers = (await noticesOf(eve.id)).filter((n) => n.title.includes("offered"));
    expect(offers.map((n) => n.title)).toEqual(["3 shifts offered to you"]);
    expect(offers[0]?.body).toContain("Morning clean");
  });

  it("stage 45's warning and eligibility follow; staffing.back refuses the row", async () => {
    const shift = await duty("Tuesday clean", null, "2026-06-09T09:00", "2026-06-09T11:00");
    const check = await call<{ warnings: { code: string }[] }>(
      "staffing.check",
      { object: DUTY, id: shift, account: di.id },
      manager,
    );
    expect(check.warnings.map((w) => w.code)).toContain("unavailable");
    const away = await call<{ items: { id: string; leaveRequest: string | null }[] }>(
      "staffing.awayList",
      { from: "2026-06-01" },
      di,
    );
    const row = away.items.find((a) => a.leaveRequest === request);
    expect(row).toBeTruthy();
    const e = await refusal(call("staffing.back", { id: row?.id }, di));
    expect(e.details?.rule).toBe("leave_request_away");
  });

  it("two approvals at once apply once", async () => {
    const asked = await call<Asked>(
      "staffing.leave.request",
      { type: annual, startDate: "2026-06-22" },
      di,
    );
    const id = asked.request?.id as string;
    const results = await Promise.allSettled([
      call("staffing.leave.approve", { id }, manager),
      call("staffing.leave.approve", { id }, admin),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((failed.reason as { details?: { rule?: string } }).details?.rule).toBe("leave_closed");
    const entries = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_leave_balance_entry WHERE request_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(entries?.n).toBe(0); // nothing rostered that day: an amount of 0 writes no entry
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_staff_away WHERE leave_request = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("below zero warns for a type that warns, and is refused by the database for one that refuses", async () => {
    // Annual warns: 340 left, 400 asked.
    const asked = await call<Asked>(
      "staffing.leave.request",
      { type: annual, startDate: "2026-06-23", amounts: [{ date: "2026-06-23", amount: 400 }] },
      di,
    );
    expect(asked.warnings.map((w) => w.code)).toEqual(["below_zero"]);
    const done = await call<Approved>("staffing.leave.approve", { id: asked.request?.id }, manager);
    expect(done.warnings.map((w) => w.code)).toEqual(["below_zero"]);
    expect(await balance(di.id, annual)).toBe(-60);
    // Personal refuses: a day each asked within the balance, two approved at once that together
    // are not: the second fails whole.
    await call(
      "staffing.leave.setBalance",
      { account: di.id, type: personal, amount: 100, note: "One day" },
      payer,
    );
    const one = await call<Asked>(
      "staffing.leave.request",
      { type: personal, startDate: "2026-06-24" },
      di,
    );
    const two = await call<Asked>(
      "staffing.leave.request",
      { type: personal, startDate: "2026-06-25" },
      di,
    );
    const results = await Promise.allSettled([
      call("staffing.leave.approve", { id: one.request?.id }, manager),
      call("staffing.leave.approve", { id: two.request?.id }, admin),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((failed.reason as { details?: { rule?: string } }).details?.rule).toBe(
      "leave_below_zero",
    );
    expect(await balance(di.id, personal)).toBe(0);
  });

  it("nobody decides their own; an admin may when nobody else can", async () => {
    const own = await call<Asked>(
      "staffing.leave.request",
      { type: unpaid, startDate: "2026-08-03" },
      manager,
    );
    const e = await refusal(call("staffing.leave.approve", { id: own.request?.id }, manager));
    expect(e.details?.rule).toBe("own_leave");
    const mine = await call<Asked>(
      "staffing.leave.request",
      { type: unpaid, startDate: "2026-08-04" },
      admin,
    );
    // The manager can approve, so the admin may not approve their own.
    expect(
      (await refusal(call("staffing.leave.approve", { id: mine.request?.id }, admin))).details
        ?.rule,
    ).toBe("own_leave");
    await call("staffing.leave.approve", { id: mine.request?.id }, manager);
    await call(
      "staffing.leave.decline",
      { id: own.request?.id, why: "Short-staffed that week" },
      admin,
    );
  });

  it("declining tells the person, not why; they read why themselves", async () => {
    const declined = (await noticesOf(manager.id)).filter((n) => n.title.includes("declined"));
    expect(declined.length).toBe(1);
    expect(JSON.stringify(declined)).not.toContain("Short-staffed");
    const mine = await call<{ items: { state: string; why: string | null }[] }>(
      "staffing.leave.mine",
      {},
      manager,
    );
    expect(mine.items[0]).toMatchObject({ state: "declined", why: "Short-staffed that week" });
  });

  it("cancelling approved leave reverses the balance and removes the row, and puts nobody back", async () => {
    const before = await balance(di.id, annual);
    const e = await refusal(call("staffing.leave.cancelApproved", { id: request, why: "x" }, eve));
    expect(e.details?.rule).toBe("rostering");
    await call("staffing.leave.cancelApproved", { id: request, why: "Changed plans" }, manager);
    expect(await balance(di.id, annual)).toBe(before + 560);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_staff_away WHERE leave_request = ?",
    )
      .bind(request)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
    for (const id of shifts) expect(await claim(DUTY, id)).toBeNull();
    expect((await noticesOf(admin.id)).some((n) => n.title.includes("leave was cancelled"))).toBe(
      true,
    );
    // A cancelled request never moves again.
    const again = await refusal(
      call("staffing.leave.cancelApproved", { id: request, why: "x" }, manager),
    );
    expect(again.details?.rule).toBe("leave_closed");
  });

  it("the person cancels their own approved leave before it starts, never after", async () => {
    const asked = await call<Asked>(
      "staffing.leave.request",
      { type: unpaid, startDate: "2026-06-02" },
      di,
    );
    await call("staffing.leave.approve", { id: asked.request?.id }, manager);
    const started = await refusal(
      call("staffing.leave.cancel", { id: asked.request?.id }, di, "2026-06-02T01:00:00.000Z"),
    );
    expect(started.details?.rule).toBe("leave_started");
    const later = await call<Asked>(
      "staffing.leave.request",
      { type: unpaid, startDate: "2026-09-01" },
      di,
    );
    await call("staffing.leave.approve", { id: later.request?.id }, manager);
    const out = await call<{ request: { state: string } }>(
      "staffing.leave.cancel",
      { id: later.request?.id },
      di,
    );
    expect(out.request.state).toBe("cancelled");
  });

  it("an approver records leave already approved for someone (a sick day phoned in)", async () => {
    const shift = await create(KLASS, {
      name: "Strength",
      coach: boProfile,
      startsAt: sydney("2026-06-12T18:00"),
      endsAt: sydney("2026-06-12T19:00"),
      timezone: ZONE,
    });
    const out = await call<Asked & { uncovered: { id: string }[] }>(
      "staffing.leave.requestFor",
      { account: bo.id, type: unpaid, startDate: "2026-06-12", approve: true },
      manager,
    );
    expect(out.request?.state).toBe("approved");
    // Nobody is qualified for a class with no kind: taken off, not offered, and said so.
    expect(out.uncovered.map((s) => s.id)).toEqual([shift]);
    expect(await claim(KLASS, shift)).toBeNull();
    expect(await openOffer(KLASS, shift)).toBeNull();
    const self = await refusal(
      call(
        "staffing.leave.requestFor",
        { account: manager.id, type: unpaid, startDate: "2026-06-13" },
        manager,
      ),
    );
    expect(self.code).toBe("invalid_input");
  });

  it("what was asked never changes, and an approved request is never deleted", async () => {
    await expect(
      env.DB.prepare("UPDATE core_leave_request SET state = 'requested' WHERE id = ?")
        .bind(request)
        .run(),
    ).rejects.toThrow(/core_leave_request_closed/);
    const approved = await env.DB.prepare(
      "SELECT id FROM core_leave_request WHERE state = 'approved' LIMIT 1",
    ).first<{ id: string }>();
    for (const statement of [
      "UPDATE core_leave_request SET end_date = '2026-12-31' WHERE id = ?",
      "DELETE FROM core_leave_request WHERE id = ?",
      "INSERT OR REPLACE INTO core_leave_request SELECT * FROM core_leave_request WHERE id = ?",
      "UPDATE core_leave_day SET approved = 1 WHERE request_id = ?",
      "DELETE FROM core_leave_day WHERE request_id = ?",
    ]) {
      await expect(env.DB.prepare(statement).bind(approved?.id).run(), statement).rejects.toThrow(
        /core_leave_request_(fixed|closed)/,
      );
    }
  });
});

describe("who sees what (criterion 12)", () => {
  it("another staff member reads none of a person's requests or balances", async () => {
    expect(
      (await refusal(call("staffing.leave.balances", { account: di.id }, fay))).details?.rule,
    ).toBe("not_yours");
    expect((await refusal(call("staffing.leave.pending", {}, fay))).details?.rule).toBe(
      "rostering",
    );
    const theirs = await env.DB.prepare(
      "SELECT id FROM core_leave_request WHERE account_id = ? AND state = 'requested' LIMIT 1",
    )
      .bind(di.id)
      .first<{ id: string }>();
    const asked =
      theirs?.id ??
      (await call<Asked>("staffing.leave.request", { type: unpaid, startDate: "2026-10-05" }, di))
        .request?.id;
    expect((await refusal(call("staffing.leave.cancel", { id: asked }, fay))).code).toBe(
      "not_found",
    );
    // Their own list holds only their own.
    const mine = await call<{ items: { account: string }[] }>("staffing.leave.mine", {}, fay);
    expect(mine.items.every((r) => r.account === fay.id)).toBe(true);
    // An approver and a pay holder read everyone's balances.
    for (const reader of [manager, payer]) {
      const all = await call<{ items: { account: string }[] }>(
        "staffing.leave.balances",
        {},
        reader,
      );
      expect(all.items.some((b) => b.account === di.id)).toBe(true);
    }
    // The approver's list of what waits holds the note, at the screen.
    const pending = await call<{
      items: { id: string; note: string | null; balanceAfter: number | null }[];
    }>("staffing.leave.pending", {}, manager);
    expect(pending.items.some((p) => p.id === asked)).toBe(true);
  });

  it("an assistant and MCP are refused every leave tool but the types, whatever is granted", async () => {
    for (const user of [admin, manager, payer, di]) {
      for (const [name, input] of [
        ["staffing.leave.request", { type: unpaid, startDate: "2026-11-02" }],
        ["staffing.leave.requestFor", { account: fay.id, type: unpaid, startDate: "2026-11-02" }],
        ["staffing.leave.cancel", { id: "lvr_x" }],
        ["staffing.leave.mine", {}],
        ["staffing.leave.pending", {}],
        ["staffing.leave.approve", { id: "lvr_x" }],
        ["staffing.leave.decline", { id: "lvr_x", why: "x" }],
        ["staffing.leave.cancelApproved", { id: "lvr_x", why: "x" }],
        ["staffing.leave.balances", {}],
        ["staffing.leave.setBalance", { account: di.id, type: annual, amount: 1, note: "x" }],
        ["staffing.leave.adjust", { account: di.id, type: annual, amount: 1, note: "x" }],
      ] as const) {
        for (const actor of ["assistant", "mcp"]) {
          const e = await refusal(
            invokeByName(name, input, tool(user, { humanOnly: true, actor })),
          );
          expect(e.details?.rule, `${name} ${actor}`).toBe("human_only");
        }
        const e = await refusal(invokeByName(name, input, tool(user, { personApproves: true })));
        expect(e.details?.rule, name).toBe("human_only");
      }
    }
    // A person, MCP or the assistant calling the host directly: no such operation.
    await expect(
      invoke("staffing.leave.balances" as never, {} as never, as(admin)),
    ).rejects.toMatchObject({
      code: "unknown_operation",
    });
  });

  it("no note, reason, amount or balance is in the audit log", async () => {
    const { results } = await env.DB.prepare(
      "SELECT operation, input, result FROM core_audit WHERE operation LIKE 'staffing.leave.%'",
    ).all<{ operation: string; input: string | null; result: string | null }>();
    expect(results.length).toBeGreaterThan(10);
    const text = JSON.stringify(results);
    for (const secret of [
      "wedding",
      "Short-staffed",
      "Changed plans",
      "Opening balance",
      "This fortnight",
      '"amount":600',
      '"balance"',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    // Reads of balances and of what waits are audited as reads.
    expect(results.some((r) => r.operation === "staffing.leave.balances")).toBe(true);
    expect(results.some((r) => r.operation === "staffing.leave.pending")).toBe(true);
  });

  it("no leave table is in a rec_* view", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'view' AND name LIKE 'rec_%'",
    ).all<{ name: string; sql: string }>();
    for (const v of results) expect(v.sql, v.name).not.toMatch(/core_leave|core_staff_away/);
  });
});

describe("races the database decides (the review of PR #374)", () => {
  it("a cancel planned while the request waited fails whole once it has been approved", async () => {
    await duty("Race clean", di.id, "2026-07-10T08:00", "2026-07-10T10:00");
    const asked = await call<Asked>(
      "staffing.leave.request",
      { type: annual, startDate: "2026-07-10" },
      di,
    );
    const id = asked.request?.id as string;
    const held = heldDb();
    const cancel = invokeByName("staffing.leave.cancel", { id }, { ...tool(di), db: held.db });
    await held.waiting;
    await call("staffing.leave.approve", { id }, manager);
    held.release();
    const e = await refusal(cancel);
    expect(e.details?.rule).toBe("leave_closed");
    const row = await env.DB.prepare("SELECT state FROM core_leave_request WHERE id = ?")
      .bind(id)
      .first<{ state: string }>();
    expect(row?.state).toBe("approved");
    // Still undoable, whole: the away row goes and the balance comes back.
    const before = await balance(di.id, annual);
    await call("staffing.leave.cancelApproved", { id, why: "Not needed" }, manager);
    expect(await balance(di.id, annual)).toBe(before + 120);
    const away = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_staff_away WHERE leave_request = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(away?.n).toBe(0);
  });

  it("approved leave is cancelled only with its away row removed and its balance reversed", async () => {
    const asked = await call<Asked>(
      "staffing.leave.request",
      { type: annual, startDate: "2026-07-13", amounts: [{ date: "2026-07-13", amount: 60 }] },
      di,
    );
    const id = asked.request?.id as string;
    await call("staffing.leave.approve", { id }, manager);
    await expect(
      env.DB.prepare(
        "UPDATE core_leave_request SET state = 'cancelled', updated_at = 'x' WHERE id = ?",
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/core_leave_request_held/);
    await env.DB.prepare("DELETE FROM core_staff_away WHERE leave_request = ?").bind(id).run();
    // The away row gone, the ledger still not reversed: refused too.
    await expect(
      env.DB.prepare(
        "UPDATE core_leave_request SET state = 'cancelled', updated_at = 'x' WHERE id = ?",
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/core_leave_request_held/);
  });

  it("an approval planned before a shift was given to someone else fails whole, leaving them on it", async () => {
    const shift = await duty("Clean B", di.id, "2026-07-20T08:00", "2026-07-20T10:00");
    const asked = await call<Asked>(
      "staffing.leave.request",
      { type: unpaid, startDate: "2026-07-20" },
      di,
    );
    const id = asked.request?.id as string;
    const held = heldDb();
    const approving = invokeByName(
      "staffing.leave.approve",
      { id },
      { ...tool(manager), db: held.db },
    );
    await held.waiting;
    await invokeByName(
      "staffing.assign",
      { object: DUTY, id: shift, account: eve.id },
      tool(admin, { personApproves: true }),
    );
    held.release();
    const e = await refusal(approving);
    expect(e.details?.rule).toBe("roster_changed");
    expect(await claim(DUTY, shift)).toEqual({ account_id: eve.id });
    const row = await env.DB.prepare("SELECT state FROM core_leave_request WHERE id = ?")
      .bind(id)
      .first<{ state: string }>();
    expect(row?.state).toBe("requested");
    // Approved again, with what is there now: Eve keeps the shift.
    const done = await call<Approved>("staffing.leave.approve", { id }, manager);
    expect(done.offered.length + done.uncovered.length).toBe(0);
    expect(await claim(DUTY, shift)).toEqual({ account_id: eve.id });
  });

  it("an assistant reading its person's time off never gets their approved leave", async () => {
    const own = await call<{ items: { leaveRequest: string | null }[] }>(
      "staffing.awayList",
      { from: "2026-06-01" },
      di,
    );
    expect(own.items.some((a) => a.leaveRequest)).toBe(true);
    const ai = (await invokeByName(
      "staffing.awayList",
      { from: "2026-06-01" },
      tool(di, { actor: "assistant" }),
    )) as { items: { leaveRequest: string | null }[] };
    expect(ai.items.some((a) => a.leaveRequest)).toBe(false);
  });
});

describe("leaving", () => {
  it("deactivating someone cancels their leave still waiting, keeps what was approved, and marks an open entry finish missing", async () => {
    const leaver = await createUser("member");
    const waiting = await call<Asked>(
      "staffing.leave.request",
      { type: unpaid, startDate: "2026-11-09" },
      leaver,
    );
    const approved = await call<Asked>(
      "staffing.leave.request",
      { type: unpaid, startDate: "2026-11-16" },
      leaver,
    );
    await call("staffing.leave.approve", { id: approved.request?.id }, manager);
    // An entry they left open (stage 58 step 1's table).
    await env.DB.prepare(
      "INSERT INTO core_time_entry (id, account_id, starts, zone, local_date, how, state, made_by, created_at, updated_at) VALUES ('tme_leaver', ?, ?, ?, '2026-06-01', 'clocked', 'open', ?, ?, ?)",
    )
      .bind(leaver.id, Date.parse(NOW) / 1000 - 3600, ZONE, leaver.id, NOW, NOW)
      .run();
    await invoke("user.deactivate", { id: leaver.id }, as(admin));
    const entry = await env.DB.prepare(
      "SELECT ends, finish_missing FROM core_time_entry WHERE id = 'tme_leaver'",
    ).first();
    expect(entry).toEqual({ ends: null, finish_missing: 1 });
    const states = await env.DB.prepare(
      "SELECT id, state, why FROM core_leave_request WHERE account_id = ? ORDER BY start_date",
    )
      .bind(leaver.id)
      .all<{ id: string; state: string; why: string | null }>();
    expect(states.results).toEqual([
      { id: waiting.request?.id, state: "cancelled", why: "deactivated" },
      { id: approved.request?.id, state: "approved", why: null },
    ]);
  });
});
