// Agreement documents and their versions (stage 44 step 1, ADR 0640): the working copy's checks,
// the hash of what a person is shown, which version is in effect, the counter every change to
// what is due bumps, and the agreement points installed objects declare (ADR 0641).
//
// The tables are core tables, not records (migration 0850): no rec_* view reads them. Versions are
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

/**
 * A document body: rich text (ADR 0440) without what the hash or the signed copy cannot pin: an
 * embed or a button (the copy cannot show them) and a picture (it can be deleted from the media
 * library later, and the hash covers only its id). A link is allowed only when its text is its
 * own address, so every rendering shows where it goes; the linked page is not part of what a
 * person agrees to.
 */
export const BODY_MAX_BYTES = 131_072;
const BODY_BLOCKS_REFUSED = new Set(["embed", "button", "image"]);

/**
 * Characters a person does not see, which never count as text: zero-width spaces and joiners, word
 * joiner and BOM, direction marks, soft hyphen, combining grapheme joiner, Mongolian vowel
 * separator, Hangul fillers, the blank Braille pattern, and variation selectors. They are allowed
 * (several languages and emoji need them); a text made only of them is not text.
 */
const INVISIBLE =
  /[\u200b-\u200f]|[\u2060-\u2064]|[\ufeff]|[\u061c]|[\u00ad]|[\u034f]|[\u180e]|[\u3164]|[\u115f]|[\u1160]|[\uffa0]|[\u2800]|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/gu;
/** Bidirectional overrides and isolates: they make a text read differently from what it holds. */
export const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/;
/** C0 and C1 control characters, and DEL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
export const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
/** The same in body text, which may hold tabs and line ends. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
const BODY_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
/** A subdivision flag (a black flag, tag letters, a cancel tag): the one use of tag characters. */
const TAG_FLAG = /\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}/gu;
const TAGS = /[\u{e0000}-\u{e007f}]/u;

/** Tag characters outside a subdivision flag: invisible text that can carry anything. */
const hasStrayTags = (value: string) => TAGS.test(value.replace(TAG_FLAG, ""));

/** Whether a string has something a person can read. */
const visible = (value: string) => /\S/u.test(value.replace(INVISIBLE, ""));

/** A single line a person reads: no control characters, no bidi controls, not empty to the eye. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !CONTROLS.test(value), "No control characters")
    .refine((value) => !BIDI_CONTROLS.test(value), "No bidirectional control characters")
    .refine((value) => !hasStrayTags(value), "No invisible tag characters")
    .refine(visible, "Nothing a person could read");

export const titleSchema = line(200);
export const tickLabelSchema = line(500);

/** Every string in a body, with its path, and every text run. */
function walk(
  value: unknown,
  path: (string | number)[],
  onString: (text: string, path: (string | number)[]) => void,
  onRun: (run: { text: string; href?: string }, path: (string | number)[]) => void,
): void {
  if (typeof value === "string") onString(value, path);
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) walk(v, [...path, i], onString, onRun);
  } else if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    if (node.type === "text" && typeof node.text === "string") {
      onRun(node as { text: string; href?: string }, path);
    }
    for (const [k, v] of Object.entries(node)) walk(v, [...path, k], onString, onRun);
  }
}

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
        message: `A document cannot hold a ${block.type}: the signed copy could not pin it`,
      });
    }
  });
  walk(
    value,
    [],
    (text, path) => {
      if (BIDI_CONTROLS.test(text)) {
        ctx.addIssue({ code: "custom", path, message: "No bidirectional control characters" });
      }
      if (BODY_CONTROLS.test(text)) {
        ctx.addIssue({ code: "custom", path, message: "No control characters" });
      }
      if (hasStrayTags(text)) {
        ctx.addIssue({ code: "custom", path, message: "No invisible tag characters" });
      }
    },
    (run, path) => {
      if (run.href !== undefined && run.text.trim() !== run.href) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "text"],
          message: "A link's text must be its own address, so the person sees where it goes",
        });
      }
    },
  );
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

/** Whether a body holds any words a person can read (zero-width characters are not words). */
export function bodyHasText(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  let found = false;
  walk(
    value,
    [],
    () => {},
    (run) => {
      if (visible(run.text)) found = true;
    },
  );
  return found;
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

/**
 * Everything that becomes part of a version (ADR 0640 as amended): what a person is shown and
 * every term of how it applies. The hash covers all of it, so a publish of a reviewed hash cannot
 * carry a change to who agrees, for whom, how, or when a health form is asked again.
 */
export interface VersionContent {
  kind: string;
  title: string;
  body: unknown;
  tickLabel: string | null;
  questions: Question[] | null;
  how: string;
  who: string;
  forWhom: string;
  askAgainMonths: number | null;
}

/** SHA-256 (hex) of the canonical JSON of a version's whole content. */
export async function versionHash(content: VersionContent): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalJson({
      kind: content.kind,
      title: content.title,
      body: content.body ?? null,
      tickLabel: content.tickLabel ?? null,
      questions: content.questions ?? null,
      how: content.how,
      who: content.who,
      forWhom: content.forWhom,
      askAgainMonths: content.askAgainMonths ?? null,
    }),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A stored version row, as migration 0850 holds it. */
export interface StoredVersion {
  title: string;
  body: string;
  tick_label: string;
  questions: string | null;
  how: string;
  who: string;
  for_whom: string;
  ask_again_months: number | null;
  hash: string;
}

/**
 * Whether a stored version's hash matches its own content (ADR 0640): SQLite cannot hash, so a raw
 * writer could give a row a made-up hash. Every read that matters recomputes it; an acceptance
 * refuses a version that is not intact (ADR 0642).
 */
export async function versionIntact(v: StoredVersion, kind: string): Promise<boolean> {
  let body: unknown;
  let questions: Question[] | null;
  try {
    body = JSON.parse(v.body);
    questions = v.questions === null ? null : (JSON.parse(v.questions) as Question[]);
  } catch {
    return false;
  }
  return (
    (await versionHash({
      kind,
      title: v.title,
      body,
      tickLabel: v.tick_label,
      questions,
      how: v.how,
      who: v.who,
      forWhom: v.for_whom,
      askAgainMonths: v.ask_again_months,
    })) === v.hash
  );
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
 * count from the newest `first` or `agree_again` version that has (ADR 0640).
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

/** Bumps the counter step 2's guard reads (ADR 0640). Queued in the batch of the change. */
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

/** An agreement point as installed objects declare it (ADR 0641). */
export interface AgreementPoint {
  point: string;
  label: string;
  suggests: string[];
  objects: string[];
  /**
   * Whether the screens of every object declaring the point let a person agree on the way
   * (`inlineStep`, stage 44 step 5). False: attaching a document there refuses purchases or
   * bookings on those screens until the person agrees elsewhere.
   */
  inlineStep: boolean;
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
      if (declared.inlineStep !== true) point.inlineStep = false;
      for (const kind of declared.suggests ?? []) {
        if (!point.suggests.includes(kind)) point.suggests.push(kind);
      }
    } else {
      points.set(declared.point, {
        point: declared.point,
        label: declared.label,
        suggests: [...(declared.suggests ?? [])],
        objects: [object.name],
        inlineStep: declared.inlineStep === true,
      });
    }
  }
  return [...points.values()].sort((a, b) => a.point.localeCompare(b.point));
}
