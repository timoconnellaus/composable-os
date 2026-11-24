// The Daily checklists pack against the SDK's test host (ADR 0651): the manifest passes the
// contract (its screens, its tools open to every staff account or held to checklists:write), every
// tool asks the host's tool-only checklist operation it should and passes on what the host
// answered, and the headless entry only formats what the host gave. The host's rules (what is due,
// who may do it, who ticks for whom, the last tick finishing it, a finished or missed day never
// changing, who reads how a day went) are tested against the real host in
// apps/runner/test/checklists-standalone.test.ts.
import { createTestHost, type TestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import {
  addDays,
  DAILYCHECKS_HOOKS_CALL,
  type DayItem,
  dateLabel,
  dayRefusal,
  dayStateLabel,
  finishedLabel,
  stepsOf,
} from "../client/index.ts";
import dailychecks from "../index.ts";

const ME = { kind: "staff", userId: "usr_sam", name: "Sam" } as const;

const ITEM: DayItem = {
  template: { id: "ckl_1", name: "Opening up", purpose: null },
  date: "2026-06-02",
  who: { kind: "role", value: "rostering.team" },
  dueBy: "09:00",
  dueAt: "2026-06-01T23:00:00.000Z",
  opens: "2026-06-01T14:00:00.000Z",
  closes: "2026-06-02T14:00:00.000Z",
  state: "not_started",
  late: false,
  run: null,
  preview: [
    { text: "Lights on", required: true, asksNote: false },
    { text: "Note the fridge's temperature", required: false, asksNote: true },
  ],
  mayDo: true,
  canTick: true,
};

function hostWith(): TestHost {
  return createTestHost(dailychecks, {
    operations: {
      "checklist.today": () => ({
        zone: "Australia/Sydney",
        date: "2026-06-02",
        items: [ITEM],
        you: "usr_sam",
        youManage: false,
      }),
      "checklist.day": () => ({
        item: ITEM,
        zone: "Australia/Sydney",
        doers: null,
        you: "usr_sam",
        youManage: false,
      }),
      "checklist.dayTick": (input) => ({
        run: "ckr_1",
        step: (input as { step: number }).step,
        state: (input as { state: "done" }).state,
        ticked: 1,
        of: 2,
        finished: false,
      }),
      "checklist.dayDone": () => ({ run: "ckr_1", state: "done" }),
      "checklist.days": () => ({ zone: "Australia/Sydney", days: [], truncated: false }),
    },
  });
}

const callsTo = (host: TestHost, operation: string) =>
  host.calls.filter((c) => c.operation === operation);

describe("the manifest", () => {
  it("passes the contract, requires nothing and declares its two screens", () => {
    const host = hostWith();
    expect(host.issues).toEqual([]);
    expect(host.manifest.requires ?? []).toEqual([]);
    expect(host.manifest.screens).toEqual({
      today: {
        label: "Today's checklists",
        block: "dailychecks-today",
        export: "TodaysChecklists",
        nav: { group: "Checklists", order: 10 },
        opens: ["today", "tick"],
      },
      history: {
        label: "Checklist history",
        block: "dailychecks-history",
        export: "ChecklistHistory",
        nav: { group: "Checklists", order: 20 },
        opens: ["history"],
      },
    });
  });

  it("opens the doing to every staff account and the history to checklists:write, each a person's own", () => {
    const tools = hostWith().manifest.tools;
    for (const name of ["today", "day", "tick", "done"]) {
      expect(tools[name]?.anyStaff, name).toBe(true);
      expect(tools[name]?.permission, name).toBeUndefined();
    }
    expect(tools.history?.corePermission).toBe("checklists:write");
    expect(tools.history?.anyStaff).toBeUndefined();
    for (const name of Object.keys(tools)) expect(tools[name]?.humanOnly, name).toBe(true);
    // What someone writes on a step, why, and for whom: never in the audit log.
    expect(tools.tick?.redact).toEqual(["note", "why", "forWhy", "state"]);
    expect(tools.done?.redact).toEqual(["forWhy"]);
    // No objects, no roles, no grants: the rules are the host's.
    expect(Object.keys(hostWith().manifest.objects)).toEqual([]);
    expect(hostWith().manifest.roles).toEqual({});
  });
});

describe("the tools", () => {
  it("pass the host's answers on, and send nothing the host decides", async () => {
    const host = hostWith();
    const today = await host.runTool<{ items: DayItem[] }>("today", {}, { caller: ME });
    expect(today.items[0]?.template.name).toBe("Opening up");
    const day = { template: "ckl_1", date: "2026-06-02" };
    await host.runTool("day", day, { caller: ME });
    expect(callsTo(host, "checklist.day")[0]?.input).toEqual(day);
    await host.runTool("tick", { ...day, step: 0, state: "done" }, { caller: ME });
    expect(callsTo(host, "checklist.dayTick")[0]?.input).toEqual({
      ...day,
      step: 0,
      state: "done",
    });
    await host.runTool(
      "done",
      { ...day, for: "usr_ann", forWhy: "Opened for her" },
      { caller: ME },
    );
    expect(callsTo(host, "checklist.dayDone")[0]?.input).toMatchObject({ for: "usr_ann" });
    await host.runTool("history", { from: "2026-06-01", to: "2026-06-07" }, { caller: ME });
    expect(callsTo(host, "checklist.days")[0]?.input).toEqual({
      from: "2026-06-01",
      to: "2026-06-07",
    });
  });
});

describe("the headless entry", () => {
  it("formats only what the host gave", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dateLabel("2026-06-02", "en-AU")).toMatch(/2 Jun/);
    expect(dayStateLabel("not_started")).toBe("Not started");
    expect(dayStateLabel("missed")).toBe("Missed");
    expect(stepsOf(ITEM).map((s) => [s.text, s.tick])).toEqual([
      ["Lights on", null],
      ["Note the fridge's temperature", null],
    ]);
    expect(finishedLabel(ITEM)).toBeNull();
  });

  it("names each refusal's state, from the host's rule inside a tool's error", () => {
    const wrapped = (rule: string) => ({
      code: "tool_failed",
      message: "Only someone who manages checklists ticks one for someone else.",
      details: { details: { rule } },
    });
    expect(dayRefusal(wrapped("checklist_for_someone")).kind).toBe("checklist_for_someone");
    expect(dayRefusal(wrapped("checklist_closed")).kind).toBe("checklist_closed");
    expect(dayRefusal({ code: "not_found" }).kind).toBe("not_found");
    expect(dayRefusal({ name: "NetworkError" }).kind).toBe("network");
  });

  it("each hook names the one tool it calls", () => {
    expect(DAILYCHECKS_HOOKS_CALL).toEqual({
      useToday: ["x.dailychecks.today"],
      useDay: ["x.dailychecks.day"],
      useTick: ["x.dailychecks.tick"],
      useDone: ["x.dailychecks.done"],
      useHistory: ["x.dailychecks.history"],
    });
  });
});
