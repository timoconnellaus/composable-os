// The Rostering pack against the SDK's test host: the manifest passes the contract (duties, a duty
// series that makes duty shifts, the shift a `staffed` record, the team role, the restricted
// rosterers' permission and the roster's rules for the host), and every tool asks the host's
// tool-only `staffing.*` operation it should and passes on what the host answered. The host's
// rules (the time claim, who may take, who may roster, the restricted permission, the caller) are
// tested against the real host in apps/runner/test/rostering.test.ts and
// packages/core/test/staffing-offers.test.ts.
import { createTestHost, type TestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import rostering from "../index.ts";

const ME = { kind: "staff", userId: "usr_sam", name: "Sam" } as const;

const SHIFT = {
  object: "rostering.shift",
  id: "shf_1",
  title: "Close-down clean",
  kind: { object: "rostering.duty", id: "duty_1", name: "Cleaning" },
  startsAt: "2026-06-02T08:00:00.000Z",
  endsAt: "2026-06-02T09:00:00.000Z",
  zone: "Australia/Sydney",
  place: "Main floor",
  uncovered: false,
  noAccount: false,
  account: "usr_sam",
  name: "Sam",
  mine: true,
  offer: null,
  warnings: null,
};
const SUMMARY = {
  object: "rostering.shift",
  id: "shf_1",
  title: "Close-down clean",
  startsAt: SHIFT.startsAt,
  endsAt: SHIFT.endsAt,
};
const OFFER = {
  id: "sof_1",
  shift: SUMMARY,
  from: "usr_sam",
  fromName: "Sam",
  to: null,
  state: "open",
  madeAt: "2026-05-31T00:00:00.000Z",
  takenBy: null,
  takenAt: null,
  closesAt: "2026-06-02T07:00:00.000Z",
};
const AWAY = {
  id: "saw_1",
  account: "usr_sam",
  name: "Sam",
  kind: "leave",
  note: "Holiday",
  startsAt: "2026-06-10T00:00:00.000Z",
  endsAt: "2026-06-14T00:00:00.000Z",
  weekdays: [],
  startTime: null,
  endTime: null,
  fromDate: null,
  untilDate: null,
  zone: "Australia/Sydney",
};

function hostWith(): TestHost {
  return createTestHost(rostering, {
    operations: {
      "staffing.week": () => ({ shifts: [SHIFT], zone: "Australia/Sydney" }),
      "staffing.offers": () => ({ open: [{ ...OFFER, unavailable: false }], mine: [] }),
      "staffing.offer": () => ({ offer: OFFER, told: null }),
      "staffing.withdraw": () => ({ offer: { ...OFFER, state: "withdrawn" } }),
      "staffing.take": () => ({ offer: "sof_1", shift: SUMMARY, warnings: [] }),
      "staffing.away": () => ({ id: "saw_1", shifts: [SUMMARY], count: 1 }),
      "staffing.back": (input) => ({ id: input.id }),
      "staffing.awayList": () => ({ items: [AWAY] }),
      "staffing.assign": () => ({
        shift: SUMMARY,
        warnings: [
          {
            code: "not_qualified",
            object: "rostering.shift",
            id: "shf_1",
            account: "usr_ann",
            message: "Ann is not marked as qualified for this kind of duty shift.",
          },
        ],
      }),
      "staffing.check": () => ({ warnings: [], clash: null }),
      "staffing.qualify": (input) => ({
        account: input.account,
        kind: input.kind,
        qualified: input.qualified,
        changed: true,
      }),
      "staffing.qualifications": () => ({ items: [] }),
      "staffing.uncovered": () => ({ items: [{ ...SUMMARY, offered: false }] }),
    },
  });
}

const callsTo = (host: TestHost, operation: string) =>
  host.calls.filter((c) => c.operation === operation);

describe("the manifest", () => {
  it("passes the contract", () => {
    expect(hostWith().issues).toEqual([]);
  });

  it("declares the team role, the grants, the restricted permission and the roster's rules", () => {
    const m = hostWith().manifest;
    expect(m.roles.team).toMatchObject({ permissions: ["rostering:team"], read: [] });
    expect(m.grantable).toEqual(["rostering:roster", "rostering:manage"]);
    expect(m.restricted).toEqual(["rostering:manage"]);
    expect(m.staffing).toEqual({
      rosters: "rostering:manage",
      settings: { offerCutoffMinutes: "offerCutoffMinutes", uncoveredDays: "uncoveredDays" },
    });
    // The shift is a staffed record; the series makes it, 8 weeks ahead unless the setting says.
    expect(m.objects.shift?.staffed).toMatchObject({ who: { field: "staff" }, kind: "duty" });
    expect(m.objects.dutyseries?.recurring).toMatchObject({
      generates: "shift",
      horizonDays: 56,
      horizonSetting: "dutyHorizonDays",
    });
    // Who is on a shift, and a series' regular person, are a person's to change.
    expect(m.objects.shift?.fields.staff?.personApproves).toBe(true);
    expect(m.objects.dutyseries?.fields.staff?.personApproves).toBe(true);
  });

  it("gives each tool the permission, and the AI limits, the spec says", () => {
    const tools = hostWith().manifest.tools;
    const team = ["week", "mine", "offers", "offer", "withdraw", "take", "away", "back", "myAway"];
    for (const name of team) {
      expect(tools[name]?.permission, name).toEqual(["rostering:team", "rostering:roster"]);
    }
    for (const name of [
      "assign",
      "check",
      "qualify",
      "qualifications",
      "awayFor",
      "awayList",
      "uncovered",
    ]) {
      expect(tools[name]?.permission, name).toBe("rostering:manage");
    }
    // A person's own acts: never an assistant's.
    for (const name of ["offer", "withdraw", "take", "away", "back", "awayFor", "awayList"]) {
      expect(tools[name]?.humanOnly, name).toBe(true);
    }
    // Roster changes an assistant may ask for, applied by a person.
    for (const name of ["assign", "qualify"]) expect(tools[name]?.personApproves, name).toBe(true);
    // Reads open to an assistant.
    for (const name of [
      "week",
      "mine",
      "offers",
      "myAway",
      "check",
      "qualifications",
      "uncovered",
    ]) {
      expect(tools[name]?.humanOnly, name).toBeUndefined();
      expect(tools[name]?.risk, name).toBe("read");
    }
  });
});

describe("the team's tools", () => {
  it("week reads the roster for a week from today when no dates are given", async () => {
    const host = hostWith();
    const out = await host.runTool<{ shifts: unknown[] }>("week", {}, { caller: ME });
    expect(out.shifts).toEqual([SHIFT]);
    const [call] = callsTo(host, "staffing.week");
    const input = call?.input as { from: string; to: string; mine?: boolean };
    expect(input.mine).toBeUndefined();
    expect(Date.parse(input.to) - Date.parse(input.from)).toBe(6 * 86_400_000);
  });

  it("week passes the dates it is given", async () => {
    const host = hostWith();
    await host.runTool("week", { from: "2026-06-01", to: "2026-06-14" }, { caller: ME });
    expect(callsTo(host, "staffing.week")[0]?.input).toEqual({
      from: "2026-06-01",
      to: "2026-06-14",
    });
  });

  it("mine reads the caller's own shifts, four weeks by default, never naming an account", async () => {
    const host = hostWith();
    await host.runTool("mine", {}, { caller: ME });
    const input = callsTo(host, "staffing.week")[0]?.input as Record<string, unknown>;
    expect(input.mine).toBe(true);
    expect(input).not.toHaveProperty("account");
    expect(Date.parse(String(input.to)) - Date.parse(String(input.from))).toBe(27 * 86_400_000);
  });

  it("offers lists what the caller could take and their own", async () => {
    const host = hostWith();
    const out = await host.runTool<{ open: unknown[] }>("offers", {}, { caller: ME });
    expect(out.open).toHaveLength(1);
    expect(callsTo(host, "staffing.offers")).toHaveLength(1);
  });

  it("offer, withdraw and take pass the shift and the offer to the host", async () => {
    const host = hostWith();
    await host.runTool("offer", { object: "rostering.shift", id: "shf_1" }, { caller: ME });
    await host.runTool("withdraw", { offer: "sof_1" }, { caller: ME });
    await host.runTool("take", { offer: "sof_1", confirmUnavailable: true }, { caller: ME });
    expect(callsTo(host, "staffing.offer")[0]?.input).toEqual({
      object: "rostering.shift",
      id: "shf_1",
    });
    expect(callsTo(host, "staffing.withdraw")[0]?.input).toEqual({ offer: "sof_1" });
    expect(callsTo(host, "staffing.take")[0]?.input).toEqual({
      offer: "sof_1",
      confirmUnavailable: true,
    });
  });

  it("away and back say when the caller cannot work, never for someone else", async () => {
    const host = hostWith();
    const out = await host.runTool<{ count: number }>(
      "away",
      { kind: "leave", startsAt: "2026-06-10T00:00", endsAt: "2026-06-14T00:00", note: "Holiday" },
      { caller: ME },
    );
    expect(out.count).toBe(1);
    expect(callsTo(host, "staffing.away")[0]?.input).not.toHaveProperty("account");
    await host.runTool("back", { id: "saw_1" }, { caller: ME });
    expect(callsTo(host, "staffing.back")[0]?.input).toEqual({ id: "saw_1" });
  });

  it("myAway reads the caller's own time off, by the host-verified caller", async () => {
    const host = hostWith();
    const out = await host.runTool<{ items: unknown[] }>("myAway", {}, { caller: ME });
    expect(out.items).toEqual([AWAY]);
    expect(callsTo(host, "staffing.awayList")[0]?.input).toEqual({ account: "usr_sam" });
  });
});

describe("the rosterers' tools", () => {
  it("assign puts someone on a shift and answers its warnings", async () => {
    const host = hostWith();
    const out = await host.runTool<{ warnings: { code: string }[] }>(
      "assign",
      { object: "rostering.shift", id: "shf_1", account: "usr_ann" },
      { caller: ME },
    );
    expect(out.warnings.map((w) => w.code)).toEqual(["not_qualified"]);
  });

  it("check is the dry run", async () => {
    const host = hostWith();
    const out = await host.runTool("check", {
      object: "rostering.shift",
      id: "shf_1",
      account: null,
    });
    expect(out).toEqual({ warnings: [], clash: null });
  });

  it("qualify and qualifications", async () => {
    const host = hostWith();
    const out = await host.runTool<{ changed: boolean }>("qualify", {
      account: "usr_ann",
      kind: { object: "rostering.duty", id: "duty_1" },
    });
    expect(out.changed).toBe(true);
    expect(callsTo(host, "staffing.qualify")[0]?.input).toMatchObject({ qualified: true });
    expect(await host.runTool("qualifications", { account: "usr_ann" })).toEqual({ items: [] });
  });

  it("awayFor says when someone else cannot work; awayList reads everyone's", async () => {
    const host = hostWith();
    await host.runTool("awayFor", {
      account: "usr_ann",
      kind: "regular",
      weekdays: ["wed"],
      startTime: "13:00",
      endTime: "17:00",
      fromDate: "2026-06-01",
    });
    expect(callsTo(host, "staffing.away")[0]?.input).toMatchObject({ account: "usr_ann" });
    expect(await host.runTool("awayList", {})).toEqual({ items: [AWAY] });
  });

  it("uncovered lists the shifts with nobody on them", async () => {
    const host = hostWith();
    const out = await host.runTool<{ items: unknown[] }>("uncovered", {});
    expect(out.items).toHaveLength(1);
    expect(callsTo(host, "staffing.uncovered")[0]?.input).toEqual({});
  });
});
