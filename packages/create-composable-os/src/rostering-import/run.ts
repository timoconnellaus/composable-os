// `cos rostering import <roster.csv>` (stage 45 step 7, the spec's "The move"), as the person
// running it, signed in for the run on the shared import door (import-door/, ADR 0470): duties and
// who works them, as weekly patterns and one-off shifts. A dry run unless --apply.
//
//   cos rostering import ./roster.csv --host https://admin.example.com [--email you@example.com]
//       [--apply]
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { hostOf, withRunSession } from "../import-door/sign-in.ts";
import type { Io } from "../io.ts";
import { readRosterFile, rosterReportLines, runRosterImport } from "./engine.ts";

export interface RosterImportFlags {
  host?: string;
  email?: string;
  apply?: boolean;
}

export const ROSTER_USAGE =
  "Usage: cos rostering import <roster.csv> --host <url> [--email <you>] [--apply]";

/** `cos rostering import <roster.csv>`. */
export async function rosteringImport(
  positional: string[],
  flags: RosterImportFlags,
  io: Io,
): Promise<number> {
  const path = positional[0];
  if (!path) {
    io.err(
      `${ROSTER_USAGE}\n\nThe file: a header naming duty, time and length, and weekdays with first_date (a weekly pattern) or date (one shift); optionally staff_email, last_date, zone and place. A dry run unless --apply. See docs/importing.md.`,
    );
    return 2;
  }
  const host = hostOf(flags.host, io);
  if (!host) return 2;
  if (!existsSync(path) || !statSync(path).isFile()) {
    io.err(`${path} is not a file`);
    return 2;
  }
  const name = basename(path);
  const file = readRosterFile(readFileSync(path, "utf8"), name);
  if (file.problems.length) {
    io.err(`Nothing was sent: ${file.problems.length} problem(s) in ${name}.`);
    for (const p of file.problems) io.err(`  ${p.file}: ${p.message}`);
    return 1;
  }
  io.out(
    `${file.rows.length} row(s) in ${name}.${flags.apply ? "" : " A dry run: nothing is written."}`,
  );
  return withRunSession(host, flags.email, io, "cos rostering import", async (on) => {
    try {
      const report = await runRosterImport(file, on, {
        apply: Boolean(flags.apply),
        name,
        progress: (line) => io.out(line),
      });
      for (const line of rosterReportLines(report, name)) {
        (report.problems.length ? io.err : io.out)(line);
      }
      return report.problems.length ? 1 : 0;
    } catch (error) {
      io.err(`Error: ${(error as Error).message}`);
      return 1;
    }
  });
}
