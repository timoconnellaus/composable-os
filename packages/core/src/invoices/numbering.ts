// Numbering (stage 35, ADR 0730): one series each for quotes, invoices and credit notes
// (core_document_counter). A number is given in the batch that sends a quote or issues an invoice
// or a credit note, by SQL against the series row, never read first and written later: two issues
// at once are serialised by D1 and get consecutive numbers, and a batch that fails uses none. A
// human admin sets a series' prefix and next number (it only goes up) naming the version they read.
import type { CoreDatabase } from "@composable-os/db";
import { type Compilable, type Kysely, sql } from "kysely";

export const SERIES = ["quote", "invoice", "credit_note"] as const;
export type Series = (typeof SERIES)[number];

/** The table each series numbers. */
export const SERIES_TABLE = {
  quote: "core_quote",
  invoice: "core_invoice",
  credit_note: "core_credit_note",
} as const satisfies Record<Series, keyof CoreDatabase>;

/** Letters, digits and - / . only, up to 12: printed before the number (INV-0042). */
export const PREFIX_RE = /^[A-Za-z0-9\-/.]{0,12}$/;
export const MAX_NUMBER = 99_999_999;

/** As the database writes it: the prefix, then the number with at least four digits. */
export function formatNumber(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(4, "0")}`;
}

export interface SeriesRow {
  series: Series;
  prefix: string;
  nextNumber: number;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export async function loadSeries(db: Kysely<CoreDatabase>): Promise<SeriesRow[]> {
  const rows = await db.selectFrom("core_document_counter").selectAll().execute();
  return SERIES.flatMap((series) => {
    const row = rows.find((r) => r.series === series);
    return row
      ? [
          {
            series,
            prefix: row.prefix,
            nextNumber: row.next_number,
            version: row.version,
            updatedAt: row.updated_at,
            updatedBy: row.updated_by,
          },
        ]
      : [];
  });
}

/**
 * The statements that give the draft `id` the next number of `series`, to queue in the batch that
 * sends or issues it, with what else that update sets (`set`: its state, dates and snapshots).
 * `version` is the version of the document the caller read: a document changed since is refused
 * (core_document_stale), and with it the whole batch.
 *
 * The series moves on only while the document is still a draft, so a draft deleted meanwhile
 * uses no number (its update then changes nothing, and the caller's read after the commit finds
 * no document). The document then takes the number the series just moved past; the trigger on
 * the document refuses any other (migration 1030). Read the number back after the commit.
 */
export function numberStatements(
  db: Kysely<CoreDatabase>,
  series: Series,
  id: string,
  version: number,
  set: Record<string, unknown>,
): Compilable[] {
  const table = SERIES_TABLE[series];
  const current = (expression: ReturnType<typeof sql>) =>
    sql`(SELECT ${expression} FROM core_document_counter WHERE series = ${series})`;
  return [
    db
      .updateTable("core_document_counter")
      .set({
        next_number: sql`next_number + 1`,
        version: sql`version + 1`,
      })
      .where("series", "=", series)
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM ${sql.table(table)} WHERE id = ${id} AND state = 'draft')`,
      ),
    // biome-ignore lint/suspicious/noExplicitAny: one update for three tables that share these columns.
    (db as Kysely<any>)
      .updateTable(table)
      .set({
        ...set,
        number_seq: current(sql`next_number - 1`),
        number: current(sql`prefix || printf('%04d', next_number - 1)`),
        version: version + 1,
      })
      .where("id", "=", id),
  ];
}

/**
 * A human admin's change to a series: its prefix and next number, made against the version they
 * read (a number given meanwhile moves it, and the change is refused). The next number never goes
 * down (the trigger refuses it too).
 */
export function seriesStatement(
  db: Kysely<CoreDatabase>,
  row: SeriesRow,
  change: { prefix?: string | undefined; nextNumber?: number | undefined },
  by: string,
  now: string,
): Compilable {
  return db
    .updateTable("core_document_counter")
    .set({
      prefix: change.prefix ?? row.prefix,
      next_number: change.nextNumber ?? row.nextNumber,
      version: row.version + 1,
      updated_at: now,
      updated_by: by,
    })
    .where("series", "=", row.series);
}
