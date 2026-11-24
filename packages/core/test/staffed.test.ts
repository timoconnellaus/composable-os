// Stage 45 step 2 (ADRs 0621 and 0622): the `staffed` behaviour on a fixture of classes (whose
// coach profile holds the staff account) and duty shifts (whose staff field is the account). One
// account is never on two overlapping shifts, refused by the database for every writer and every
// statement shape, with exactly one winner of fifty at once; back-to-back is allowed; the Trash,
// a cancel and a profile with no account claim nothing; a restore into a taken time is refused; a
// series' generation leaves a clashing date uncovered and a series change that would double-book
// is refused whole, naming the dates. Writes answer their warnings, which the audit row records,
// and staffing.check gives the same answer first. Every clock is injected.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  checkManifest,
  createInvoker,
  createRegistry,
  defineOperation,
  type ExtensionHost,
  getObject,
  installShippedExtensions,
  invoke,
  objectTableOf,
  PendingApprovalError,
  regularOverlaps,
  runRecurringDue,
} from "../src/index.ts";
import { extId, manifest, plan, reconcile } from "./extension-helpers.ts";
import { auditRows, context, createUser, db, setPreset } from "./helpers.ts";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((value) => ({
  value,
  label: value,
}));

const roster = (id: string, options: { staffed?: boolean } = {}) =>
  manifest(id, {
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
      series: {
        label: "Series",
        plural: "Series",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          weekdays: { type: "multiSelect", label: "Weekdays", options: WEEKDAYS },
          time: { type: "text", label: "Time" },
          length: { type: "number", label: "Length" },
          firstDate: { type: "date", label: "First date" },
          lastDate: { type: "date", label: "Last date" },
          timezone: { type: "timezone", label: "Time zone" },
          coach: { type: "relation", label: "Coach", to: `${id}.coach` },
          kind: { type: "relation", label: "Kind", to: `${id}.kind` },
        },
        recurring: {
          generates: "klass",
          link: "series",
          rule: {
            weekdays: "weekdays",
            time: "time",
            length: "length",
            from: "firstDate",
            until: "lastDate",
            zone: "timezone",
          },
          into: { starts: "startsAt", ends: "endsAt", zone: "timezone", changed: "changed" },
          copy: { coach: "coach", kind: "kind" },
          cancel: "cancelled",
          horizonDays: 21,
        },
      },
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          series: { type: "relation", label: "Series", to: `${id}.series`, readOnly: true },
          kind: { type: "relation", label: "Kind", to: `${id}.kind` },
          startsAt: { type: "datetime", label: "Starts at" },
          endsAt: { type: "datetime", label: "Ends at" },
          timezone: { type: "timezone", label: "Time zone" },
          coach: { type: "relation", label: "Coach", to: `${id}.coach` },
          changed: { type: "boolean", label: "Changed", readOnly: true },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "scheduled", label: "Scheduled" },
              { value: "cancelled", label: "Cancelled" },
              { value: "done", label: "Done" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "scheduled",
          moves: [
            { from: "scheduled", to: "cancelled", by: ["staff", "host"], final: true },
            { from: "scheduled", to: "done", by: ["staff", "host"], final: true },
          ],
        },
        ...(options.staffed === false
          ? {}
          : {
              staffed: {
                who: { field: "coach", account: "user" },
                starts: "startsAt",
                ends: "endsAt",
                zone: "timezone",
                kind: "kind",
                live: ["scheduled", "done"],
                pattern: { link: "series", who: "coach" },
              },
            }),
      },
      duty: {
        label: "Duty shift",
        plural: "Duty shifts",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          kind: { type: "relation", label: "Duty", to: `${id}.kind` },
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
          moves: [
            { from: "scheduled", to: "cancelled", by: ["staff"] },
            { from: "cancelled", to: "scheduled", by: ["staff"] },
          ],
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

const ext = extId("stf");
const COACH = `${ext}.coach`;
const KIND = `${ext}.kind`;
const SERIES = `${ext}.series`;
const KLASS = `${ext}.klass`;
const DUTY = `${ext}.duty`;

// The day before the shifts below: all of them fall inside the 14-day uncovered window.
const NOW = "2026-05-31T00:00:00.000Z";
let admin: ActingUser;
const as = (now = NOW) => context(admin, { clock: () => new Date(now) });

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(roster(ext));
}, 60_000);

const at = (day: string, time: string) => `2026-06-${day}T${time}:00.000Z`;

async function create(object: string, values: Record<string, unknown>, now = NOW) {
  return invoke("record.create", { object, values }, as(now));
}
async function update(object: string, id: string, values: Record<string, unknown>, now = NOW) {
  return invoke("record.update", { object, id, values }, as(now));
}

/** A staff account and its coach profile. */
async function coach(name = "Coach") {
  const user = await createUser("member");
  const profile = await create(COACH, { name, user: user.id });
  return { user, profile: profile.id as string };
}

async function claims(account: string) {
  const { results } = await env.DB.prepare(
    "SELECT object_type, record_id, starts, ends FROM core_staff_time WHERE account_id = ? ORDER BY starts",
  )
    .bind(account)
    .all<{ object_type: string; record_id: string; starts: number; ends: number }>();
  return results;
}

const column = (object: string, field: string) =>
  getObject(object)?.fields.find((f) => f.name === field)?.column as string;
const table = (object: string) => objectTableOf(object) as string;

const refused = { code: "conflict", details: { rule: "double_booked" } };

describe("the declaration", () => {
  it("passes the contract, and its mistakes are named", () => {
    expect(validateManifest(roster("okstf")).issues).toEqual([]);
    const broken = roster("badstf");
    const objects = broken.objects as Record<string, { staffed?: Record<string, unknown> }>;
    (objects.duty as { staffed: Record<string, unknown> }).staffed = {
      who: { field: "name" },
      starts: "name",
      ends: "endsAt",
      kind: "staff",
      live: ["gone"],
    };
    (objects.klass as { staffed: Record<string, unknown> }).staffed = {
      ...(objects.klass?.staffed ?? {}),
      who: { field: "coach", account: "name" },
      pattern: { link: "series", who: "kind" },
    };
    const paths = validateManifest(broken).issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "objects.duty.staffed.who.field",
        "objects.duty.staffed.starts",
        "objects.duty.staffed.kind",
        "objects.duty.staffed.live",
        "objects.klass.staffed.who.account",
        "objects.klass.staffed.pattern.who",
      ]),
    );
  });

  it("is refused to a runtime extension: who works when feeds pay", async () => {
    const id = extId("stfrun");
    const result = await checkManifest(db.query, id, roster(id), NOW, { source: "runtime" });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "outside_audience", path: "objects.duty.staffed" }),
      ]),
    );
  });

  it("builds the triggers and the person's index on the object's tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name = ? OR tbl_name = ?) ORDER BY name",
    )
      .bind(table(KLASS), table(COACH))
      .all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(
      [
        `${table(COACH)}__staffs_${table(KLASS)}_del`,
        `${table(COACH)}__staffs_${table(KLASS)}_ins`,
        `${table(COACH)}__staffs_${table(KLASS)}_upd`,
        `${table(KLASS)}__staffed_del`,
        `${table(KLASS)}__staffed_ins`,
        `${table(KLASS)}__staffed_upd`,
        // The pay lock (stage 45 step 6, ADR 0627), built and dropped with the claim's.
        `${table(COACH)}__paylock_${table(KLASS)}_del`,
        `${table(COACH)}__paylock_${table(KLASS)}_ins`,
        `${table(COACH)}__paylock_${table(KLASS)}_upd`,
        `${table(KLASS)}__paylock_del`,
        `${table(KLASS)}__paylock_mark`,
        `${table(KLASS)}__paylock_ins`,
        `${table(KLASS)}__paylock_upd`,
      ].sort(),
    );
  });
});

describe("double-booking is refused", () => {
  it("two classes, and a class and a duty, of one account overlapping; back-to-back is fine", async () => {
    const { user, profile } = await coach("Sam");
    const first = await create(KLASS, {
      name: "Strength",
      coach: profile,
      startsAt: at("01", "06:00"),
      endsAt: at("01", "07:00"),
    });
    expect(await claims(user.id)).toEqual([
      expect.objectContaining({ object_type: KLASS, record_id: first.id }),
    ]);
    // Another class over it: refused, naming the first.
    await expect(
      create(KLASS, {
        name: "Yoga",
        coach: profile,
        startsAt: at("01", "06:30"),
        endsAt: at("01", "07:30"),
      }),
    ).rejects.toMatchObject({
      ...refused,
      details: { rule: "double_booked", other: { id: first.id, title: "Strength" } },
    });
    // A duty of the same account over it: refused too (another object).
    await expect(
      create(DUTY, {
        name: "Clean",
        staff: user.id,
        startsAt: at("01", "06:45"),
        endsAt: at("01", "07:15"),
      }),
    ).rejects.toMatchObject(refused);
    // Back to back: 07:00 to 08:00 does not clash with 06:00 to 07:00.
    const next = await create(DUTY, {
      name: "Clean",
      staff: user.id,
      startsAt: at("01", "07:00"),
      endsAt: at("01", "08:00"),
    });
    expect((await claims(user.id)).map((c) => c.record_id)).toEqual([first.id, next.id]);
    // Moving the duty earlier, into the class: refused, and nothing changed.
    await expect(update(DUTY, next.id, { startsAt: at("01", "06:59") })).rejects.toMatchObject(
      refused,
    );
    expect((await claims(user.id))[1]?.starts).toBe(Date.parse(at("01", "07:00")) / 1000);
  });

  it("claims nothing for a cancelled or trashed shift, or a coach with no account", async () => {
    const { user, profile } = await coach("Ana");
    const visiting = (await create(COACH, { name: "Visiting" })).id as string;
    const klass = await create(KLASS, {
      name: "Pilates",
      coach: profile,
      startsAt: at("02", "06:00"),
      endsAt: at("02", "07:00"),
    });
    const other = await create(KLASS, {
      name: "Visitor's class",
      coach: visiting,
      startsAt: at("02", "06:00"),
      endsAt: at("02", "07:00"),
    });
    expect(other.warnings).toBeUndefined(); // Covered for members; nobody's time.
    await update(KLASS, klass.id, { state: "cancelled" });
    expect(await claims(user.id)).toEqual([]);
    // Free again: a duty at that time is fine, then the Trash frees it too.
    const duty = await create(DUTY, {
      name: "Open up",
      staff: user.id,
      startsAt: at("02", "06:00"),
      endsAt: at("02", "06:30"),
    });
    await invoke("record.delete", { object: DUTY, id: duty.id }, as());
    expect(await claims(user.id)).toEqual([]);
    // Something else takes the time; restoring the duty is refused as a double-booking.
    const taken = await create(DUTY, {
      name: "Stock take",
      staff: user.id,
      startsAt: at("02", "06:15"),
      endsAt: at("02", "06:45"),
    });
    await expect(
      invoke("record.restore", { object: DUTY, id: duty.id }, as()),
    ).rejects.toMatchObject({ ...refused, details: { other: { id: taken.id } } });
    await invoke("record.delete", { object: DUTY, id: taken.id }, as());
    await invoke("record.restore", { object: DUTY, id: duty.id }, as());
    expect((await claims(user.id)).map((c) => c.record_id)).toEqual([duty.id]);
  });

  it("a coach profile given an account takes its classes' time, refused when it clashes", async () => {
    const user = await createUser("member");
    const profile = (await create(COACH, { name: "Kai" })).id as string;
    const klass = await create(KLASS, {
      name: "Boxing",
      coach: profile,
      startsAt: at("03", "18:00"),
      endsAt: at("03", "19:00"),
    });
    await create(DUTY, {
      name: "Close",
      staff: user.id,
      startsAt: at("03", "18:30"),
      endsAt: at("03", "19:30"),
    });
    await expect(update(COACH, profile, { user: user.id })).rejects.toMatchObject({
      ...refused,
      details: { shift: { id: klass.id } },
    });
    const free = await createUser("member");
    await update(COACH, profile, { user: free.id });
    expect((await claims(free.id)).map((c) => c.record_id)).toEqual([klass.id]);
    // A coach changed on the class moves the claim.
    const { user: other, profile: otherProfile } = await coach("Lee");
    await update(KLASS, klass.id, { coach: otherProfile });
    expect(await claims(free.id)).toEqual([]);
    expect((await claims(other.id)).map((c) => c.record_id)).toEqual([klass.id]);
  });

  it("fifty writes at once that would each double-book one person leave exactly one", async () => {
    const user = await createUser("member");
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        create(DUTY, {
          name: `Rush ${i}`,
          staff: user.id,
          startsAt: at("04", `09:${String(i).padStart(2, "0")}`),
          endsAt: at("04", "11:00"),
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject(refused);
    }
    expect(await claims(user.id)).toHaveLength(1);
    // Fifty updates at once moving fifty other people's duties onto the same person.
    const target = await createUser("member");
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const owner = await createUser("member");
      const duty = await create(DUTY, {
        name: `Swap ${i}`,
        staff: owner.id,
        startsAt: at("05", "09:00"),
        endsAt: at("05", "10:00"),
      });
      ids.push(duty.id as string);
    }
    const moved = await Promise.allSettled(ids.map((id) => update(DUTY, id, { staff: target.id })));
    expect(moved.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await claims(target.id)).toHaveLength(1);
  });
});

describe("every actor", () => {
  it("refuses the assistant once approved, MCP and an import alike", async () => {
    const user = await createUser("member");
    const other = await createUser("member");
    const theirs = await create(DUTY, {
      name: "Theirs",
      staff: other.id,
      startsAt: at("06", "12:00"),
      endsAt: at("06", "13:00"),
    });
    // The assistant asks to put `user` on it while they are free; a person approves later.
    await setPreset("cautious");
    try {
      const assistant = context(admin, { actor: "assistant", clock: () => new Date(NOW) });
      const asked = await invoke(
        "record.update",
        { object: DUTY, id: theirs.id as string, values: { staff: user.id } },
        assistant,
      ).catch((e: unknown) => e);
      expect(asked).toBeInstanceOf(PendingApprovalError);
      // Meanwhile a person puts `user` on another duty at that time.
      await create(DUTY, {
        name: "Meanwhile",
        staff: user.id,
        startsAt: at("06", "12:30"),
        endsAt: at("06", "13:30"),
      });
      const decided = await invoke(
        "approval.approve",
        { actionIds: [(asked as PendingApprovalError).pending.actionId] },
        as(),
      ).catch((e: unknown) => e);
      expect(JSON.stringify(decided)).toContain("double_booked");
    } finally {
      await setPreset("balanced");
    }
    expect((await claims(other.id)).map((c) => c.record_id)).toEqual([theirs.id]);
    // MCP, with the writes applied directly.
    await setPreset("autonomous");
    try {
      const mcp = context(admin, { actor: "mcp", clock: () => new Date(NOW) });
      await expect(
        invoke(
          "record.update",
          { object: DUTY, id: theirs.id as string, values: { staff: user.id } },
          mcp,
        ),
      ).rejects.toMatchObject(refused);
    } finally {
      await setPreset("balanced");
    }
    // An import of a duty over it: refused whole.
    await expect(
      invoke(
        "record.import",
        {
          object: DUTY,
          records: [
            {
              key: "old-1",
              values: {
                name: "Imported",
                staff: user.id,
                startsAt: at("06", "12:15"),
                endsAt: at("06", "12:45"),
              },
            },
          ],
        },
        as(),
      ),
    ).rejects.toMatchObject(refused);
    expect(await claims(user.id)).toHaveLength(1);
  });
});

describe("every statement shape", () => {
  async function fixture() {
    const user = await createUser("member");
    const a = await create(DUTY, {
      name: "A",
      staff: user.id,
      startsAt: at("08", "06:00"),
      endsAt: at("08", "07:00"),
    });
    const b = await create(DUTY, {
      name: "B",
      staff: user.id,
      startsAt: at("08", "07:00"),
      endsAt: at("08", "08:00"),
    });
    return { user, a: a.id as string, b: b.id as string };
  }
  const run = (sql: string, ...binds: unknown[]) =>
    env.DB.prepare(sql)
      .bind(...binds)
      .run();
  const failsDoubleBooked = (p: Promise<unknown>) =>
    expect(p).rejects.toThrow(/core_staff_double_booked/);

  it("refuses an overlap written to the shift's own table, whatever the statement", async () => {
    const { user, a, b } = await fixture();
    const T = table(DUTY);
    const starts = column(DUTY, "startsAt");
    const ends = column(DUTY, "endsAt");
    const staff = column(DUTY, "staff");
    const state = column(DUTY, "state");
    // A plain update.
    await failsDoubleBooked(
      run(`UPDATE ${T} SET ${starts} = ? WHERE id = ?`, at("08", "06:30"), b),
    );
    // UPDATE OR REPLACE.
    await failsDoubleBooked(
      run(`UPDATE OR REPLACE ${T} SET ${starts} = ? WHERE id = ?`, at("08", "06:30"), b),
    );
    // INSERT OR REPLACE over an existing row.
    await failsDoubleBooked(
      run(
        `INSERT OR REPLACE INTO ${T} (id, created_at, updated_at, ${staff}, ${starts}, ${ends}, ${state}) VALUES (?, ?, ?, ?, ?, ?, 'scheduled')`,
        b,
        NOW,
        NOW,
        user.id,
        at("08", "06:30"),
        at("08", "07:30"),
      ),
    );
    // An upsert.
    await failsDoubleBooked(
      run(
        `INSERT INTO ${T} (id, created_at, updated_at, ${staff}, ${starts}, ${ends}, ${state}) VALUES (?, ?, ?, ?, ?, ?, 'scheduled') ON CONFLICT (id) DO UPDATE SET ${starts} = excluded.${starts}`,
        b,
        NOW,
        NOW,
        user.id,
        at("08", "06:30"),
        at("08", "08:00"),
      ),
    );
    // A new row.
    await failsDoubleBooked(
      run(
        `INSERT INTO ${T} (id, created_at, updated_at, ${staff}, ${starts}, ${ends}, ${state}) VALUES ('raw1', ?, ?, ?, ?, ?, 'scheduled')`,
        NOW,
        NOW,
        user.id,
        at("08", "06:10"),
        at("08", "06:20"),
      ),
    );
    // Back into a live state from cancelled, over the other: refused.
    await run(`UPDATE ${T} SET ${state} = 'cancelled' WHERE id = ?`, b);
    await run(`UPDATE ${T} SET ${starts} = ? WHERE id = ?`, at("08", "06:30"), b);
    await failsDoubleBooked(run(`UPDATE ${T} SET ${state} = 'scheduled' WHERE id = ?`, b));
    // An id update moves the claim with the row; nothing is left on the old id.
    await run(`UPDATE ${T} SET id = 'moved1' WHERE id = ?`, a);
    const held = await claims(user.id);
    expect(held.map((c) => c.record_id)).toEqual(["moved1"]);
    // Out of the Trash, over the other: refused.
    await run(`UPDATE ${T} SET deleted_at = ? WHERE id = 'moved1'`, NOW);
    await run(`UPDATE ${T} SET ${state} = 'scheduled' WHERE id = ?`, b);
    await failsDoubleBooked(run(`UPDATE ${T} SET deleted_at = NULL WHERE id = 'moved1'`));
    // A hard delete releases the claim.
    await run(`DELETE FROM ${T} WHERE id = ?`, b);
    expect(await claims(user.id)).toEqual([]);
  });

  it("refuses an overlap written to the claims themselves, whatever the statement", async () => {
    const { user, a, b } = await fixture();
    const s = Date.parse(at("08", "06:30")) / 1000;
    await failsDoubleBooked(
      run(
        "INSERT INTO core_staff_time (object_type, record_id, account_id, starts, ends) VALUES ('x', 'y', ?, ?, ?)",
        user.id,
        s,
        s + 600,
      ),
    );
    await failsDoubleBooked(
      run(
        "INSERT OR REPLACE INTO core_staff_time (object_type, record_id, account_id, starts, ends) VALUES (?, ?, ?, ?, ?)",
        DUTY,
        b,
        user.id,
        s,
        s + 600,
      ),
    );
    await failsDoubleBooked(
      run(
        "INSERT INTO core_staff_time (object_type, record_id, account_id, starts, ends) VALUES (?, ?, ?, ?, ?) ON CONFLICT (object_type, record_id) DO UPDATE SET starts = excluded.starts",
        DUTY,
        b,
        user.id,
        s,
        s + 3600,
      ),
    );
    await failsDoubleBooked(
      run(
        "UPDATE OR REPLACE core_staff_time SET starts = ? WHERE object_type = ? AND record_id = ?",
        s,
        DUTY,
        b,
      ),
    );
    // A key change onto another account's row: still checked against the account's time.
    const other = await createUser("member");
    await run(
      "INSERT INTO core_staff_time (object_type, record_id, account_id, starts, ends) VALUES ('x', 'z', ?, ?, ?)",
      other.id,
      s,
      s + 60,
    );
    await failsDoubleBooked(
      run(
        "UPDATE core_staff_time SET account_id = ? WHERE object_type = 'x' AND record_id = 'z'",
        user.id,
      ),
    );
    await run("DELETE FROM core_staff_time WHERE object_type = 'x'");
    expect((await claims(user.id)).map((c) => c.record_id).sort()).toEqual([a, b].sort());
  });

  it("follows the coach profile holding the account, whatever the statement", async () => {
    const { user, profile } = await coach("Mo");
    const klass = await create(KLASS, {
      name: "Spin",
      coach: profile,
      startsAt: at("09", "06:00"),
      endsAt: at("09", "07:00"),
    });
    const other = await createUser("member");
    await create(DUTY, {
      name: "Desk",
      staff: other.id,
      startsAt: at("09", "06:30"),
      endsAt: at("09", "07:30"),
    });
    const C = table(COACH);
    const userColumn = column(COACH, "user");
    await failsDoubleBooked(
      run(`UPDATE ${C} SET ${userColumn} = ? WHERE id = ?`, other.id, profile),
    );
    await failsDoubleBooked(
      run(
        `INSERT OR REPLACE INTO ${C} (id, created_at, updated_at, name, ${userColumn}) VALUES (?, ?, ?, 'Mo', ?)`,
        profile,
        NOW,
        NOW,
        other.id,
      ),
    );
    // The profile's id changed: its classes no longer name it, so they claim nobody.
    await run(`UPDATE ${C} SET id = 'gone1' WHERE id = ?`, profile);
    expect(await claims(user.id)).toEqual([]);
    await run(`UPDATE ${C} SET id = ? WHERE id = 'gone1'`, profile);
    expect((await claims(user.id)).map((c) => c.record_id)).toEqual([klass.id]);
    // Deleted for good: its classes claim nobody.
    await run(`DELETE FROM ${C} WHERE id = ?`, profile);
    expect(await claims(user.id)).toEqual([]);
  });
});

describe("patterns", () => {
  /** The minute cron at `now`, until nothing is due. */
  async function tick(now: string) {
    for (let i = 0; i < 20; i += 1) {
      const result = await runRecurringDue(db, { clock: () => new Date(now) });
      if (result.series === 0) break;
    }
  }
  async function classesOf(series: string) {
    const page = await invoke(
      "record.list",
      { object: KLASS, filter: { field: "series", op: "eq", value: series }, limit: 100 },
      as(),
    );
    return page.items
      .map((r): Record<string, unknown> & { id: string } => ({ ...r.values, id: r.id }))
      .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
  }

  it("generation leaves a date that would clash uncovered, kept as its own, and fails nothing", async () => {
    const { user, profile } = await coach("Pat");
    // A one-off duty on the second Monday at the class's time.
    await create(DUTY, {
      name: "Inventory",
      staff: user.id,
      startsAt: at("08", "06:30"),
      endsAt: at("08", "07:30"),
    });
    const series = await create(SERIES, {
      name: "Mondays",
      weekdays: ["mon"],
      time: "06:00",
      length: 60,
      firstDate: "2026-06-01",
      timezone: "UTC",
      coach: profile,
    });
    await tick(NOW);
    const made = await classesOf(series.id as string);
    expect(made.map((c) => [String(c.startsAt).slice(0, 10), c.coach])).toEqual([
      ["2026-06-01", profile],
      ["2026-06-08", null],
      ["2026-06-15", profile],
    ]);
    const { results } = await env.DB.prepare(
      "SELECT field FROM core_recurrence_exception WHERE record_id = ?",
    )
      .bind(made[1]?.id)
      .all<{ field: string }>();
    expect(results).toEqual([{ field: "coach" }]);
    expect(await claims(user.id)).toHaveLength(3); // Two classes and the duty.
  });

  it("a series change that would double-book on any date is refused whole, naming the dates", async () => {
    const first = await coach("Jo");
    const second = await coach("Rae");
    const series = await create(SERIES, {
      name: "Wednesdays",
      weekdays: ["wed"],
      time: "18:00",
      length: 60,
      firstDate: "2026-06-03",
      timezone: "UTC",
      coach: first.profile,
    });
    await tick(NOW);
    expect((await classesOf(series.id as string)).map((c) => c.coach)).toEqual([
      first.profile,
      first.profile,
      first.profile,
    ]);
    await create(DUTY, {
      name: "Late clean",
      staff: second.user.id,
      startsAt: at("10", "18:30"),
      endsAt: at("10", "19:30"),
    });
    await expect(
      update(SERIES, series.id as string, { coach: second.profile }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { rule: "double_booked", dates: ["2026-06-10"] },
    });
    expect((await classesOf(series.id as string)).map((c) => c.coach)).toEqual([
      first.profile,
      first.profile,
      first.profile,
    ]);
    // A coach swapped on that date by hand (a field exception) settles it; the change then goes.
    const made = await classesOf(series.id as string);
    await update(KLASS, made[1]?.id as string, { coach: null });
    await update(SERIES, series.id as string, { coach: second.profile });
    expect((await classesOf(series.id as string)).map((c) => c.coach)).toEqual([
      second.profile,
      null,
      second.profile,
    ]);
    // "Back to the pattern" on that date would double-book: refused.
    await expect(
      invoke("recurring.follow", { object: KLASS, id: made[1]?.id as string }, as()),
    ).rejects.toMatchObject(refused);
  });
});

describe("warnings", () => {
  async function kind(name: string) {
    return (await create(KIND, { name })).id as string;
  }
  async function qualify(account: string, kindId: string) {
    await env.DB.prepare(
      "INSERT INTO core_staff_qualification (account_id, kind_object, kind_record, set_by, set_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(account, KIND, kindId, admin.id, NOW)
      .run();
  }
  async function away(account: string, values: Record<string, string | null>) {
    const id = `away${Math.random().toString(36).slice(2)}`;
    const columns = Object.keys(values);
    await env.DB.prepare(
      `INSERT INTO core_staff_away (id, account_id, set_by, set_at, ${columns.join(", ")}) VALUES (?, ?, ?, ?, ${columns.map(() => "?").join(", ")})`,
    )
      .bind(id, account, admin.id, NOW, ...Object.values(values))
      .run();
  }
  const codes = (record: { warnings?: { code: string }[] }) =>
    (record.warnings ?? []).map((w) => w.code).sort();

  it("answers not qualified, away and uncovered, and the audit row records them", async () => {
    const strength = await kind("Strength");
    const { user, profile } = await coach("Vi");
    // Nobody is marked qualified for any kind yet: the business has not set it up, no warning.
    const made = await create(KLASS, {
      name: "Strength",
      kind: strength,
      coach: profile,
      startsAt: at("11", "06:00"),
      endsAt: at("11", "07:00"),
    });
    expect(codes(made)).toEqual([]);
    // Someone else is marked for another kind: now an unmarked coach is warned.
    const other = await createUser("member");
    await qualify(other.id, await kind("Boxing"));
    const again = await update(KLASS, made.id as string, { startsAt: at("11", "06:05") });
    expect(codes(again)).toEqual(["not_qualified"]);
    await qualify(user.id, strength);
    await away(user.id, {
      kind: "leave",
      starts_at: "2026-06-12T00:00:00.000Z",
      ends_at: "2026-06-14T00:00:00.000Z",
      zone: "UTC",
    });
    const moved = await update(KLASS, made.id as string, {
      startsAt: at("12", "06:00"),
      endsAt: at("12", "07:00"),
    });
    expect(codes(moved)).toEqual(["unavailable"]);
    // A write that does not touch who, when, what or the state warns of nothing.
    expect(codes(await update(KLASS, made.id as string, { name: "Strength 2" }))).toEqual([]);
    // Left with nobody, within the window.
    const left = await update(KLASS, made.id as string, { coach: null });
    expect(left.warnings).toEqual([
      expect.objectContaining({ code: "uncovered", object: KLASS, id: made.id, account: null }),
    ]);
    // Beyond the 14-day window: nothing.
    const later = await create(KLASS, {
      name: "Far off",
      startsAt: "2026-08-01T06:00:00.000Z",
      endsAt: "2026-08-01T07:00:00.000Z",
    });
    expect(later.warnings).toBeUndefined();
    const rows = await auditRows("record.update", admin.id);
    const summary = JSON.parse(String(rows.at(-1)?.result)) as {
      records: { id: string; warnings?: { code: string }[] }[];
    };
    expect(summary.records[0]).toMatchObject({ id: made.id, warnings: [{ code: "uncovered" }] });
  });

  it("tells that someone is away only to them and to an admin, never to other staff", async () => {
    const pilates = await kind("Pilates");
    const { user, profile } = await coach("Noa");
    await qualify(user.id, pilates);
    await away(user.id, {
      kind: "leave",
      starts_at: "2026-06-12T00:00:00.000Z",
      ends_at: "2026-06-13T00:00:00.000Z",
      zone: "UTC",
    });
    const member = await createUser("member");
    const asMember = context(member, { clock: () => new Date(NOW) });
    const theirs = await invoke(
      "record.create",
      {
        object: KLASS,
        values: {
          name: "Pilates",
          kind: pilates,
          coach: profile,
          startsAt: at("12", "09:00"),
          endsAt: at("12", "10:00"),
        },
      },
      asMember,
    );
    expect(codes(theirs)).toEqual([]);
    // The person themselves, writing their own duty: told.
    const own = await invoke(
      "record.create",
      {
        object: DUTY,
        values: {
          name: "Own",
          staff: user.id,
          startsAt: at("12", "11:00"),
          endsAt: at("12", "12:00"),
        },
      },
      context(user, { clock: () => new Date(NOW) }),
    );
    expect(codes(own)).toEqual(["unavailable"]);
    // An admin: told.
    const moved = await update(KLASS, theirs.id as string, { startsAt: at("12", "08:00") });
    expect(codes(moved)).toEqual(["unavailable"]);
  });

  it("refuses a live shift that ends at or before it starts, whoever writes it", async () => {
    const user = await createUser("member");
    await expect(
      create(DUTY, {
        name: "Backwards",
        staff: user.id,
        startsAt: at("14", "08:00"),
        endsAt: at("14", "07:00"),
      }),
    ).rejects.toMatchObject({ code: "invalid_input", details: { rule: "staffed_time" } });
    const duty = await create(DUTY, {
      name: "Forwards",
      staff: user.id,
      startsAt: at("14", "07:00"),
      endsAt: at("14", "08:00"),
    });
    await expect(
      env.DB.prepare(`UPDATE ${table(DUTY)} SET ${column(DUTY, "endsAt")} = ? WHERE id = ?`)
        .bind(at("14", "07:00"), duty.id)
        .run(),
    ).rejects.toThrow(/core_staff_time_backwards/);
    // Cancelled, it is no shift: its times are not checked.
    await update(DUTY, duty.id as string, { state: "cancelled" });
    await update(DUTY, duty.id as string, { endsAt: at("14", "06:00") });
  });

  // The review of PR #336, finding 1: a time no clock can read claimed nothing, so the shift could
  // sit over another of its person's. Refused at write, and by the trigger past the operations.
  it("refuses a live shift whose time cannot be read, whoever writes it", async () => {
    const user = await createUser("member");
    await create(DUTY, {
      name: "Held",
      staff: user.id,
      startsAt: at("16", "07:00"),
      endsAt: at("16", "08:00"),
    });
    await expect(
      create(DUTY, {
        name: "Unreadable",
        staff: user.id,
        startsAt: at("16", "07:10"),
        endsAt: "2026-06-16T99:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const duty = await create(DUTY, {
      name: "Later",
      staff: user.id,
      startsAt: at("16", "09:00"),
      endsAt: at("16", "10:00"),
    });
    await expect(
      env.DB.prepare(
        `UPDATE ${table(DUTY)} SET ${column(DUTY, "startsAt")} = ?, ${column(DUTY, "endsAt")} = ? WHERE id = ?`,
      )
        .bind(at("16", "07:10"), "2026-06-16T09:75Z", duty.id)
        .run(),
    ).rejects.toThrow(/core_staff_time_unreadable/);
    expect(await claims(user.id)).toHaveLength(2);
  });

  it("checks a regular unavailability by wall clock, across a clock change", () => {
    const rule = {
      weekdays: "wed",
      start_time: "13:00",
      end_time: "17:00",
      from_date: "2026-03-01",
      until_date: null,
      zone: "Australia/Sydney",
    };
    const s = (iso: string) => Date.parse(iso) / 1000;
    // Wednesday 1 April (AEDT, +11): 13:00 local is 02:00Z.
    expect(regularOverlaps(rule, s("2026-04-01T02:30:00Z"), s("2026-04-01T03:30:00Z"))).toBe(true);
    // Wednesday 8 April (AEST, +10 after the change): 13:00 local is 03:00Z; 02:30Z is 12:30.
    expect(regularOverlaps(rule, s("2026-04-08T02:00:00Z"), s("2026-04-08T03:00:00Z"))).toBe(false);
    expect(regularOverlaps(rule, s("2026-04-08T03:00:00Z"), s("2026-04-08T04:00:00Z"))).toBe(true);
    // A Thursday: nothing; before the first date: nothing.
    expect(regularOverlaps(rule, s("2026-04-09T03:00:00Z"), s("2026-04-09T04:00:00Z"))).toBe(false);
    expect(regularOverlaps(rule, s("2026-02-25T03:00:00Z"), s("2026-02-25T04:00:00Z"))).toBe(false);
    // Overnight: 22:00 to 06:00 reaches into Thursday morning.
    const night = { ...rule, start_time: "22:00", end_time: "06:00" };
    expect(regularOverlaps(night, s("2026-04-08T19:00:00Z"), s("2026-04-08T19:30:00Z"))).toBe(true);
  });

  it("staffing.check gives the same answer first, and only to a shipped pack's tool", async () => {
    const yoga = await kind("Yoga");
    const { user, profile } = await coach("Ben");
    const klass = await create(KLASS, {
      name: "Yoga",
      kind: yoga,
      startsAt: at("13", "06:00"),
      endsAt: at("13", "07:00"),
    });
    await away(user.id, {
      kind: "regular",
      weekdays: "sat",
      start_time: "05:00",
      end_time: "09:00",
      from_date: "2026-06-01",
      zone: "UTC",
    });
    const busy = await create(DUTY, {
      name: "Busy",
      staff: user.id,
      startsAt: at("13", "06:30"),
      endsAt: at("13", "07:30"),
    });
    await env.DB.prepare(
      "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', '{}', ?, ?, ?)",
    )
      .bind(ext, admin.id, NOW, NOW)
      .run();
    // As in the runtime: the run's calls act as the extension's account, for the admin who called
    // the tool (`calledBy`): the admin, a rosterer, learns that the person is away.
    const extAccount = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
      .bind(extAccount.id)
      .run();
    const tool = context(extAccount, {
      actor: "extension",
      clock: () => new Date(NOW),
      extension: {
        id: ext,
        permissions: { operations: ["staffing.check"], objects: {} } as never,
        tool: {
          name: "check",
          humanOnly: false,
          permission: null,
          calledBy: { account: admin.id, actor: "human" },
        },
      },
    });
    const checked = await invoke(
      "staffing.check",
      { object: KLASS, id: klass.id as string, account: user.id },
      tool,
    );
    expect(checked.warnings.map((w) => w.code).sort()).toEqual(["not_qualified", "unavailable"]);
    expect(checked.clash).toMatchObject({ id: busy.id, title: "Busy" });
    const empty = await invoke("staffing.check", { object: KLASS, id: klass.id as string }, tool);
    expect(empty.warnings.map((w) => w.code)).toEqual(["uncovered"]);
    // The write itself: refused for the clash; then, the duty moved, made with the same warnings.
    await expect(update(KLASS, klass.id as string, { coach: profile })).rejects.toMatchObject(
      refused,
    );
    await update(DUTY, busy.id as string, { startsAt: at("13", "07:00") });
    const written = await update(KLASS, klass.id as string, { coach: profile });
    expect(codes(written)).toEqual(["not_qualified", "unavailable"]);
    // A person, MCP or the assistant calling it directly: no such operation.
    await expect(
      invoke("staffing.check", { object: KLASS, id: klass.id as string }, as()),
    ).rejects.toMatchObject({ code: "unknown_operation" });
  });
});

describe("installing over records that already clash", () => {
  it("is refused for shifts not yet ended, naming them; past clashes are reported and skipped", async () => {
    const id = extId("stfimp");
    await reconcile(roster(id, { staffed: false }), NOW);
    const user = await createUser("member");
    const profile = (await create(`${id}.coach`, { name: "Imported", user: user.id })).id;
    const one = await create(`${id}.klass`, {
      name: "One",
      coach: profile,
      startsAt: at("15", "06:00"),
      endsAt: at("15", "07:00"),
    });
    await create(`${id}.klass`, {
      name: "Two",
      coach: profile,
      startsAt: at("15", "06:30"),
      endsAt: at("15", "07:30"),
    });
    const planned = await plan(roster(id), NOW);
    expect(planned.issues).toEqual([
      expect.objectContaining({ code: "staffed_conflict", path: "objects.klass.staffed" }),
    ]);
    expect(planned.issues[0]?.message).toContain("One (2026-06-15 06:00 UTC)");
    expect(planned.issues[0]?.message).toContain("Two (2026-06-15 06:30 UTC)");
    // Once both have ended: installed; the later one claims no time, and the plan says so.
    const later = "2026-07-01T00:00:00.000Z";
    const installed = await reconcile(roster(id), later);
    expect(installed.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skip_claims",
          detail: expect.stringContaining("Two (2026-06-15 06:30 UTC)"),
        }),
      ]),
    );
    expect((await claims(user.id)).map((c) => c.record_id)).toEqual([one.id]);
    // A claim a raw REPLACE left behind (its row gone) is healed by the next reconcile.
    await env.DB.prepare(
      "INSERT INTO core_staff_time (object_type, record_id, account_id, starts, ends) VALUES (?, 'gone', ?, 1, 2)",
    )
      .bind(`${id}.klass`, user.id)
      .run();
    await reconcile(roster(id), later);
    expect((await claims(user.id)).map((c) => c.record_id)).toEqual([one.id]);
    await reconcile(roster(id, { staffed: false }), later);
    expect(await claims(user.id)).toEqual([]);
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name = ? OR tbl_name = ?)",
    )
      .bind(`x_${id}_klass`, `x_${id}_coach`)
      .all();
    expect(results).toEqual([]);
  });

  it("tells the admins when a shipped extension cannot be upgraded", async () => {
    const host = {
      shipped: async () => [{ id: "stfbroken", optional: false }],
      commitShipped: async () => {
        throw new Error("these shifts put one person on two at once");
      },
    } as unknown as ExtensionHost;
    const results = await installShippedExtensions({ db, host });
    expect(results).toEqual([expect.objectContaining({ id: "stfbroken", outcome: "failed" })]);
    const { results: notes } = await env.DB.prepare(
      "SELECT title, body FROM core_notifications WHERE user_id = ? AND title LIKE '%stfbroken%'",
    )
      .bind(admin.id)
      .all<{ title: string; body: string }>();
    expect(notes).toEqual([
      expect.objectContaining({ body: expect.stringContaining("keeps running as it was") }),
    ]);
    // Once per release: a second boot does not tell them again.
    await installShippedExtensions({ db, host });
    const { results: again } = await env.DB.prepare(
      "SELECT 1 FROM core_notifications WHERE user_id = ? AND title LIKE '%stfbroken%'",
    )
      .bind(admin.id)
      .all();
    expect(again).toHaveLength(1);
  });
});

describe("a coach profile in the Trash", () => {
  it("is refused while it is on shifts not yet ended; with only past ones it goes", async () => {
    const { user, profile } = await coach("Ari");
    const klass = await create(KLASS, {
      name: "Future",
      coach: profile,
      startsAt: at("16", "06:00"),
      endsAt: at("16", "07:00"),
    });
    await expect(
      invoke("record.delete", { object: COACH, id: profile }, as()),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "staffed_holder", count: 1 } });
    // After the class, the profile may go, and the class keeps its claim (it was worked).
    const after = "2026-06-20T00:00:00.000Z";
    await invoke("record.delete", { object: COACH, id: profile }, as(after));
    expect((await claims(user.id)).map((c) => c.record_id)).toEqual([klass.id]);
  });
});

describe("toolOnly for staff", () => {
  it("the pipeline itself refuses a staff-only tool-only operation outside a tool run", async () => {
    const probe = defineOperation({
      name: "staffing.probe",
      description: "A staff-only tool-only probe for this test: answers ok, checks nothing itself.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      permission: "records:read",
      risk: "read",
      toolOnly: true,
      async handler() {
        return { ok: true };
      },
    });
    const invoker = createInvoker(createRegistry([probe]));
    await expect(invoker.invokeByName("staffing.probe", {}, as())).rejects.toMatchObject({
      code: "unknown_operation",
    });
    expect((await invoker.listFor(as())).map((o) => o.name)).not.toContain("staffing.probe");
    await expect(invoker.resolveFor("staffing.probe", as())).rejects.toMatchObject({
      code: "unknown_operation",
    });
    const tool = context(admin, {
      actor: "extension",
      extension: {
        id: ext,
        permissions: { operations: ["staffing.probe"], objects: {} } as never,
        tool: { name: "probe", humanOnly: false, permission: null },
      },
    });
    expect(await invoker.invokeByName("staffing.probe", {}, tool)).toEqual({ ok: true });
  });
});
