// The courses import itself (stage 42, ADR 0495): a plan (format.ts) written to a host through its
// HTTP surface as the person signed in for the run, on the shared import door (import-door/,
// ADR 0470): `record.import` with import keys, a dry run first, a person's or a student's edit
// reported as a conflict, never overwritten. No file system and no terminal here.
//
// The order, so nothing is written before everything is checked:
//   1. the folder's own problems;
//   2. who each row is: a student is the one live Person with the row's email address (none, or
//      more than one, is reported with the row's file and line, and the row is left out);
//      a session lesson's program is a published program with that id or that title;
//   3. a dry run of every record (themes, courses, bundles, enrolments, progress) on the host;
//   4. only then, unless dryRun: pictures and downloads the library lacks (by SHA-256); videos the
//      library lacks (by the SHA-256 of their file, or of their address), uploaded straight to
//      Stream (resumable, with progress) or copied from their address, and their captions; a wait
//      for Stream to say each is ready; the records; and with `publish`, publishing.
// A course whose videos are not ready when the wait ends is not written: the report names it,
// and a re-run (which uploads nothing twice) writes it once they are.
import type { ImportHost } from "../import-door/host.ts";
import {
  type ImportResult,
  importRecords,
  knownByHash,
  outcomeLines,
  type Problem,
  sha256,
} from "../import-door/records.ts";
import {
  BUNDLE,
  COURSE,
  type CoursesPlan,
  ENROLMENT,
  MEDIA,
  PROGRESS,
  THEME,
  withMedia,
} from "./format.ts";

/** A video's bytes, read when they are sent (a large file is never held whole). */
export interface VideoSource {
  size: number;
  /** SHA-256 of the whole file, hex (the CLI streams it once). */
  sha256: string;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface CoursesImportOptions {
  dryRun?: boolean;
  publish?: boolean;
  confirm?: (summary: string) => Promise<boolean>;
  /** videos/ files by name. */
  videoFiles?: (name: string) => VideoSource | undefined;
  /** How long to wait for Stream to have the videos ready, in ms. Default 10 minutes. */
  waitMs?: number;
  /** How often to ask, in ms. Default 5 s. */
  pollMs?: number;
  /** Progress for a person to watch: an upload's share, a wait. */
  progress?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface CoursesImportReport {
  problems: Problem[];
  records: ImportResult[];
  /** Rows that matched nothing on the host or in the outline: left out, with their file and line. */
  unmatched: Problem[];
  media: { uploaded: number; already: number; videosUploaded: number; videosAlready: number };
  /** Courses not written because their videos are not ready yet (run again). */
  waiting: { file: string; videos: string[] }[];
  published: { file: string; id: string; as: "published" | "unchanged" }[];
  notes: Problem[];
  wroteNothing: boolean;
}

const placeholder = (i: number) => `med_import${i}`;

/** The one live Person with this address, or why there is not one. */
async function personFor(
  host: ImportHost,
  email: string,
): Promise<{ id: string } | { problem: string }> {
  const found = await host.call<{ items: { id: string }[] }>("person.list", {
    filter: { field: "emails", op: "eq", value: email },
    limit: 3,
  });
  if (!found.items.length) {
    return {
      problem: `No person on the host has ${email}: import people first (the people CSV import)`,
    };
  }
  if (found.items.length > 1) {
    return {
      problem: `${found.items.length} people on the host have ${email}: merge them first (left out, not guessed)`,
    };
  }
  return { id: (found.items[0] as { id: string }).id };
}

/** Runs the import. Throws only for what the host refused outright (a session that ended). */
export async function runCoursesImport(
  plan: CoursesPlan,
  host: ImportHost,
  options: CoursesImportOptions = {},
): Promise<CoursesImportReport> {
  const report: CoursesImportReport = {
    problems: [...plan.problems],
    records: [],
    unmatched: [],
    media: { uploaded: 0, already: 0, videosUploaded: 0, videosAlready: 0 },
    waiting: [],
    published: [],
    notes: [],
    wroteNothing: true,
  };
  if (report.problems.length) return report;
  const say = options.progress ?? (() => {});
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // 2. Who each row is, and each session lesson's program.
  const emails = [
    ...new Set([...plan.access.map((r) => r.email), ...(plan.progress ?? []).map((r) => r.email)]),
  ];
  const people = new Map<string, { id: string } | { problem: string }>();
  for (const email of emails) people.set(email, await personFor(host, email));
  const programs = new Map<string, string | null>();
  for (const name of new Set(plan.courses.flatMap((c) => c.programs.map((p) => p.name)))) {
    const page = await host.call<{ items: { id: string; values: Record<string, unknown> }[] }>(
      "record.list",
      {
        object: "programs.program",
        filter: { field: "publishState", op: "eq", value: "published" },
        limit: 200,
      },
    );
    const hit =
      page.items.find((p) => p.id === name) ?? page.items.filter((p) => p.values.title === name);
    const one = Array.isArray(hit) ? (hit.length === 1 ? hit[0] : undefined) : hit;
    programs.set(name, one?.id ?? null);
    if (!one) {
      for (const c of plan.courses.filter((c) => c.programs.some((p) => p.name === name))) {
        report.problems.push({
          file: c.file,
          message: `No one published program is "${name}" (its id, or its exact title)`,
        });
      }
    }
  }
  if (report.problems.length) return report;
  const withPrograms = (values: Record<string, unknown>, course: (typeof plan.courses)[number]) => {
    const outline = JSON.parse(JSON.stringify(values.outline)) as {
      sections: { lessons: Record<string, unknown>[] }[];
    };
    for (const p of course.programs) {
      const lesson = outline.sections[p.path[0] as number]?.lessons[p.path[1] as number];
      if (lesson) lesson.program = programs.get(p.name);
    }
    return { ...values, outline };
  };

  // What the library has already: files by their bytes, videos by their file's or address's hash.
  const fileHashes = new Map<string, string>();
  for (const [ref, file] of plan.files) fileHashes.set(ref, await sha256(file.bytes));
  const videoHashes = new Map<string, string>();
  for (const [ref, video] of plan.videos) {
    const source = video.file ? options.videoFiles?.(video.file) : undefined;
    if (video.file && !source) {
      report.problems.push({ file: `videos/${video.file}`, message: "Cannot be read" });
      continue;
    }
    videoHashes.set(ref, source ? source.sha256 : await sha256(`url:${video.url}`));
  }
  if (report.problems.length) return report;
  const known = await knownByHash(host, [...fileHashes.values(), ...videoHashes.values()]);

  // 3. The dry run: every record through the host's own checks, media not yet in the library as
  // placeholders, so a bad record stops the run before any write.
  let n = 0;
  const dryIds = new Map<string, string>();
  const dryMedia = (ref: string) => {
    const hash = fileHashes.get(ref) ?? videoHashes.get(ref);
    const have = hash ? known.get(hash)?.id : undefined;
    if (have) return have;
    if (!dryIds.has(ref)) {
      n += 1;
      dryIds.set(ref, placeholder(n));
    }
    return dryIds.get(ref) as string;
  };
  const themeRecords = plan.themes.map((name) => ({
    key: `theme:${name}`,
    file: null,
    values: { name },
  }));
  const courseRecords = (
    media: (ref: string) => string,
    themeId: (name: string) => string | null,
  ) =>
    plan.courses.map((c) => ({
      key: c.key,
      file: c.file,
      values: {
        ...(withMedia(withPrograms(c.values, c), media) as Record<string, unknown>),
        ...(c.theme && themeId(c.theme) ? { theme: themeId(c.theme) } : {}),
      },
    }));
  const dryThemes = await importRecords(host, THEME, themeRecords, {
    dryRun: true,
    checkReferences: false,
  });
  const dryCourses = await importRecords(
    host,
    COURSE,
    courseRecords(dryMedia, () => null),
    {
      dryRun: true,
      checkReferences: false,
    },
  );
  const dryBundles = await importRecords(
    host,
    BUNDLE,
    plan.bundles.map((b) => ({
      key: b.key,
      file: b.file,
      values: {
        ...(withMedia(b.values, dryMedia) as Record<string, unknown>),
        courses: { items: b.courses.map((_c, i) => `rec_importplaceholder${i}`) },
      },
    })),
    { dryRun: true, checkReferences: false },
  );
  for (const r of [...dryThemes, ...dryCourses, ...dryBundles]) {
    if (r.outcome === "invalid") {
      for (const message of r.problems) report.problems.push({ file: r.file ?? r.key, message });
    }
  }

  // Enrolments and progress, as rows the host can take (who, which course, which lesson).
  const courseOf = new Map(plan.courses.map((c) => [c.key, c]));
  const access = plan.access.flatMap((row) => {
    const who = people.get(row.email);
    if (!who || "problem" in who) {
      report.unmatched.push({
        file: `${row.file}:${row.line}`,
        message: who?.problem ?? "No person",
      });
      return [];
    }
    return [{ row, person: who.id }];
  });
  const progress = (plan.progress ?? []).flatMap((row) => {
    const who = people.get(row.email);
    if (!who || "problem" in who) {
      report.unmatched.push({
        file: `${row.file}:${row.line}`,
        message: who?.problem ?? "No person",
      });
      return [];
    }
    const lessonKey = courseOf.get(row.course)?.lessons.get(row.sourceId);
    if (!lessonKey) {
      report.unmatched.push({
        file: `${row.file}:${row.line}`,
        message: `No lesson of ${row.course} has the sourceId "${row.sourceId}" (dropped from the outline?)`,
      });
      return [];
    }
    return [{ row, person: who.id, lessonKey }];
  });
  if (report.problems.length || options.dryRun) {
    report.records = [...dryThemes, ...dryCourses, ...dryBundles];
    return report;
  }
  if (options.publish && options.confirm) {
    const live = [...plan.courses, ...plan.bundles].filter((x) => x.status === "published");
    const summary = `Publish ${live.length} course(s) and bundle(s), as you`;
    if (!(await options.confirm(summary))) {
      report.notes.push({ file: "", message: "Stopped before writing: not confirmed" });
      return report;
    }
  }

  // 4a. Pictures and downloads the library lacks.
  const ids = new Map<string, string>();
  for (const [ref, file] of plan.files) {
    const hash = fileHashes.get(ref) as string;
    const have = known.get(hash);
    if (have) {
      report.media.already += 1;
      ids.set(ref, have.id);
      continue;
    }
    const up = await host.upload(file.bytes, file.name);
    report.wroteNothing = false;
    report.media[up.existing ? "already" : "uploaded"] += 1;
    ids.set(ref, up.id);
  }

  // 4b. Videos the library lacks: uploaded once, found by their hash on a re-run.
  for (const [ref, video] of plan.videos) {
    const hash = videoHashes.get(ref) as string;
    const have = known.get(hash);
    if (have && have.state !== "uploading" && have.state !== "failed") {
      report.media.videosAlready += 1;
      ids.set(ref, have.id);
      continue;
    }
    if (have) {
      // An upload a run left half-done, or one Stream could not take: removed and sent again.
      await host.call("media.delete", { id: have.id });
      report.notes.push({
        file: video.file ? `videos/${video.file}` : (video.url ?? ref),
        message: `Sent again (it was ${have.state})`,
      });
    }
    report.wroteNothing = false;
    if (video.url) {
      const made = await host.call<{ item: { id: string } }>("media.videoFromUrl", {
        name: video.name,
        url: video.url,
        sha256: hash,
      });
      ids.set(ref, made.item.id);
      say(`${video.url}: Stream is copying it`);
    } else {
      const source = options.videoFiles?.(video.file as string) as VideoSource;
      const asked = await host.call<{
        item: { id: string };
        upload: { url: string; protocol: "tus" | "post"; chunkBytes: number };
      }>("media.videoUpload", { name: video.name, bytes: source.size, sha256: hash });
      await sendVideo(host, asked.upload, source, (share) =>
        say(`videos/${video.file}: ${Math.round(share * 100)}%`),
      );
      ids.set(ref, asked.item.id);
    }
    report.media.videosUploaded += 1;
    for (const caption of video.captions) {
      await host.uploadCaption?.(
        ids.get(ref) as string,
        caption.language,
        caption.label,
        caption.vtt,
      );
    }
  }

  // 4c. Wait for Stream to have them ready, then write what is ready.
  const ready = new Set<string>();
  const deadline = Date.now() + (options.waitMs ?? 10 * 60_000);
  for (;;) {
    for (const [ref] of plan.videos) {
      if (ready.has(ref)) continue;
      const item = await host.call<{ state: string }>("media.videoRefresh", { id: ids.get(ref) });
      if (item.state === "ready") ready.add(ref);
    }
    const left = [...plan.videos.keys()].filter((r) => !ready.has(r));
    if (!left.length || Date.now() >= deadline) break;
    say(`Waiting for Stream: ${left.length} video(s) not ready yet`);
    await sleep(options.pollMs ?? 5000);
  }
  const mediaId = (ref: string) => ids.get(ref) as string;
  const themes = await importRecords(host, THEME, themeRecords, {
    dryRun: false,
    checkReferences: true,
  });
  const themeIds = new Map(themes.map((t) => [t.key, t.id]));
  const writable = plan.courses.filter((c) => c.videos.every((v) => ready.has(v)));
  for (const c of plan.courses.filter((c) => !writable.includes(c))) {
    report.waiting.push({ file: c.file, videos: c.videos.filter((v) => !ready.has(v)) });
  }
  const courses = await importRecords(
    host,
    COURSE,
    courseRecords(mediaId, (name) => themeIds.get(`theme:${name}`) ?? null).filter((r) =>
      writable.some((c) => c.key === r.key),
    ),
    { dryRun: false, checkReferences: true },
  );
  const courseIds = new Map(courses.filter((r) => r.id).map((r) => [r.key, r.id as string]));
  const bundles = await importRecords(
    host,
    BUNDLE,
    plan.bundles
      .filter((b) => b.courses.every((c) => courseIds.has(c)))
      .map((b) => ({
        key: b.key,
        file: b.file,
        values: {
          ...(withMedia(b.values, mediaId) as Record<string, unknown>),
          courses: { items: b.courses.map((c) => courseIds.get(c)) },
        },
      })),
    { dryRun: false, checkReferences: true },
  );
  for (const b of plan.bundles.filter((b) => !b.courses.every((c) => courseIds.has(c)))) {
    report.waiting.push({ file: b.file, videos: [] });
  }
  const bundleIds = new Map(bundles.filter((r) => r.id).map((r) => [r.key, r.id as string]));

  // 4d. Enrolments: access as `courses.enrolment` records from the import, never orders.
  const enrolments = await importRecords(
    host,
    ENROLMENT,
    access
      .filter(({ row }) =>
        row.course ? courseIds.has(row.course) : bundleIds.has(row.bundle as string),
      )
      .map(({ row, person }) => {
        const key = `${row.email}|${row.course ? `course:${row.course}` : `bundle:${row.bundle}`}`;
        return {
          key,
          file: `${row.file}:${row.line}`,
          values: {
            holder: person,
            ...(row.course
              ? { course: courseIds.get(row.course) }
              : { bundle: bundleIds.get(row.bundle as string) }),
            source: "import",
            reason: "Imported from the old platform",
            ...(row.from ? { from: row.from } : {}),
            ...(row.until ? { until: row.until } : {}),
            completed: row.completed,
          },
        };
      }),
    { dryRun: false, checkReferences: true },
  );

  // 4e. Progress, lesson by lesson. A student's own row for a lesson (theirs, not the import's)
  // is kept: reported as a conflict, never written over.
  const own = new Map<string, Set<string>>();
  for (const courseKey of new Set(progress.map((p) => p.row.course))) {
    const id = courseIds.get(courseKey);
    if (!id) continue;
    const rows = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { items: { values: Record<string, unknown> }[]; nextCursor: string | null } =
        await host.call("record.list", {
          object: PROGRESS,
          filter: {
            and: [
              { field: "course", op: "eq", value: id },
              { field: "source", op: "neq", value: "import" },
            ],
          },
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
      for (const p of page.items) rows.add(`${p.values.holder}|${p.values.lessonKey}`);
      cursor = page.nextCursor;
    } while (cursor);
    own.set(id, rows);
  }
  const kept: ImportResult[] = [];
  const progressRecords = progress.flatMap(({ row, person, lessonKey }) => {
    const id = courseIds.get(row.course);
    if (!id) return [];
    const key = `${row.email}|${row.course}|${row.sourceId}`;
    if (own.get(id)?.has(`${person}|${lessonKey}`)) {
      kept.push({
        key,
        file: `${row.file}:${row.line}`,
        object: PROGRESS,
        id: null,
        outcome: "conflict",
        fields: [],
        problems: ["The student has their own progress on this lesson: kept"],
      });
      return [];
    }
    return [
      {
        key,
        file: `${row.file}:${row.line}`,
        values: {
          holder: person,
          course: id,
          lessonKey,
          state: row.state,
          source: "import",
          ...(row.doneAt ? { doneAt: row.doneAt, startedAt: row.doneAt } : {}),
          ...(row.position !== null ? { position: row.position } : {}),
        },
      },
    ];
  });
  const progressResults = progressRecords.length
    ? await importRecords(host, PROGRESS, progressRecords, { dryRun: false, checkReferences: true })
    : [];

  report.records = [...themes, ...courses, ...bundles, ...enrolments, ...progressResults, ...kept];
  if (report.records.some((r) => r.outcome === "created" || r.outcome === "updated")) {
    report.wroteNothing = false;
  }
  const withProgress = new Set(progress.map((p) => p.row.course));
  const brought = plan.courses.filter(
    (c) => plan.access.some((a) => a.course === c.key) && !withProgress.has(c.key),
  );
  if (plan.progress === null && plan.access.length) {
    report.notes.push({
      file: "",
      message: "No progress.csv: completions imported, lesson progress not",
    });
  }
  for (const c of brought) {
    report.notes.push({ file: c.file, message: "No lesson progress to bring for this course" });
  }

  // 4f. Publishing, a person's decision for the whole run; only what was written.
  if (options.publish) {
    for (const item of [
      ...plan.courses.map((c) => ({ object: COURSE, plan: c, id: courseIds.get(c.key) })),
      ...plan.bundles.map((b) => ({ object: BUNDLE, plan: b, id: bundleIds.get(b.key) })),
    ]) {
      if (item.plan.status !== "published" || !item.id) continue;
      const record = await host.call<{ values: Record<string, unknown> }>("record.get", {
        object: item.object,
        id: item.id,
      });
      if (
        record.values.publishState === "published" &&
        typeof record.values.publishedVersion === "number"
      ) {
        const diff = await host.call<{ changes: unknown[] }>("record.compareVersions", {
          object: item.object,
          id: item.id,
          from: record.values.publishedVersion,
        });
        if (!diff.changes.length) {
          report.published.push({ file: item.plan.file, id: item.id, as: "unchanged" });
          continue;
        }
      }
      await host.call("record.publish", { object: item.object, id: item.id, note: "Imported" });
      report.wroteNothing = false;
      report.published.push({ file: item.plan.file, id: item.id, as: "published" });
    }
  } else {
    for (const x of [...plan.courses, ...plan.bundles].filter((x) => x.status === "published")) {
      report.notes.push({
        file: x.file,
        message: "Published in the source: imported as a draft (pass --publish to publish it)",
      });
    }
  }
  return report;
}

/** Sends a video's file to its one-time Stream address: one post, or tus chunks resumed on a drop. */
export async function sendVideo(
  host: ImportHost,
  upload: { url: string; protocol: "tus" | "post"; chunkBytes: number },
  source: VideoSource,
  progress: (share: number) => void,
): Promise<void> {
  const send = host.send;
  if (!send) throw new Error("This host cannot send to Stream");
  if (upload.protocol === "post") {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(await source.read(0, source.size))]), "video");
    const response = await send(upload.url, { method: "POST", body: form });
    if (!response.ok) throw new Error(`Stream refused the upload (HTTP ${response.status})`);
    progress(1);
    return;
  }
  let offset = 0;
  let retries = 0;
  while (offset < source.size) {
    const length = Math.min(upload.chunkBytes, source.size - offset);
    const chunk = await source.read(offset, length);
    const response = await send(upload.url, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
      },
      body: new Uint8Array(chunk),
    }).catch(() => null);
    if (!response?.ok) {
      if (retries++ >= 5) throw new Error("Stream stopped taking the upload; run the import again");
      // Ask where Stream is, and carry on from there.
      const head = await send(upload.url, {
        method: "HEAD",
        headers: { "Tus-Resumable": "1.0.0" },
      }).catch(() => null);
      offset = Number(head?.headers.get("upload-offset") ?? offset);
      continue;
    }
    retries = 0;
    offset = Number(response.headers.get("upload-offset") ?? offset + length);
    progress(offset / source.size);
  }
}

/** The report as lines for a person to read. */
export function coursesReportLines(report: CoursesImportReport, dryRun: boolean): string[] {
  const lines: string[] = [];
  if (report.problems.length) {
    lines.push(`Nothing was written: ${report.problems.length} problem(s).`);
    for (const p of report.problems) lines.push(`  ${p.file}: ${p.message}`);
    return lines;
  }
  lines.push(...outcomeLines(report.records, dryRun));
  if (report.unmatched.length) {
    lines.push(`${report.unmatched.length} row(s) matched nothing and were left out:`);
    for (const u of report.unmatched) lines.push(`  ${u.file}: ${u.message}`);
  }
  if (!dryRun) {
    const m = report.media;
    lines.push(
      `Media: ${m.uploaded} file(s) uploaded, ${m.already} already in the library; ${m.videosUploaded} video(s) sent, ${m.videosAlready} already in Stream.`,
    );
  }
  for (const w of report.waiting) {
    lines.push(
      `  ${w.file}: not written yet: ${w.videos.length ? "its videos are not ready in Stream" : "a course it lists is not written yet"}. Run the import again later.`,
    );
  }
  for (const p of report.published) if (p.as !== "unchanged") lines.push(`  ${p.file}: ${p.as}`);
  for (const note of report.notes)
    lines.push(`  ${note.file ? `${note.file}: ` : ""}${note.message}`);
  return lines;
}

export { MEDIA };
