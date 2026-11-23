// The Rostering pack's headless entry (stage 45 step 7): its plain functions format only what the
// host gave (times in the business's zone, never the device's; a clock-change day from the host's
// hours), its refusals say which designed state to show for every rule the roster's tools can
// refuse with, and its hooks are only those the client holds (a team role's client has no
// rosterers' or pay hooks), with what a person writes and pay figures kept out of the app's cache.
import { describe, expect, it } from "vitest";
import {
  addDays,
  awayWhen,
  clockChange,
  createRosteringHooks,
  dateIn,
  dayLabel,
  feedAddresses,
  personOn,
  ROSTERING_HOOKS_CALL,
  type RosterShift,
  refusalNext,
  rosterRefusal,
  shiftName,
  shiftsByDay,
  shiftTime,
  weekOf,
} from "../client/index.ts";

const ZONE = "Australia/Sydney";

const shift = (over: Partial<RosterShift> = {}): RosterShift => ({
  object: "rostering.shift",
  id: "shf_1",
  title: "Close-down clean",
  kind: { object: "rostering.duty", id: "duty_1", name: "Cleaning" },
  startsAt: "2026-06-02T08:00:00.000Z",
  endsAt: "2026-06-02T09:00:00.000Z",
  zone: ZONE,
  place: "Main floor",
  uncovered: false,
  noAccount: false,
  account: "usr_sam",
  name: "Sam",
  mine: false,
  offer: null,
  warnings: null,
  ...over,
});

describe("dates and times (display only)", () => {
  it("moves calendar dates and finds a week's Monday with no zone or time of day", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekOf("2026-06-03")).toBe("2026-06-01");
    expect(weekOf("2026-06-07")).toBe("2026-06-01");
    expect(weekOf("2026-06-01")).toBe("2026-06-01");
    expect(dayLabel("2026-06-02")).toMatch(/Tue/);
  });

  it("shows a shift's times in its zone, with the end's date when it crosses midnight", () => {
    expect(shiftTime(shift(), "UTC")).toBe("18:00–19:00");
    // The date as the runtime's Intl writes it in the locale (it differs between runtimes).
    expect(shiftTime(shift(), "UTC", { withDate: true })).toBe(
      `${dayLabel("2026-06-02")}, 18:00–19:00`,
    );
    const late = shift({
      startsAt: "2026-06-02T13:00:00.000Z",
      endsAt: "2026-06-02T15:00:00.000Z",
    });
    expect(shiftTime(late, "UTC")).toBe(`23:00–${dayLabel("2026-06-03")} 01:00`);
    // A shift with no zone of its own is shown in the roster's.
    expect(shiftTime({ ...shift(), zone: null }, "UTC")).toBe("08:00–09:00");
  });

  it("puts each shift on its start's date in the roster's zone, every day of the host's range listed", () => {
    // 23:30 UTC on the 1st is 09:30 on the 2nd in Sydney.
    const early = shift({ id: "a", startsAt: "2026-06-01T23:30:00.000Z", endsAt: null });
    const days = shiftsByDay({
      zone: ZONE,
      days: [
        { date: "2026-06-01", hours: 24 },
        { date: "2026-06-02", hours: 24 },
        { date: "2026-06-03", hours: 24 },
      ],
      shifts: [early, shift({ id: "b" })],
    });
    expect(days.map((d) => [d.day.date, d.shifts.map((s) => s.id)])).toEqual([
      ["2026-06-01", []],
      ["2026-06-02", ["a", "b"]],
      ["2026-06-03", []],
    ]);
    expect(dateIn(early.startsAt, "UTC")).toBe("2026-06-01");
  });

  it("says when the clocks change, from the host's hours", () => {
    expect(clockChange({ date: "2027-04-04", hours: 25 })).toMatch(/back: a 25-hour day/);
    expect(clockChange({ date: "2027-10-03", hours: 23 })).toMatch(/forward: a 23-hour day/);
    expect(clockChange({ date: "2027-06-01", hours: 24 })).toBeNull();
  });

  it("puts the host's origin before the feed's path, as https and as webcal", () => {
    expect(
      feedAddresses("https://admin.example.com/anything", "/api/v1/staffing/feed/abc.ics"),
    ).toEqual({
      https: "https://admin.example.com/api/v1/staffing/feed/abc.ics",
      webcal: "webcal://admin.example.com/api/v1/staffing/feed/abc.ics",
    });
  });

  it("names a shift for a screen reader: what, when, where, who", () => {
    expect(shiftName(shift({ mine: true }), ZONE)).toBe(
      `Close-down clean, ${dayLabel("2026-06-02")}, 18:00–19:00, Main floor, Sam (you)`,
    );
    expect(personOn(shift({ uncovered: true, account: null, name: null }))).toBe("Nobody on it");
    expect(personOn(shift({ noAccount: true, account: null, name: "Visiting Vi" }))).toBe(
      "Visiting Vi (no account)",
    );
    expect(shiftName(shift({ offer: { id: "o", to: null, from: "usr_sam" } }), ZONE)).toMatch(
      /offered$/,
    );
  });

  it("reads a regular time off and a one-off one", () => {
    const base = {
      id: "saw_1",
      account: "usr_sam",
      name: "Sam",
      note: null,
      startsAt: null,
      endsAt: null,
      weekdays: [] as string[],
      startTime: null,
      endTime: null,
      fromDate: null,
      untilDate: null,
      zone: ZONE,
    };
    expect(
      awayWhen({
        ...base,
        kind: "regular",
        weekdays: ["wed", "mon"],
        startTime: "13:00",
        endTime: "17:00",
        fromDate: "2026-06-01",
      }),
    ).toBe(`Every Monday, Wednesday, 13:00–17:00, from ${dayLabel("2026-06-01")}`);
    expect(
      awayWhen({
        ...base,
        kind: "leave",
        startsAt: "2026-06-09T14:00:00.000Z",
        endsAt: "2026-06-13T14:00:00.000Z",
      }),
    ).toBe(`${dayLabel("2026-06-10")}, 00:00–${dayLabel("2026-06-14")} 00:00`);
  });
});

/** A refusal as a pack tool's call raises it: the host's words, its rule inside the tool's details. */
const toolError = (message: string, details: Record<string, unknown>, code = "conflict") =>
  Object.assign(new Error(message), {
    name: "ApiError",
    code: "extension_error",
    details: { extension: "rostering", tool: "take", code, details },
  });

describe("refusals (one designed state each)", () => {
  it("names every rule the roster's tools refuse with, keeping the host's words", () => {
    for (const rule of [
      "double_booked",
      "nobody_qualified",
      "not_qualified",
      "offer_stale",
      "offer_taken",
      "offer_closed",
      "offer_cutoff",
      "unavailable_confirm",
      "rostering",
      "pay_period_locked",
      "pay_period_held",
      "roster_changed",
      "deactivate_confirm",
    ]) {
      const r = rosterRefusal(toolError(`Host words for ${rule}`, { rule }));
      expect([rule, r.kind, r.message]).toEqual([rule, rule, `Host words for ${rule}`]);
    }
  });

  it("keeps who took an offer, and the dates and other shift of a clash", () => {
    const taken = rosterRefusal(
      toolError("Lee took this shift already.", { rule: "offer_taken", takenBy: "usr_lee" }),
    );
    expect(taken).toMatchObject({ kind: "offer_taken", takenBy: "usr_lee" });
    expect(taken.message).toBe("Lee took this shift already.");
    const clash = rosterRefusal(
      toolError("Sam would be on two shifts at once on 2026-06-03.", {
        rule: "double_booked",
        dates: ["2026-06-03"],
        clashes: [{ date: "2026-06-03", other: { title: "Strength", startsAt: "s", endsAt: "e" } }],
      }),
    );
    expect(clash).toMatchObject({
      kind: "double_booked",
      dates: ["2026-06-03"],
      other: { title: "Strength" },
    });
  });

  it("a host error of its own (not inside a tool) reads the same", () => {
    const direct = Object.assign(new Error("This is inside a locked pay period."), {
      code: "conflict",
      details: { rule: "pay_period_locked" },
    });
    expect(rosterRefusal(direct).kind).toBe("pay_period_locked");
  });

  it("a retried new calendar address the host never kept is its own state: make another", () => {
    const lost = Object.assign(new Error("applied, response not kept"), {
      code: "conflict",
      details: { reason: "idempotency_response_lost" },
    });
    expect(rosterRefusal(lost)).toMatchObject({ kind: "address_lost" });
    expect(rosterRefusal(lost).message).toMatch(/Make a new address/);
  });

  it("forbidden, not found, a network failure and anything else each have their own state", () => {
    expect(rosterRefusal(Object.assign(new Error("Forbidden"), { code: "forbidden" })).kind).toBe(
      "forbidden",
    );
    expect(rosterRefusal(Object.assign(new Error("x"), { code: "not_found" })).kind).toBe(
      "not_found",
    );
    const network = Object.assign(new Error("offline"), { name: "NetworkError" });
    expect(rosterRefusal(network)).toMatchObject({ kind: "network" });
    expect(rosterRefusal(new Error("Odd")).kind).toBe("other");
    expect(rosterRefusal(undefined).message).toBeTruthy();
  });

  it("says what to do next, differently for someone who rosters", () => {
    expect(refusalNext("nobody_qualified", true)).toMatch(/Qualifications/);
    expect(refusalNext("nobody_qualified", false)).toMatch(/whoever rosters/);
    expect(refusalNext("pay_period_locked", false)).toMatch(/Reopen/);
    expect(refusalNext("other", true)).toBeNull();
  });
});

describe("hooks", () => {
  /** A client holding these operations, recording what each hook asks of the app's React Query. */
  function clientWith(names: readonly string[]) {
    return {
      operations: Object.fromEntries(names.map((n) => [n, { kind: "query", invalidates: [] }])),
      query: (name: string, input: unknown) => ({
        queryKey: [name, input],
        queryFn: async () => ({ name, input }),
      }),
      mutation: (name: string) => ({
        mutationKey: [name],
        mutationFn: async (input: unknown) => ({ name, input }),
      }),
    };
  }
  const seen: { options: Record<string, unknown> }[] = [];
  const react = {
    useQuery: (options: Record<string, unknown>) => {
      seen.push({ options });
      return { data: undefined, isPending: true, error: null };
    },
    useMutation: (options: Record<string, unknown>) => {
      seen.push({ options });
      return {
        mutate() {},
        mutateAsync: async (input: unknown) =>
          (options.mutationFn as (i: unknown) => Promise<unknown>)(input),
        data: undefined,
        isPending: false,
        error: null,
        reset() {},
      };
    },
  } as never;

  it("a team role's client gets the team's hooks and none of the rosterers' or pay", () => {
    const team = [
      "x.rostering.me",
      "x.rostering.week",
      "x.rostering.mine",
      "x.rostering.offers",
      "x.rostering.offer",
      "x.rostering.withdraw",
      "x.rostering.take",
      "x.rostering.away",
      "x.rostering.back",
      "x.rostering.myAway",
    ];
    const hooks = createRosteringHooks(react, clientWith(team)) as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual(
      Object.entries(ROSTERING_HOOKS_CALL)
        .filter(([, ops]) => ops.every((op) => team.includes(op)))
        .map(([name]) => name)
        .sort(),
    );
    for (const name of ["useAssign", "useCandidates", "usePeriodTotals", "useExport"]) {
      expect(hooks[name], name).toBeUndefined();
    }
  });

  it("keeps notes, reasons and pay figures out of the cache once off screen", () => {
    const all = Object.values(ROSTERING_HOOKS_CALL).flat();
    const hooks = createRosteringHooks(react, clientWith(all)) as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const gc = (call: () => unknown) => {
      seen.length = 0;
      call();
      return seen[0]?.options.gcTime;
    };
    expect(gc(() => hooks.useAway?.())).toBe(0);
    expect(gc(() => hooks.useAwayFor?.())).toBe(0);
    expect(gc(() => hooks.useMyAway?.({}))).toBe(0);
    expect(gc(() => hooks.useAwayList?.({ from: "2026-06-01", to: "2026-06-07" }))).toBe(0);
    expect(gc(() => hooks.useReopen?.())).toBe(0);
    expect(gc(() => hooks.useMarkNotWorked?.())).toBe(0);
    expect(gc(() => hooks.usePeriodTotals?.({ start: "2026-06-01" }))).toBe(0);
    expect(gc(() => hooks.usePayBases?.({ everyone: true }))).toBe(0);
    expect(gc(() => hooks.useExport?.())).toBe(0);
    // A rosterer's roster and dry run carry who is away.
    expect(gc(() => hooks.useWeek?.({ from: "2026-06-01", to: "2026-06-07" }))).toBe(0);
    expect(gc(() => hooks.useCheck?.({ object: "rostering.shift", id: "shf_1" }))).toBe(0);
    expect(gc(() => hooks.useFeedRotate?.())).toBe(0);
    // Nothing of a note or a figure is in a query's key: only what was asked for.
    seen.length = 0;
    hooks.usePeriodTotals?.({ start: "2026-06-01" });
    expect(seen[0]?.options.queryKey).toEqual([
      "x.rostering.periodTotals",
      { start: "2026-06-01" },
    ]);
  });

  it("a new calendar address is on the host the client talks to, never one the page was given", async () => {
    const client = {
      ...clientWith(["x.rostering.feedRotate"]),
      baseUrl: "https://admin.example.com",
      mutation: (name: string) => ({
        mutationKey: [name],
        mutationFn: async () => ({
          path: "/api/v1/staffing/feed/tok.ics",
          createdAt: "2026-06-01",
        }),
      }),
    };
    const hooks = createRosteringHooks(react, client) as unknown as {
      useFeedRotate: () => { mutateAsync: (i: unknown) => Promise<unknown> };
    };
    expect(await hooks.useFeedRotate().mutateAsync({})).toEqual({
      https: "https://admin.example.com/api/v1/staffing/feed/tok.ics",
      webcal: "webcal://admin.example.com/api/v1/staffing/feed/tok.ics",
      createdAt: "2026-06-01",
    });
    const noHost = createRosteringHooks(
      react,
      clientWith(["x.rostering.feedRotate"]),
    ) as unknown as {
      useFeedRotate: () => { mutateAsync: (i: unknown) => Promise<unknown> };
    };
    await expect(noHost.useFeedRotate().mutateAsync({})).rejects.toThrow(/no host address/);
  });

  it("the export is fetched when asked, through the query, never as a cached query", async () => {
    const hooks = createRosteringHooks(react, clientWith(["x.rostering.export"])) as unknown as {
      useExport: () => { mutateAsync: (i: unknown) => Promise<unknown> };
    };
    seen.length = 0;
    const exported = hooks.useExport();
    expect(seen[0]?.options.mutationKey).toEqual(["x.rostering.export"]);
    expect(await exported.mutateAsync({ start: "2026-06-01" })).toEqual({
      name: "x.rostering.export",
      input: { start: "2026-06-01" },
    });
  });
});
