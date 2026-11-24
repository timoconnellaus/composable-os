// `cos subscriptions offers import <offers.csv>` and `cos subscriptions offers report` (stage 32a,
// build step 4, ADRs 0491 and 0492), as the person running them, signed in for the run on the
// shared import door (import-door/, ADR 0470).
//
//   cos subscriptions offers import ./offers.csv --host https://admin.example.com
//       --plan courses.plan[:<id>] [--email you@example.com] [--dry-run] [--invite]
//   cos subscriptions offers report --host https://admin.example.com [--status taken]
//       [--out report.csv] [--email you@example.com]
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { hostOf, withRunSession } from "../import-door/sign-in.ts";
import type { Io } from "../io.ts";
import { offersReportLines, readOffersFile, resolvePlan, runOffersImport } from "./engine.ts";

export interface OffersImportFlags {
  host?: string;
  email?: string;
  plan?: string;
  dryRun?: boolean;
  invite?: boolean;
  reissue?: boolean;
}

export const OFFERS_USAGE =
  "Usage: cos subscriptions offers import <offers.csv> --host <url> --plan <object>[:<id>] [--email <you>] [--dry-run] [--invite] [--reissue]\n" +
  "       cos subscriptions offers report --host <url> [--status taken|open|expired|withdrawn] [--out <file.csv>] [--email <you>]";

/** `cos subscriptions offers import <offers.csv>`. */
export async function offersImport(
  positional: string[],
  flags: OffersImportFlags,
  io: Io,
): Promise<number> {
  const path = positional[0];
  if (!path) {
    io.err(
      `${OFFERS_USAGE}\n\nThe file: a header naming email and paid_up_to (and optionally reference), one row a person. See docs/importing.md.`,
    );
    return 2;
  }
  const host = hostOf(flags.host, io);
  if (!host) return 2;
  if (!flags.plan || !/^[a-z][a-z0-9]*\.[a-z][a-z0-9]*(:[A-Za-z0-9_-]+)?$/.test(flags.plan)) {
    io.err(
      "--plan is the plan's object, e.g. courses.plan (or courses.plan:<id> when there are several)",
    );
    return 2;
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    io.err(`${path} is not a file`);
    return 2;
  }
  const name = basename(path);
  const file = readOffersFile(readFileSync(path, "utf8"), name);
  if (file.problems.length) {
    io.err(`Nothing was sent: ${file.problems.length} problem(s) in ${name}.`);
    for (const p of file.problems) io.err(`  ${p.file}: ${p.message}`);
    return 1;
  }
  io.out(`${file.rows.length} person(s) in ${name}.`);
  const planFlag = flags.plan;
  return withRunSession(host, flags.email, io, "cos subscriptions offers import", async (on) => {
    try {
      const plan = await resolvePlan(on, planFlag);
      const report = await runOffersImport(file, on, {
        plan,
        dryRun: Boolean(flags.dryRun),
        invite: Boolean(flags.invite),
        reissue: Boolean(flags.reissue),
        progress: (line) => io.out(line),
      });
      for (const line of offersReportLines(report, name)) {
        (report.problems.length ? io.err : io.out)(line);
      }
      return report.problems.length ? 1 : 0;
    } catch (error) {
      io.err(`Error: ${(error as Error).message}`);
      return 1;
    }
  });
}

/** `cos subscriptions offers report`: the report as CSV, to a file or the terminal. */
export async function offersReport(
  flags: { host?: string; email?: string; status?: string; out?: string },
  io: Io,
): Promise<number> {
  const host = hostOf(flags.host, io);
  if (!host) return 2;
  if (flags.status && !["taken", "open", "expired", "withdrawn"].includes(flags.status)) {
    io.err("--status is taken, open, expired or withdrawn");
    return 2;
  }
  return withRunSession(host, flags.email, io, "cos subscriptions offers report", async (on) => {
    try {
      const file = await on.call<{ filename: string; csv: string; rowCount: number }>(
        "subscription.offer.export",
        flags.status ? { status: flags.status } : {},
      );
      if (flags.out) {
        writeFileSync(flags.out, file.csv);
        io.out(`${file.rowCount} offer(s) written to ${flags.out}.`);
      } else {
        io.out(file.csv.trimEnd());
      }
      return 0;
    } catch (error) {
      io.err(`Error: ${(error as Error).message}`);
      return 1;
    }
  });
}
