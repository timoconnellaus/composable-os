// `cos subscriptions offers import <offers.csv>` (stage 32a, build step 4, ADRs 0491 and 0492): a
// list of people subscribed on another platform, as continuation offers on one plan. Pure but for
// the host it is given (import-door/host.ts), so the command and the tests against a real host
// run the same code.
//
// The file: a header row naming `email` and `paid_up_to` (or `free_until`), and optionally
// `reference` (the other platform's own reference for the old subscription); one row a person.
// A date is the start of that day in the organisation's time zone; a moment with its offset is
// itself. Every problem in the file (not an address, not a real date, an address twice) is named
// with its line, and stops the run before anything is sent. Then the host checks every row in a
// dry run and writes them. A row the host cannot write (no person has the address, an offer
// taken or withdrawn since, a checkout still open on it) is listed with its line and left out,
// and the rest are written, as the courses import does with access rows it cannot match. People
// come first (the people CSV import): nobody is created.

import { parseCsv } from "../courses-import/format.ts";
import type { ImportHost } from "../import-door/host.ts";

/** One row of the file, with its line. */
export interface OfferRow {
  line: number;
  email: string;
  freeUntil: string;
  reference?: string;
}

export interface OffersFile {
  rows: OfferRow[];
  problems: { file: string; message: string }[];
}

const EMAIL_HEADERS = ["email", "email_address"];
const DATE_HEADERS = ["paid_up_to", "free_until", "paid_until"];
const REFERENCE_HEADERS = ["reference", "ref", "subscription_id", "old_reference"];

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MOMENT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Whether `when` is a real date (`YYYY-MM-DD`) or a real moment with its offset: no 30 February,
 * no 24:00, no offset past 14 hours, checked by a round trip, as the host checks it.
 */
export function realPaidUpDate(when: string): boolean {
  const m = DATE.exec(when) ?? MOMENT.exec(when);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (m[9] !== undefined && (Number(m[9]) > 14 || Number(m[10]) > 59)) return false;
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    at.getUTCFullYear() === y &&
    at.getUTCMonth() === mo - 1 &&
    at.getUTCDate() === d &&
    at.getUTCHours() === h &&
    at.getUTCMinutes() === mi &&
    at.getUTCSeconds() === s
  );
}

/** Reads the CSV: the rows, or every problem with `name` and its line. Never throws. */
export function readOffersFile(text: string, name = "offers.csv"): OffersFile {
  const problems: OffersFile["problems"] = [];
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
  const column = (options: string[]) => names.findIndex((n) => options.includes(n));
  const email = column(EMAIL_HEADERS);
  const date = column(DATE_HEADERS);
  const reference = column(REFERENCE_HEADERS);
  if (email < 0 || date < 0) {
    problems.push({
      file: at(header.line),
      message: `the header must name ${EMAIL_HEADERS[0]} and ${DATE_HEADERS[0]} (it has: ${names.join(", ") || "nothing"})`,
    });
    return { rows: [], problems };
  }
  const rows: OfferRow[] = [];
  const seen = new Map<string, number>();
  for (const { line, cells } of table.slice(1)) {
    const address = (cells[email] ?? "").trim().toLowerCase();
    const when = (cells[date] ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      problems.push({ file: at(line), message: `not an email address: "${cells[email] ?? ""}"` });
      continue;
    }
    if (!realPaidUpDate(when)) {
      problems.push({
        file: at(line),
        message: `the paid-up date is not a real date (YYYY-MM-DD) or moment with its offset: "${when}"`,
      });
      continue;
    }
    const before = seen.get(address);
    if (before !== undefined) {
      problems.push({ file: at(line), message: `${address} is on line ${before} already` });
      continue;
    }
    seen.set(address, line);
    const ref = reference >= 0 ? (cells[reference] ?? "").trim() : "";
    rows.push({ line, email: address, freeUntil: when, ...(ref ? { reference: ref } : {}) });
  }
  if (!rows.length && !problems.length) {
    problems.push({ file: name, message: "no rows under the header" });
  }
  return { rows, problems };
}

/** What the host answered for one row (subscription.offer.import). */
export interface OfferOutcome {
  email: string;
  outcome:
    | "created"
    | "updated"
    | "unchanged"
    | "unmatched"
    | "several_people"
    | "invalid"
    | "conflict";
  offerId: string | null;
  personId: string | null;
  freeUntil: string | null;
  note: string | null;
  signIn: "invited" | "invited_before" | "has_account" | "invite_refused" | null;
}

export interface OffersReport {
  plan: { object: string; id: string; title: string };
  dryRun: boolean;
  rows: (OfferOutcome & { line: number })[];
  /** Rows the host would not write: unmatched, several people, invalid, conflicts. */
  problems: (OfferOutcome & { line: number })[];
}

/** The most rows one call sends (the host's limit). */
export const OFFERS_BATCH = 50;

type PlanRecord = { id: string; title?: string | null; values?: Record<string, unknown> };

/**
 * The plan, from `--plan <object>:<id>` (that record, read by its id) or `--plan <object>` (its
 * only live record). Throws with the plans to choose from when there is more than one.
 */
export async function resolvePlan(
  host: ImportHost,
  spec: string,
): Promise<{ object: string; id: string; title: string }> {
  const [object, id] = spec.split(":") as [string, string | undefined];
  const title = (r: PlanRecord) => String(r.title ?? r.values?.title ?? r.values?.name ?? r.id);
  if (id) {
    let found: PlanRecord;
    try {
      found = await host.call<PlanRecord>("record.get", { object, id });
    } catch (error) {
      if ((error as { code?: unknown }).code === "not_found") {
        throw new Error(`No ${object} record ${id} on the host.`);
      }
      throw error;
    }
    return { object, id, title: title(found) };
  }
  const page = await host.call<{ items: PlanRecord[] }>("record.list", { object, limit: 50 });
  if (page.items.length === 1) {
    const only = page.items[0] as (typeof page.items)[number];
    return { object, id: only.id, title: title(only) };
  }
  if (!page.items.length) throw new Error(`The host has no ${object} record to offer.`);
  throw new Error(
    `The host has ${page.items.length} ${object} records; name one with --plan ${object}:<id>:\n` +
      page.items.map((r) => `  ${object}:${r.id}  ${title(r)}`).join("\n"),
  );
}

const PROBLEM = new Set(["unmatched", "several_people", "invalid", "conflict"]);

/**
 * Runs the import: a dry run of every row first, then (unless `dryRun`) the same rows for real.
 * The rows the host would not write are reported with their line, and the rest are written.
 */
export async function runOffersImport(
  file: OffersFile,
  host: ImportHost,
  options: {
    plan: { object: string; id: string; title: string };
    dryRun: boolean;
    invite: boolean;
    /** Give an address whose offer staff withdrew a fresh one (asked for, never by default). */
    reissue?: boolean;
    progress?: (line: string) => void;
  },
): Promise<OffersReport> {
  const call = async (batch: OfferRow[], dryRun: boolean) => {
    const input = {
      plan: { object: options.plan.object, id: options.plan.id },
      rows: batch.map(({ email, freeUntil, reference }) => ({
        email,
        freeUntil,
        ...(reference ? { reference } : {}),
      })),
      dryRun,
      invite: options.invite,
      reissue: Boolean(options.reissue),
    };
    // An offer someone changed while this batch was being written (a take, a withdrawal, another
    // import): nothing of the batch was written. Sent again, it answers from the offers as they
    // are now.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await host.call<{ results: OfferOutcome[] }>("subscription.offer.import", input);
      } catch (error) {
        const e = error as { code?: unknown; details?: { rule?: unknown } };
        if (attempt >= 3 || e.code !== "conflict" || e.details?.rule !== "offer_changed") {
          throw error;
        }
      }
    }
  };
  const send = async (dryRun: boolean) => {
    const out: (OfferOutcome & { line: number })[] = [];
    for (let i = 0; i < file.rows.length; i += OFFERS_BATCH) {
      const batch = file.rows.slice(i, i + OFFERS_BATCH);
      const answer = await call(batch, dryRun);
      answer.results.forEach((r, n) => {
        out.push({ ...r, line: (batch[n] as OfferRow).line });
      });
      if (!dryRun)
        options.progress?.(
          `Wrote ${Math.min(i + OFFERS_BATCH, file.rows.length)} of ${file.rows.length}…`,
        );
    }
    return out;
  };
  const checked = await send(true);
  const rows = options.dryRun ? checked : await send(false);
  return {
    plan: options.plan,
    dryRun: options.dryRun,
    rows,
    problems: rows.filter((r) => PROBLEM.has(r.outcome)),
  };
}

const NOTE_WORDS: Record<string, string> = {
  past: "the paid-up date has passed: it cannot be taken; they subscribe as anyone does",
  under_48_hours:
    "under 48 hours to the paid-up date: taking it now is charged at once (the provider needs 48 hours for free time)",
  taken: "taken already",
  withdrawn:
    "withdrawn by staff; to give this person a fresh offer, run again with --reissue (the withdrawn one stays as it was)",
  reissued: "a fresh offer beside the one staff withdrew",
  held: "a checkout from it is still open at the payment provider on the old date; run again once it expires (within a day) or is completed",
  held_unconfirmed:
    "the payment provider could not say whether its checkout is still open; run again later",
  completing: "its checkout was completed: the subscription is being confirmed",
  another_person: "the address now belongs to another person",
  twice: "the address is in this import twice",
  "merge them first": "more than one person has this address: merge them first",
  "no person has this address": "no person has this address: import the people first",
};

/** The report, in lines: totals, then every row to look at with its line. */
export function offersReportLines(report: OffersReport, name = "offers.csv"): string[] {
  const lines: string[] = [];
  const count = (o: string) => report.rows.filter((r) => r.outcome === o).length;
  const verb = report.dryRun ? "would be" : "were";
  lines.push(
    `Continuation offers on ${report.plan.title} (${report.plan.object}:${report.plan.id}): ` +
      `${count("created")} ${verb} created, ${count("updated")} updated, ${count("unchanged")} unchanged; ` +
      `${report.problems.length} not written.`,
  );
  for (const r of report.rows) {
    if (!PROBLEM.has(r.outcome) && !r.note) continue;
    const why = r.note ? (NOTE_WORDS[r.note] ?? r.note) : r.outcome;
    lines.push(
      `  ${name}:${r.line} ${r.email}: ${PROBLEM.has(r.outcome) ? `${r.outcome}: ` : ""}${why}`,
    );
  }
  const usable = report.rows.filter((r) => !PROBLEM.has(r.outcome) && r.note !== "past");
  const invited = usable.filter((r) => r.signIn === "invited").length;
  const cannot = usable.filter((r) => r.signIn === null).length;
  if (invited) lines.push(`${invited} address(es) ${verb} invited to sign in.`);
  for (const r of report.rows.filter((x) => x.signIn === "invite_refused")) {
    lines.push(
      `  ${name}:${r.line} ${r.email}: cannot be invited (an erased person's address); the rest went ahead`,
    );
  }
  if (cannot) {
    lines.push(
      `${cannot} of these people have no customer account and no invite. They can sign in to take ` +
        'their offer while customer sign-up is open, or while the setting "anyone starting a ' +
        'subscription" is on and the plan is on sale (Settings → Users); otherwise run again with ' +
        "--invite (users:manage) to invite them, which works under every sign-up setting.",
    );
  }
  if (!report.dryRun) {
    lines.push(
      "Nothing is sent to anyone. Tell each person to sign in on the site with this address and " +
        "continue their subscription there; the report (Subscriptions, Continuation offers) says " +
        "who has, so you end exactly those old subscriptions at their period's end.",
    );
  }
  return lines;
}
