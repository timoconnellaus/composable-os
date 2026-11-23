// Agreement documents and their versions (stage 44 step 1, ADR 0610): the working copy's checks,
// the hash of what a person is shown, which version is in effect, the counter every change to
// what is due bumps, and the agreement points installed objects declare (ADR 0611).
//
// The tables are core tables, not records (migration 0790): no rec_* view reads them. Versions are
// refused any update or delete by the database; the host only ever inserts one.
import type { CoreDatabase } from "@composable-os/db";
import { AGREEMENT_KINDS, RICH_TEXT_SCHEMA, validateDocument } from "@composable-os/sdk";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { z } from "zod";
import { listObjects } from "../fields/index.ts";

export { AGREEMENT_KINDS };
export const AGREEMENT_HOW = ["typed", "drawn"] as const;
export const AGREEMENT_WHO = ["participant", "payer"] as const;
export const AGREEMENT_FOR = ["everyone", "dependants"] as const;
export const AGREEMENT_CHANGES = ["first", "small", "agree_again"] as const;

/** A document body: rich text (ADR 0440) without blocks a signed copy cannot hold. */
export const BODY_MAX_BYTES = 131_072;
const BODY_BLOCKS_REFUSED = new Set(["embed", "button"]);

/** A single line a person reads: no control characters. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "No control characters");

export const titleSchema = line(200);
export const tickLabelSchema = line(500);

export const bodySchema = z.unknown().superRefine((value, ctx) => {
  const result = validateDocument(RICH_TEXT_SCHEMA, value, { maxBytes: BODY_MAX_BYTES });
  if (!result.ok) {
    for (const issue of result.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
    return;
  }
  const blocks = (value as { blocks?: { type?: string }[] }).blocks ?? [];
  blocks.forEach((block, i) => {
    if (block.type && BODY_BLOCKS_REFUSED.has(block.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["blocks", i, "type"],
        message: `A document cannot hold a ${block.type}: the signed copy could not show it`,
      });
    }
  });
});

/** A health form's question (stage 44): yes or no, and whether a "yes" asks for a note. */
export const questionSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/, "A key is a lowercase word")
    .describe("Stable key of the question within the form"),
  text: line(500),
  noteOnYes: z.boolean().default(false),
});
export const questionsSchema = z
  .array(questionSchema)
  .min(1)
  .max(40)
  .refine((qs) => new Set(qs.map((q) => q.key)).size === qs.length, "Each key once");
export type Question = z.infer<typeof questionSchema>;

/** Whether a body holds any words a person can read. */
export function bodyHasText(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return /"text":"[^"]*\S/.test(JSON.stringify(value));
}

/** JSON with every object's keys sorted, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** What a person is shown of a version, as hashed (title, body, tick label, questions). */
export interface Shown {
  title: string;
  body: unknown;
  tickLabel: string | null;
  questions: Question[] | null;
}

/** SHA-256 (hex) of the canonical JSON of what a person is shown. */
export async function shownHash(shown: Shown): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalJson({
      title: shown.title,
      body: shown.body ?? null,
      tickLabel: shown.tickLabel ?? null,
      questions: shown.questions ?? null,
    }),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A version's number, change and effective moment: enough to work out what is in effect. */
export interface VersionTiming {
  id: string;
  number: number;
  change: (typeof AGREEMENT_CHANGES)[number];
  effective_from: string;
}

/**
 * What is in effect at `now`: the newest version that has taken effect is current, and acceptances
 * count from the newest `first` or `agree_again` version that has (ADR 0610).
 */
export function inEffect(
  versions: readonly VersionTiming[],
  now: string,
): { currentId: string | null; agreeFrom: number } {
  let current: VersionTiming | null = null;
  let agreeFrom = 0;
  for (const v of versions) {
    if (v.effective_from > now) continue;
    if (!current || v.number > current.number) current = v;
    if (v.change !== "small" && v.number > agreeFrom) agreeFrom = v.number;
  }
  return { currentId: current?.id ?? null, agreeFrom };
}

/** Bumps the counter step 2's guard reads (ADR 0610). Queued in the batch of the change. */
export function bumpRev(db: Kysely<CoreDatabase>) {
  return db
    .updateTable("core_agreement_rev")
    .set({ rev: sql<number>`rev + 1` })
    .where("id", "=", 1);
}

export async function readRev(db: Kysely<CoreDatabase>): Promise<number> {
  const row = await db
    .selectFrom("core_agreement_rev")
    .select("rev")
    .where("id", "=", 1)
    .executeTakeFirst();
  return row?.rev ?? 0;
}

/** An agreement point as installed objects declare it (ADR 0611). */
export interface AgreementPoint {
  point: string;
  label: string;
  suggests: string[];
  objects: string[];
}

/** Every point installed objects declare, each once (objects may share one). */
export function agreementPoints(): AgreementPoint[] {
  const points = new Map<string, AgreementPoint>();
  for (const object of listObjects()) {
    const declared = object.agreements;
    if (!declared) continue;
    const point = points.get(declared.point);
    if (point) {
      point.objects.push(object.name);
      for (const kind of declared.suggests ?? []) {
        if (!point.suggests.includes(kind)) point.suggests.push(kind);
      }
    } else {
      points.set(declared.point, {
        point: declared.point,
        label: declared.label,
        suggests: [...(declared.suggests ?? [])],
        objects: [object.name],
      });
    }
  }
  return [...points.values()].sort((a, b) => a.point.localeCompare(b.point));
}
