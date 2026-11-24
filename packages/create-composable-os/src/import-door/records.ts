// What every import writes records with (ADR 0470, shared by `cos content import` and `cos
// courses import`, ADR 0495): `record.import` in batches, each record named by its import key, a
// dry run first, a person's edit reported as a conflict, never overwritten.
import type { ImportHost } from "./host.ts";

export type Outcome = "created" | "updated" | "unchanged" | "conflict" | "invalid";

export interface ImportResult {
  key: string;
  file: string | null;
  object: string;
  id: string | null;
  outcome: Outcome;
  fields: string[];
  problems: string[];
}

/** A problem in the folder, named by its file (and line, for a CSV row). */
export interface Problem {
  file: string;
  message: string;
}

interface ImportCall {
  results: {
    key: string;
    id: string | null;
    outcome: Outcome;
    fields: string[];
    problems: string[];
  }[];
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every `{ [marker]: ref }` in a value replaced by `id(ref)` (a picture or a media item's place). */
export function replaceMarked(
  value: unknown,
  marker: string,
  id: (ref: string) => string,
): unknown {
  if (Array.isArray(value)) return value.map((v) => replaceMarked(v, marker, id));
  if (!isObject(value)) return value;
  if (typeof value[marker] === "string" && Object.keys(value).length === 1)
    return id(value[marker]);
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, replaceMarked(v, marker, id)]),
  );
}

/** Records a call takes at once (`record.import` takes up to 50). */
export const IMPORT_BATCH = 25;

export const chunks = <T>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size),
  );

/** SHA-256 of bytes (or of text), hex. */
export async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Writes (or, with dryRun, checks) records of one object with their keys. */
export async function importRecords(
  host: ImportHost,
  object: string,
  records: { key: string; file: string | null; values: Record<string, unknown> }[],
  options: { dryRun: boolean; checkReferences: boolean },
): Promise<ImportResult[]> {
  const out: ImportResult[] = [];
  for (const part of chunks(records, IMPORT_BATCH)) {
    const answer = await host.call<ImportCall>("record.import", {
      object,
      records: part.map(({ key, values }) => ({ key, values })),
      dryRun: options.dryRun,
      checkReferences: options.checkReferences,
    });
    for (const result of answer.results) {
      const file = part.find((r) => r.key === result.key)?.file ?? null;
      out.push({ ...result, object, file });
    }
  }
  return out;
}

/** The media items the library has already, by their files' SHA-256 (a read). */
export async function knownByHash(
  host: ImportHost,
  hashes: string[],
): Promise<Map<string, { id: string; kind?: string; state?: string | null }>> {
  const known = new Map<string, { id: string; kind?: string; state?: string | null }>();
  for (const part of chunks([...new Set(hashes)], 200)) {
    if (!part.length) continue;
    const found = await host.call<{
      items: { id: string; sha256: string; kind?: string; state?: string | null }[];
    }>("media.findByHash", { sha256: part });
    for (const item of found.items) known.set(item.sha256, item);
  }
  return known;
}

/** Counts of records by outcome, as a person reads them. */
export function outcomeLines(records: ImportResult[], dryRun: boolean): string[] {
  const lines: string[] = [];
  const by = (outcome: Outcome) => records.filter((r) => r.outcome === outcome);
  const verb = dryRun ? "would be" : "were";
  for (const outcome of ["created", "updated", "unchanged"] as const) {
    const list = by(outcome);
    if (list.length) {
      lines.push(`${list.length} record(s) ${outcome === "unchanged" ? "are" : verb} ${outcome}.`);
    }
  }
  const conflicts = by("conflict");
  if (conflicts.length) {
    lines.push(`${conflicts.length} conflict(s), left as they are:`);
    for (const c of conflicts) lines.push(`  ${c.file ?? c.key}: ${c.problems.join("; ")}`);
  }
  return lines;
}
