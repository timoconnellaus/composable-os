// The programs import itself (stage 41): a plan (format.ts) written to a host through its HTTP
// surface as the person signed in for the run, on the shared import door (import-door/, ADR 0470):
// `record.import` with import keys, a dry run of everything first, a person's edit reported as a
// conflict and never overwritten. No file system and no terminal here.
//
// The order, so nothing is written before everything is checked, and each batch can name what the
// one before it made:
//   1. the folder's own problems;
//   2. reads: the bank the host has (a training row may name one of its exercises by name), and who
//      each training row is (the one live Person with its email; none, or more than one, is
//      reported with its line and the row left out);
//   3. every batch as a dry run, records not yet made named by placeholders, and every program's
//      shorthand read by the pack's own reader (`readProgramText`) against the bank and the
//      folder's exercises, every line it cannot read a problem;
//   4. only then, unless dryRun: class types, exercises, their easier and harder versions,
//      programs (working copies, never published), past sessions and their sets, each batch
//      naming the records the ones before made by id.
// Past sessions and sets are marked `source: import`. Written by the import door, they start no
// automation and send no message (the event origin says `imported`, ADR 0470 amended).
import { type BankExercise, readProgramText } from "@composable-os/pack-programs";
import { personFor } from "../courses-import/engine.ts";
import type { ImportHost } from "../import-door/host.ts";
import {
  type ImportResult,
  importRecords,
  outcomeLines,
  type Problem,
} from "../import-door/records.ts";
import {
  CLASSTYPE,
  EXERCISE,
  LOG,
  PROGRAM,
  type ProgramsPlan,
  SESSION,
  type TrainingRow,
} from "./format.ts";

export interface ProgramsImportOptions {
  dryRun?: boolean;
  progress?: (line: string) => void;
}

export interface ProgramsImportReport {
  problems: Problem[];
  records: ImportResult[];
  /** Rows that matched nothing on the host: left out, with their file and line. */
  unmatched: Problem[];
  notes: Problem[];
  wroteNothing: boolean;
}

interface Page {
  items: { id: string; values: Record<string, unknown> }[];
  nextCursor?: string | null;
}

/** A name as the shorthand reader matches it. */
const norm = (name: string) =>
  name
    .toLowerCase()
    .replace(/[’'"“”]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Every exercise of the host's bank (a read, in pages). */
async function hostBank(host: ImportHost): Promise<BankExercise[]> {
  const out: BankExercise[] = [];
  let cursor: string | null | undefined;
  do {
    const page: Page = await host.call("record.list", {
      object: EXERCISE,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const e of page.items) {
      out.push({
        id: e.id,
        name: String(e.values.name ?? ""),
        measure: typeof e.values.measure === "string" ? e.values.measure : null,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** The key a past session is found by again: its person (or class), day and name. */
const sessionKey = (person: string, row: TrainingRow) => `${person}|${row.date}|${row.session}`;

/** Runs the import. Throws only for what the host refused outright (a session that ended). */
export async function runProgramsImport(
  plan: ProgramsPlan,
  host: ImportHost,
  options: ProgramsImportOptions = {},
): Promise<ProgramsImportReport> {
  const report: ProgramsImportReport = {
    problems: [...plan.problems],
    records: [],
    unmatched: [],
    notes: [],
    wroteNothing: true,
  };
  if (report.problems.length) return report;
  const say = options.progress ?? (() => {});

  // 2. What the host has: its bank, and who each training row is.
  const bank = await hostBank(host);
  const folderExercise = new Map(plan.exercises.map((e) => [e.key, e]));
  const bankByName = new Map<string, BankExercise[]>();
  for (const e of bank) bankByName.set(norm(e.name), [...(bankByName.get(norm(e.name)) ?? []), e]);
  // A training row names an exercise by its key in exercises.csv, or by name: the folder's first,
  // then the host's.
  const folderByName = new Map(plan.exercises.map((e) => [norm(e.name), e.key]));
  const exerciseKeyOf = (row: TrainingRow) =>
    folderExercise.has(row.exercise) ? row.exercise : folderByName.get(norm(row.exercise));
  const onHost = new Map<string, BankExercise>();
  for (const row of plan.training) {
    if (exerciseKeyOf(row) || onHost.has(row.exercise)) continue;
    const hits = bankByName.get(norm(row.exercise)) ?? [];
    if (hits.length === 1) onHost.set(row.exercise, hits[0] as BankExercise);
    else {
      report.problems.push({
        file: row.file,
        message: hits.length
          ? `${hits.length} exercises on the host are called "${row.exercise}": give it a row of exercises.csv`
          : `"${row.exercise}" is no key of exercises.csv and no exercise on the host`,
      });
    }
  }
  if (report.problems.length) return report;
  const people = new Map<string, { id: string } | { problem: string }>();
  for (const email of new Set(plan.training.map((r) => r.email))) {
    people.set(email, await personFor(host, email));
  }
  const training = plan.training.flatMap((row) => {
    const who = people.get(row.email);
    if (!who || "problem" in who) {
      report.unmatched.push({ file: row.file, message: who?.problem ?? "No person" });
      return [];
    }
    return [{ row, person: who.id }];
  });

  /** Every batch, in order: a dry run with placeholders, or the writes. */
  const batches = async (dryRun: boolean): Promise<ImportResult[]> => {
    let n = 0;
    const placeholders = new Map<string, string>();
    const idOf = (results: ImportResult[], what: string) => {
      const ids = new Map<string, string>();
      for (const r of results) {
        if (r.id) ids.set(r.key, r.id);
        else if (dryRun && r.outcome !== "invalid") {
          const at = `${what}:${r.key}`;
          if (!placeholders.has(at)) placeholders.set(at, `rec_importplaceholder${++n}`);
          ids.set(r.key, placeholders.get(at) as string);
        }
      }
      return ids;
    };
    const options = { dryRun, checkReferences: !dryRun };
    const out: ImportResult[] = [];
    const step = async (
      object: string,
      label: string,
      records: { key: string; file: string | null; values: Record<string, unknown> }[],
    ) => {
      if (!records.length) return [];
      if (!dryRun) say(`${label}: ${records.length}…`);
      const results = await importRecords(host, object, records, options);
      out.push(...results);
      return results;
    };

    // Class types.
    await step(
      CLASSTYPE,
      "Class types",
      plan.classTypes.map((c) => ({ key: c.key, file: c.file, values: c.values })),
    );

    // Exercises, then their easier and harder versions (they name each other). A dry run checks
    // both at once, since a record not yet made cannot be updated.
    const exerciseResults = await step(
      EXERCISE,
      "Exercises",
      plan.exercises.map((e) => ({ key: e.key, file: e.file, values: e.values })),
    );
    const exerciseIds = idOf(exerciseResults, "exercise");
    const linked = plan.exercises.filter((e) => e.easier.length || e.harder.length);
    const versions = (e: (typeof linked)[number]) => ({
      ...(e.easier.length ? { easier: e.easier.map((k) => exerciseIds.get(k) as string) } : {}),
      ...(e.harder.length ? { harder: e.harder.map((k) => exerciseIds.get(k) as string) } : {}),
    });
    const ready = linked.filter((e) =>
      [e.key, ...e.easier, ...e.harder].every((k) => exerciseIds.has(k)),
    );
    if (dryRun) {
      // Checked as the record will be: its values with its versions.
      const checked = await importRecords(
        host,
        EXERCISE,
        ready.map((e) => ({ key: e.key, file: e.file, values: { ...e.values, ...versions(e) } })),
        options,
      );
      for (const r of checked) if (r.outcome === "invalid") out.push(r);
    } else {
      await step(
        EXERCISE,
        "Easier and harder versions",
        ready.map((e) => ({ key: e.key, file: e.file, values: versions(e) })),
      );
    }

    // Programs: the pack's reader, over the host's bank and the folder's exercises.
    const readBank: BankExercise[] = [
      ...bank,
      ...plan.exercises.flatMap((e) => {
        const id = exerciseIds.get(e.key);
        return id ? [{ id, name: e.name, measure: String(e.values.measure) }] : [];
      }),
    ];
    const programRecords: { key: string; file: string; values: Record<string, unknown> }[] = [];
    const titles = new Map<string, string>();
    for (const p of plan.programs) {
      const read = readProgramText(p.text, readBank);
      for (const u of read.unread) {
        const where = u.line ? `${p.file}:${u.line}` : p.file;
        if (u.reason.startsWith("kept as warm-up text")) {
          if (dryRun) report.notes.push({ file: where, message: `${u.text} (${u.reason})` });
          continue;
        }
        report.problems.push({ file: where, message: `${u.text}: ${u.reason}` });
      }
      const title = read.title ?? p.key;
      titles.set(p.key, title);
      programRecords.push({
        key: p.key,
        file: p.file,
        values: {
          title,
          kind: read.kind ?? "class",
          guidance: read.guidance,
          layout: read.layout,
        },
      });
    }
    if (report.problems.length) return out;
    const programIds = idOf(await step(PROGRAM, "Programs", programRecords), "program");

    // Past sessions: one per person, day and name, done, marked as imported.
    const sessions = new Map<
      string,
      { key: string; file: string; values: Record<string, unknown> }
    >();
    for (const { row, person } of training) {
      const key = sessionKey(person, row);
      const program = row.program ? programIds.get(row.program) : undefined;
      const had = sessions.get(key);
      if (had) {
        if (program && !had.values.program) had.values.program = program;
        continue;
      }
      sessions.set(key, {
        key,
        file: row.file,
        values: {
          name: row.session,
          person,
          date: row.date,
          state: "done",
          source: "import",
          ...(program ? { program } : {}),
        },
      });
    }
    const sessionIds = idOf(await step(SESSION, "Past sessions", [...sessions.values()]), "session");

    // Their sets, each naming its session, person and exercise by id.
    const logs = training.flatMap(({ row, person }) => {
      const session = sessionIds.get(sessionKey(person, row));
      const folderKey = exerciseKeyOf(row);
      const exercise = folderKey ? exerciseIds.get(folderKey) : onHost.get(row.exercise)?.id;
      if (!session || !exercise) return [];
      const name = folderKey
        ? folderExercise.get(folderKey)?.name
        : onHost.get(row.exercise)?.name;
      return [
        {
          key: `${sessionKey(person, row)}|${row.item ?? ""}|${exercise}|${row.setNumber}`,
          file: row.file,
          values: {
            label: `${row.item ?? name ?? "Set"} set ${row.setNumber}`,
            person,
            session,
            exercise,
            ...(name ? { exerciseName: name } : {}),
            ...(row.item ? { item: row.item } : {}),
            setNumber: row.setNumber,
            ...(row.level !== null ? { level: row.level } : {}),
            date: row.date,
            ...row.values,
            source: "import",
          },
        },
      ];
    });
    await step(LOG, "Logged sets", logs);
    return out;
  };

  // 3. The dry run: every batch through the host's own checks, before any write.
  const dry = await batches(true);
  for (const r of dry) {
    if (r.outcome === "invalid") {
      for (const message of r.problems) report.problems.push({ file: r.file ?? r.key, message });
    }
  }
  if (report.problems.length || options.dryRun) {
    report.records = dry.filter((r) => r.outcome !== "invalid");
    return report;
  }

  // 4. The writes, in order.
  report.records = await batches(false);
  for (const r of report.records) {
    if (r.outcome === "invalid") {
      for (const message of r.problems) report.problems.push({ file: r.file ?? r.key, message });
    }
  }
  if (report.records.some((r) => r.outcome === "created" || r.outcome === "updated")) {
    report.wroteNothing = false;
  }
  return report;
}

/** The report as lines for a person to read. */
export function programsReportLines(report: ProgramsImportReport, dryRun: boolean): string[] {
  const lines: string[] = [];
  if (report.problems.length) {
    lines.push(
      `${report.wroteNothing ? "Nothing was written" : "Stopped"}: ${report.problems.length} problem(s).`,
    );
    for (const p of report.problems) lines.push(`  ${p.file}: ${p.message}`);
    return lines;
  }
  const by = (object: string) => report.records.filter((r) => r.object === object);
  for (const [object, label] of [
    [CLASSTYPE, "Class types"],
    [EXERCISE, "Exercises"],
    [PROGRAM, "Programs"],
    [SESSION, "Past sessions"],
    [LOG, "Logged sets"],
  ] as const) {
    const records = by(object);
    if (!records.length) continue;
    lines.push(`${label}:`);
    for (const line of outcomeLines(records, dryRun)) lines.push(`  ${line}`);
  }
  if (report.unmatched.length) {
    lines.push(`${report.unmatched.length} row(s) matched nothing and were left out:`);
    for (const u of report.unmatched) lines.push(`  ${u.file}: ${u.message}`);
  }
  for (const note of report.notes) lines.push(`  ${note.file}: ${note.message}`);
  lines.push(
    dryRun
      ? "Dry run: nothing was written. Run again without --dry-run to import."
      : "Done. Programs are working copies: a person with the publish permission publishes them.",
  );
  return lines;
}
