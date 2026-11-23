// `cos rostering import <roster.csv>` (stage 45 step 7, the spec's "The move"): duties that are not
// classes (cleaning, opening up) and who works them, moved from wherever they were kept, as duty
// series (a weekly pattern with its regular person) and one-off duty shifts. Pure but for the host
// it is given (import-door/host.ts), so the command and its tests run the same code.
//
// The file: a header naming `duty`, `time` and `length` (minutes), and per row either `weekdays`
// with `first_date` (and optionally `last_date`) for a weekly pattern, or `date` for one shift;
// optionally `staff_email` (who works it), `zone` (an IANA zone; the organisation's when empty)
// and `place` (a new duty's place). Every problem in the file is named with its line before
// anyone signs in.
//
// What the host decides, and this only reports: staff accounts are never made by an import (ADR
// 0455), so an email with no staff account stops the run, naming the line; the host's own dry run
// of the roster (`x.rostering.planCheck`, the same clash check the writes and the reconcile make,
// ADR 0621) names every date a row would put someone on two shifts at once, by the other shift's
// title and start, and the dates they said they are away or are not qualified for the duty. A
// one-off shift that clashes is imported with nobody on it; a weekly pattern is imported with its
// person, and the host makes each clashing date with nobody on it and tells the rosterers. A clash
// between shifts that have both ended is reported, never refused.
//
// A dry run by default: nothing is written until `--apply`. Everything is written through the
// host's operations (record.create), as the person running it, never to the database; a re-run
// makes nothing twice (a duty by its name, a pattern by its duty, days, time and first date, a
// shift by its duty and start).
import { parseCsv } from "../courses-import/format.ts";
import type { ImportHost } from "../import-door/host.ts";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];

/** One row of the file, with its line. */
export interface RosterRow {
  line: number;
  duty: string;
  time: string;
  length: number;
  weekdays?: Weekday[];
  firstDate?: string;
  lastDate?: string;
  date?: string;
  staffEmail?: string;
  zone?: string;
  place?: string;
}

export interface RosterFile {
  rows: RosterRow[];
  problems: { file: string; message: string }[];
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether `date` is a real `YYYY-MM-DD` date (no 30 February). */
export function realDate(date: string): boolean {
  const m = DATE.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

/** Weekdays as a person writes them ("Mon Wed Fri", "mon;wed", "Monday, Friday"), or null. */
export function weekdaysOf(text: string): Weekday[] | null {
  const words = text
    .toLowerCase()
    .split(/[\s,;/|]+/)
    .filter(Boolean);
  if (!words.length) return null;
  const out: Weekday[] = [];
  for (const word of words) {
    const day = WEEKDAYS.find((d) => word.startsWith(d));
    if (!day) return null;
    if (!out.includes(day)) out.push(day);
  }
  return WEEKDAYS.filter((d) => out.includes(d));
}

/** Reads the CSV: the rows, or every problem with `name` and its line. Never throws. */
export function readRosterFile(text: string, name = "roster.csv"): RosterFile {
  const problems: RosterFile["problems"] = [];
  const at = (line: number) => `${name}:${line}`;
  const table = parseCsv(text.replace(/^﻿/, ""));
  const header = table[0];
  if (!header) return { rows: [], problems: [{ file: name, message: "the file is empty" }] };
  const names = header.cells.map((c) =>
    c
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
  const column = (...options: string[]) => names.findIndex((n) => options.includes(n));
  const col = {
    duty: column("duty", "duty_name"),
    time: column("time", "start_time", "starts_at"),
    length: column("length", "minutes", "length_minutes"),
    weekdays: column("weekdays", "days"),
    firstDate: column("first_date", "from", "from_date"),
    lastDate: column("last_date", "until", "until_date"),
    date: column("date"),
    staff: column("staff_email", "email", "staff"),
    zone: column("zone", "timezone", "time_zone"),
    place: column("place", "where"),
  };
  if (col.duty < 0 || col.time < 0 || col.length < 0) {
    problems.push({
      file: at(header.line),
      message: `the header must name duty, time and length (it has: ${names.join(", ") || "nothing"})`,
    });
    return { rows: [], problems };
  }
  if (col.weekdays < 0 && col.date < 0) {
    problems.push({
      file: at(header.line),
      message: "the header must name weekdays (with first_date) or date",
    });
    return { rows: [], problems };
  }
  const rows: RosterRow[] = [];
  for (const { line, cells } of table.slice(1)) {
    const cell = (i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
    const problem = (message: string) => problems.push({ file: at(line), message });
    const duty = cell(col.duty);
    const time = cell(col.time);
    const length = Number(cell(col.length));
    const days = cell(col.weekdays);
    const date = cell(col.date);
    const firstDate = cell(col.firstDate);
    const lastDate = cell(col.lastDate);
    const email = cell(col.staff).toLowerCase();
    const zone = cell(col.zone);
    const place = cell(col.place);
    if (!duty) {
      problem("no duty");
      continue;
    }
    if (duty.length > 200) {
      problem("the duty's name is longer than 200 characters");
      continue;
    }
    if (!TIME.test(time)) {
      problem(`the time is not HH:MM: "${time}"`);
      continue;
    }
    if (!Number.isInteger(length) || length < 1 || length > 1440) {
      problem(`the length is not whole minutes from 1 to 1440: "${cell(col.length)}"`);
      continue;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      problem(`not an email address: "${cell(col.staff)}"`);
      continue;
    }
    if (zone && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(zone)) {
      problem(`not a time zone: "${zone}"`);
      continue;
    }
    const base = {
      line,
      duty,
      time,
      length,
      ...(email ? { staffEmail: email } : {}),
      ...(zone ? { zone } : {}),
      ...(place ? { place } : {}),
    };
    if (days && date) {
      problem("a row is either a weekly pattern (weekdays) or one shift (date), not both");
      continue;
    }
    if (date) {
      if (!realDate(date)) {
        problem(`the date is not a real date (YYYY-MM-DD): "${date}"`);
        continue;
      }
      rows.push({ ...base, date });
      continue;
    }
    const weekdays = weekdaysOf(days);
    if (!weekdays) {
      problem(`the weekdays are not days of the week: "${days}"`);
      continue;
    }
    if (!realDate(firstDate)) {
      problem(`a weekly pattern needs a real first_date (YYYY-MM-DD): "${firstDate}"`);
      continue;
    }
    if (lastDate && (!realDate(lastDate) || lastDate < firstDate)) {
      problem(`the last_date is not a real date on or after the first: "${lastDate}"`);
      continue;
    }
    rows.push({ ...base, weekdays, firstDate, ...(lastDate ? { lastDate } : {}) });
  }
  if (!rows.length && !problems.length) {
    problems.push({ file: name, message: "no rows under the header" });
  }
  return { rows, problems };
}

/** What the host's dry run said about one row. */
interface PlanAnswer {
  key: string | null;
  dates: number;
  clashes: {
    date: string;
    startsAt: string;
    other: { title: string; startsAt: string; endsAt: string };
    ended: boolean;
  }[];
  away: string[];
  notQualified: boolean;
  first: { date: string; startsAt: string; endsAt: string } | null;
}

/** One row's outcome. */
export interface RowReport {
  line: number;
  label: string;
  dates: number;
  /** Dates it would put its person on two shifts at once: imported with nobody on them. */
  clashes: PlanAnswer["clashes"];
  /** Warnings: the person said they are away; not qualified for the duty. */
  away: string[];
  notQualified: boolean;
  /** created, already there (a re-run), or would be (a dry run). */
  outcome: "created" | "exists" | "dry_run";
}

export interface RosterReport {
  apply: boolean;
  rows: RowReport[];
  dutiesCreated: string[];
  /** What stops the run before anything is written: each with its line. */
  problems: { file: string; message: string }[];
}

interface Listed {
  items: { id: string; values: Record<string, unknown> }[];
}

const DUTY = "rostering.duty";
const SERIES = "rostering.dutyseries";
const SHIFT = "rostering.shift";

function labelOf(row: RosterRow, who: string | null): string {
  const when = row.date
    ? `${row.date} ${row.time}`
    : `${(row.weekdays ?? []).join(" ")} ${row.time} from ${row.firstDate}`;
  return `${row.duty}, ${when}, ${row.length} minutes, ${who ?? "nobody"}`;
}

/**
 * The import: who each row names, the host's dry run, then (with `apply`) the duties, patterns and
 * shifts, each through record.create. Problems stop it before anything is written.
 */
export async function runRosterImport(
  file: RosterFile,
  host: ImportHost,
  options: { apply: boolean; name?: string; progress?: (line: string) => void },
): Promise<RosterReport> {
  const name = options.name ?? "roster.csv";
  const report: RosterReport = { apply: options.apply, rows: [], dutiesCreated: [], problems: [] };
  // Staff: each email a staff account the business invited. Never made here (ADR 0455).
  const accounts = new Map<string, string>();
  for (const email of new Set(file.rows.flatMap((r) => (r.staffEmail ? [r.staffEmail] : [])))) {
    const found = await host.call<{ items: { id: string; email: string }[] }>("user.list", {
      filter: { field: "email", op: "eq", value: email },
    });
    const id = found.items.find((u) => u.email.toLowerCase() === email)?.id;
    if (id) accounts.set(email, id);
  }
  for (const row of file.rows) {
    if (row.staffEmail && !accounts.has(row.staffEmail)) {
      report.problems.push({
        file: `${name}:${row.line}`,
        message: `no staff account has ${row.staffEmail}: invite them first (an import never makes an account)`,
      });
    }
  }
  if (report.problems.length) return report;
  // Duties by name: those there already, and those this import would add.
  const duties = new Map<string, string>();
  for (const dutyName of new Set(file.rows.map((r) => r.duty))) {
    const found = await host.call<Listed>("record.list", {
      object: DUTY,
      filter: { field: "name", op: "eq", value: dutyName },
      limit: 1,
    });
    const id = found.items[0]?.id;
    if (id) duties.set(dutyName, id);
  }
  // The host's dry run, every row in one check so rows are checked against each other too.
  const plans = file.rows.map((row) => ({
    key: `line ${row.line}`,
    kind: duties.has(row.duty) ? { object: DUTY, id: duties.get(row.duty) as string } : null,
    account: row.staffEmail ? (accounts.get(row.staffEmail) ?? null) : null,
    time: row.time,
    length: row.length,
    ...(row.zone ? { zone: row.zone } : {}),
    ...(row.date
      ? { date: row.date }
      : {
          weekdays: row.weekdays,
          firstDate: row.firstDate,
          ...(row.lastDate ? { lastDate: row.lastDate } : {}),
        }),
  }));
  const answers: PlanAnswer[] = [];
  for (let i = 0; i < plans.length; i += 200) {
    const checked = await host.call<{ plans: PlanAnswer[] }>("x.rostering.planCheck", {
      plans: plans.slice(i, i + 200),
    });
    answers.push(...checked.plans);
  }
  for (const [i, row] of file.rows.entries()) {
    const answer = answers[i] as PlanAnswer;
    const who = row.staffEmail ?? null;
    const entry: RowReport = {
      line: row.line,
      label: labelOf(row, who),
      dates: answer.dates,
      clashes: answer.clashes,
      away: answer.away,
      notQualified: answer.notQualified,
      outcome: "dry_run",
    };
    report.rows.push(entry);
    if (!options.apply) continue;
    let duty = duties.get(row.duty);
    if (!duty) {
      duty = (
        await host.call<{ id: string }>("record.create", {
          object: DUTY,
          values: { name: row.duty, ...(row.place ? { place: row.place } : {}) },
        })
      ).id;
      duties.set(row.duty, duty);
      report.dutiesCreated.push(row.duty);
      options.progress?.(`Duty ${row.duty} added.`);
    }
    const account = row.staffEmail ? (accounts.get(row.staffEmail) ?? null) : null;
    if (row.date) {
      const first = answer.first;
      if (!first) continue;
      const there = await host.call<Listed>("record.list", {
        object: SHIFT,
        filter: {
          and: [
            { field: "duty", op: "eq", value: duty },
            { field: "startsAt", op: "eq", value: first.startsAt },
          ],
        },
        limit: 1,
      });
      if (there.items.length) {
        entry.outcome = "exists";
        continue;
      }
      // A clash is the host's to refuse: the shift is made with nobody on it instead.
      const staffed = account && !answer.clashes.length ? { staff: account } : {};
      await host.call("record.create", {
        object: SHIFT,
        values: {
          duty,
          startsAt: first.startsAt,
          endsAt: first.endsAt,
          ...(row.zone ? { timezone: row.zone } : {}),
          ...staffed,
        },
      });
      entry.outcome = "created";
      continue;
    }
    const there = await host.call<Listed>("record.list", {
      object: SERIES,
      filter: { field: "duty", op: "eq", value: duty },
      limit: 200,
    });
    const same = there.items.find(
      (s) =>
        s.values.time === row.time &&
        s.values.firstDate === row.firstDate &&
        JSON.stringify([...((s.values.weekdays as string[] | undefined) ?? [])].sort()) ===
          JSON.stringify([...(row.weekdays ?? [])].sort()),
    );
    if (same) {
      entry.outcome = "exists";
      continue;
    }
    // A weekly pattern keeps its person: the host makes each clashing date with nobody on it.
    await host.call("record.create", {
      object: SERIES,
      values: {
        duty,
        weekdays: row.weekdays,
        time: row.time,
        length: row.length,
        firstDate: row.firstDate,
        ...(row.lastDate ? { lastDate: row.lastDate } : {}),
        ...(row.zone ? { timezone: row.zone } : {}),
        ...(account ? { staff: account } : {}),
      },
    });
    entry.outcome = "created";
  }
  return report;
}

/** The report as lines for the terminal. */
export function rosterReportLines(report: RosterReport, name: string): string[] {
  if (report.problems.length) {
    return [
      `Nothing was written: ${report.problems.length} problem(s).`,
      ...report.problems.map((p) => `  ${p.file}: ${p.message}`),
    ];
  }
  const lines: string[] = [];
  let clashes = 0;
  for (const row of report.rows) {
    const verb =
      row.outcome === "created"
        ? "made"
        : row.outcome === "exists"
          ? "already there, left as it is"
          : "would be made";
    lines.push(`${name}:${row.line} ${row.label}: ${row.dates} shift(s) ${verb}.`);
    for (const c of row.clashes) {
      clashes++;
      lines.push(
        `  clash on ${c.date}: already on ${c.other.title} at ${c.other.startsAt}${
          c.ended ? " (both over: reported only)" : ": made with nobody on it"
        }`,
      );
    }
    if (row.away.length) lines.push(`  warning: away on ${row.away.join(", ")}`);
    if (row.notQualified) lines.push("  warning: not marked as qualified for this duty");
  }
  if (report.dutiesCreated.length) lines.push(`Duties added: ${report.dutiesCreated.join(", ")}.`);
  if (clashes) {
    lines.push(
      `${clashes} date(s) clash: whoever rosters is told, and puts someone on them from the roster.`,
    );
  }
  lines.push(
    report.apply
      ? "Done. Each pattern's shifts are made by the host over the next minutes, as far ahead as the duty horizon."
      : "Dry run: nothing was written. Run again with --apply to make them.",
  );
  return lines;
}
