// Stage 49 step 3 (ADR 0762): open hours, when someone takes appointments. The operations are
// tool-only: the tests call them as a shipped pack's tool run would, for the person who called the
// tool, and as an AI's tool run would. The ranges are read by wall clock, checked against fixtures
// worked out by hand, across a clock change and overnight. Every clock is injected.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { openCovers, openRanges } from "../src/staffing/hours.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const ext = extId("sthr");
const SERVICE = `${ext}.service`;
const SHIFT = `${ext}.shift`;

const fixture = manifest(ext, {
  objects: {
    service: {
      label: "Service",
      plural: "Services",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    shift: {
      label: "Shift",
      plural: "Shifts",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        service: { type: "relation", label: "Service", to: `${ext}.service` },
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
        kind: "service",
        live: ["scheduled"],
      },
    },
  },
});

const NOW = "2026-05-31T00:00:00.000Z";
const HOURS = ["staffing.hours.set", "staffing.hours.clear", "staffing.hours.list"];
let admin: ActingUser;
let extUser: ActingUser;

type ToolFlags = { humanOnly?: boolean; personApproves?: boolean; actor?: string };
/** A shipped pack's tool run called for `user`, with the tool's flags (as staffing-offers). */
const tool = (user: ActingUser, flags: ToolFlags = { humanOnly: true }) =>
  context(extUser, {
    actor: "extension",
    clock: () => new Date(NOW),
    extension: {
      id: ext,
      permissions: { operations: HOURS, objects: {} } as never,
      tool: {
        name: "hours",
        humanOnly: flags.humanOnly ?? false,
        ...(flags.personApproves ? { personApproves: true } : {}),
        permission: "records:write",
        calledBy: { account: user.id, actor: flags.actor ?? "human" },
      },
    },
  });

beforeAll(async () => {
  admin = await createUser("admin");
  extUser = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extUser.id)
    .run();
  await reconcile(fixture, NOW);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', '{}', ?, ?, ?)",
  )
    .bind(ext, admin.id, NOW, NOW)
    .run();
}, 60_000);

async function service(name: string) {
  return (
    await invoke(
      "record.create",
      { object: SERVICE, values: { name } },
      context(admin, { clock: () => new Date(NOW) }),
    )
  ).id as string;
}
async function set(user: ActingUser, input: Record<string, unknown>, flags?: ToolFlags) {
  return invoke("staffing.hours.set", input as never, tool(user, flags));
}
async function rowsOf(account: string) {
  return (
    await env.DB.prepare("SELECT * FROM core_staff_hours WHERE account_id = ?").bind(account).all()
  ).results as never[];
}
const s = (iso: string) => Date.parse(iso) / 1000;
const iso = (r: { starts: number; ends: number }) => [
  new Date(r.starts * 1000).toISOString(),
  new Date(r.ends * 1000).toISOString(),
];

describe("who sets open hours", () => {
  it("only a shipped pack's tool: a person, MCP or the assistant calling directly gets none", async () => {
    for (const name of HOURS) {
      await expect(
        invoke(name as "staffing.hours.list", {} as never, context(admin)),
      ).rejects.toMatchObject({ code: "unknown_operation" });
    }
  });

  it("the person sets their own; someone who rosters sets anyone's; nobody else does", async () => {
    const coach = await createUser("member");
    const other = await createUser("member");
    const own = await set(coach, {
      kind: "weekly",
      weekdays: ["mon"],
      startTime: "09:00",
      endTime: "12:00",
      zone: "UTC",
    });
    expect(own.item).toMatchObject({
      account: coach.id,
      kind: "weekly",
      weekdays: ["mon"],
      fromDate: "2026-05-31",
      onlyFor: [],
    });
    await expect(
      set(other, {
        account: coach.id,
        kind: "weekly",
        weekdays: ["tue"],
        startTime: "09:00",
        endTime: "12:00",
      }),
    ).rejects.toMatchObject({ code: "forbidden", details: { rule: "rostering" } });
    // Changing or removing someone else's: as if it were not there.
    await expect(
      set(other, {
        id: own.id,
        kind: "weekly",
        weekdays: ["tue"],
        startTime: "09:00",
        endTime: "12:00",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(invoke("staffing.hours.clear", { id: own.id }, tool(other))).rejects.toMatchObject(
      { code: "not_found" },
    );
    await expect(
      invoke("staffing.hours.list", { account: coach.id }, tool(other)),
    ).rejects.toMatchObject({ code: "forbidden" });
    // A rosterer (an admin, with no Rostering pack installed) changes it.
    const changed = await set(admin, {
      id: own.id,
      kind: "weekly",
      weekdays: ["fri", "mon"],
      startTime: "10:00",
      endTime: "14:00",
      zone: "UTC",
    });
    expect(changed.item).toMatchObject({ id: own.id, account: coach.id, weekdays: ["mon", "fri"] });
    expect(await rowsOf(coach.id)).toHaveLength(1);
    const mine = await invoke("staffing.hours.list", {}, tool(coach));
    expect(mine.items.map((i) => [i.id, i.startTime])).toEqual([[own.id, "10:00"]]);
    // A rosterer reads everyone's when account is left out.
    const all = await invoke("staffing.hours.list", {}, tool(admin));
    expect(all.items.some((i) => i.account === coach.id)).toBe(true);
    await invoke("staffing.hours.clear", { id: own.id }, tool(coach));
    expect(await rowsOf(coach.id)).toHaveLength(0);
  });

  it("an AI's change waits for a person: the calling tool must ask one", async () => {
    const coach = await createUser("member");
    const input = {
      kind: "weekly",
      weekdays: ["mon"],
      startTime: "09:00",
      endTime: "12:00",
    };
    await expect(set(coach, input, { actor: "assistant" })).rejects.toMatchObject({
      code: "forbidden",
      details: { rule: "person_applies" },
    });
    const applied = await set(coach, input, { personApproves: true, actor: "assistant" });
    await expect(
      invoke("staffing.hours.clear", { id: applied.id }, tool(coach, { actor: "assistant" })),
    ).rejects.toMatchObject({ details: { rule: "person_applies" } });
    // Reading one's own is open to the assistant.
    const read = await invoke("staffing.hours.list", {}, tool(coach, { actor: "assistant" }));
    expect(read.items).toHaveLength(1);
  });

  it("refuses what is not open hours, and holds at most 50 entries a person", async () => {
    const coach = await createUser("member");
    const bad = [
      { kind: "weekly", startTime: "09:00", endTime: "12:00" },
      {
        kind: "weekly",
        weekdays: ["mon"],
        startTime: "09:00",
        endTime: "12:00",
        startsAt: "2026-06-01T09:00",
      },
      {
        kind: "weekly",
        weekdays: ["mon"],
        startTime: "09:00",
        endTime: "12:00",
        fromDate: "2026-06-10",
        untilDate: "2026-06-01",
      },
      { kind: "extra", startsAt: "2026-06-01T09:00" },
      { kind: "extra", startsAt: "2026-06-01T09:00", endsAt: "2026-06-01T09:00" },
      { kind: "extra", startsAt: "2026-06-01T09:00", endsAt: "2026-06-02T09:01" },
      {
        kind: "extra",
        startsAt: "2026-06-01T09:00",
        endsAt: "2026-06-01T10:00",
        weekdays: ["mon"],
      },
      { kind: "extra", startsAt: "2026-06-01T09:00", endsAt: "2026-06-01T10:00", zone: "Mars" },
      {
        kind: "extra",
        startsAt: "2026-06-01T09:00",
        endsAt: "2026-06-01T10:00",
        onlyFor: [{ object: SHIFT, id: "x" }],
      },
      {
        kind: "extra",
        startsAt: "2026-06-01T09:00",
        endsAt: "2026-06-01T10:00",
        onlyFor: [{ object: SERVICE, id: "missing" }],
      },
    ];
    for (const input of bad) {
      await expect(set(coach, input)).rejects.toMatchObject({
        code: expect.stringMatching(/^(invalid_input|not_found)$/),
      });
    }
    // A deactivated or unknown account has no hours.
    await expect(
      set(admin, {
        account: "usr_none",
        kind: "weekly",
        weekdays: ["mon"],
        startTime: "09:00",
        endTime: "10:00",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await rowsOf(coach.id)).toHaveLength(0);
    for (let i = 0; i < 50; i++) {
      const day = String(1 + (i % 28)).padStart(2, "0");
      await set(coach, {
        kind: "extra",
        startsAt: `2026-07-${day}T${String(i % 20).padStart(2, "0")}:00`,
        endsAt: `2026-07-${day}T${String((i % 20) + 1).padStart(2, "0")}:00`,
        zone: "UTC",
      });
    }
    await expect(
      set(coach, { kind: "weekly", weekdays: ["mon"], startTime: "09:00", endTime: "10:00" }),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "hours_too_many", max: 50 } });
  });
});

describe("the ranges, by wall clock", () => {
  it("a week worked out by hand: merged, dated, extra, and for some kinds only", async () => {
    const coach = await createUser("member");
    const pt = await service("Personal training");
    const assessment = await service("Assessment");
    await set(coach, {
      kind: "weekly",
      weekdays: ["mon", "wed"],
      startTime: "09:00",
      endTime: "12:00",
      zone: "UTC",
    });
    // Touching the morning: one range 09:00 to 15:00.
    await set(coach, {
      kind: "weekly",
      weekdays: ["mon"],
      startTime: "12:00",
      endTime: "15:00",
      fromDate: "2026-06-08",
      zone: "UTC",
    });
    // Extra hours on Tuesday evening, given in Sydney's time.
    await set(coach, {
      kind: "extra",
      startsAt: "2026-06-03T04:00",
      endsAt: "2026-06-03T06:00",
      zone: "Australia/Sydney",
    });
    // Assessments only, on Saturday mornings, until 6 June.
    const sat = await set(coach, {
      kind: "weekly",
      weekdays: ["sat"],
      startTime: "08:00",
      endTime: "10:00",
      untilDate: "2026-06-06",
      onlyFor: [{ object: SERVICE, id: assessment }],
      zone: "UTC",
    });
    expect(sat.item.onlyFor).toEqual([{ object: SERVICE, id: assessment }]);
    const rows = await rowsOf(coach.id);
    // Monday 1 June to Monday 15 June.
    const from = s("2026-06-01T00:00:00Z");
    const to = s("2026-06-15T00:00:00Z");
    expect(openRanges(rows, from, to, { object: SERVICE, id: pt }).map(iso)).toEqual([
      ["2026-06-01T09:00:00.000Z", "2026-06-01T12:00:00.000Z"],
      // Sydney is ten hours ahead in June: 04:00 to 06:00 on the 3rd is 18:00 to 20:00 the 2nd.
      ["2026-06-02T18:00:00.000Z", "2026-06-02T20:00:00.000Z"],
      ["2026-06-03T09:00:00.000Z", "2026-06-03T12:00:00.000Z"],
      ["2026-06-08T09:00:00.000Z", "2026-06-08T15:00:00.000Z"],
      ["2026-06-10T09:00:00.000Z", "2026-06-10T12:00:00.000Z"],
    ]);
    const forAssessment = openRanges(rows, from, to, { object: SERVICE, id: assessment }).map(iso);
    expect(forAssessment).toContainEqual(["2026-06-06T08:00:00.000Z", "2026-06-06T10:00:00.000Z"]);
    // Until 6 June: the 13th is not open.
    expect(forAssessment.some(([a]) => a?.startsWith("2026-06-13"))).toBe(false);
    // Clipped to the range asked for.
    expect(openRanges(rows, s("2026-06-08T10:00:00Z"), s("2026-06-08T11:00:00Z")).map(iso)).toEqual(
      [["2026-06-08T10:00:00.000Z", "2026-06-08T11:00:00.000Z"]],
    );
    // Covered across the join of two entries; not past the end.
    expect(openCovers(rows, s("2026-06-08T11:00:00Z"), s("2026-06-08T13:00:00Z"))).toBe(true);
    expect(openCovers(rows, s("2026-06-01T11:00:00Z"), s("2026-06-01T13:00:00Z"))).toBe(false);
    // The list reads the entries that apply in a range.
    const listed = await invoke(
      "staffing.hours.list",
      { from: "2026-06-07", to: "2026-06-14" },
      tool(coach),
    );
    expect(listed.items.map((i) => i.kind).sort()).toEqual(["weekly", "weekly"]);
  });

  it("09:00 to 17:00 is eight hours on both sides of a clock change; overnight runs into the next day", async () => {
    const coach = await createUser("member");
    await set(coach, {
      kind: "weekly",
      weekdays: ["mon"],
      startTime: "09:00",
      endTime: "17:00",
      fromDate: "2026-10-01",
      zone: "Europe/London",
    });
    // Saturday night into Sunday, the night the clocks go back (25 October 2026, 02:00 BST).
    await set(coach, {
      kind: "weekly",
      weekdays: ["sat"],
      startTime: "22:00",
      endTime: "06:00",
      fromDate: "2026-10-01",
      zone: "Europe/London",
    });
    const rows = await rowsOf(coach.id);
    expect(openRanges(rows, s("2026-10-19T00:00:00Z"), s("2026-10-27T00:00:00Z")).map(iso)).toEqual(
      [
        // Monday in summer time: 08:00 to 16:00 UTC.
        ["2026-10-19T08:00:00.000Z", "2026-10-19T16:00:00.000Z"],
        // 22:00 BST to 06:00 GMT: nine hours, the night the clocks go back.
        ["2026-10-24T21:00:00.000Z", "2026-10-25T06:00:00.000Z"],
        // Monday in winter time: 09:00 to 17:00 UTC.
        ["2026-10-26T09:00:00.000Z", "2026-10-26T17:00:00.000Z"],
      ],
    );
    // An overnight range that started the day before the range asked for is read too.
    expect(openRanges(rows, s("2026-10-25T00:00:00Z"), s("2026-10-25T12:00:00Z")).map(iso)).toEqual(
      [["2026-10-25T00:00:00.000Z", "2026-10-25T06:00:00.000Z"]],
    );
  });
});

describe("privacy and leaving", () => {
  it("open hours are in no rec_* view", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'rec_%' AND sql LIKE '%core_staff_hours%'",
    ).all();
    expect(results).toEqual([]);
  });

  it("deactivating someone removes their open hours, in one statement", async () => {
    const leaver = await createUser("member");
    const stays = await createUser("member");
    for (const who of [leaver, stays]) {
      await set(who, { kind: "weekly", weekdays: ["mon"], startTime: "09:00", endTime: "12:00" });
      await set(who, { kind: "extra", startsAt: "2026-06-02T09:00", endsAt: "2026-06-02T12:00" });
    }
    await invoke("user.deactivate", { id: leaver.id }, context(admin, { db }));
    expect(await rowsOf(leaver.id)).toHaveLength(0);
    expect(await rowsOf(stays.id)).toHaveLength(2);
  });
});
