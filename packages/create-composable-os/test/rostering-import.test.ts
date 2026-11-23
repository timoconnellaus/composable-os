// `cos rostering import` (stage 45 step 7, the spec's "The move"): the file it reads and the
// problems it names with their line before anyone signs in, staff never made by an import, the
// host's own dry run of every row together (`x.rostering.planCheck`: the clash check the writes
// and the reconcile make), a dry run by default, and with --apply everything written through
// record.create, a clashing one-off shift with nobody on it, and nothing made twice on a re-run.
// Every name and address here is invented.
import { describe, expect, it } from "vitest";
import type { ImportHost } from "../src/import-door/host.ts";
import { runCli } from "../src/main.ts";
import {
  readRosterFile,
  rosterReportLines,
  runRosterImport,
  weekdaysOf,
} from "../src/rostering-import/engine.ts";

const FILE = [
  "duty,weekdays,first_date,last_date,date,time,length,staff_email,place",
  "Close-down clean,Mon Wed Fri,2030-03-04,,,18:00,60,cleaner@example.com,Main floor",
  "Open up,,,,2030-03-05,05:30,30,coach@example.com,",
  "Open up,sat,2030-03-09,2030-06-29,,06:00,45,,",
].join("\n");

describe("the roster file", () => {
  it("reads weekly patterns and one-off shifts by header, each with its line", () => {
    const file = readRosterFile(FILE);
    expect(file.problems).toEqual([]);
    expect(file.rows).toEqual([
      {
        line: 2,
        duty: "Close-down clean",
        time: "18:00",
        length: 60,
        weekdays: ["mon", "wed", "fri"],
        firstDate: "2030-03-04",
        staffEmail: "cleaner@example.com",
        place: "Main floor",
      },
      {
        line: 3,
        duty: "Open up",
        time: "05:30",
        length: 30,
        date: "2030-03-05",
        staffEmail: "coach@example.com",
      },
      {
        line: 4,
        duty: "Open up",
        time: "06:00",
        length: 45,
        weekdays: ["sat"],
        firstDate: "2030-03-09",
        lastDate: "2030-06-29",
      },
    ]);
    expect(weekdaysOf("Friday, monday")).toEqual(["mon", "fri"]);
    expect(weekdaysOf("someday")).toBeNull();
  });

  it("names every problem with its file and line", () => {
    const file = readRosterFile(
      [
        "duty,weekdays,first_date,date,time,length,staff_email,zone",
        ",mon,2030-03-04,,18:00,60,,",
        "Clean,mon,2030-03-04,,6pm,60,,",
        "Clean,mon,2030-03-04,,18:00,0,,",
        "Clean,mon,2030-02-30,,18:00,60,,",
        "Clean,someday,2030-03-04,,18:00,60,,",
        "Clean,mon,2030-03-04,2030-03-05,18:00,60,,",
        "Clean,,,2030-03-05,18:00,60,not-an-address,",
        "Clean,,,2030-03-05,18:00,60,,Not a zone",
      ].join("\n"),
      "moving.csv",
    );
    expect(file.problems.map((p) => p.file)).toEqual([
      "moving.csv:2",
      "moving.csv:3",
      "moving.csv:4",
      "moving.csv:5",
      "moving.csv:6",
      "moving.csv:7",
      "moving.csv:8",
      "moving.csv:9",
    ]);
    expect(file.problems[1]?.message).toContain("not HH:MM");
    expect(file.problems[5]?.message).toContain("not both");
    expect(readRosterFile("name,when\nx,y").problems[0]?.message).toMatch(/must name duty/);
    expect(readRosterFile("").problems[0]?.message).toBe("the file is empty");
  });
});

/** A host that answers as the real one does, and records what it was sent. */
function fakeHost(
  options: {
    staff?: Record<string, string>;
    duties?: Record<string, string>;
    clash?: (plan: Record<string, unknown>) => boolean;
    series?: { id: string; values: Record<string, unknown> }[];
    shifts?: { id: string; values: Record<string, unknown> }[];
  } = {},
) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let made = 0;
  const host: ImportHost = {
    async call<T>(name: string, input: unknown): Promise<T> {
      const i = input as Record<string, unknown>;
      calls.push({ name, input: i });
      if (name === "user.list") {
        const email = (i.filter as { value: string }).value;
        const id = options.staff?.[email];
        return { items: id ? [{ id, email }] : [] } as T;
      }
      if (name === "record.list") {
        const filter = i.filter as { field?: string; value?: string; and?: unknown[] };
        if (i.object === "rostering.duty") {
          const id = options.duties?.[filter.value ?? ""];
          return { items: id ? [{ id, values: { name: filter.value } }] : [] } as T;
        }
        if (i.object === "rostering.dutyseries") return { items: options.series ?? [] } as T;
        return { items: options.shifts ?? [] } as T;
      }
      if (name === "x.rostering.planCheck") {
        const plans = i.plans as Record<string, unknown>[];
        return {
          plans: plans.map((plan) => ({
            key: plan.key,
            dates: plan.date ? 1 : 8,
            clashes:
              options.clash?.(plan) === true
                ? [
                    {
                      date: (plan.date as string) ?? "2030-03-06",
                      startsAt: "2030-03-05T05:30:00.000Z",
                      other: {
                        title: "Strength",
                        startsAt: "2030-03-05T05:00:00.000Z",
                        endsAt: "2030-03-05T06:00:00.000Z",
                      },
                      ended: false,
                    },
                  ]
                : [],
            away: plan.account === "usr_cleaner" ? ["2030-03-11"] : [],
            notQualified: plan.account === "usr_coach",
            first: plan.date
              ? {
                  date: plan.date,
                  startsAt: "2030-03-04T18:30:00.000Z",
                  endsAt: "2030-03-04T19:00:00.000Z",
                }
              : null,
          })),
          truncated: false,
        } as T;
      }
      if (name === "record.create") return { id: `rec_${++made}` } as T;
      throw new Error(`unexpected ${name}`);
    },
    async upload() {
      throw new Error("no uploads");
    },
  };
  return { host, calls };
}

const staff = { "cleaner@example.com": "usr_cleaner", "coach@example.com": "usr_coach" };

describe("the import", () => {
  it("stops before writing anything when a row names someone with no staff account", async () => {
    const { host, calls } = fakeHost({ staff: { "cleaner@example.com": "usr_cleaner" } });
    const report = await runRosterImport(readRosterFile(FILE), host, { apply: true });
    expect(report.problems).toEqual([
      {
        file: "roster.csv:3",
        message:
          "no staff account has coach@example.com: invite them first (an import never makes an account)",
      },
    ]);
    expect(calls.filter((c) => c.name === "record.create")).toEqual([]);
    expect(rosterReportLines(report, "roster.csv")[0]).toBe("Nothing was written: 1 problem(s).");
  });

  it("a dry run asks the host about every row at once and writes nothing", async () => {
    const { host, calls } = fakeHost({ staff, clash: (p) => p.date === "2030-03-05" });
    const report = await runRosterImport(readRosterFile(FILE), host, { apply: false });
    const checks = calls.filter((c) => c.name === "x.rostering.planCheck");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.input.plans).toEqual([
      {
        key: "line 2",
        kind: null,
        account: "usr_cleaner",
        time: "18:00",
        length: 60,
        weekdays: ["mon", "wed", "fri"],
        firstDate: "2030-03-04",
      },
      {
        key: "line 3",
        kind: null,
        account: "usr_coach",
        time: "05:30",
        length: 30,
        date: "2030-03-05",
      },
      {
        key: "line 4",
        kind: null,
        account: null,
        time: "06:00",
        length: 45,
        weekdays: ["sat"],
        firstDate: "2030-03-09",
        lastDate: "2030-06-29",
      },
    ]);
    expect(calls.filter((c) => c.name === "record.create")).toEqual([]);
    const lines = rosterReportLines(report, "roster.csv");
    expect(lines).toContain(
      "  clash on 2030-03-05: already on Strength at 2030-03-05T05:00:00.000Z: made with nobody on it",
    );
    expect(lines).toContain("  warning: away on 2030-03-11");
    expect(lines).toContain("  warning: not marked as qualified for this duty");
    expect(lines.at(-1)).toMatch(/Dry run: nothing was written/);
  });

  it("with --apply, writes through record.create: the duty, the pattern with its person, and a clashing shift with nobody on it", async () => {
    const { host, calls } = fakeHost({ staff, clash: (p) => p.date === "2030-03-05" });
    const report = await runRosterImport(readRosterFile(FILE), host, { apply: true });
    expect(report.problems).toEqual([]);
    const creates = calls.filter((c) => c.name === "record.create").map((c) => c.input);
    expect(creates).toEqual([
      { object: "rostering.duty", values: { name: "Close-down clean", place: "Main floor" } },
      {
        object: "rostering.dutyseries",
        values: {
          duty: "rec_1",
          weekdays: ["mon", "wed", "fri"],
          time: "18:00",
          length: 60,
          firstDate: "2030-03-04",
          staff: "usr_cleaner",
        },
      },
      { object: "rostering.duty", values: { name: "Open up" } },
      {
        object: "rostering.shift",
        // The host placed it in its zone; it clashes, so nobody is on it.
        values: {
          duty: "rec_3",
          startsAt: "2030-03-04T18:30:00.000Z",
          endsAt: "2030-03-04T19:00:00.000Z",
        },
      },
      {
        object: "rostering.dutyseries",
        values: {
          duty: "rec_3",
          weekdays: ["sat"],
          time: "06:00",
          length: 45,
          firstDate: "2030-03-09",
          lastDate: "2030-06-29",
        },
      },
    ]);
    expect(report.rows.map((r) => r.outcome)).toEqual(["created", "created", "created"]);
    expect(report.dutiesCreated).toEqual(["Close-down clean", "Open up"]);
  });

  it("a re-run makes nothing twice", async () => {
    const { host, calls } = fakeHost({
      staff,
      duties: { "Close-down clean": "dty_1", "Open up": "dty_2" },
      series: [
        {
          id: "dse_1",
          values: { time: "18:00", firstDate: "2030-03-04", weekdays: ["mon", "wed", "fri"] },
        },
        { id: "dse_2", values: { time: "06:00", firstDate: "2030-03-09", weekdays: ["sat"] } },
      ],
      shifts: [{ id: "shf_1", values: {} }],
    });
    const report = await runRosterImport(readRosterFile(FILE), host, { apply: true });
    expect(calls.filter((c) => c.name === "record.create")).toEqual([]);
    expect(report.rows.map((r) => r.outcome)).toEqual(["exists", "exists", "exists"]);
    // Known duties go to the host's check as the kind of work, for its qualification warning.
    const plans = calls.find((c) => c.name === "x.rostering.planCheck")?.input.plans as {
      kind: unknown;
    }[];
    expect(plans[0]?.kind).toEqual({ object: "rostering.duty", id: "dty_1" });
  });
});

describe("cos rostering import", () => {
  it("says how to use it, and needs a file and a host", async () => {
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    expect(await runCli(["rostering"], { io } as never)).toBe(2);
    expect(out.join("\n")).toContain("cos rostering import <roster.csv>");
    expect(await runCli(["rostering", "import"], { io } as never)).toBe(2);
    expect(
      await runCli(["rostering", "import", "nowhere.csv", "--host", "https://admin.example.com"], {
        io,
      } as never),
    ).toBe(2);
    expect(out.join("\n")).toContain("nowhere.csv is not a file");
  });
});
