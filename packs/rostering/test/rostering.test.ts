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
      "staffing.week": () => ({ shifts: [SHIFT], zone: "Australia/Sydney", truncated: false }),
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
      "staffing.markNotWorked": (input) => ({
        object: input.object,
        id: input.id,
        notWorked: input.notWorked,
        changed: true,
      }),
      "staffing.payBasis": (input) => ({
        account: input.account,
        from: "2026-06-01",
        changed: true,
      }),
      "staffing.payBases": () => ({ today: "2026-06-01", items: [], truncated: false }),
      "staffing.payPeriod.list": () => ({
        setting: { period: "fortnightly", start: "2026-06-01", day: 1, zone: "Australia/Sydney" },
        set: true,
        periods: [],
      }),
      "staffing.payPeriod.totals": () => ({
        period: {
          start: "2026-06-01",
          end: "2026-06-14",
          zone: "Australia/Sydney",
          locked: false,
          preview: true,
          version: null,
        },
        totals: [],
        lines: [],
        minutes: 0,
        hours: "0.00",
      }),
      "staffing.payPeriod.lock": (input) => ({
        id: "ppe_1",
        start: input.start,
        end: "2026-06-14",
        version: 1,
      }),
      "staffing.payPeriod.reopen": (input) => ({ id: "ppe_1", start: input.start, version: 1 }),
      "staffing.payPeriod.export": (input) => ({
        filename: `pay-${input.start}-to-2026-06-14-v1.csv`,
        contentType: "text/csv",
        csv: "name\r\n",
        locked: true,
        version: 1,
      }),
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
    expect(m.grantable).toEqual(["rostering:roster", "rostering:manage", "rostering:pay"]);
    expect(m.restricted).toEqual(["rostering:manage", "rostering:pay"]);
    expect(m.staffing).toEqual({
      rosters: "rostering:manage",
      pays: "rostering:pay",
      settings: {
        offerCutoffMinutes: "offerCutoffMinutes",
        uncoveredDays: "uncoveredDays",
        payPeriod: "payPeriod",
        payPeriodStart: "payPeriodStart",
        payPeriodDay: "payPeriodDay",
      },
    });
    // The pay period: fortnightly by default, from a date the business sets; a person's to change.
    expect(m.settings.payPeriod).toMatchObject({ default: "fortnightly", personApproves: true });
    expect(m.settings.payPeriodStart?.personApproves).toBe(true);
    expect(m.settings.payPeriodDay?.personApproves).toBe(true);
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
      "markNotWorked",
    ]) {
      expect(tools[name]?.permission, name).toBe("rostering:manage");
    }
    // Pay: restricted, and a person's only: an assistant never reads or changes it.
    const PAY = ["payBasis", "payBases", "periods", "periodTotals", "lock", "reopen", "export"];
    for (const name of PAY) {
      expect(tools[name]?.permission, name).toBe("rostering:pay");
      expect(tools[name]?.humanOnly, name).toBe(true);
    }
    // What the audit log never keeps: how someone is counted, why a period was reopened or a
    // shift not worked.
    expect(tools.payBasis?.redact).toEqual(["basis"]);
    expect(tools.reopen?.redact).toEqual(["reason"]);
    expect(tools.markNotWorked?.redact).toEqual(["reason"]);
    // A person's own acts: never an assistant's.
    for (const name of ["offer", "withdraw", "take", "away", "back", "awayFor", "awayList"]) {
      expect(tools[name]?.humanOnly, name).toBe(true);
    }
    // Roster changes an assistant may ask for, applied by a person.
    for (const name of ["assign", "qualify", "markNotWorked"]) {
      expect(tools[name]?.personApproves, name).toBe(true);
    }
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

describe("the pay tools", () => {
  it("markNotWorked passes the shift, the mark and why", async () => {
    const host = hostWith();
    await host.runTool("markNotWorked", {
      object: "bookings.class",
      id: "cls_1",
      reason: "Nobody ran it",
    });
    expect(callsTo(host, "staffing.markNotWorked")[0]?.input).toEqual({
      object: "bookings.class",
      id: "cls_1",
      notWorked: true,
      reason: "Nobody ran it",
    });
  });

  it("each pay tool asks the host's pay operation, passing only what it was given", async () => {
    const host = hostWith();
    await host.runTool("payBasis", { account: "usr_ann", basis: "by_time" }, { caller: ME });
    await host.runTool("payBases", {}, { caller: ME });
    await host.runTool("periods", {}, { caller: ME });
    await host.runTool("periodTotals", { start: "2026-06-01" }, { caller: ME });
    await host.runTool("lock", { start: "2026-06-01" }, { caller: ME });
    await host.runTool(
      "reopen",
      { start: "2026-06-01", reason: "A late correction" },
      { caller: ME },
    );
    const out = await host.runTool<{ filename: string }>(
      "export",
      { start: "2026-06-01" },
      { caller: ME },
    );
    expect(out.filename).toBe("pay-2026-06-01-to-2026-06-14-v1.csv");
    expect(callsTo(host, "staffing.payBasis")[0]?.input).toEqual({
      account: "usr_ann",
      basis: "by_time",
    });
    expect(callsTo(host, "staffing.payPeriod.list")[0]?.input).toEqual({});
    expect(callsTo(host, "staffing.payPeriod.totals")[0]?.input).toEqual({ start: "2026-06-01" });
    expect(callsTo(host, "staffing.payPeriod.lock")[0]?.input).toEqual({ start: "2026-06-01" });
    expect(callsTo(host, "staffing.payPeriod.reopen")[0]?.input).toEqual({
      start: "2026-06-01",
      reason: "A late correction",
    });
    expect(callsTo(host, "staffing.payPeriod.export")[0]?.input).toEqual({ start: "2026-06-01" });
  });
});
