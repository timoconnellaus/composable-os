// The programs folder (`cos programs import`, stage 41): what a gym's converter writes from wherever
// its programming lived, read and checked here before anyone signs in. No file system and no
// terminal here: the command reads the folder (run.ts) and the tests give it in memory.
//
//   exercises.csv    key, name, measure, video, cues, theme, level, equipment, body_areas, easier,
//                    harder (a list is split by ";"; easier and harder name other rows' keys)
//   classtypes.csv   key, name, order
//   programs/*.txt   one program each in the pack's shorthand (x.programs.importText's), its file
//                    name (without .txt) its import key; a `Kind:` line says class, client or course
//   training.csv     past training, one row per set: email, date, session, exercise, set, reps,
//                    seconds, load, rpe, note, item, level, program, target_reps, target_seconds,
//                    target_load
//
// Every file is optional; a key is what the record is found by on a re-run, so it must stay the
// same between runs. A row's exercise is a key of exercises.csv or the name of one on the host; a
// row's program is a file of programs/. Every problem is named with its file and line.
import { parseCsv } from "../courses-import/format.ts";
import type { Problem } from "../import-door/records.ts";
import { realDate } from "../rostering-import/engine.ts";

export const EXERCISE = "programs.exercise";
export const CLASSTYPE = "programs.classtype";
export const PROGRAM = "programs.program";
export const SESSION = "programs.session";
export const LOG = "programs.log";

const MEASURES = ["weight_reps", "reps", "time", "hold"] as const;

/** The folder as its files' text. */
export interface ProgramsFolder {
  exercises: string | null;
  classTypes: string | null;
  /** programs/ files by name. */
  programs: Map<string, string>;
  training: string | null;
}

export interface ExercisePlan {
  key: string;
  file: string;
  name: string;
  values: Record<string, unknown>;
  /** Keys of other rows: the easier and harder versions. */
  easier: string[];
  harder: string[];
}

export interface ProgramPlan {
  key: string;
  file: string;
  text: string;
}

/** One set of past training, with its line. */
export interface TrainingRow {
  file: string;
  email: string;
  date: string;
  session: string;
  /** A key of exercises.csv, or the name of an exercise on the host. */
  exercise: string;
  setNumber: number;
  item: string | null;
  level: number | null;
  program: string | null;
  values: Record<string, unknown>;
}

export interface ProgramsPlan {
  exercises: ExercisePlan[];
  classTypes: { key: string; file: string; values: Record<string, unknown> }[];
  programs: ProgramPlan[];
  training: TrainingRow[];
  problems: Problem[];
}

/** A CSV with its header's names in snake case, and a cell reader. */
function table(text: string, name: string, problems: Problem[]) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const header = rows[0];
  if (!header) {
    problems.push({ file: name, message: "the file is empty" });
    return null;
  }
  const names = header.cells.map((c) =>
    c
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
  const column = (...options: string[]) => names.findIndex((n) => options.includes(n));
  return { header, names, column, rows: rows.slice(1) };
}

const listOf = (cell: string) =>
  cell
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean);

/** A number cell: undefined when empty, NaN when not a number. */
const numberOf = (cell: string): number | undefined =>
  cell.trim() === "" ? undefined : Number(cell.trim());

const today = () => new Date().toISOString().slice(0, 10);

/** Reads and checks the folder: what to import, or every problem with its file and line. */
export function readProgramsFolder(folder: ProgramsFolder): ProgramsPlan {
  const problems: Problem[] = [];
  const plan: ProgramsPlan = {
    exercises: [],
    classTypes: [],
    programs: [],
    training: [],
    problems,
  };

  if (folder.exercises !== null) {
    const name = "exercises.csv";
    const t = table(folder.exercises, name, problems);
    if (t) {
      const col = {
        key: t.column("key", "id"),
        name: t.column("name"),
        measure: t.column("measure", "measured_by"),
        video: t.column("video", "demo_video"),
        cues: t.column("cues", "coaching_cues"),
        theme: t.column("theme"),
        level: t.column("level"),
        equipment: t.column("equipment"),
        bodyAreas: t.column("body_areas", "bodyareas"),
        easier: t.column("easier"),
        harder: t.column("harder"),
      };
      if (col.name < 0) {
        problems.push({ file: `${name}:${t.header.line}`, message: "the header must name name" });
      } else {
        const seen = new Set<string>();
        for (const { line, cells } of t.rows) {
          const cell = (i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
          const at = `${name}:${line}`;
          const exerciseName = cell(col.name);
          const key = cell(col.key) || exerciseName;
          if (!exerciseName) {
            problems.push({ file: at, message: "no name" });
            continue;
          }
          if (seen.has(key)) {
            problems.push({ file: at, message: `the key "${key}" is there twice` });
            continue;
          }
          seen.add(key);
          const measure = cell(col.measure) || "reps";
          if (!(MEASURES as readonly string[]).includes(measure)) {
            problems.push({
              file: at,
              message: `measure is ${MEASURES.join(", ")}, not "${measure}"`,
            });
            continue;
          }
          const values: Record<string, unknown> = { name: exerciseName, measure };
          const put = (field: string, value: unknown) => {
            if (value !== "" && !(Array.isArray(value) && !value.length)) values[field] = value;
          };
          put("video", cell(col.video));
          put("cues", cell(col.cues));
          put("theme", cell(col.theme));
          put("level", cell(col.level));
          put("equipment", listOf(cell(col.equipment)));
          put("bodyAreas", listOf(cell(col.bodyAreas)));
          plan.exercises.push({
            key,
            file: at,
            name: exerciseName,
            values,
            easier: listOf(cell(col.easier)),
            harder: listOf(cell(col.harder)),
          });
        }
        for (const e of plan.exercises) {
          for (const other of [...e.easier, ...e.harder]) {
            if (other === e.key) {
              problems.push({
                file: e.file,
                message: "an exercise is not its own easier or harder version",
              });
            } else if (!seen.has(other)) {
              problems.push({
                file: e.file,
                message: `no row of exercises.csv has the key "${other}"`,
              });
            }
          }
        }
      }
    }
  }

  if (folder.classTypes !== null) {
    const name = "classtypes.csv";
    const t = table(folder.classTypes, name, problems);
    if (t) {
      const col = { key: t.column("key", "id"), name: t.column("name"), order: t.column("order") };
      if (col.name < 0) {
        problems.push({ file: `${name}:${t.header.line}`, message: "the header must name name" });
      } else {
        const seen = new Set<string>();
        for (const { line, cells } of t.rows) {
          const cell = (i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
          const at = `${name}:${line}`;
          const typeName = cell(col.name);
          const key = cell(col.key) || typeName;
          if (!typeName) {
            problems.push({ file: at, message: "no name" });
            continue;
          }
          if (seen.has(key)) {
            problems.push({ file: at, message: `the key "${key}" is there twice` });
            continue;
          }
          seen.add(key);
          const order = numberOf(cell(col.order));
          if (order !== undefined && !Number.isFinite(order)) {
            problems.push({ file: at, message: `the order is not a number: "${cell(col.order)}"` });
            continue;
          }
          plan.classTypes.push({
            key,
            file: at,
            values: { name: typeName, ...(order !== undefined ? { order } : {}) },
          });
        }
      }
    }
  }

  for (const [file, text] of [...folder.programs].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/\.txt$/i.test(file)) {
      problems.push({ file: `programs/${file}`, message: "a program is a .txt file of shorthand" });
      continue;
    }
    if (!text.trim()) {
      problems.push({ file: `programs/${file}`, message: "the file is empty" });
      continue;
    }
    plan.programs.push({ key: file.replace(/\.txt$/i, ""), file: `programs/${file}`, text });
  }

  if (folder.training !== null) {
    const name = "training.csv";
    const t = table(folder.training, name, problems);
    if (t) {
      const col = {
        email: t.column("email"),
        date: t.column("date"),
        session: t.column("session", "session_name"),
        exercise: t.column("exercise"),
        set: t.column("set", "set_number"),
        reps: t.column("reps", "actual_reps"),
        seconds: t.column("seconds", "actual_seconds"),
        load: t.column("load", "actual_load", "kg"),
        rpe: t.column("rpe", "effort"),
        note: t.column("note"),
        item: t.column("item"),
        level: t.column("level"),
        program: t.column("program"),
        targetReps: t.column("target_reps"),
        targetSeconds: t.column("target_seconds"),
        targetLoad: t.column("target_load"),
      };
      const missing = (["email", "date", "exercise"] as const).filter((c) => col[c] < 0);
      if (missing.length) {
        problems.push({
          file: `${name}:${t.header.line}`,
          message: `the header must name ${missing.join(", ")}`,
        });
      } else {
        const programKeys = new Set(plan.programs.map((p) => p.key));
        /** Sets counted per person, day, session, item and exercise, for rows with no set. */
        const counted = new Map<string, number>();
        const taken = new Set<string>();
        for (const { line, cells } of t.rows) {
          const cell = (i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
          const at = `${name}:${line}`;
          const problem = (message: string) => problems.push({ file: at, message });
          const email = cell(col.email).toLowerCase();
          const date = cell(col.date);
          const session = cell(col.session) || "Training";
          const exercise = cell(col.exercise);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            problem(`not an email address: "${cell(col.email)}"`);
            continue;
          }
          if (!realDate(date)) {
            problem(`the date is not a real date (YYYY-MM-DD): "${date}"`);
            continue;
          }
          if (date > today()) {
            problem(`${date} is after today: only past training is imported`);
            continue;
          }
          if (!exercise) {
            problem("no exercise");
            continue;
          }
          if (session.length > 200) {
            problem("the session's name is longer than 200 characters");
            continue;
          }
          const program = cell(col.program) || null;
          if (program && !programKeys.has(program)) {
            problem(`no file of programs/ is "${program}.txt"`);
            continue;
          }
          const numbers: Record<string, number | undefined> = {
            actualReps: numberOf(cell(col.reps)),
            actualSeconds: numberOf(cell(col.seconds)),
            actualLoad: numberOf(cell(col.load)),
            rpe: numberOf(cell(col.rpe)),
            targetReps: numberOf(cell(col.targetReps)),
            targetSeconds: numberOf(cell(col.targetSeconds)),
            targetLoad: numberOf(cell(col.targetLoad)),
          };
          const level = numberOf(cell(col.level));
          const set = numberOf(cell(col.set));
          const bad = Object.entries({ ...numbers, level, set }).find(
            ([, v]) => v !== undefined && !Number.isFinite(v),
          );
          if (bad) {
            problem(`${bad[0]} is not a number`);
            continue;
          }
          if (
            numbers.actualReps === undefined &&
            numbers.actualSeconds === undefined &&
            numbers.actualLoad === undefined
          ) {
            problem("nothing done: give reps, seconds or load");
            continue;
          }
          const item = cell(col.item) || null;
          const group = [email, date, session, item ?? "", exercise].join("\u0000");
          const setNumber = set ?? (counted.get(group) ?? 0) + 1;
          counted.set(group, Math.max(counted.get(group) ?? 0, setNumber));
          const setKey = `${group}\u0000${setNumber}`;
          if (taken.has(setKey)) {
            problem(`set ${setNumber} of ${exercise} on ${date} is there twice`);
            continue;
          }
          taken.add(setKey);
          const note = cell(col.note);
          plan.training.push({
            file: at,
            email,
            date,
            session,
            exercise,
            setNumber,
            item,
            level: level ?? null,
            program,
            values: Object.fromEntries(
              Object.entries({ ...numbers, ...(note ? { note } : {}) }).filter(
                ([, v]) => v !== undefined,
              ),
            ),
          });
        }
      }
    }
  }

  if (
    !problems.length &&
    !plan.exercises.length &&
    !plan.classTypes.length &&
    !plan.programs.length &&
    !plan.training.length
  ) {
    problems.push({
      file: "",
      message:
        "nothing to import: the folder has no exercises.csv, classtypes.csv, programs/ or training.csv rows",
    });
  }
  return plan;
}
