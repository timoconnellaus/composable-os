// Stage 58 step 1 (ADR 0850): time entries, the one record of time worked. Starting and finishing
// on the host's clock, one open entry per person (twenty starts at once leave one), a retried
// start with its key, entering time afterwards, correcting and withdrawing it, overlaps refused by
// the database for every statement shape, what an entry may be against (an own live shift, a live
// workedOn record, nothing), the finish-missing cron, and the workedOn declaration. Acceptance
// criteria 1 to 4. Every operation is called as a shipped pack's tool run would call it (the
// extension's account as `ctx.user`, the person as the verified caller). Every clock is injected.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, checkManifest, invokeByName, runStaffingDue } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, refusal } from "./helpers.ts";

const ext = extId("sttime");
const KIND = `${ext}.kind`;
const DUTY = `${ext}.duty`;
const JOB = `${ext}.job`;
const NOTE = `${ext}.note`;

/** The pack's objects: a duty shift (staffed), a job (workedOn) and a note (neither). */
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
        options: [
          { value: "scheduled", label: "Scheduled" },
          { value: "in_progress", label: "In progress" },
          { value: "done", label: "Done" },
        ],
      },
    },
    states: {
      field: "state",
      initial: "scheduled",
      moves: [
        { from: "scheduled", to: "in_progress", by: ["staff"] },
        { from: "in_progress", to: "done", by: ["staff"] },
      ],
    },
    workedOn: { live: ["scheduled", "in_progress"], title: "name", readers: `${ext}:jobs` },
  },
  note: {
    label: "Note",
    plural: "Notes",
    titleField: "name",
    fields: { name: { type: "text", label: "Name" } },
  },
};
const tools = {
  jobTime: {
    description: "Read the time recorded against a job",
    risk: "read",
    permission: `${ext}:jobs`,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  },
};
const fixture = manifest(ext, { objects } as never);

/** The installed manifest's parts the host reads: who rosters, and recording time. */
const installed = {
  grantable: [`${ext}:manage`],
  restricted: [`${ext}:manage`],
  settings: {
    recordsTime: { type: "boolean", label: "Staff record their time", default: false },
    enterDays: { type: "number", label: "Days back", default: 14 },
    finishMissingHours: { type: "number", label: "Finish missing after", default: 4 },
  },
  staffing: {
    rosters: `${ext}:manage`,
    settings: {
      recordsTime: "recordsTime",
      enterDays: "enterDays",
      finishMissingHours: "finishMissingHours",
    },
  },
};

const NOW = "2026-06-10T10:00:00.000Z";
const BEFORE = "2026-05-01T00:00:00.000Z";
const TIME = [
  "staffing.time.clockIn",
  "staffing.time.clockOut",
  "staffing.time.enter",
  "staffing.time.edit",
  "staffing.time.withdraw",
  "staffing.time.mine",
];

let admin: ActingUser;
let extUser: ActingUser;
type ToolFlags = { humanOnly?: boolean; actor?: string };
const tool = (user: ActingUser, now = NOW, flags: ToolFlags = { humanOnly: true }) =>
  context(extUser, {
    actor: "extension",
    clock: () => new Date(now),
    extension: {
      id: ext,
      permissions: { operations: TIME, objects: {} } as never,
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
  state: string;
  how: string;
  startsAt: string;
  endsAt: string | null;
  breakMinutes: number;
  minutes: number | null;
  localDate: string;
  against: { object: string; id: string; title: string; shift: boolean } | null;
  finishMissing: boolean;
};
type Answer = { id: string; entry: Entry; proposed?: boolean; replayed?: boolean };
const time = <T = Answer>(name: string, input: unknown, user: ActingUser, now = NOW) =>
  invokeByName(`staffing.time.${name}`, input, tool(user, now)) as Promise<T>;
async function create(object: string, values: Record<string, unknown>, now = BEFORE) {
  return (
    (await invokeByName(
      "record.create",
      { object, values },
      context(admin, { clock: () => new Date(now) }),
    )) as { id: string }
  ).id;
}
let kind: string;
async function duty(staff: ActingUser | null, startsAt: string, endsAt: string, name = "Duty") {
  return create(DUTY, { name, kind, staff: staff?.id ?? null, startsAt, endsAt });
}
async function rows(account: string) {
  return (
    await env.DB.prepare("SELECT * FROM core_time_entry WHERE account_id = ? ORDER BY starts")
      .bind(account)
      .all<Record<string, unknown>>()
  ).results;
}
async function setRecording(on: boolean) {
  await env.DB.prepare("UPDATE core_extension_settings SET value = ? WHERE extension_id = ?")
    .bind(JSON.stringify({ recordsTime: on }), ext)
    .run();
}
const s = (iso: string) => Date.parse(iso) / 1000;
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
    .bind(JSON.stringify("UTC"), BEFORE)
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
  kind = await create(KIND, { name: "Cleaning" });
}, 60_000);

describe("who records time", () => {
  it("only a shipped pack's tool: a person, MCP or the assistant calling directly gets none", async () => {
    for (const name of TIME) {
      expect((await refusal(invokeByName(name, {}, context(admin)))).code).toBe(
        "unknown_operation",
      );
    }
  });

  it("a person's own act: an assistant's or MCP's call is refused, whatever is granted", async () => {
    const who = await createUser("member");
    for (const actor of ["assistant", "mcp"]) {
      const e = await refusal(
        invokeByName("staffing.time.clockIn", {}, tool(who, NOW, { humanOnly: true, actor })),
      );
      expect(e).toMatchObject({ code: "forbidden", details: { rule: "human_only" } });
    }
    const e = await refusal(
      invokeByName("staffing.time.mine", {}, tool(who, NOW, { humanOnly: false })),
    );
    expect(e).toMatchObject({ code: "forbidden", details: { rule: "human_only" } });
    expect(await rows(who.id)).toHaveLength(0);
  });

  it("nobody records until the business switches recording on", async () => {
    const who = await createUser("member");
    await setRecording(false);
    try {
      const e = await refusal(time("clockIn", {}, who));
      expect(e).toMatchObject({ code: "conflict", details: { rule: "time_not_recorded" } });
    } finally {
      await setRecording(true);
    }
  });
});

describe("starting and finishing", () => {
  it("on the host's clock, proposing the shift under way; one open entry at a time", async () => {
    const cleaner = await createUser("member");
    const shift = await duty(cleaner, "2026-06-10T09:00:00.000Z", "2026-06-10T13:00:00.000Z");
    // A time in the request is never read.
    const start = await time(
      "clockIn",
      { startsAt: "2026-06-10T06:00:00.000Z", starts: 1 },
      cleaner,
      plus(NOW, 0),
    );
    expect(start.proposed).toBe(true);
    expect(start.entry).toMatchObject({
      state: "open",
      how: "clocked",
      startsAt: NOW,
      endsAt: null,
      localDate: "2026-06-10",
      against: { object: DUTY, id: shift, title: "Duty", shift: true },
    });
    const again = await refusal(time("clockIn", {}, cleaner, plus(NOW, 5)));
    expect(again).toMatchObject({ code: "conflict", details: { rule: "time_open" } });
    const mine = await time<{ open: Entry | null; proposed: unknown }>("mine", {}, cleaner);
    expect(mine.open?.id).toBe(start.id);
    expect(mine.proposed).toBeNull();
    const done = await time(
      "clockOut",
      { breakMinutes: 15, endsAt: "2026-06-10T23:00:00.000Z" },
      cleaner,
      plus(NOW, 185),
    );
    expect(done.entry).toMatchObject({
      id: start.id,
      state: "waiting",
      endsAt: plus(NOW, 185),
      breakMinutes: 15,
      minutes: 170,
    });
    const [row] = await rows(cleaner.id);
    expect(row).toMatchObject({ starts: s(NOW), ends: s(NOW) + 185 * 60, state: "waiting" });
    expect((await refusal(time("clockOut", {}, cleaner, plus(NOW, 190)))).details).toMatchObject({
      rule: "time_not_open",
    });
  });

  it("no shift near: nothing proposed; null is other work, a live job is a job", async () => {
    const who = await createUser("member");
    const later = await duty(who, "2026-06-10T16:00:00.000Z", "2026-06-10T18:00:00.000Z");
    const mine = await time<{ proposed: unknown }>("mine", {}, who);
    expect(mine.proposed).toBeNull();
    const other = await time("clockIn", {}, who);
    expect(other.proposed).toBe(false);
    expect(other.entry.against).toBeNull();
    await time("clockOut", {}, who, plus(NOW, 60));
    // Within 60 minutes of the next shift, it is proposed.
    const soon = await time<{ proposed: { id: string } | null }>(
      "mine",
      {},
      who,
      "2026-06-10T15:10:00.000Z",
    );
    expect(soon.proposed?.id).toBe(later);
    const job = await create(JOB, { name: "Kitchen refit" });
    const onJob = await time("clockIn", { against: { object: JOB, id: job } }, who, plus(NOW, 60));
    expect(onJob.entry.against).toEqual({
      object: JOB,
      id: job,
      title: "Kitchen refit",
      shift: false,
    });
    await time("clockOut", {}, who, plus(NOW, 120));
    const nothing = await time("clockIn", { against: null }, who, "2026-06-10T15:30:00.000Z");
    expect(nothing.entry.against).toBeNull();
  });

  it("a retried start with its key makes one entry", async () => {
    const who = await createUser("member");
    const key = "retry-0123456789abcdef";
    const first = await time("clockIn", { key }, who);
    const second = await time("clockIn", { key }, who, plus(NOW, 1));
    expect(second).toMatchObject({ id: first.id, replayed: true });
    expect(await rows(who.id)).toHaveLength(1);
  });

  it("twenty starts at once leave one open entry", async () => {
    const who = await createUser("member");
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => time("clockIn", {}, who)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toMatchObject({ code: "conflict", details: { rule: "time_open" } });
      }
    }
    expect(await rows(who.id)).toHaveLength(1);
  });
});

describe("what an entry is against", () => {
  it("refused against someone else's shift, a cancelled one, and a record that declares no workedOn", async () => {
    const who = await createUser("member");
    const other = await createUser("member");
    const theirs = await duty(other, "2026-06-10T09:00:00.000Z", "2026-06-10T12:00:00.000Z");
    expect(
      (await refusal(time("clockIn", { against: { object: DUTY, id: theirs } }, who))).details,
    ).toMatchObject({ rule: "not_your_shift" });
    // A colleague's cancelled or trashed shift is refused as theirs, saying nothing of its state.
    const theirsCancelled = await duty(
      other,
      "2026-06-10T13:00:00.000Z",
      "2026-06-10T14:00:00.000Z",
    );
    await invokeByName(
      "record.update",
      { object: DUTY, id: theirsCancelled, values: { state: "cancelled" } },
      context(admin, { clock: () => new Date(NOW) }),
    );
    const theirsTrashed = await duty(other, "2026-06-10T15:00:00.000Z", "2026-06-10T16:00:00.000Z");
    await invokeByName(
      "record.delete",
      { object: DUTY, id: theirsTrashed },
      context(admin, { clock: () => new Date(NOW) }),
    );
    for (const id of [theirsCancelled, theirsTrashed]) {
      expect(
        (await refusal(time("clockIn", { against: { object: DUTY, id } }, who))).details,
      ).toMatchObject({ rule: "not_your_shift" });
    }
    const mineShift = await duty(who, "2026-06-10T09:00:00.000Z", "2026-06-10T12:00:00.000Z");
    await invokeByName(
      "record.update",
      { object: DUTY, id: mineShift, values: { state: "cancelled" } },
      context(admin, { clock: () => new Date(NOW) }),
    );
    expect(
      (await refusal(time("clockIn", { against: { object: DUTY, id: mineShift } }, who))).details,
    ).toMatchObject({ rule: "shift_not_live" });
    const note = await create(NOTE, { name: "A note" });
    expect(
      (await refusal(time("clockIn", { against: { object: NOTE, id: note } }, who))).details,
    ).toMatchObject({ rule: "not_worked_on" });
    const job = await create(JOB, { name: "Done job" });
    for (const state of ["in_progress", "done"]) {
      await invokeByName(
        "record.update",
        { object: JOB, id: job, values: { state } },
        context(admin, { clock: () => new Date(NOW) }),
      );
    }
    expect(
      (await refusal(time("clockIn", { against: { object: JOB, id: job } }, who))).details,
    ).toMatchObject({ rule: "not_live" });
    const missing = await refusal(time("clockIn", { against: { object: JOB, id: "nope" } }, who));
    expect(missing.code).toBe("not_found");
    expect(await rows(who.id)).toHaveLength(0);
  });
});

describe("entering time afterwards", () => {
  it("in the past, up to the setting's days back, never overlapping, never in a locked period", async () => {
    const who = await createUser("member");
    const shift = await duty(who, "2026-06-08T08:00:00.000Z", "2026-06-08T12:00:00.000Z");
    const next = await duty(who, "2026-06-08T12:00:00.000Z", "2026-06-08T14:00:00.000Z", "Next");
    // Against the earlier shift, running into the next shift's rostered time: allowed.
    const entered = await time(
      "enter",
      {
        startsAt: "2026-06-08T08:05",
        endsAt: "2026-06-08T12:30",
        breakMinutes: 30,
        against: { object: DUTY, id: shift },
      },
      who,
    );
    expect(entered.entry).toMatchObject({
      state: "waiting",
      how: "entered",
      minutes: 235,
      localDate: "2026-06-08",
      against: { id: shift, shift: true },
    });
    // Back to back is allowed; an overlap is refused, naming the other entry.
    await time(
      "enter",
      {
        startsAt: "2026-06-08T12:30",
        endsAt: "2026-06-08T14:00",
        against: { object: DUTY, id: next },
      },
      who,
    );
    const overlap = await refusal(
      time("enter", { startsAt: "2026-06-08T12:00", endsAt: "2026-06-08T13:00" }, who),
    );
    expect(overlap).toMatchObject({
      code: "conflict",
      details: { rule: "time_overlap", entry: entered.id },
    });
    // Not finished yet; too far back; a break as long as the time; more than a day.
    for (const [input, field] of [
      [{ startsAt: "2026-06-10T09:00", endsAt: "2026-06-10T11:00" }, "endsAt"],
      [{ startsAt: "2026-05-20T09:00", endsAt: "2026-05-20T11:00" }, "startsAt"],
      [
        { startsAt: "2026-06-09T09:00", endsAt: "2026-06-09T10:00", breakMinutes: 60 },
        "breakMinutes",
      ],
      [{ startsAt: "2026-06-05T09:00", endsAt: "2026-06-06T10:00" }, "endsAt"],
    ] as const) {
      const e = await refusal(time("enter", input, who));
      expect(e).toMatchObject({ code: "invalid_input", details: { field } });
    }
    // A local time in another zone is read in that zone; the local date is the organisation's.
    const sydney = await time(
      "enter",
      { startsAt: "2026-06-09T08:00", endsAt: "2026-06-09T09:00", zone: "Australia/Sydney" },
      who,
    );
    expect(sydney.entry).toMatchObject({
      startsAt: "2026-06-08T22:00:00.000Z",
      localDate: "2026-06-08",
    });
    // A locked pay period takes no entry.
    await env.DB.prepare(
      "INSERT INTO core_pay_period (id, start_date, end_date, zone, starts, ends, version, state, locked_by, locked_at) VALUES ('ppe_time1', '2026-06-01', '2026-06-07', 'UTC', ?, ?, 1, 'locking', ?, ?)",
    )
      .bind(s("2026-06-01T00:00:00.000Z"), s("2026-06-08T00:00:00.000Z"), admin.id, NOW)
      .run();
    await env.DB.prepare(
      "UPDATE core_pay_period SET state = 'locked' WHERE id = 'ppe_time1'",
    ).run();
    // (A locked period is never deleted: it stays for the rest of this file, before its dates.)
    const locked = await refusal(
      time("enter", { startsAt: "2026-06-05T09:00", endsAt: "2026-06-05T10:00" }, who),
    );
    expect(locked.details).toMatchObject({ rule: "pay_period_locked" });
  });
});

describe("correcting and withdrawing", () => {
  it("own entries only, before approval; a rejected one corrected waits again", async () => {
    const who = await createUser("member");
    const other = await createUser("member");
    const e = await time(
      "enter",
      { startsAt: "2026-06-09T09:00", endsAt: "2026-06-09T12:00" },
      who,
    );
    expect((await refusal(time("edit", { id: e.id, breakMinutes: 10 }, other))).code).toBe(
      "not_found",
    );
    expect((await refusal(time("withdraw", { id: e.id }, other))).code).toBe("not_found");
    // Rejected (step 2's approver), then corrected: waiting again, the reason cleared.
    await env.DB.prepare(
      "UPDATE core_time_entry SET state = 'rejected', rejected_why = 'Wrong day' WHERE id = ?",
    )
      .bind(e.id)
      .run();
    const fixed = await time(
      "edit",
      { id: e.id, startsAt: "2026-06-09T10:00", endsAt: "2026-06-09T12:00", breakMinutes: 10 },
      who,
    );
    expect(fixed.entry).toMatchObject({ state: "waiting", minutes: 110 });
    const [row] = await rows(who.id);
    expect(row).toMatchObject({
      state: "waiting",
      rejected_why: null,
      starts: s("2026-06-09T10:00:00.000Z"),
    });
    // Approved: no longer theirs to change or withdraw.
    await env.DB.prepare("UPDATE core_time_entry SET state = 'approved' WHERE id = ?")
      .bind(e.id)
      .run();
    expect((await refusal(time("edit", { id: e.id, breakMinutes: 0 }, who))).details).toMatchObject(
      {
        rule: "time_approved",
      },
    );
    expect((await refusal(time("withdraw", { id: e.id }, who))).details).toMatchObject({
      rule: "time_approved",
    });
    await env.DB.prepare("UPDATE core_time_entry SET state = 'waiting' WHERE id = ?")
      .bind(e.id)
      .run();
    await time("withdraw", { id: e.id }, who);
    expect(await rows(who.id)).toHaveLength(0);
  });

  it("a clocked entry whose times are changed is entered; an open one keeps the host's start", async () => {
    const who = await createUser("member");
    const start = await time("clockIn", { against: null }, who);
    expect(
      (await refusal(time("edit", { id: start.id, startsAt: "2026-06-10T08:00" }, who))).details,
    ).toMatchObject({ field: "startsAt" });
    expect(
      (await refusal(time("edit", { id: start.id, endsAt: "2026-06-10T11:00" }, who))).details,
    ).toMatchObject({ field: "endsAt" });
    expect((await refusal(time("withdraw", { id: start.id }, who))).details).toMatchObject({
      rule: "time_open",
    });
    await time("clockOut", {}, who, plus(NOW, 60));
    const changed = await time(
      "edit",
      { id: start.id, endsAt: "2026-06-10T10:50" },
      who,
      plus(NOW, 70),
    );
    expect(changed.entry).toMatchObject({ how: "entered", minutes: 50, state: "waiting" });
  });
});

describe("a missing finish", () => {
  it("marked by the cron after the setting's hours past its shift, the person told, no finish written", async () => {
    const who = await createUser("member");
    await duty(who, "2026-06-11T09:00:00.000Z", "2026-06-11T13:00:00.000Z");
    const start = await time("clockIn", {}, who, "2026-06-11T08:58:00.000Z");
    expect(start.entry.against?.shift).toBe(true);
    // Three hours past the shift's end: nothing yet.
    await runStaffingDue(db, { clock: () => new Date("2026-06-11T16:00:00.000Z") });
    expect((await rows(who.id))[0]).toMatchObject({ finish_missing: 0 });
    const ran = await runStaffingDue(db, { clock: () => new Date("2026-06-11T17:00:00.000Z") });
    expect(ran.finishMissing).toBeGreaterThanOrEqual(1);
    expect((await rows(who.id))[0]).toMatchObject({ finish_missing: 1, ends: null, state: "open" });
    const told = await env.DB.prepare(
      "SELECT title, human_only FROM core_notifications WHERE user_id = ? AND title = 'Enter the time you finished'",
    )
      .bind(who.id)
      .all();
    expect(told.results).toHaveLength(1);
    // Again: marked once, told once.
    await runStaffingDue(db, { clock: () => new Date("2026-06-11T17:01:00.000Z") });
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM core_notifications WHERE user_id = ? AND title = 'Enter the time you finished'",
        )
          .bind(who.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    // The clock cannot finish it now; the person enters their real finish.
    expect(
      (await refusal(time("clockOut", {}, who, "2026-06-11T17:05:00.000Z"))).details,
    ).toMatchObject({ rule: "finish_missing" });
    const fixed = await time(
      "edit",
      { id: start.id, endsAt: "2026-06-11T13:05", breakMinutes: 20 },
      who,
      "2026-06-11T17:05:00.000Z",
    );
    // A finish the host marked missing, entered afterwards, waits for an approver even when it
    // matches the shift (ADR 0851).
    expect(fixed.entry).toMatchObject({ state: "waiting", finishMissing: false, minutes: 227 });
  });

  it("with no shift, 14 hours after its start", async () => {
    const who = await createUser("member");
    await time("clockIn", { against: null }, who, "2026-06-12T08:00:00.000Z");
    await runStaffingDue(db, { clock: () => new Date("2026-06-12T21:59:00.000Z") });
    expect((await rows(who.id))[0]).toMatchObject({ finish_missing: 0 });
    await runStaffingDue(db, { clock: () => new Date("2026-06-12T22:00:00.000Z") });
    expect((await rows(who.id))[0]).toMatchObject({ finish_missing: 1, ends: null });
  });
});

describe("the review's sequences (PR #364)", () => {
  /** A pay period locked as the lock writes it: made `locking`, then `locked`. */
  async function lock(id: string, start: string, end: string) {
    await env.DB.prepare(
      "INSERT INTO core_pay_period (id, start_date, end_date, zone, starts, ends, version, state, locked_by, locked_at) VALUES (?, ?, ?, 'UTC', ?, ?, 1, 'locking', ?, ?)",
    )
      .bind(
        id,
        start,
        end,
        s(`${start}T00:00:00.000Z`),
        s(`${end}T00:00:00.000Z`) + 86_400,
        admin.id,
        NOW,
      )
      .run();
    await env.DB.prepare("UPDATE core_pay_period SET state = 'locked' WHERE id = ?").bind(id).run();
  }

  it("a finish missing for longer than the days back can still be entered, or the entry withdrawn", async () => {
    const who = await createUser("member");
    const first = await time("clockIn", { against: null }, who, "2026-08-01T08:00:00.000Z");
    await runStaffingDue(db, { clock: () => new Date("2026-08-01T23:00:00.000Z") });
    expect((await rows(who.id))[0]).toMatchObject({ finish_missing: 1 });
    // Nineteen days later (the setting is 14): the real finish is taken.
    const fixed = await time(
      "edit",
      { id: first.id, endsAt: "2026-08-01T16:00" },
      who,
      "2026-08-20T09:00:00.000Z",
    );
    expect(fixed.entry).toMatchObject({ state: "waiting", minutes: 480, localDate: "2026-08-01" });
    // And another left open the same way may be withdrawn instead; then the clock starts again.
    const second = await time("clockIn", { against: null }, who, "2026-08-02T08:00:00.000Z");
    await runStaffingDue(db, { clock: () => new Date("2026-08-02T23:00:00.000Z") });
    await time("withdraw", { id: second.id }, who, "2026-08-21T09:00:00.000Z");
    const again = await time("clockIn", { against: null }, who, "2026-08-21T09:00:00.000Z");
    expect(again.entry.state).toBe("open");
    expect((await rows(who.id)).map((r) => r.id)).toEqual([first.id, again.id]);
  });

  it("the clock does not finish an entry inside a locked pay period", async () => {
    const who = await createUser("member");
    await time("clockIn", { against: null }, who, "2026-09-01T08:00:00.000Z");
    await lock("ppe_time2", "2026-09-01", "2026-09-07");
    const e = await refusal(time("clockOut", {}, who, "2026-09-01T12:00:00.000Z"));
    expect(e).toMatchObject({ code: "conflict", details: { rule: "pay_period_locked" } });
    expect((await rows(who.id))[0]).toMatchObject({ ends: null, state: "open" });
  });

  it("of two corrections at once, one is saved and the other fails: none answers what was not saved", async () => {
    const who = await createUser("member");
    const e = await time(
      "enter",
      { startsAt: "2026-06-09T13:00", endsAt: "2026-06-09T16:00" },
      who,
    );
    const results = await Promise.allSettled([
      time("edit", { id: e.id, breakMinutes: 10 }, who),
      time("edit", { id: e.id, breakMinutes: 50 }, who),
    ]);
    const saved = (await rows(who.id)).find((r) => r.id === e.id)?.break_minutes;
    const answered = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value.entry.breakMinutes] : [],
    );
    expect(answered).toEqual([saved]);
    for (const r of results) {
      if (r.status === "rejected") expect((r.reason as { code: string }).code).toBe("conflict");
    }
  });

  it("an entry against a shift given to someone else since is not corrected as this person's", async () => {
    const who = await createUser("member");
    const other = await createUser("member");
    const shift = await duty(who, "2026-06-09T08:00:00.000Z", "2026-06-09T10:00:00.000Z");
    const e = await time(
      "enter",
      {
        // Twenty minutes late, so it waits (one matching its shift is approved by the host).
        startsAt: "2026-06-09T08:20",
        endsAt: "2026-06-09T10:00",
        against: { object: DUTY, id: shift },
      },
      who,
    );
    expect(e.entry.state).toBe("waiting");
    await invokeByName(
      "record.update",
      { object: DUTY, id: shift, values: { staff: other.id } },
      context(admin, { clock: () => new Date(NOW) }),
    );
    const refused = await refusal(
      time("edit", { id: e.id, startsAt: "2026-06-09T08:15", endsAt: "2026-06-09T10:00" }, who),
    );
    expect(refused.details).toMatchObject({ rule: "not_your_shift" });
    // Said as other work, it is theirs to correct.
    const fixed = await time(
      "edit",
      { id: e.id, startsAt: "2026-06-09T08:15", endsAt: "2026-06-09T10:00", against: null },
      who,
    );
    expect(fixed.entry.against).toBeNull();
  });

  it("my time lists the open entry once", async () => {
    const who = await createUser("member");
    const start = await time("clockIn", { against: null }, who);
    const mine = await time<{ open: Entry | null; items: Entry[] }>("mine", {}, who, plus(NOW, 10));
    expect(mine.open?.id).toBe(start.id);
    expect(mine.items.map((i) => i.id)).not.toContain(start.id);
  });
});

describe("overlaps, refused by the database", () => {
  const insert = (verb: string, id: string, account: string, starts: number, ends: number | null) =>
    env.DB.prepare(
      `${verb} INTO core_time_entry (id, account_id, starts, ends, zone, local_date, how, state, made_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'UTC', '2026-06-01', 'entered', ?, ?, ?, ?)`,
    )
      .bind(id, account, starts, ends, ends === null ? "open" : "waiting", account, NOW, NOW)
      .run();
  const overlap = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => null,
      (x: unknown) => x,
    );
    expect(String(e)).toMatch(
      /core_time_overlap|core_time_open|UNIQUE constraint failed: core_time_entry/,
    );
  };
  const H = 3600;
  const T0 = s("2026-06-01T08:00:00.000Z");

  it("every statement shape: insert, replace, upsert, update and update or replace", async () => {
    const who = await createUser("member");
    const a = who.id;
    await insert("INSERT", "tme_a", a, T0, T0 + 2 * H);
    // Back to back, both sides.
    await insert("INSERT", "tme_b", a, T0 + 2 * H, T0 + 3 * H);
    await insert("INSERT", "tme_c", a, T0 - H, T0);
    await overlap(insert("INSERT", "tme_d", a, T0 + H, T0 + 4 * H));
    await overlap(insert("INSERT OR REPLACE", "tme_d", a, T0 + 30 * 60, T0 + H));
    // A REPLACE of a row by its own id may move it only where it overlaps nothing else.
    await overlap(insert("INSERT OR REPLACE", "tme_b", a, T0 + H, T0 + 3 * H));
    await insert("INSERT OR REPLACE", "tme_b", a, T0 + 2 * H, T0 + 150 * 60);
    // An upsert moving a row onto another's time.
    await overlap(
      env.DB.prepare(
        "INSERT INTO core_time_entry (id, account_id, starts, ends, zone, local_date, how, state, made_by, created_at, updated_at) VALUES ('tme_b', ?, ?, ?, 'UTC', '2026-06-01', 'entered', 'waiting', ?, ?, ?) ON CONFLICT (id) DO UPDATE SET starts = excluded.starts",
      )
        .bind(a, T0 + H, T0 + 150 * 60, a, NOW, NOW)
        .run(),
    );
    await overlap(
      env.DB.prepare("UPDATE core_time_entry SET starts = ? WHERE id = 'tme_b'")
        .bind(T0 + H)
        .run(),
    );
    await overlap(
      env.DB.prepare(
        "UPDATE OR REPLACE core_time_entry SET id = 'tme_c', starts = ? WHERE id = 'tme_b'",
      )
        .bind(T0 + H)
        .run(),
    );
    // An open entry runs on: it overlaps everything after its start, and a second one is refused.
    await insert("INSERT", "tme_open", a, T0 + 10 * H, null);
    await overlap(insert("INSERT", "tme_e", a, T0 + 20 * H, T0 + 21 * H));
    await insert("INSERT", "tme_f", a, T0 + 9 * H, T0 + 10 * H);
    await overlap(insert("INSERT", "tme_g", a, T0 + 30 * H, null));
    // A NULL id (a rowid table's TEXT key would take one) is refused, by insert and by update.
    const nullId = /NOT NULL constraint failed: core_time_entry\.id|core_time_overlap/;
    await expect(insert("INSERT", null as never, a, T0 + 30 * 60, T0 + H)).rejects.toThrow(nullId);
    await expect(
      env.DB.prepare("UPDATE core_time_entry SET id = NULL, starts = ? WHERE id = 'tme_b'")
        .bind(T0 + H)
        .run(),
    ).rejects.toThrow(nullId);
    // Another account's time is its own.
    const other = await createUser("member");
    await insert("INSERT", "tme_h", other.id, T0, T0 + 2 * H);
    expect(await rows(a)).toHaveLength(5);
  });
});

describe("the workedOn declaration", () => {
  const raw = (id: string) => ({
    id,
    version: "1.0.0",
    contractVersion: 1,
    objects: JSON.parse(JSON.stringify(objects).replaceAll(ext, id)),
    tools: JSON.parse(JSON.stringify(tools).replaceAll(ext, id)),
  });

  it("passes the contract, and its mistakes are named", () => {
    expect(validateManifest(raw("okwrk")).issues).toEqual([]);
    const broken = raw("badwrk");
    broken.objects.job.workedOn = {
      live: ["gone"],
      title: "missing",
      kind: "name",
      readers: "other:jobs",
    };
    broken.objects.note.workedOn = { live: ["x"], title: "name", readers: "badwrk:jobs" };
    broken.objects.duty.workedOn = {
      live: ["scheduled"],
      title: "name",
      readers: "badwrk:jobs",
      partOf: "kind",
    };
    const paths = validateManifest(broken).issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "objects.job.workedOn.live",
        "objects.job.workedOn.title",
        "objects.job.workedOn.kind",
        "objects.job.workedOn.readers",
        "objects.note.workedOn.live",
        "objects.duty.workedOn.partOf",
      ]),
    );
  });

  it("a staffed visit may be part of a job", () => {
    const m = raw("visit");
    m.objects.duty.fields.job = { type: "relation", label: "Job", to: "visit.job" };
    m.objects.duty.workedOn = {
      live: ["scheduled"],
      title: "name",
      readers: "visit:jobs",
      partOf: "job",
    };
    expect(validateManifest(m).issues).toEqual([]);
  });

  it("is refused to a runtime extension: time worked feeds pay", async () => {
    const id = extId("wrkrun");
    const result = await checkManifest(db.query, id, manifest(id, raw(id) as never), NOW, {
      source: "runtime",
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "outside_audience", path: "objects.job.workedOn" }),
      ]),
    );
  });
});
