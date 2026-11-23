// Stage 45 step 3 (ADRs 0622 to 0624): qualifications, unavailability, offers and takes, uncovered
// shifts, the host's notices and leaving. On a fixture of classes (whose coach profile holds the
// staff account, made by a weekly series) and duty shifts (whose staff field is the account).
// Every operation here is tool-only: the tests call it as a shipped pack's tool run would, with
// the tool's own flags (a person's own act, or a person applies), and as an AI's tool run would.
// Every clock is injected.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  getObject,
  invoke,
  objectTableOf,
  runRecurringDue,
  runStaffingDue,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((value) => ({
  value,
  label: value,
}));

const ext = extId("stfo");
const COACH = `${ext}.coach`;
const KIND = `${ext}.kind`;
const SERIES = `${ext}.series`;
const KLASS = `${ext}.klass`;
const DUTY = `${ext}.duty`;

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
        coach: { type: "relation", label: "Coach", to: `${ext}.coach` },
        kind: { type: "relation", label: "Kind", to: `${ext}.kind` },
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
        copy: { coach: "coach", kind: "kind", name: "name" },
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
        series: { type: "relation", label: "Series", to: `${ext}.series`, readOnly: true },
        kind: { type: "relation", label: "Kind", to: `${ext}.kind` },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        timezone: { type: "timezone", label: "Time zone" },
        coach: { type: "relation", label: "Coach", to: `${ext}.coach` },
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
      staffed: {
        who: { field: "coach", account: "user" },
        starts: "startsAt",
        ends: "endsAt",
        zone: "timezone",
        kind: "kind",
        live: ["scheduled", "done"],
        pattern: { link: "series", who: "coach" },
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

// The day before the shifts below: all of them fall inside the 14-day uncovered window.
const NOW = "2026-05-31T00:00:00.000Z";
const at = (day: string, time: string) => `2026-06-${day}T${time}:00.000Z`;
let admin: ActingUser;
const as = (user: ActingUser, now = NOW) => context(user, { clock: () => new Date(now) });

const STAFFING = [
  "staffing.check",
  "staffing.qualify",
  "staffing.qualifications",
  "staffing.away",
  "staffing.back",
  "staffing.awayList",
  "staffing.offer",
  "staffing.withdraw",
  "staffing.take",
  "staffing.offers",
  "staffing.assign",
  "staffing.uncovered",
];
type ToolFlags = { humanOnly?: boolean; personApproves?: boolean };
/** A call from a shipped pack's tool run, as `user`, with the tool's flags. */
const tool = (user: ActingUser, flags: ToolFlags = { humanOnly: true }, now = NOW) =>
  context(user, {
    actor: "extension",
    clock: () => new Date(now),
    extension: {
      id: ext,
      permissions: { operations: STAFFING, objects: {} } as never,
      tool: {
        name: "roster",
        humanOnly: flags.humanOnly ?? false,
        ...(flags.personApproves ? { personApproves: true } : {}),
        permission: "rostering:team",
      },
    },
  });
/** The same tool run by an assistant acting for `user` (the tool lets an AI call it). */
const aiTool = (user: ActingUser, now = NOW) => tool(user, {}, now);

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture, NOW);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', '{}', ?, ?, ?)",
  )
    .bind(ext, admin.id, NOW, NOW)
    .run();
}, 60_000);

async function create(object: string, values: Record<string, unknown>, by = admin, now = NOW) {
  return invoke("record.create", { object, values }, as(by, now));
}
async function update(object: string, id: string, values: Record<string, unknown>, by = admin) {
  return invoke("record.update", { object, id, values }, as(by));
}
async function kind(name: string) {
  return (await create(KIND, { name })).id as string;
}
async function qualify(account: string, kindId: string) {
  return invoke(
    "staffing.qualify",
    { account, kind: { object: KIND, id: kindId } },
    tool(admin, { personApproves: true }),
  );
}
/** A staff account and its coach profile. */
async function coach(name: string) {
  const user = await createUser("member");
  const profile = (await create(COACH, { name, user: user.id })).id as string;
  return { user, profile };
}
async function duty(
  name: string,
  kindId: string,
  staff: string | null,
  day: string,
  time = "18:00",
) {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const end = `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return (
    await create(DUTY, {
      name,
      kind: kindId,
      staff,
      startsAt: at(day, time),
      endsAt: at(day, end),
    })
  ).id as string;
}
/** A person's notices whose title matches `like` (SQL LIKE's `%`, matched here). */
async function notices(user: string, like = "%") {
  const { results } = await env.DB.prepare(
    "SELECT title, body, human_only FROM core_notifications WHERE user_id = ? ORDER BY created_at, id",
  )
    .bind(user)
    .all<{ title: string; body: string | null; human_only: number }>();
  const pattern = new RegExp(
    `^${like
      .split("%")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return results.filter((r) => pattern.test(r.title));
}
async function claimOf(object: string, id: string) {
  return env.DB.prepare(
    "SELECT account_id FROM core_staff_time WHERE object_type = ? AND record_id = ?",
  )
    .bind(object, id)
    .first<{ account_id: string }>();
}
const column = (object: string, field: string) =>
  getObject(object)?.fields.find((f) => f.name === field)?.column as string;
async function stored(object: string, id: string, field: string) {
  const row = await env.DB.prepare(
    `SELECT ${column(object, field)} AS v FROM ${objectTableOf(object)} WHERE id = ?`,
  )
    .bind(id)
    .first<{ v: unknown }>();
  return row?.v ?? null;
}

describe("only a shipped pack's tool, and an AI's limits", () => {
  it("a person, MCP or the assistant calling directly gets no such operation", async () => {
    for (const name of [
      "staffing.offer",
      "staffing.take",
      "staffing.away",
      "staffing.qualify",
    ] as const) {
      await expect(invoke(name, {} as never, as(admin))).rejects.toMatchObject({
        code: "unknown_operation",
      });
    }
  });

  it("offer, take, withdraw and away are a person's own act; qualify and assign wait for one", async () => {
    const k = await kind("Limits");
    const member = await createUser("member");
    const shift = await duty("Limits", k, member.id, "02");
    // A tool an assistant may call: refused whatever the caller holds.
    await expect(
      invoke("staffing.offer", { object: DUTY, id: shift }, aiTool(member)),
    ).rejects.toMatchObject({ code: "forbidden", details: { rule: "human_only" } });
    await expect(
      invoke(
        "staffing.away",
        { kind: "leave", startsAt: "2026-06-02T00:00", endsAt: "2026-06-03T00:00" },
        aiTool(member),
      ),
    ).rejects.toMatchObject({ details: { rule: "human_only" } });
    await expect(
      invoke("staffing.take", { offer: "sfo_none" }, aiTool(member)),
    ).rejects.toMatchObject({ details: { rule: "human_only" } });
    await expect(
      invoke("staffing.withdraw", { offer: "sfo_none" }, aiTool(member)),
    ).rejects.toMatchObject({ details: { rule: "human_only" } });
    // A roster change: a tool that asks a person (personApproves) may call it; one that does not
    // cannot, even for an admin.
    await expect(
      invoke(
        "staffing.qualify",
        { account: member.id, kind: { object: KIND, id: k } },
        aiTool(admin),
      ),
    ).rejects.toMatchObject({ details: { rule: "person_applies" } });
    await expect(
      invoke("staffing.assign", { object: DUTY, id: shift, account: null }, aiTool(admin)),
    ).rejects.toMatchObject({ details: { rule: "person_applies" } });
    // Who may roster: admins, until step 4's permission.
    await expect(
      invoke(
        "staffing.qualify",
        { account: member.id, kind: { object: KIND, id: k } },
        tool(member, { personApproves: true }),
      ),
    ).rejects.toMatchObject({ details: { rule: "rostering" } });
    const done = await invoke(
      "staffing.assign",
      { object: DUTY, id: shift, account: null },
      tool(admin, { personApproves: true }),
    );
    expect(done.warnings.map((w) => w.code)).toEqual(["uncovered"]);
  });
});

describe("qualifications", () => {
  it("are set and cleared by a rosterer, read by them and by the person themselves", async () => {
    const k = await kind("Strength");
    const a = await createUser("member");
    const b = await createUser("member");
    expect((await qualify(a.id, k)).changed).toBe(true);
    expect((await qualify(a.id, k)).changed).toBe(false);
    await qualify(b.id, k);
    const own = await invoke("staffing.qualifications", {}, tool(a));
    expect(own.items.map((i) => [i.account, i.kind.name])).toEqual([[a.id, "Strength"]]);
    await expect(
      invoke("staffing.qualifications", { account: b.id }, tool(a)),
    ).rejects.toMatchObject({ details: { rule: "rostering" } });
    const all = await invoke("staffing.qualifications", { kindObject: KIND }, tool(admin));
    expect(all.items.filter((i) => i.kind.id === k).length).toBe(2);
    const cleared = await invoke(
      "staffing.qualify",
      { account: b.id, kind: { object: KIND, id: k }, qualified: false },
      tool(admin, { personApproves: true }),
    );
    expect(cleared.changed).toBe(true);
    await expect(
      invoke(
        "staffing.qualify",
        { account: a.id, kind: { object: COACH, id: k } },
        tool(admin, { personApproves: true }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("unavailability", () => {
  it("is said by the person, lists their shifts, tells the rosterers only, and is private", async () => {
    const k = await kind("Away");
    const sam = await createUser("member");
    const other = await createUser("member");
    const s1 = await duty("Away one", k, sam.id, "08");
    await duty("Away two", k, sam.id, "09");
    await duty("Not covered", k, sam.id, "20");
    const said = await invoke(
      "staffing.away",
      {
        kind: "leave",
        note: "Family wedding",
        startsAt: "2026-06-08T00:00",
        endsAt: "2026-06-10T00:00",
        zone: "UTC",
      },
      tool(sam),
    );
    expect(said.count).toBe(2);
    expect(said.shifts.map((s) => s.title).sort()).toEqual(["Away one", "Away two"]);
    // The rosterers are told (a person-only notice: never shown to an AI acting for them).
    const told = await notices(admin.id, "%is away and is on 2 shifts");
    expect(told).toHaveLength(1);
    expect(told[0]?.human_only).toBe(1);
    expect(told[0]?.body).not.toContain("Family wedding");
    // Its shifts now answer the warning to the person and the rosterer, never to anyone else.
    const asAdmin = await update(DUTY, s1, {
      startsAt: at("08", "17:30"),
      endsAt: at("08", "18:30"),
    });
    expect((asAdmin.warnings ?? []).map((w) => w.code)).toContain("unavailable");
    const asOther = await update(DUTY, s1, { startsAt: at("08", "17:00") }, other);
    expect((asOther.warnings ?? []).map((w) => w.code)).not.toContain("unavailable");
    // Reading it: their own, or a rosterer's; nobody else, not even that it exists.
    const mine = await invoke("staffing.awayList", {}, tool(sam));
    expect(mine.items.map((i) => i.note)).toEqual(["Family wedding"]);
    await expect(
      invoke("staffing.awayList", { account: sam.id }, tool(other)),
    ).rejects.toMatchObject({ code: "forbidden" });
    const otherOwn = await invoke("staffing.awayList", {}, tool(other));
    expect(otherOwn.items).toEqual([]);
    const everyone = await invoke("staffing.awayList", {}, tool(admin));
    expect(everyone.items.some((i) => i.id === said.id)).toBe(true);
    await expect(
      invoke(
        "staffing.away",
        {
          account: sam.id,
          kind: "other",
          startsAt: "2026-06-01T00:00",
          endsAt: "2026-06-01T02:00",
        },
        tool(other),
      ),
    ).rejects.toMatchObject({ details: { rule: "rostering" } });
    await expect(invoke("staffing.back", { id: said.id }, tool(other))).rejects.toMatchObject({
      code: "not_found",
    });
    await invoke("staffing.back", { id: said.id }, tool(sam));
    expect((await invoke("staffing.awayList", {}, tool(sam))).items).toEqual([]);
  });

  it("a regular time off is by wall clock across a clock change", async () => {
    const k = await kind("Sunday");
    const sam = await createUser("member");
    await invoke(
      "staffing.away",
      {
        account: sam.id,
        kind: "regular",
        weekdays: ["sun"],
        startTime: "09:00",
        endTime: "12:00",
        fromDate: "2026-10-01",
        zone: "Europe/London",
      },
      tool(admin),
    );
    // 09:30 London: 08:30 UTC before the clocks go back on 25 October, 09:30 UTC after.
    const before = await create(DUTY, {
      name: "Before",
      kind: k,
      staff: sam.id,
      startsAt: "2026-10-18T08:30:00.000Z",
      endsAt: "2026-10-18T09:00:00.000Z",
    });
    const after = await create(DUTY, {
      name: "After",
      kind: k,
      staff: sam.id,
      startsAt: "2026-10-25T09:30:00.000Z",
      endsAt: "2026-10-25T10:00:00.000Z",
    });
    const outside = await create(DUTY, {
      name: "Outside",
      kind: k,
      staff: sam.id,
      startsAt: "2026-10-25T08:30:00.000Z",
      endsAt: "2026-10-25T09:00:00.000Z",
    });
    expect((before.warnings ?? []).map((w) => w.code)).toContain("unavailable");
    expect((after.warnings ?? []).map((w) => w.code)).toContain("unavailable");
    expect((outside.warnings ?? []).map((w) => w.code)).not.toContain("unavailable");
  });
});

describe("offers reach only the eligible", () => {
  it("tells exactly the qualified, available, free accounts with a profile", async () => {
    const yoga = await kind("Yoga");
    const giver = await coach("Giver");
    const free1 = await coach("Free one");
    const free2 = await coach("Free two");
    const unqualified = await coach("Unqualified");
    const away = await coach("Away");
    const busy = await coach("Busy");
    const gone = await coach("Gone");
    const noProfile = await createUser("member");
    for (const c of [giver, free1, free2, away, busy, gone]) await qualify(c.user.id, yoga);
    await qualify(noProfile.id, yoga);
    const klass = (
      await create(KLASS, {
        name: "Yoga",
        kind: yoga,
        coach: giver.profile,
        startsAt: at("05", "06:00"),
        endsAt: at("05", "07:00"),
      })
    ).id as string;
    await invoke(
      "staffing.away",
      { kind: "leave", startsAt: "2026-06-05T00:00", endsAt: "2026-06-06T00:00", zone: "UTC" },
      tool(away.user),
    );
    await create(DUTY, {
      name: "Busy duty",
      kind: yoga,
      staff: busy.user.id,
      startsAt: at("05", "06:30"),
      endsAt: at("05", "07:30"),
    });
    await env.DB.prepare("UPDATE core_user SET deactivated_at = ? WHERE id = ?")
      .bind(NOW, gone.user.id)
      .run();
    const made = await invoke("staffing.offer", { object: KLASS, id: klass }, tool(giver.user));
    expect(made.offer.state).toBe("open");
    expect(made.offer.from).toBe(giver.user.id);
    // The offerer is never told who is away, not even how many were told.
    expect(made.told).toBeNull();
    const toldOf = async (u: ActingUser) => (await notices(u.id, "Shift offered: Yoga%")).length;
    expect(await toldOf(free1.user)).toBe(1);
    expect(await toldOf(free2.user)).toBe(1);
    for (const u of [giver.user, unqualified.user, away.user, busy.user, gone.user, noProfile]) {
      expect(await toldOf(u)).toBe(0);
    }
    // One open offer per shift.
    await expect(
      invoke("staffing.offer", { object: KLASS, id: klass }, tool(giver.user)),
    ).rejects.toMatchObject({ details: { rule: "offer_open" } });
    // Someone else's shift is not theirs to offer.
    const d = await duty("Not yours", yoga, free1.user.id, "06");
    await expect(
      invoke("staffing.offer", { object: DUTY, id: d }, tool(free2.user)),
    ).rejects.toMatchObject({ details: { rule: "not_yours" } });
    // The open offers a person could take.
    const open = await invoke("staffing.offers", {}, tool(free1.user));
    expect(open.open.map((o) => o.shift.id)).toContain(klass);
    const notOpen = await invoke("staffing.offers", {}, tool(unqualified.user));
    expect(notOpen.open.map((o) => o.shift.id)).not.toContain(klass);
    const mine = await invoke("staffing.offers", {}, tool(giver.user));
    expect(mine.mine.map((o) => o.id)).toEqual([made.offer.id]);
  });
});

describe("the take", () => {
  it("of twenty at once, exactly one wins; the rest are told who took it", async () => {
    const k = await kind("Race");
    const giver = await createUser("member");
    await qualify(giver.id, k);
    const takers: ActingUser[] = [];
    for (let i = 0; i < 20; i++) {
      const u = await createUser("member");
      await qualify(u.id, k);
      takers.push(u);
    }
    const shift = await duty("Race", k, giver.id, "03");
    const { offer } = await invoke("staffing.offer", { object: DUTY, id: shift }, tool(giver));
    const results = await Promise.allSettled(
      takers.map((u) => invoke("staffing.take", { offer: offer.id }, tool(u))),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    const row = await env.DB.prepare("SELECT state, taken_by FROM core_staff_offer WHERE id = ?")
      .bind(offer.id)
      .first<{ state: string; taken_by: string }>();
    expect(row?.state).toBe("taken");
    expect(await stored(DUTY, shift, "staff")).toBe(row?.taken_by);
    expect((await claimOf(DUTY, shift))?.account_id).toBe(row?.taken_by);
    const claims = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_staff_time WHERE object_type = ? AND record_id = ?",
    )
      .bind(DUTY, shift)
      .first<{ n: number }>();
    expect(claims?.n).toBe(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toMatchObject({
          code: "conflict",
          details: { rule: "offer_taken", takenBy: row?.taken_by },
        });
      }
    }
    // The offerer and the rosterers are told; nobody approved anything.
    expect(await notices(giver.id, "% took your shift: Race")).toHaveLength(1);
    expect(await notices(admin.id, "% took a shift: Race%")).toHaveLength(1);
  });

  it("is refused to someone not qualified, after the cut-off, and to the offerer; confirms when away", async () => {
    const k = await kind("Rules");
    const giver = await createUser("member");
    const taker = await createUser("member");
    const unqualified = await createUser("member");
    await qualify(taker.id, k);
    const shift = await duty("Rules", k, giver.id, "04", "10:00");
    const { offer } = await invoke("staffing.offer", { object: DUTY, id: shift }, tool(giver));
    await expect(
      invoke("staffing.take", { offer: offer.id }, tool(unqualified)),
    ).rejects.toMatchObject({ code: "forbidden", details: { rule: "not_qualified" } });
    await expect(invoke("staffing.take", { offer: offer.id }, tool(giver))).rejects.toMatchObject({
      details: { rule: "own_offer" },
    });
    await invoke(
      "staffing.away",
      { kind: "other", startsAt: "2026-06-04T09:00", endsAt: "2026-06-04T12:00", zone: "UTC" },
      tool(taker),
    );
    await expect(invoke("staffing.take", { offer: offer.id }, tool(taker))).rejects.toMatchObject({
      details: { rule: "unavailable_confirm" },
    });
    // 59 minutes before the start: past the cut-off. Refused, and the offerer is still on it.
    const late = "2026-06-04T09:01:00.000Z";
    await expect(
      invoke(
        "staffing.take",
        { offer: offer.id, confirmUnavailable: true },
        tool(taker, undefined, late),
      ),
    ).rejects.toMatchObject({ details: { rule: "offer_cutoff" } });
    expect(await stored(DUTY, shift, "staff")).toBe(giver.id);
    // The minute cron lapses it: the offerer is told it is still theirs, the rosterers too.
    const ran = await runStaffingDue(db, { clock: () => new Date(late) });
    expect(ran.lapsed).toBeGreaterThanOrEqual(1);
    const state = await env.DB.prepare("SELECT state FROM core_staff_offer WHERE id = ?")
      .bind(offer.id)
      .first<{ state: string }>();
    expect(state?.state).toBe("lapsed");
    expect(await notices(giver.id, "Nobody took your shift: Rules")).toHaveLength(1);
    expect(await notices(admin.id, "An offered shift was not taken: Rules")).toHaveLength(1);
    await expect(
      invoke("staffing.take", { offer: offer.id, confirmUnavailable: true }, tool(taker)),
    ).rejects.toMatchObject({ details: { rule: "offer_closed", state: "lapsed" } });
    expect(await stored(DUTY, shift, "staff")).toBe(giver.id);
  });

  it("an away taker who confirms takes it; a double-booked taker is refused", async () => {
    const k = await kind("Confirm");
    const giver = await createUser("member");
    const taker = await createUser("member");
    await qualify(taker.id, k);
    const shift = await duty("Confirm", k, giver.id, "12");
    await duty("Taker's own", k, taker.id, "12", "18:30");
    const { offer } = await invoke("staffing.offer", { object: DUTY, id: shift }, tool(giver));
    await expect(invoke("staffing.take", { offer: offer.id }, tool(taker))).rejects.toMatchObject({
      details: { rule: "double_booked" },
    });
    const other = await createUser("member");
    await qualify(other.id, k);
    await invoke(
      "staffing.away",
      { kind: "leave", startsAt: "2026-06-12T00:00", endsAt: "2026-06-13T00:00", zone: "UTC" },
      tool(other),
    );
    const taken = await invoke(
      "staffing.take",
      { offer: offer.id, confirmUnavailable: true },
      tool(other),
    );
    expect(taken.warnings.map((w) => w.code)).toContain("unavailable");
    expect(await stored(DUTY, shift, "staff")).toBe(other.id);
  });

  it("a taken class keeps its taker as an exception when its series' coach changes", async () => {
    const pilates = await kind("Pilates");
    const regular = await coach("Regular");
    const cover = await coach("Cover");
    const next = await coach("Next");
    await qualify(cover.user.id, pilates);
    const series = (
      await create(SERIES, {
        name: "Pilates",
        weekdays: ["tue"],
        time: "07:00",
        length: 60,
        firstDate: "2026-06-01",
        timezone: "UTC",
        coach: regular.profile,
        kind: pilates,
      })
    ).id as string;
    await runRecurringDue(db, { clock: () => new Date(NOW) });
    const { results } = await env.DB.prepare(
      `SELECT id FROM ${objectTableOf(KLASS)} WHERE ${column(KLASS, "series")} = ? ORDER BY ${column(KLASS, "startsAt")}`,
    )
      .bind(series)
      .all<{ id: string }>();
    const [first, second] = results.map((r) => r.id) as [string, string];
    const { offer } = await invoke(
      "staffing.offer",
      { object: KLASS, id: first },
      tool(regular.user),
    );
    await invoke("staffing.take", { offer: offer.id }, tool(cover.user));
    expect(await stored(KLASS, first, "coach")).toBe(cover.profile);
    const exceptions = await env.DB.prepare(
      "SELECT field FROM core_recurrence_exception WHERE object_type = ? AND record_id = ?",
    )
      .bind(KLASS, first)
      .all<{ field: string }>();
    expect(exceptions.results.map((r) => r.field)).toEqual(["coach"]);
    await update(SERIES, series, { coach: next.profile });
    expect(await stored(KLASS, first, "coach")).toBe(cover.profile);
    expect(await stored(KLASS, second, "coach")).toBe(next.profile);
  });

  it("a rosterer's reassignment cancels the open offer, tells its offerer, and a take then fails", async () => {
    const k = await kind("Reassign");
    const giver = await createUser("member");
    const other = await createUser("member");
    const taker = await createUser("member");
    await qualify(taker.id, k);
    const shift = await duty("Reassign", k, giver.id, "10");
    const { offer } = await invoke("staffing.offer", { object: DUTY, id: shift }, tool(giver));
    await update(DUTY, shift, { staff: other.id });
    expect(await notices(giver.id, "Your offer was cancelled: Reassign")).toHaveLength(1);
    expect(await notices(giver.id, "You are off a shift: Reassign")).toHaveLength(1);
    expect(await notices(other.id, "You are on a shift: Reassign")).toHaveLength(1);
    await expect(invoke("staffing.take", { offer: offer.id }, tool(taker))).rejects.toMatchObject({
      details: { rule: "offer_closed", state: "cancelled" },
    });
    // A cancelled offer can never be moved again, whoever writes.
    await expect(
      env.DB.prepare(
        "UPDATE core_staff_offer SET state = 'taken', taken_by = ?, taken_at = ? WHERE id = ?",
      )
        .bind(taker.id, NOW, offer.id)
        .run(),
    ).rejects.toThrow(/core_staff_offer_closed/);
    await expect(
      env.DB.prepare(
        "INSERT OR REPLACE INTO core_staff_offer (id, object_type, record_id, made_by, state, made_at) VALUES (?, ?, ?, ?, 'open', ?)",
      )
        .bind(offer.id, DUTY, shift, giver.id, NOW)
        .run(),
    ).rejects.toThrow(/core_staff_offer_replaced/);
  });

  it("a rosterer offers an uncovered shift to everyone; withdrawing tells the offerer", async () => {
    const k = await kind("Open");
    const taker = await createUser("member");
    await qualify(taker.id, k);
    const shift = await duty("Open", k, null, "11");
    const made = await invoke("staffing.offer", { object: DUTY, id: shift }, tool(admin));
    expect(made.offer.from).toBeNull();
    expect(made.told).toBe(1);
    await invoke("staffing.take", { offer: made.offer.id }, tool(taker));
    expect(await stored(DUTY, shift, "staff")).toBe(taker.id);
    // Withdrawn by a rosterer: its offerer hears the shift is still theirs.
    const second = await invoke("staffing.offer", { object: DUTY, id: shift }, tool(taker));
    await invoke("staffing.withdraw", { offer: second.offer.id }, tool(admin));
    expect(await notices(taker.id, "Your offer was withdrawn: Open")).toHaveLength(1);
  });
});

describe("uncovered shifts and the host's notices", () => {
  it("a shift just left with nobody is told at once; the daily notice once a day", async () => {
    const k = await kind("Uncovered");
    const staff = await createUser("member");
    const shift = await duty("Uncovered now", k, staff.id, "07");
    // Someone other than the rosterer takes them off it (the one who does it is never told).
    await update(DUTY, shift, { staff: null }, staff);
    expect(await notices(admin.id, "A shift has nobody on it: Uncovered now")).toHaveLength(1);
    const listed = await invoke("staffing.uncovered", {}, tool(admin));
    expect(listed.items.map((i) => i.id)).toContain(shift);
    await expect(invoke("staffing.uncovered", {}, tool(staff))).rejects.toMatchObject({
      details: { rule: "rostering" },
    });
    // The daily notice: from 07:00 in the organisation's zone (UTC here), once.
    await env.DB.prepare("DELETE FROM core_staff_run").run();
    const early = await runStaffingDue(db, { clock: () => new Date("2026-05-31T06:00:00.000Z") });
    expect(early.uncovered).toBe(0);
    const morning = await runStaffingDue(db, { clock: () => new Date("2026-05-31T07:05:00.000Z") });
    expect(morning.uncovered).toBeGreaterThanOrEqual(1);
    const again = await runStaffingDue(db, { clock: () => new Date("2026-05-31T07:06:00.000Z") });
    expect(again.uncovered).toBe(0);
    expect(await notices(admin.id, "% in the next 14 days")).toHaveLength(1);
  });

  it("a shift's person hears when it changes time or is cancelled", async () => {
    const k = await kind("Changes");
    const staff = await createUser("member");
    const shift = await duty("Changes", k, staff.id, "13");
    await update(DUTY, shift, { startsAt: at("13", "17:00") });
    expect(await notices(staff.id, "Your shift changed time: Changes")).toHaveLength(1);
    await update(DUTY, shift, { state: "cancelled" });
    expect(await notices(staff.id, "Your shift was cancelled: Changes")).toHaveLength(1);
    // Their own change tells them nothing.
    const own = await duty("Own", k, staff.id, "14");
    await update(DUTY, own, { startsAt: at("14", "17:00") }, staff);
    expect(await notices(staff.id, "Your shift changed time: Own")).toHaveLength(0);
  });

  it("a pattern that cannot be applied on a date tells the rosterers", async () => {
    const k = await kind("Clash");
    const c = await coach("Clashing");
    await create(DUTY, {
      name: "Before the class",
      kind: k,
      staff: c.user.id,
      startsAt: at("03", "06:30"),
      endsAt: at("03", "07:30"),
    });
    await create(SERIES, {
      name: "Clash series",
      weekdays: ["wed"],
      time: "07:00",
      length: 60,
      firstDate: "2026-06-01",
      lastDate: "2026-06-04",
      timezone: "UTC",
      coach: c.profile,
      kind: k,
    });
    await runRecurringDue(db, { clock: () => new Date(NOW) });
    expect(
      await notices(admin.id, "A shift has nobody on it: Clash series on 2026-06-03"),
    ).toHaveLength(1);
  });
});

describe("leaving", () => {
  it("deactivating a coach clears their future shifts and pattern, keeps the past, cancels offers", async () => {
    const k = await kind("Leaving");
    const leaver = await coach("Leaver");
    const colleague = await createUser("member");
    await qualify(leaver.user.id, k);
    const series = (
      await create(SERIES, {
        name: "Leaver's class",
        weekdays: ["thu"],
        time: "06:00",
        length: 60,
        firstDate: "2026-05-01",
        timezone: "UTC",
        coach: leaver.profile,
        kind: k,
      })
    ).id as string;
    await runRecurringDue(db, { clock: () => new Date(NOW) });
    // A past class of theirs, made directly (the series makes none before now).
    const past = (
      await create(KLASS, {
        name: "Past",
        kind: k,
        coach: leaver.profile,
        startsAt: "2026-05-20T06:00:00.000Z",
        endsAt: "2026-05-20T07:00:00.000Z",
      })
    ).id as string;
    const dutyShift = await duty("Leaver's duty", k, leaver.user.id, "15");
    // An offer they made, and one made to them.
    const theirs = await invoke(
      "staffing.offer",
      { object: DUTY, id: dutyShift },
      tool(leaver.user),
    );
    const giverShift = await duty("Offered to leaver", k, colleague.id, "16");
    const toThem = await invoke(
      "staffing.offer",
      { object: DUTY, id: giverShift, to: leaver.user.id },
      tool(colleague),
    );
    const future = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_staff_time WHERE account_id = ? AND starts > ?",
    )
      .bind(leaver.user.id, Date.parse(NOW) / 1000)
      .first<{ n: number }>();
    const count = (future?.n ?? 0) + 1; // and the pattern
    const refused = invoke("user.deactivate", { id: leaver.user.id }, as(admin));
    await expect(refused).rejects.toMatchObject({
      code: "conflict",
      details: { rule: "deactivate_confirm", count },
    });
    const done = await invoke("user.deactivate", { id: leaver.user.id, confirm: count }, as(admin));
    expect(done.roster).toEqual({ shifts: count - 1, patterns: 1, offers: 2 });
    expect(await stored(SERIES, series, "coach")).toBeNull();
    expect(await stored(DUTY, dutyShift, "staff")).toBeNull();
    expect(await stored(KLASS, past, "coach")).toBe(leaver.profile);
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_staff_time WHERE account_id = ? AND starts > ?",
    )
      .bind(leaver.user.id, Date.parse(NOW) / 1000)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await claimOf(KLASS, past))?.account_id).toBe(leaver.user.id);
    const states = await env.DB.prepare(
      "SELECT id, state FROM core_staff_offer WHERE id IN (?, ?) ORDER BY id",
    )
      .bind(theirs.offer.id, toThem.offer.id)
      .all<{ state: string }>();
    expect(states.results.map((r) => r.state)).toEqual(["cancelled", "cancelled"]);
    expect(await notices(colleague.id, "Your offer was cancelled")).toHaveLength(1);
    // The admin who deactivated them knows; another rosterer is told, with the list.
    const other = await createUser("admin");
    const second = await coach("Second leaver");
    await duty("Second's duty", k, second.user.id, "17");
    await invoke("user.deactivate", { id: second.user.id, confirm: 1 }, as(admin));
    const told = await notices(other.id, "% left: 1 shift%");
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toContain("Second's duty");
  });
});
