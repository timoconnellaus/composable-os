// The content import itself (ADR 0470): an import plan (format.ts) written to a host through its
// HTTP surface, as the person signed in for the run. No file system and no terminal here: the CLI
// (run.ts) reads the folder, signs the person in and prints; the tests drive this against a real
// host. Every write is an operation the person's session calls (`record.import`,
// `record.publish`, `record.schedulePublish`, the token upload route), so it is checked, audited
// and theirs, as any staff call is.
//
// The order, so nothing is written before everything is checked:
//   1. the plan's own problems (the folder);
//   2. a dry run of every record on the host (`record.import` with dryRun): its checks, and what
//      would happen to each (created, updated, unchanged, a conflict);
//   3. only then, unless dryRun: the pictures the library lacks (by SHA-256), the categories, the
//      posts; and with `publish`, publishing (or scheduling) each as its file says.
import type { ImportHost } from "../import-door/host.ts";
import {
  chunks,
  type ImportResult,
  importRecords,
  type Outcome,
  outcomeLines,
  sha256,
} from "../import-door/records.ts";
import {
  CATEGORY_OBJECT,
  type ImportPlan,
  PICTURE,
  type PlannedPost,
  POST_OBJECT,
  type Problem,
  placeholderMedia,
  withPictures,
} from "./format.ts";

export type { ImportHost, ImportResult, Outcome };

export interface ImportReport {
  /** Problems that stopped the import before anything was written. */
  problems: Problem[];
  records: ImportResult[];
  pictures: { uploaded: number; already: number };
  published: { file: string; id: string; as: "published" | "scheduled" | "unchanged" }[];
  /** Notes for the person: a scheduled or published post left a draft without --publish, … */
  notes: { file: string; message: string }[];
  /** True when the run wrote nothing (a dry run, or stopped by problems). */
  wroteNothing: boolean;
}

export interface ImportOptions {
  dryRun?: boolean;
  publish?: boolean;
  /** Asked before writing when `publish` is set; false stops the run. */
  confirm?: (summary: string) => Promise<boolean>;
  now?: () => Date;
}

/** The values a post is written with, its pictures and category resolved. */
function resolved(
  post: PlannedPost,
  media: (file: string) => string,
  category: (key: string) => string | null,
): Record<string, unknown> {
  const values = withPictures(post.values, media) as Record<string, unknown>;
  if (post.category) {
    const id = category(post.category);
    if (id) values.category = id;
  }
  return values;
}

/**
 * What to say, without --publish, of a post the source has published or scheduled: nothing when
 * the host already has it so and it is unchanged; that a change is saved unpublished when the
 * host has it published or scheduled; otherwise that it is imported as a draft.
 */
async function unpublishedNote(
  host: ImportHost,
  post: PlannedPost,
  result: ImportResult | undefined,
): Promise<string | null> {
  if (result?.id && (result.outcome === "unchanged" || result.outcome === "updated")) {
    const record = await host.call<{ values: Record<string, unknown> }>("record.get", {
      object: POST_OBJECT,
      id: result.id,
    });
    const state = record.values.publishState;
    const same =
      post.status === "published"
        ? state === "published"
        : state === "scheduled" && record.values.publishAt === post.date;
    if (same) {
      return result.outcome === "unchanged"
        ? null
        : post.status === "published"
          ? "Published here already: the change is saved, not published (pass --publish to publish it)"
          : "Scheduled here already: the change is saved, not published (pass --publish to schedule it)";
    }
    if (state === "published" || state === "scheduled") {
      return (
        "Already " +
        state +
        " here; left as it is (pass --publish to publish or schedule it as the source has it)"
      );
    }
  }
  return post.status === "scheduled"
    ? `Scheduled for ${post.date} in the source: imported as a draft (pass --publish to schedule it)`
    : "Published in the source: imported as a draft (pass --publish to publish it)";
}

/** Runs the import. Throws only for what the host refused outright (a session that ended). */
export async function runImport(
  plan: ImportPlan,
  host: ImportHost,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const report: ImportReport = {
    problems: [...plan.problems],
    records: [],
    pictures: { uploaded: 0, already: 0 },
    published: [],
    notes: [],
    wroteNothing: true,
  };
  if (report.problems.length) return report;
  const now = (options.now ?? (() => new Date()))();

  // The pictures the library has already, by their bytes' hash (a read).
  const hashes = new Map<string, string>();
  for (const [file, bytes] of plan.pictures) hashes.set(file, await sha256(bytes));
  const known = new Map<string, string>();
  for (const part of chunks([...new Set(hashes.values())], 200)) {
    if (!part.length) continue;
    const found = await host.call<{ items: { id: string; sha256: string }[] }>("media.findByHash", {
      sha256: part,
    });
    for (const item of found.items) known.set(item.sha256, item.id);
  }

  // 2. The dry run: every record through the host's own checks, with the pictures and categories
  // that do not exist yet as placeholders, so a bad record stops the run before any write.
  const dryCategories = await importRecords(
    host,
    CATEGORY_OBJECT,
    plan.categories.map((c) => ({ key: c.key, file: null, values: c.values })),
    { dryRun: true, checkReferences: false },
  );
  const placeholders = new Map(
    [...plan.pictures.keys()].map((f, i) => [
      f,
      known.get(hashes.get(f) as string) ?? placeholderMedia(i),
    ]),
  );
  const dryCategoryIds = new Map(dryCategories.map((c) => [c.key, c.id]));
  const dryPosts = await importRecords(
    host,
    POST_OBJECT,
    plan.posts.map((post) => ({
      key: post.key,
      file: post.file,
      values: resolved(
        post,
        (f) => placeholders.get(f) ?? placeholderMedia(0),
        (key) => dryCategoryIds.get(key) ?? "rec_importplaceholder",
      ),
    })),
    { dryRun: true, checkReferences: false },
  );
  for (const result of [...dryCategories, ...dryPosts]) {
    if (result.outcome === "invalid") {
      for (const message of result.problems) {
        report.problems.push({ file: result.file ?? `category ${result.key}`, message });
      }
    }
  }
  for (const post of plan.posts) {
    if (post.status === "draft" || options.publish) continue;
    const note = await unpublishedNote(
      host,
      post,
      dryPosts.find((r) => r.key === post.key),
    );
    if (note) report.notes.push({ file: post.file, message: note });
  }
  if (report.problems.length || options.dryRun) {
    report.records = [...dryCategories, ...dryPosts];
    return report;
  }
  if (options.publish && options.confirm) {
    const live = plan.posts.filter((p) => p.status !== "draft");
    const summary =
      `Publish ${live.filter((p) => p.status === "published").length} post(s) and schedule ` +
      `${live.filter((p) => p.status === "scheduled").length}, as you, with their own dates`;
    if (!(await options.confirm(summary))) {
      report.notes.push({ file: "", message: "Stopped before writing: not confirmed" });
      return report;
    }
  }

  // 3a. The pictures the library lacks.
  const ids = new Map<string, string>();
  for (const [file, bytes] of plan.pictures) {
    const hash = hashes.get(file) as string;
    let id = known.get(hash);
    if (id) report.pictures.already += 1;
    else {
      report.wroteNothing = false;
      const uploaded = await host.upload(bytes, file);
      id = uploaded.id;
      known.set(hash, id);
      if (uploaded.existing) report.pictures.already += 1;
      else report.pictures.uploaded += 1;
    }
    ids.set(file, id);
  }

  // 3b. Categories, then posts.
  const categories = await importRecords(
    host,
    CATEGORY_OBJECT,
    plan.categories.map((c) => ({ key: c.key, file: null, values: c.values })),
    { dryRun: false, checkReferences: true },
  );
  const categoryIds = new Map(categories.map((c) => [c.key, c.id]));
  const posts = await importRecords(
    host,
    POST_OBJECT,
    plan.posts.map((post) => ({
      key: post.key,
      file: post.file,
      values: resolved(
        post,
        (f) => ids.get(f) as string,
        (key) => categoryIds.get(key) ?? null,
      ),
    })),
    { dryRun: false, checkReferences: true },
  );
  report.records = [...categories, ...posts];
  if (report.records.some((r) => r.outcome === "created" || r.outcome === "updated")) {
    report.wroteNothing = false;
  }

  // 3c. Publishing, a person's decision for the whole run.
  if (options.publish) {
    for (const post of plan.posts) {
      const result = posts.find((r) => r.key === post.key);
      if (!result?.id || result.outcome === "conflict" || result.outcome === "invalid") continue;
      if (post.status === "draft") continue;
      const id = result.id;
      const record = await host.call<{ values: Record<string, unknown> }>("record.get", {
        object: POST_OBJECT,
        id,
      });
      const state = record.values.publishState;
      const due = post.status === "scheduled" && post.date && Date.parse(post.date) > now.getTime();
      if (due) {
        if (state === "scheduled" && record.values.publishAt === post.date) {
          report.published.push({ file: post.file, id, as: "unchanged" });
          continue;
        }
        await host.call("record.schedulePublish", {
          object: POST_OBJECT,
          id,
          at: post.date,
          note: "Imported",
        });
        report.wroteNothing = false;
        report.published.push({ file: post.file, id, as: "scheduled" });
        continue;
      }
      if (post.status === "scheduled") {
        report.notes.push({
          file: post.file,
          message: `Scheduled for ${post.date}, which has passed: published`,
        });
      }
      if (state === "published" && typeof record.values.publishedVersion === "number") {
        const diff = await host.call<{ changes: unknown[] }>("record.compareVersions", {
          object: POST_OBJECT,
          id,
          from: record.values.publishedVersion,
        });
        if (!diff.changes.length) {
          report.published.push({ file: post.file, id, as: "unchanged" });
          continue;
        }
      }
      await host.call("record.publish", { object: POST_OBJECT, id, note: "Imported" });
      report.wroteNothing = false;
      report.published.push({ file: post.file, id, as: "published" });
    }
  }
  return report;
}

/** The report as lines for a person to read. */
export function reportLines(report: ImportReport, dryRun: boolean): string[] {
  const lines: string[] = [];
  if (report.problems.length) {
    lines.push(`Nothing was written: ${report.problems.length} problem(s).`);
    for (const p of report.problems) lines.push(`  ${p.file}: ${p.message}`);
    return lines;
  }
  lines.push(...outcomeLines(report.records, dryRun));
  if (!dryRun) {
    lines.push(
      `Pictures: ${report.pictures.uploaded} uploaded, ${report.pictures.already} already in the library.`,
    );
  }
  for (const p of report.published) {
    if (p.as !== "unchanged") lines.push(`  ${p.file}: ${p.as}`);
  }
  for (const note of report.notes)
    lines.push(`  ${note.file ? `${note.file}: ` : ""}${note.message}`);
  return lines;
}

export { PICTURE };
