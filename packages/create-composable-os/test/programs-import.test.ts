// `cos programs import` (stage 41): the folder it reads and every problem it names with its file
// and line before anyone signs in, and the command refusing a bad folder before it calls the host.
// The engine against a real host is apps/app/test/programs-import.test.ts. Every name and address
// here is invented.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Redactor } from "../src/io.ts";
import { runCli } from "../src/main.ts";
import { type ProgramsFolder, readProgramsFolder } from "../src/programs-import/format.ts";
import { readProgramsDisk } from "../src/programs-import/run.ts";

const folder = (change: Partial<ProgramsFolder> = {}): ProgramsFolder => ({
  exercises: [
    "key,name,measure,equipment,easier,harder",
    "row,Ring row,weight_reps,rings;band,,pull",
    "pull,Pull up,reps,bar,row,",
  ].join("\n"),
  classTypes: "name,order\nMobility,1",
  programs: new Map([["strength.txt", "Session: Monday\nA1: Pull up x 5"]]),
  training: [
    "email,date,session,exercise,set,reps,load,rpe,item",
    "Ana@Example.com,2025-03-03,Pull day,pull,,5,,8,A1",
    "ana@example.com,2025-03-03,Pull day,pull,,4,,9,A1",
    "ana@example.com,2025-03-03,Pull day,row,3,8,20,,A2",
  ].join("\n"),
  ...change,
});

describe("the programs folder", () => {
  it("reads exercises, class types, programs and past sets, each with its file and line", () => {
    const plan = readProgramsFolder(folder());
    expect(plan.problems).toEqual([]);
    expect(plan.exercises).toEqual([
      {
        key: "row",
        file: "exercises.csv:2",
        name: "Ring row",
        values: { name: "Ring row", measure: "weight_reps", equipment: ["rings", "band"] },
        easier: [],
        harder: ["pull"],
      },
      {
        key: "pull",
        file: "exercises.csv:3",
        name: "Pull up",
        values: { name: "Pull up", measure: "reps", equipment: ["bar"] },
        easier: ["row"],
        harder: [],
      },
    ]);
    expect(plan.classTypes).toEqual([
      { key: "Mobility", file: "classtypes.csv:2", values: { name: "Mobility", order: 1 } },
    ]);
    expect(plan.programs).toEqual([
      { key: "strength", file: "programs/strength.txt", text: "Session: Monday\nA1: Pull up x 5" },
    ]);
    // Set numbers counted where the file leaves them out; the address as one person's.
    expect(plan.training.map((r) => [r.file, r.email, r.setNumber, r.values])).toEqual([
      ["training.csv:2", "ana@example.com", 1, { actualReps: 5, rpe: 8 }],
      ["training.csv:3", "ana@example.com", 2, { actualReps: 4, rpe: 9 }],
      ["training.csv:4", "ana@example.com", 3, { actualReps: 8, actualLoad: 20 }],
    ]);
  });

  it("names every problem with its file and line", () => {
    const plan = readProgramsFolder(
      folder({
        exercises: [
          "key,name,measure,easier",
          "row,Ring row,kilos,",
          "pull,Pull up,reps,nothing",
          "pull,Pull up again,reps,",
          "self,Self,reps,self",
        ].join("\n"),
        programs: new Map([
          ["strength.json", "{}"],
          ["empty.txt", "  "],
        ]),
        training: [
          "email,date,session,exercise,set,reps,program",
          "not-an-email,2025-03-03,Pull day,pull,,5,",
          "ana@example.com,2025-02-30,Pull day,pull,,5,",
          "ana@example.com,2999-01-01,Pull day,pull,,5,",
          "ana@example.com,2025-03-03,Pull day,pull,,,",
          "ana@example.com,2025-03-03,Pull day,pull,1,5,",
          "ana@example.com,2025-03-03,Pull day,pull,1,6,",
          "ana@example.com,2025-03-03,Pull day,pull,,lots,",
          "ana@example.com,2025-03-03,Pull day,pull,,5,elsewhere",
        ].join("\n"),
      }),
    );
    expect(plan.problems).toEqual([
      { file: "exercises.csv:2", message: "measure is weight_reps, reps, time, hold, not \"kilos\"" },
      { file: "exercises.csv:4", message: 'the key "pull" is there twice' },
      { file: "exercises.csv:3", message: 'no row of exercises.csv has the key "nothing"' },
      { file: "exercises.csv:5", message: "an exercise is not its own easier or harder version" },
      { file: "programs/empty.txt", message: "the file is empty" },
      { file: "programs/strength.json", message: "a program is a .txt file of shorthand" },
      { file: "training.csv:2", message: 'not an email address: "not-an-email"' },
      {
        file: "training.csv:3",
        message: 'the date is not a real date (YYYY-MM-DD): "2025-02-30"',
      },
      { file: "training.csv:4", message: "2999-01-01 is after today: only past training is imported" },
      { file: "training.csv:5", message: "nothing done: give reps, seconds or load" },
      { file: "training.csv:7", message: "set 1 of pull on 2025-03-03 is there twice" },
      { file: "training.csv:8", message: "actualReps is not a number" },
      { file: "training.csv:9", message: 'no file of programs/ is "elsewhere.txt"' },
    ]);
  });

  it("an empty folder is a problem, not a run that does nothing", () => {
    expect(
      readProgramsFolder({ exercises: null, classTypes: null, programs: new Map(), training: null })
        .problems,
    ).toMatchObject([{ message: expect.stringContaining("nothing to import") }]);
  });

  it("reads the folder from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-programs-"));
    mkdirSync(join(dir, "programs"));
    writeFileSync(join(dir, "exercises.csv"), "name\nPull up");
    writeFileSync(join(dir, "programs", "a.txt"), "Session: Monday");
    writeFileSync(join(dir, "programs", ".DS_Store"), "");
    expect(readProgramsDisk(dir)).toEqual({
      exercises: "name\nPull up",
      classTypes: null,
      programs: new Map([["a.txt", "Session: Monday"]]),
      training: null,
    });
  });

  it("stops on a bad folder before signing in, and asks for --host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-programs-"));
    writeFileSync(join(dir, "exercises.csv"), "name,measure\nPull up,kilos");
    const out: string[] = [];
    const deps: Parameters<typeof runCli>[1] = {
      io: {
        interactive: false,
        out: (l) => out.push(l),
        err: (l) => out.push(l),
        ask: async () => {
          throw new Error("no prompts in tests");
        },
      },
      redactor: new Redactor(),
      env: {},
      ghVerifier: null,
      fetch: (async () => {
        throw new Error("no network in this test");
      }) as never,
    };
    expect(await runCli(["programs", "import", dir], deps)).toBe(2);
    expect(out.join("\n")).toContain("--host");
    out.length = 0;
    expect(
      await runCli(["programs", "import", dir, "--host", "https://admin.example.com", "--dry-run"], deps),
    ).toBe(1);
    expect(out.join("\n")).toContain('exercises.csv:2: measure is weight_reps, reps, time, hold, not "kilos"');
    expect(await runCli(["programs", "export"], deps)).toBe(2);
  });
});
