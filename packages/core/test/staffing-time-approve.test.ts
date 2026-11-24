// Stage 58 step 2 (ADR 0851): differences from the roster and approval of time entries. The
// tolerance and approval on a match (the host's, recorded as the host's; never for time with no
// shift or an approver's entry), approval as is and changed (the recorded times kept beside),
// rejection and the person's correction, reopening while the pay period is open, entering time
// for someone, who may (an approver, never their own; a person reads their own), and the
// differences against a fixture worked out by hand: early, late, within the tolerance, not
// recorded, unrostered, over 12 hours, across midnight and a clock change. Acceptance criteria 5
// and 6. The organisation is in Sydney, whose clocks go forward at 02:00 on 4 October 2026.
// Every operation is called as a shipped pack's tool run would call it. Every clock is injected.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { instantOf } from "../src/operations/staffing.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser } from "./helpers.ts";

const ext = extId("stappr");
const KIND = `${ext}.kind`;
const DUTY = `${ext}.duty`;
const JOB = `${ext}.job`;
const ZONE = "Australia/Sydney";

const objects = {
  kind: {
    label: "Kind",
    plural: "Kinds",
    titleField: "name",
    fields: { name: { type: "text", label: "Name", required: true } },
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
  job: {
    label: "Job",
    plural: "Jobs",
    titleField: "name",
    fields: {
      name: { type: "text", label: "Name", required: true },
      state: {
        type: "select",
        label: "State",
        options: [{ value: "scheduled", label: "Scheduled" }],
      },
    },
    states: { field: "state", initial: "scheduled", moves: [] },
    workedOn: { live: ["scheduled"], title: "name", readers: `${ext}:jobs` },
  },
};
const fixture = manifest(ext, { objects } as never);

const installed = {
  grantable: [`${ext}:manage`],
  restricted: [`${ext}:manage`],
  settings: {
    recordsTime: { type: "boolean", label: "Staff record their time", default: false },
    matchMinutes: { type: "number", label: "Matches the roster within", default: 5 },
  },
  staffing: {
    rosters: `${ext}:manage`,
    settings: { recordsTime: "recordsTime", matchMinutes: "matchMinutes" },
  },
};

// 14:00 in Sydney on Tuesday 6 October 2026 (daylight time, +11).
const NOW = "2026-10-06T03:00:00.000Z";
const BEFORE = "2026-09-01T00:00:00.000Z";
const OPS = [
  "staffing.time.clockIn",
  "staffing.time.clockOut",
  "staffing.time.enter",
  "staffing.time.edit",
  "staffing.time.withdraw",
  "staffing.time.mine",
  "staffing.time.waiting",
  "staffing.time.differences",
  "staffing.time.approve",
  "staffing.time.reject",
  "staffing.time.reopen",
  "staffing.time.enterFor",
];

let admin: ActingUser;
let extUser: ActingUser;
let manager: ActingUser;
let deputy: ActingUser;
type Flags = { humanOnly?: boolean; actor?: string };
const tool = (user: ActingUser, now = NOW, flags: Flags = { humanOnly: true }) =>
  context(extUser, {
    actor: "extension",
    clock: () => new Date(now),
    extension: {
      id: ext,
      permissions: { operations: OPS, objects: {} } as never,
      tool: {
        name: "time",
        humanOnly: flags.humanOnly ?? false,
        permission: "records:write",
        calledBy: { account: user.id, actor: flags.actor ?? "human" },
      },
    },
  });
type Entry = {
  id: string;
  account: string;
  state: string;
  how: string;
  startsAt: string;
  endsAt: string | null;
  breakMinutes: number;
  minutes: number | null;
  localDate: string;
  against: { object: string; id: string; title: string; shift: boolean } | null;
  rejectedWhy: string | null;
  reopenedWhy: string | null;
  approval: { by: string; at: string } | null;
  recorded: { startsAt: string; endsAt: string; breakMinutes: number } | null;
};
type Answer = { id: string; entry: Entry };
type Difference = {
  account: string;
  name: string;
  entry: Entry | null;
  shift: { object: string; id: string; title: string; startsAt: string; endsAt: string } | null;
  startMinutes: number | null;
  finishMinutes: number | null;
  matches: boolean;
  notRecorded: boolean;
  unrostered: boolean;
  long: boolean;
};
type Differences = { from: string; to: string; tolerance: number; items: Difference[] };
const call = <T = Answer>(name: string, input: unknown, user: ActingUser, now = NOW) =>
  invokeByName(`staffing.time.${name}`, input, tool(user, now)) as Promise<T>;
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeTruthy();
  return error as { code: string; message: string; details?: Record<string, unknown> };
}

/** A local date-time in Sydney as an ISO instant. */
const syd = (local: string) => new Date(instantOf(local, ZONE) * 1000).toISOString();

async function create(object: string, values: Record<string, unknown>) {
  return (
    (await invokeByName(
      "record.create",
      { object, values },
      context(admin, { clock: () => new Date(BEFORE) }),
    )) as { id: string }
  ).id;
}
let kind: string;
const duty = (staff: ActingUser, startsAt: string, endsAt: string, name = "Cleaning") =>
  create(DUTY, { name, kind, staff: staff.id, startsAt, endsAt });
async function byTime(user: ActingUser, basis = "by_time") {
  await env.DB.prepare(
    "INSERT INTO core_staff_pay_basis (account_id, from_date, basis, set_by, set_at) VALUES (?, '2026-01-01', ?, ?, ?)",
  )
    .bind(user.id, basis, admin.id, BEFORE)
    .run();
}
async function setting(values: Record<string, unknown>) {
  await env.DB.prepare("UPDATE core_extension_settings SET value = ? WHERE extension_id = ?")
    .bind(JSON.stringify({ recordsTime: true, ...values }), ext)
    .run();
}
async function row(id: string) {
  return env.DB.prepare("SELECT * FROM core_time_entry WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}
async function told(user: ActingUser) {
  return (
    await env.DB.prepare(
      "SELECT title, body FROM core_notifications WHERE user_id = ? ORDER BY created_at",
    )
      .bind(user.id)
      .all<{ title: string; body: string | null }>()
  ).results;
}
const named = async (name: string, grants: string[] = []) => {
  const user = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET name = ?, granted_permissions = ? WHERE id = ?")
    .bind(name, grants.length ? JSON.stringify(grants) : null, user.id)
    .run();
  return user;
};
/** Enters time as the person, local to Sydney. */
const enter = (
  user: ActingUser,
  startsAt: string,
  endsAt: string,
  against: { object: string; id: string } | null,
  extra: Record<string, unknown> = {},
) => call("enter", { startsAt, endsAt, against, ...extra }, user);
const shiftRef = (id: string) => ({ object: DUTY, id });
const plus = (iso: string, minutes: number) =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

beforeAll(async () => {
  admin = await createUser("admin");
  extUser = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extUser.id)
    .run();
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(ZONE), BEFORE)
    .run();
  await reconcile(fixture, BEFORE);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify(installed), admin.id, BEFORE, BEFORE)
    .run();
  await env.DB.prepare(
    "INSERT INTO core_extension_settings (extension_id, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify({ recordsTime: true }), BEFORE, admin.id)
    .run();
  manager = await named("Manager Mo", [`${ext}:manage`]);
  deputy = await named("Deputy Dee", [`${ext}:manage`]);
  kind = await create(KIND, { name: "Cleaning" });
}, 60_000);

describe("who decides time", () => {
  it("an approver, never an assistant or MCP, whatever is granted", async () => {
    const who = await named("Cleaner A");
    const shift = await duty(who, syd("2026-09-28T09:00"), syd("2026-09-28T13:00"));
    const e = await enter(who, "2026-09-28T09:30", "2026-09-28T13:00", shiftRef(shift));
    for (const actor of ["assistant", "mcp"]) {
      const refused = await refusal(
        invokeByName(
          "staffing.time.approve",
          { ids: [e.id] },
          tool(manager, NOW, { humanOnly: true, actor }),
        ),
      );
      expect(refused).toMatchObject({ code: "forbidden", details: { rule: "human_only" } });
      const read = await refusal(
        invokeByName(
          "staffing.time.differences",
          { from: "2026-09-28", to: "2026-09-28" },
          tool(manager, NOW, { humanOnly: true, actor }),
        ),
      );
      expect(read).toMatchObject({ code: "forbidden", details: { rule: "human_only" } });
    }
    // Not an approver: nothing decided, nobody else's time read.
    const colleague = await named("Cleaner B");
    for (const [name, input] of [
      ["approve", { ids: [e.id] }],
      ["reject", { id: e.id, why: "No" }],
      ["reopen", { id: e.id, why: "No" }],
      [
        "enterFor",
        {
          account: who.id,
          startsAt: "2026-09-28T14:00",
          endsAt: "2026-09-28T15:00",
          why: "Forgot",
        },
      ],
    ] as const) {
      expect((await refusal(call(name, input, colleague))).details).toMatchObject({
        rule: "rostering",
      });
    }
    expect(
      (
        await refusal(
          call("differences", { from: "2026-09-28", to: "2026-09-28", account: who.id }, colleague),
        )
      ).details,
    ).toMatchObject({ rule: "rostering" });
    // A person reads their own only: with no account, nothing of anyone else.
    const own = await call<Differences>(
      "differences",
      { from: "2026-09-28", to: "2026-09-28" },
      colleague,
    );
    expect(own.items).toEqual([]);
    const theirs = await call<Differences>("waiting", {}, who);
    expect(theirs.items.map((d) => d.entry?.id)).toEqual([e.id]);
    expect((await row(e.id))?.state).toBe("waiting");
  });

  it("nobody approves their own entry", async () => {
    const shift = await duty(manager, syd("2026-09-28T15:00"), syd("2026-09-28T17:00"));
    const e = await enter(manager, "2026-09-28T15:20", "2026-09-28T17:00", shiftRef(shift));
    for (const [name, input] of [
      ["approve", { ids: [e.id] }],
      ["reject", { id: e.id, why: "No" }],
    ] as const) {
      expect((await refusal(call(name, input, manager))).details).toMatchObject({
        rule: "own_time",
      });
    }
    // Someone else who approves does.
    const done = await call<{ approved: Entry[] }>("approve", { ids: [e.id] }, deputy);
    expect(done.approved[0]).toMatchObject({ state: "approved", approval: { by: "approver" } });
    expect((await row(e.id))?.approved_by).toBe(deputy.id);
  });
});

describe("approval on a match with the roster", () => {
  it("within the tolerance at both ends, the host approves it and says so", async () => {
    const who = await named("Cleaner C");
    const shift = await duty(who, syd("2026-09-29T09:00"), syd("2026-09-29T13:00"));
    await call("clockIn", { against: shiftRef(shift) }, who, syd("2026-09-29T09:04"));
    const done = await call("clockOut", { breakMinutes: 30 }, who, syd("2026-09-29T12:55"));
    expect(done.entry).toMatchObject({ state: "approved", approval: { by: "host" } });
    expect(await row(done.id)).toMatchObject({ approved_by: "host", state: "approved" });
    // Exactly five minutes late still matches; six does not.
    const late = await duty(who, syd("2026-09-30T09:00"), syd("2026-09-30T13:00"));
    const five = await enter(who, "2026-09-30T09:05", "2026-09-30T13:05", shiftRef(late));
    expect(five.entry.state).toBe("approved");
    const later = await duty(who, syd("2026-10-01T09:00"), syd("2026-10-01T13:00"));
    const six = await enter(who, "2026-10-01T09:06", "2026-10-01T13:00", shiftRef(later));
    expect(six.entry).toMatchObject({ state: "waiting", approval: null });
  });

  it("the tolerance is the business's setting", async () => {
    const who = await named("Cleaner D");
    const shift = await duty(who, syd("2026-09-29T09:00"), syd("2026-09-29T13:00"));
    await setting({ matchMinutes: 10 });
    try {
      const e = await enter(who, "2026-09-29T09:08", "2026-09-29T12:52", shiftRef(shift));
      expect(e.entry.state).toBe("approved");
      const w = await call<Differences>("waiting", {}, manager);
      expect(w.tolerance).toBe(10);
    } finally {
      await setting({});
    }
    const other = await duty(who, syd("2026-09-30T09:00"), syd("2026-09-30T13:00"));
    const e = await enter(who, "2026-09-30T09:08", "2026-09-30T12:52", shiftRef(other));
    expect(e.entry.state).toBe("waiting");
  });

  it("time with no shift, and an approver's entry for someone, always wait", async () => {
    const who = await named("Tradie E");
    const job = await create(JOB, { name: "Kitchen refit" });
    const onJob = await enter(who, "2026-09-29T09:00", "2026-09-29T12:00", {
      object: JOB,
      id: job,
    });
    const other = await enter(who, "2026-09-29T13:00", "2026-09-29T14:00", null);
    expect([onJob.entry.state, other.entry.state]).toEqual(["waiting", "waiting"]);
    const shift = await duty(who, syd("2026-09-30T09:00"), syd("2026-09-30T13:00"));
    const forThem = await call(
      "enterFor",
      {
        account: who.id,
        startsAt: "2026-09-30T09:00",
        endsAt: "2026-09-30T13:00",
        against: shiftRef(shift),
        why: "Their phone was flat",
      },
      manager,
    );
    expect(forThem.entry).toMatchObject({ state: "waiting", how: "by_approver" });
    expect(await row(forThem.id)).toMatchObject({ made_by: manager.id, account_id: who.id });
    // Its maker may approve it: it is not their own time.
    const done = await call<{ approved: Entry[] }>("approve", { ids: [forThem.id] }, manager);
    expect(done.approved[0]?.state).toBe("approved");
    // Never for themselves, and never against a shift that is not the person's.
    expect(
      (
        await refusal(
          call(
            "enterFor",
            {
              account: manager.id,
              startsAt: "2026-09-30T14:00",
              endsAt: "2026-09-30T15:00",
              why: "x",
            },
            manager,
          ),
        )
      ).details,
    ).toMatchObject({ rule: "own_time" });
  });
});

describe("approving, rejecting, reopening", () => {
  it("approved changed keeps the recorded times beside, and tells the person", async () => {
    const who = await named("Cleaner F");
    const shift = await duty(who, syd("2026-09-29T09:00"), syd("2026-09-29T13:00"));
    const e = await enter(who, "2026-09-29T08:30", "2026-09-29T13:20", shiftRef(shift), {
      breakMinutes: 10,
    });
    expect(e.entry.state).toBe("waiting");
    const done = await call<{ approved: Entry[] }>(
      "approve",
      {
        ids: [e.id],
        changes: [
          { id: e.id, startsAt: "2026-09-29T09:00", endsAt: "2026-09-29T13:00", breakMinutes: 0 },
        ],
      },
      manager,
    );
    expect(done.approved[0]).toMatchObject({
      state: "approved",
      startsAt: syd("2026-09-29T09:00"),
      endsAt: syd("2026-09-29T13:00"),
      minutes: 240,
      recorded: {
        startsAt: syd("2026-09-29T08:30"),
        endsAt: syd("2026-09-29T13:20"),
        breakMinutes: 10,
      },
      approval: { by: "approver" },
    });
    expect(await row(e.id)).toMatchObject({
      starts: instantOf("2026-09-29T09:00", ZONE),
      recorded_starts: instantOf("2026-09-29T08:30", ZONE),
      recorded_ends: instantOf("2026-09-29T13:20", ZONE),
      recorded_break_minutes: 10,
      approved_by: manager.id,
    });
    const notices = await told(who);
    expect(notices.map((n) => n.title)).toContain("Your recorded time was approved with changes");
    // Reopened and approved changed again: the first recorded times stay beside.
    await call("reopen", { id: e.id, why: "Check the start" }, manager);
    const again = await call<{ approved: Entry[] }>(
      "approve",
      { ids: [e.id], changes: [{ id: e.id, startsAt: "2026-09-29T08:45" }] },
      manager,
    );
    expect(again.approved[0]?.recorded?.startsAt).toBe(syd("2026-09-29T08:30"));
    expect(again.approved[0]?.reopenedWhy).toBeNull();
  });

  it("all or none: an entry that does not wait, or a change that overlaps, approves nothing", async () => {
    const who = await named("Cleaner G");
    const a = await enter(who, "2026-09-29T09:00", "2026-09-29T10:00", null);
    const b = await enter(who, "2026-09-29T11:00", "2026-09-29T12:00", null);
    const open = await call("clockIn", { against: null }, who, syd("2026-10-06T08:00"));
    const notWaiting = await refusal(call("approve", { ids: [a.id, open.id] }, manager));
    expect(notWaiting.details).toMatchObject({ rule: "time_not_waiting", entry: open.id });
    const overlaps = await refusal(
      call(
        "approve",
        { ids: [a.id, b.id], changes: [{ id: a.id, endsAt: "2026-09-29T11:30" }] },
        manager,
      ),
    );
    expect(overlaps).toMatchObject({ code: "conflict", details: { rule: "time_overlap" } });
    expect([(await row(a.id))?.state, (await row(b.id))?.state]).toEqual(["waiting", "waiting"]);
    // An entry whose finish is missing cannot be approved until one is entered.
    await env.DB.prepare("UPDATE core_time_entry SET finish_missing = 1 WHERE id = ?")
      .bind(open.id)
      .run();
    expect((await refusal(call("approve", { ids: [open.id] }, manager))).details).toMatchObject({
      rule: "finish_missing",
    });
  });

  it("rejected: the person is told (not why), corrects it, and it waits for an approver again", async () => {
    const who = await named("Cleaner H");
    const shift = await duty(who, syd("2026-09-29T09:00"), syd("2026-09-29T13:00"));
    const e = await enter(who, "2026-09-29T07:00", "2026-09-29T13:00", shiftRef(shift));
    const sent = await call("reject", { id: e.id, why: "You started at nine" }, manager);
    expect(sent.entry).toMatchObject({ state: "rejected", rejectedWhy: "You started at nine" });
    const notices = await told(who);
    const notice = notices.find((n) => n.title === "Your recorded time was sent back");
    expect(notice).toBeTruthy();
    expect(JSON.stringify(notice)).not.toContain("nine");
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit WHERE operation = 'staffing.time.reject' AND (input LIKE '%nine%' OR result LIKE '%nine%')",
    ).first<{ n: number }>();
    expect(audit?.n).toBe(0);
    // Rejected once more after a correction that still differs; then corrected to match: an
    // approver sent it back, so an approver decides it, never the host (the review of PR #417).
    const still = await call("edit", { id: e.id, startsAt: "2026-09-29T08:00" }, who);
    expect(still.entry).toMatchObject({ state: "waiting", rejectedWhy: null });
    await call("reject", { id: e.id, why: "Still not right" }, manager);
    const fixed = await call("edit", { id: e.id, startsAt: "2026-09-29T09:00" }, who);
    expect(fixed.entry).toMatchObject({ state: "waiting", approval: null });
    await call("approve", { ids: [e.id] }, manager);
    expect((await refusal(call("reject", { id: e.id, why: "x" }, manager))).details).toMatchObject({
      rule: "time_not_waiting",
    });
  });

  it("reopened while the period is open: it waits, and the host leaves it for an approver", async () => {
    const who = await named("Cleaner I");
    const shift = await duty(who, syd("2026-09-30T09:00"), syd("2026-09-30T13:00"));
    const e = await enter(who, "2026-09-30T09:00", "2026-09-30T13:00", shiftRef(shift));
    expect(e.entry.state).toBe("approved");
    const reopened = await call("reopen", { id: e.id, why: "They left early" }, manager);
    expect(reopened.entry).toMatchObject({
      state: "waiting",
      approval: null,
      reopenedWhy: "They left early",
    });
    // Corrected by the person to match the roster again: still waits for an approver.
    const edited = await call("edit", { id: e.id, breakMinutes: 15 }, who);
    expect(edited.entry.state).toBe("waiting");
    expect((await refusal(call("reopen", { id: e.id, why: "x" }, manager))).details).toMatchObject({
      rule: "time_not_approved",
    });
    await call("approve", { ids: [e.id] }, manager);
    // A locked pay period over it: nothing reopens.
    await env.DB.prepare(
      "INSERT INTO core_pay_period (id, start_date, end_date, zone, starts, ends, version, state, locked_by, locked_at) VALUES ('ppe_sep', '2026-09-30', '2026-09-30', ?, ?, ?, 1, 'locking', ?, ?)",
    )
      .bind(
        ZONE,
        instantOf("2026-09-30T00:00", ZONE),
        instantOf("2026-10-01T00:00", ZONE),
        admin.id,
        NOW,
      )
      .run();
    try {
      expect(
        (await refusal(call("reopen", { id: e.id, why: "Too late" }, manager))).details,
      ).toMatchObject({ rule: "pay_period_locked" });
    } finally {
      await env.DB.prepare(
        "UPDATE core_pay_period SET state = 'locked' WHERE id = 'ppe_sep'",
      ).run();
      await env.DB.prepare(
        "UPDATE core_pay_period SET state = 'reopened', reopened_by = ?, reopened_at = ?, reopen_reason = 'Done' WHERE id = 'ppe_sep'",
      )
        .bind(admin.id, NOW)
        .run();
    }
  });
});

describe("differences from the roster", () => {
  it("match a fixture worked out by hand", async () => {
    // Sydney is +10 until 02:00 on Sunday 4 October 2026, +11 after.
    const cleaner = await named("Hourly Cleaner");
    const coach = await named("Class Coach");
    const casual = await named("Not Counted");
    await byTime(cleaner);
    await byTime(coach, "by_class");
    // Thursday 1 October, 09:00 to 13:00 (23:00Z to 03:00Z): 08:57 to 13:03, within 5 minutes.
    const s1 = await duty(cleaner, "2026-09-30T23:00:00.000Z", "2026-10-01T03:00:00.000Z", "S1");
    // Friday 2 October, 09:00 to 13:00: 09:12 to 12:50, twelve late and ten early.
    const s2 = await duty(cleaner, "2026-10-01T23:00:00.000Z", "2026-10-02T03:00:00.000Z", "S2");
    // Saturday 3 October 22:00 (+10) to Sunday 06:00 (+11): seven hours across midnight and the
    // clock change (12:00Z to 19:00Z). 22:00 to 06:10: on time, ten late; 430 minutes.
    const s3 = await duty(cleaner, "2026-10-03T12:00:00.000Z", "2026-10-03T19:00:00.000Z", "S3");
    // Monday 5 October 09:00 to 13:00 (+11, 22:00Z to 02:00Z): nothing recorded.
    const s4 = await duty(cleaner, "2026-10-04T22:00:00.000Z", "2026-10-05T02:00:00.000Z", "S4");
    // Monday 15:00 to 16:00: marked not worked, so not flagged.
    const s5 = await duty(cleaner, "2026-10-05T04:00:00.000Z", "2026-10-05T05:00:00.000Z", "S5");
    await env.DB.prepare(
      "INSERT INTO core_staff_not_worked (object_type, record_id, starts, reason, marked_by, marked_at) VALUES (?, ?, ?, 'Closed', ?, ?)",
    )
      .bind(DUTY, s5, Date.parse("2026-10-05T04:00:00.000Z") / 1000, admin.id, NOW)
      .run();
    // Tuesday 6 October 15:00 to 17:00: not yet worked.
    await duty(cleaner, "2026-10-06T04:00:00.000Z", "2026-10-06T06:00:00.000Z", "S6");
    // The coach (by the class) and someone not counted: never flagged.
    await duty(coach, "2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z", "Class");
    await duty(casual, "2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z", "Casual");
    const job = await create(JOB, { name: "Office fit-out" });

    const e1 = await enter(cleaner, "2026-10-01T08:57", "2026-10-01T13:03", shiftRef(s1));
    const e2 = await enter(cleaner, "2026-10-02T09:12", "2026-10-02T12:50", shiftRef(s2));
    const e3 = await enter(cleaner, "2026-10-03T22:00", "2026-10-04T06:10", shiftRef(s3));
    // A job from Friday 14:00 to Saturday 03:00: thirteen hours.
    const e4 = await enter(cleaner, "2026-10-02T14:00", "2026-10-03T03:00", {
      object: JOB,
      id: job,
    });
    const e5 = await enter(cleaner, "2026-10-05T14:00", "2026-10-05T14:45", null);
    expect(e1.entry.state).toBe("approved");
    expect(e3.entry).toMatchObject({ minutes: 430, localDate: "2026-10-03" });

    const all = await call<Differences>(
      "differences",
      { from: "2026-10-01", to: "2026-10-06" },
      manager,
    );
    expect(all.tolerance).toBe(5);
    const people = new Set(all.items.map((d) => d.account));
    expect(people.has(coach.id)).toBe(false);
    expect(people.has(casual.id)).toBe(false);
    const theirs = all.items.filter((d) => d.account === cleaner.id);
    const shape = (d: Difference) => ({
      entry: d.entry?.id ?? null,
      shift: d.shift?.id ?? null,
      startMinutes: d.startMinutes,
      finishMinutes: d.finishMinutes,
      matches: d.matches,
      notRecorded: d.notRecorded,
      unrostered: d.unrostered,
      long: d.long,
    });
    expect(theirs.map(shape)).toEqual([
      {
        entry: e1.id,
        shift: s1,
        startMinutes: -3,
        finishMinutes: 3,
        matches: true,
        notRecorded: false,
        unrostered: false,
        long: false,
      },
      {
        entry: e2.id,
        shift: s2,
        startMinutes: 12,
        finishMinutes: -10,
        matches: false,
        notRecorded: false,
        unrostered: false,
        long: false,
      },
      {
        entry: e4.id,
        shift: null,
        startMinutes: null,
        finishMinutes: null,
        matches: false,
        notRecorded: false,
        unrostered: true,
        long: true,
      },
      {
        entry: e3.id,
        shift: s3,
        startMinutes: 0,
        finishMinutes: 10,
        matches: false,
        notRecorded: false,
        unrostered: false,
        long: false,
      },
      {
        entry: null,
        shift: s4,
        startMinutes: null,
        finishMinutes: null,
        matches: false,
        notRecorded: true,
        unrostered: false,
        long: false,
      },
      {
        entry: e5.id,
        shift: null,
        startMinutes: null,
        finishMinutes: null,
        matches: false,
        notRecorded: false,
        unrostered: true,
        long: false,
      },
    ]);
    expect(theirs[4]).toMatchObject({
      name: "Hourly Cleaner",
      shift: { title: "S4", startsAt: "2026-10-04T22:00:00.000Z" },
    });
    // The person reads the same of their own; what waits is the three that do not match.
    const own = await call<Differences>(
      "differences",
      { from: "2026-10-01", to: "2026-10-06" },
      cleaner,
    );
    expect(own.items.map(shape)).toEqual(theirs.map(shape));
    const waiting = await call<Differences>(
      "waiting",
      { from: "2026-10-01", to: "2026-10-06", account: cleaner.id },
      manager,
    );
    expect(waiting.items.map((d) => d.entry?.id)).toEqual([e2.id, e4.id, e3.id, e5.id]);
    // Recorded, the shift is no longer flagged; at most 62 days a read.
    await enter(cleaner, "2026-10-05T09:00", "2026-10-05T13:00", shiftRef(s4));
    const after = await call<Differences>(
      "differences",
      { from: "2026-10-05", to: "2026-10-05", account: cleaner.id },
      manager,
    );
    expect(after.items.some((d) => d.notRecorded)).toBe(false);
    expect(
      (await refusal(call("differences", { from: "2026-08-01", to: "2026-10-06" }, manager)))
        .details,
    ).toMatchObject({ field: "to" });
  });
});

describe("the review of PR #417", () => {
  it("an entry an approver sent back is never approved by the host, even with only its note changed", async () => {
    const who = await named("Cleaner R1");
    const shift = await duty(who, syd("2026-10-01T15:00"), syd("2026-10-01T17:00"));
    const e = await enter(who, "2026-10-01T15:00", "2026-10-01T17:00", shiftRef(shift));
    expect(e.entry.state).toBe("approved");
    // Reopened, then sent back: the person's note alone does not get it approved by the host.
    await call("reopen", { id: e.id, why: "You were not here" }, manager);
    await call("reject", { id: e.id, why: "You were not here at all" }, manager);
    const edited = await call("edit", { id: e.id, note: "I was" }, who);
    expect(edited.entry).toMatchObject({ state: "waiting", approval: null });
    expect((await row(e.id))?.approved_by).toBeNull();
    // A matching entry sent back with no reopen: the same.
    const other = await duty(who, syd("2026-10-02T15:00"), syd("2026-10-02T17:00"));
    const f = await enter(who, "2026-10-02T15:00", "2026-10-02T17:20", shiftRef(other));
    await call("reject", { id: f.id, why: "Check the finish" }, manager);
    const corrected = await call("edit", { id: f.id, endsAt: "2026-10-02T17:00" }, who);
    expect(corrected.entry.state).toBe("waiting");
  });

  it("an entry an approver reopened or sent back is not withdrawn and entered again", async () => {
    const who = await named("Cleaner R2");
    const shift = await duty(who, syd("2026-10-01T15:00"), syd("2026-10-01T17:00"));
    const e = await enter(who, "2026-10-01T15:00", "2026-10-01T17:00", shiftRef(shift));
    await call("reopen", { id: e.id, why: "Check it" }, manager);
    expect((await refusal(call("withdraw", { id: e.id }, who))).details).toMatchObject({
      rule: "time_held",
    });
    await call("reject", { id: e.id, why: "Not here" }, manager);
    expect((await refusal(call("withdraw", { id: e.id }, who))).details).toMatchObject({
      rule: "time_held",
    });
    expect(await row(e.id)).toBeTruthy();
    // An entry nobody has looked at is still the person's to withdraw.
    const g = await enter(who, "2026-10-02T15:00", "2026-10-02T16:00", null);
    expect(await call("withdraw", { id: g.id }, who)).toEqual({ id: g.id });
  });

  it("the differences say nothing about why: no note and no approver's reason", async () => {
    const who = await named("Cleaner R3");
    const e = await enter(who, "2026-10-01T15:00", "2026-10-01T16:00", null, {
      note: "doctor appointment",
    });
    const waiting = await call<Differences>("waiting", { account: who.id }, manager);
    expect(waiting.items[0]?.entry).toMatchObject({ id: e.id, note: "doctor appointment" });
    await call("reject", { id: e.id, why: "medical reason secret" }, manager);
    const read = await call<Differences>(
      "differences",
      { from: "2026-10-01", to: "2026-10-01", account: who.id },
      manager,
    );
    expect(read.items).toHaveLength(1);
    const text = JSON.stringify(read);
    expect(text).not.toContain("doctor");
    expect(text).not.toContain("secret");
    expect(read.items[0]?.entry).not.toHaveProperty("note");
    expect(read.items[0]?.entry).not.toHaveProperty("rejectedWhy");
    expect(read.items[0]?.entry).not.toHaveProperty("reopenedWhy");
  });

  it("the notices name no approver and no time", async () => {
    const who = await named("Cleaner R4");
    const a = await enter(who, "2026-10-01T15:00", "2026-10-01T16:00", null);
    const b = await enter(who, "2026-10-01T17:00", "2026-10-01T18:00", null);
    await call("reject", { id: a.id, why: "Wrong" }, deputy);
    await call(
      "approve",
      { ids: [b.id], changes: [{ id: b.id, endsAt: "2026-10-01T17:45" }] },
      deputy,
    );
    const notices = await told(who);
    expect(notices.map((n) => n.title)).toEqual([
      "Your recorded time was sent back",
      "Your recorded time was approved with changes",
    ]);
    const text = JSON.stringify(notices);
    for (const word of ["Deputy", "Dee", "15:00", "17:", "2026"]) expect(text).not.toContain(word);
  });

  it("times the person rewrites on an approver's entry for them are theirs, and still wait", async () => {
    const who = await named("Cleaner R5");
    const made = await call(
      "enterFor",
      {
        account: who.id,
        startsAt: "2026-10-01T09:00",
        endsAt: "2026-10-01T10:00",
        why: "Flat phone",
      },
      manager,
    );
    const rewritten = await call(
      "edit",
      { id: made.id, startsAt: "2026-10-01T06:00", endsAt: "2026-10-01T18:00" },
      who,
    );
    expect(rewritten.entry).toMatchObject({ how: "entered", state: "waiting" });
    expect(await row(made.id)).toMatchObject({
      how: "entered",
      how_why: null,
      made_by: who.id,
      held: "person",
    });
  });

  it("a correction after approval changed is what is recorded; a change of zone alone is refused", async () => {
    const who = await named("Cleaner R6");
    const e = await enter(who, "2026-10-01T08:00", "2026-10-01T12:00", null);
    await call(
      "approve",
      { ids: [e.id], changes: [{ id: e.id, startsAt: "2026-10-01T08:15" }] },
      manager,
    );
    await call("reopen", { id: e.id, why: "Check the start" }, manager);
    await call("edit", { id: e.id, startsAt: "2026-10-01T08:30" }, who);
    const done = await call<{ approved: Entry[] }>("approve", { ids: [e.id] }, manager);
    expect(done.approved[0]).toMatchObject({ startsAt: syd("2026-10-01T08:30"), recorded: null });
    expect(await row(e.id)).toMatchObject({ recorded_starts: null, recorded_ends: null });
    const f = await enter(who, "2026-10-02T08:00", "2026-10-02T12:00", null);
    expect(
      (
        await refusal(
          call("approve", { ids: [f.id], changes: [{ id: f.id, zone: "UTC" }] }, manager),
        )
      ).details,
    ).toMatchObject({ field: "changes" });
  });

  it("the tolerance is to the second: five minutes and one second late does not match", async () => {
    const who = await named("Cleaner R7");
    const shift = await duty(who, syd("2026-10-01T15:00"), syd("2026-10-01T17:00"));
    await call("clockIn", { against: shiftRef(shift) }, who, plus(syd("2026-10-01T15:05"), 1 / 60));
    const done = await call("clockOut", {}, who, syd("2026-10-01T17:00"));
    expect(done.entry.state).toBe("waiting");
    const read = await call<Differences>(
      "differences",
      { from: "2026-10-01", to: "2026-10-01", account: who.id },
      manager,
    );
    expect(read.items[0]).toMatchObject({ startMinutes: 6, finishMinutes: 0, matches: false });
    // With no tolerance, thirty seconds off is a difference too.
    const other = await duty(who, syd("2026-10-02T15:00"), syd("2026-10-02T17:00"));
    await setting({ matchMinutes: 0 });
    try {
      await call("clockIn", { against: shiftRef(other) }, who, plus(syd("2026-10-02T15:00"), 0.5));
      const late = await call("clockOut", {}, who, syd("2026-10-02T17:00"));
      expect(late.entry.state).toBe("waiting");
    } finally {
      await setting({});
    }
  });

  it("a finish the host marked missing, entered afterwards, waits for an approver", async () => {
    const who = await named("Cleaner R8");
    const shift = await duty(who, syd("2026-10-01T15:00"), syd("2026-10-01T17:00"));
    const start = await call("clockIn", { against: shiftRef(shift) }, who, syd("2026-10-01T15:00"));
    await env.DB.prepare("UPDATE core_time_entry SET finish_missing = 1 WHERE id = ?")
      .bind(start.id)
      .run();
    const fixed = await call("edit", { id: start.id, endsAt: "2026-10-01T17:00" }, who);
    expect(fixed.entry).toMatchObject({ state: "waiting", approval: null });
  });
});
