// `cos programs import <folder>` (stage 41): a gym's exercises, class types, programs in the pack's
// shorthand and past training, loaded into a host as the person running it, signed in for the run
// on the shared import door (import-door/, ADR 0470).
//
//   cos programs import ./programs --host https://admin.example.com [--email you@example.com]
//                       [--dry-run]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionHost } from "../import-door/host.ts";
import { signInForRun } from "../import-door/sign-in.ts";
import type { Io } from "../io.ts";
import { programsReportLines, runProgramsImport } from "./engine.ts";
import { type ProgramsFolder, readProgramsFolder } from "./format.ts";

export interface ProgramsImportFlags {
  host?: string;
  email?: string;
  dryRun?: boolean;
}

export const PROGRAMS_USAGE =
  "Usage: cos programs import <folder> --host <url> [--email <you>] [--dry-run]";

/** The folder as its files' text. */
export function readProgramsDisk(dir: string): ProgramsFolder {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${dir} is not a folder`);
  const text = (name: string) =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : null;
  const programsDir = join(root, "programs");
  return {
    exercises: text("exercises.csv"),
    classTypes: text("classtypes.csv"),
    programs: new Map(
      existsSync(programsDir)
        ? readdirSync(programsDir)
            .filter((n) => statSync(join(programsDir, n)).isFile() && !n.startsWith("."))
            .map((n) => [n, readFileSync(join(programsDir, n), "utf8")] as const)
        : [],
    ),
    training: text("training.csv"),
  };
}

/** `cos programs import <folder>`. */
export async function programsImport(
  positional: string[],
  flags: ProgramsImportFlags,
  io: Io,
): Promise<number> {
  const dir = positional[0];
  if (!dir) {
    io.err(
      `${PROGRAMS_USAGE}\n\nThe folder: exercises.csv, classtypes.csv, programs/*.txt (the shorthand), training.csv (past sets). See docs/importing.md.`,
    );
    return 2;
  }
  const host = flags.host?.replace(/\/+$/, "");
  if (!host || !/^https?:\/\//.test(host)) {
    io.err("--host is the host's address, e.g. https://admin.example.com");
    return 2;
  }
  let plan: ReturnType<typeof readProgramsFolder>;
  try {
    plan = readProgramsFolder(readProgramsDisk(dir));
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  if (plan.problems.length) {
    io.err(`Nothing was written: ${plan.problems.length} problem(s) in ${dir}.`);
    for (const p of plan.problems) io.err(`  ${p.file ? `${p.file}: ` : ""}${p.message}`);
    return 1;
  }
  io.out(
    `${plan.exercises.length} exercise(s), ${plan.classTypes.length} class type(s), ${plan.programs.length} program(s) and ${plan.training.length} logged set(s) in ${dir}.${flags.dryRun ? " A dry run: nothing is written." : ""}`,
  );
  let session: Awaited<ReturnType<typeof signInForRun>>;
  try {
    session = await signInForRun(host, flags.email, io, "cos programs import");
  } catch (error) {
    io.err(`Could not sign in: ${(error as Error).message}`);
    return 1;
  }
  try {
    const report = await runProgramsImport(
      plan,
      sessionHost(host, () => session.headers()),
      { dryRun: Boolean(flags.dryRun), progress: (line) => io.out(line) },
    );
    for (const line of programsReportLines(report, Boolean(flags.dryRun))) {
      (report.problems.length ? io.err : io.out)(line);
    }
    return report.problems.length ? 1 : 0;
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    return 1;
  } finally {
    await session.signOut();
  }
}
