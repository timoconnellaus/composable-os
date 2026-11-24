// The courses import's folder (stage 42, ADR 0495): what `cos courses import <folder>` reads, as
// data, checked before anyone signs in. Pure: run.ts reads the disk and hands the files here; the
// tests hand them in memory.
//
//   courses/<key>.json     one course: its fields, outline (sections of lessons, each lesson its
//                          sourceId on the old platform), cover, trailer, theme and level, status
//   bundles/<key>.json     one bundle: its fields and its courses (by course key), status
//   videos/<file>          a lesson's or trailer's video by `file` (or `url` in the JSON instead)
//   captions/<file>        a video's captions: WebVTT, or SubRip (.srt), converted here
//   pictures/<file>        covers, and pictures in rich text (`{ "type": "image", "file" }`)
//   downloads/<file>       a download lesson's file (a PDF)
//   access.csv             email,course,bundle,from,until,completed: who holds what
//   progress.csv           email,course,lesson,state,done_at,position: lesson by lesson, by the
//                          lesson's sourceId, when the old platform exports it
//
// The host checks every record again (`record.import`'s dry run): its outline against the course's
// schema, its prices, its references. This checks what only the folder can say: files that are
// there, keys used once, CSV rows that name a course or lesson the folder has.
import { MEDIA_CAPTION_MAX_BYTES, mediaProblem, sniffFileType } from "@composable-os/sdk";
import { isObject, type Problem, replaceMarked } from "../import-door/records.ts";

export const FORMAT_VERSION = 1;
export const COURSE = "courses.course";
export const BUNDLE = "courses.bundle";
export const THEME = "courses.theme";
export const ENROLMENT = "courses.enrolment";
export const PROGRESS = "courses.progress";

const STATUSES = ["draft", "published"] as const;
export type Status = (typeof STATUSES)[number];
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const LESSON_KEY_RE = /^[a-z0-9-]{1,40}$/;
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** Where a media item goes in a value, until it is in the library and has an id. */
export const MEDIA = "$media";
export type MediaRef = { [MEDIA]: string };

/** A video the folder names: a file in videos/, or an address Stream copies from. */
export interface PlannedVideo {
  /** `file:<name>` or `url:<address>`: the video's name in this plan, and its hash's input. */
  ref: string;
  name: string;
  file?: string;
  url?: string;
  captions: { language: string; label: string; vtt: Uint8Array }[];
}

export interface PlannedCourse {
  file: string;
  key: string;
  status: Status;
  theme: string | null;
  /** Values with `{ $media: <ref> }` where a media id goes. */
  values: Record<string, unknown>;
  /** The lessons' keys by their sourceId, for progress. */
  lessons: Map<string, string>;
  /** Video refs the course needs ready before it can be written. */
  videos: string[];
  /** Session lessons' programs as the file names them (an id or a title), and where. */
  programs: { name: string; path: (string | number)[] }[];
}

export interface PlannedBundle {
  file: string;
  key: string;
  status: Status;
  values: Record<string, unknown>;
  courses: string[];
}

export interface AccessRow {
  file: string;
  line: number;
  email: string;
  course: string | null;
  bundle: string | null;
  from: string | null;
  until: string | null;
  completed: boolean;
}

export interface ProgressRow {
  file: string;
  line: number;
  email: string;
  course: string;
  sourceId: string;
  state: "started" | "done";
  doneAt: string | null;
  position: number | null;
}

export interface CoursesPlan {
  courses: PlannedCourse[];
  bundles: PlannedBundle[];
  themes: string[];
  videos: Map<string, PlannedVideo>;
  /** pictures/ and downloads/ files the folder uses, by `picture:<name>` / `download:<name>`. */
  files: Map<string, { name: string; bytes: Uint8Array }>;
  access: AccessRow[];
  progress: ProgressRow[] | null;
  problems: Problem[];
}

export interface CoursesFolder {
  courses: Map<string, string>;
  bundles: Map<string, string>;
  /** videos/: file names and sizes (the bytes are read when sent, not held here). */
  videos: Map<string, number>;
  captions: Map<string, Uint8Array>;
  pictures: Map<string, Uint8Array>;
  downloads: Map<string, Uint8Array>;
  access: string | null;
  progress: string | null;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. Rows with their 1-based line. */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const end = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== "")) rows.push({ line: start, cells });
    cells = [];
    cell = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else {
        if (c === "\n") line += 1;
        cell += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      cells.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      end();
      line += 1;
      start = line;
    } else cell += c;
  }
  if (cell !== "" || cells.length) end();
  return rows;
}

/** SubRip (.srt) as WebVTT: the header, and a dot for the comma in each time. */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${body.trim()}\n`;
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

/** The folder as an import, with every problem and the file (and line) it is in. */
export function readCoursesFolder(folder: CoursesFolder): CoursesPlan {
  const problems: Problem[] = [];
  const videos = new Map<string, PlannedVideo>();
  const files = new Map<string, { name: string; bytes: Uint8Array }>();
  const themes = new Set<string>();
  const courses: PlannedCourse[] = [];
  const bundles: PlannedBundle[] = [];
  const sourceIds = new Map<string, string>();

  const captionsOf = (raw: unknown, where: string, fault: (m: string) => void) => {
    const out: PlannedVideo["captions"] = [];
    if (raw === undefined) return out;
    if (!Array.isArray(raw)) {
      fault(`${where}.captions is a list of { language, file, label? }`);
      return out;
    }
    for (const c of raw) {
      const language = isObject(c) && typeof c.language === "string" ? c.language : "";
      const name = isObject(c) && typeof c.file === "string" ? c.file : "";
      const bytes = folder.captions.get(name);
      if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language) || !bytes) {
        fault(
          `${where}.captions: ${name ? `captions/${name}` : "a caption"} with a language (en, pt-BR) and a file in captions/`,
        );
        continue;
      }
      const text = new TextDecoder().decode(bytes);
      const vtt = new TextEncoder().encode(
        name.toLowerCase().endsWith(".srt") ? srtToVtt(text) : text,
      );
      if (
        vtt.byteLength > MEDIA_CAPTION_MAX_BYTES ||
        !new TextDecoder().decode(vtt).replace(/^﻿/, "").startsWith("WEBVTT")
      ) {
        fault(`captions/${name}: a WebVTT or SubRip file of at most 10 MB`);
        continue;
      }
      const label = isObject(c) && typeof c.label === "string" ? c.label : language;
      out.push({ language, label, vtt });
    }
    return out;
  };

  const video = (raw: unknown, where: string, fault: (m: string) => void): MediaRef | null => {
    if (!isObject(raw)) {
      fault(`${where} is { file } (in videos/) or { url } (https), with captions`);
      return null;
    }
    const captions = captionsOf(raw.captions, where, fault);
    if (typeof raw.file === "string") {
      if (!folder.videos.has(raw.file)) {
        fault(`${where}: videos/${raw.file} is not there`);
        return null;
      }
      const ref = `file:${raw.file}`;
      if (!videos.has(ref)) videos.set(ref, { ref, name: raw.file, file: raw.file, captions });
      return { [MEDIA]: ref };
    }
    if (typeof raw.url === "string" && raw.url.startsWith("https://")) {
      const ref = `url:${raw.url}`;
      const name = raw.url.split("/").pop()?.split("?")[0] || "video";
      if (!videos.has(ref)) videos.set(ref, { ref, name, url: raw.url, captions });
      return { [MEDIA]: ref };
    }
    fault(`${where} is { file } (in videos/) or { url } (https)`);
    return null;
  };

  const picture = (name: unknown, where: string, fault: (m: string) => void): MediaRef | null => {
    const bytes = typeof name === "string" ? folder.pictures.get(name) : undefined;
    if (!bytes || typeof name !== "string") {
      fault(`${where}: a picture is a file name in pictures/`);
      return null;
    }
    const problem = mediaProblem(bytes);
    if (problem) {
      fault(`${where}: pictures/${name}: ${problem}`);
      return null;
    }
    files.set(`picture:${name}`, { name, bytes });
    return { [MEDIA]: `picture:${name}` };
  };

  const download = (name: unknown, where: string, fault: (m: string) => void): MediaRef | null => {
    const bytes = typeof name === "string" ? folder.downloads.get(name) : undefined;
    if (!bytes || typeof name !== "string" || !sniffFileType(bytes)) {
      fault(`${where}: a download is a PDF in downloads/`);
      return null;
    }
    files.set(`download:${name}`, { name, bytes });
    return { [MEDIA]: `download:${name}` };
  };

  /** Rich text with `{ type: "image", file }` pictures. */
  const richText = (raw: unknown, where: string, fault: (m: string) => void) =>
    JSON.parse(JSON.stringify(raw), (_k, v) => {
      if (isObject(v) && v.type === "image" && typeof v.file === "string" && !("media" in v)) {
        const { file: f, ...rest } = v;
        return { ...rest, media: picture(f, `${where} (picture ${f})`, fault) ?? "med_missing" };
      }
      return v;
    });

  const keys = new Map<string, string>();
  for (const [file, text] of [...folder.courses].sort(([a], [b]) => a.localeCompare(b))) {
    const path = `courses/${file}`;
    const fault = (message: string) => problems.push({ file: path, message });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      fault(`Not JSON: ${(error as Error).message}`);
      continue;
    }
    if (!isObject(raw)) {
      fault("A course is a JSON object");
      continue;
    }
    const key = typeof raw.key === "string" ? raw.key : file.replace(/\.json$/i, "");
    if (!KEY_RE.test(key)) fault(`The key "${key}" is not 1 to 100 letters, digits or ._:-`);
    if (keys.has(key)) fault(`The key "${key}" is ${keys.get(key)}'s too`);
    keys.set(key, path);
    const values: Record<string, unknown> = {};
    for (const name of ["title", "slug", "summary"] as const) {
      if (raw[name] !== undefined) values[name] = raw[name];
    }
    if (typeof raw.title !== "string" || !raw.title.trim()) fault("title is required");
    if (raw.level !== undefined) values.level = raw.level;
    if (raw.price !== undefined) values.price = raw.price;
    else fault("price is required (in the major unit: 99 is 99.00)");
    if (raw.description !== undefined)
      values.description = richText(raw.description, "description", fault);
    if (raw.cover !== undefined) {
      const c = isObject(raw.cover) ? raw.cover : {};
      const ref = picture(c.file, "cover", fault);
      if (ref) values.cover = { media: ref, alt: typeof c.alt === "string" ? c.alt : "" };
    }
    const courseVideos: string[] = [];
    if (raw.trailer !== undefined) {
      const ref = video(raw.trailer, "trailer", fault);
      if (ref) {
        values.trailer = { media: ref };
        courseVideos.push(ref[MEDIA]);
      }
    }
    const theme = typeof raw.theme === "string" && raw.theme.trim() ? raw.theme.trim() : null;
    if (theme) themes.add(theme);
    const lessons = new Map<string, string>();
    const programs: PlannedCourse["programs"] = [];
    const outline =
      isObject(raw.outline) && Array.isArray(raw.outline.sections) ? raw.outline : null;
    if (!outline) fault("outline is { sections: [{ key, title, lessons: [...] }] }");
    const lessonKeys = new Set<string>();
    const sections = ((outline?.sections as unknown[] | undefined) ?? []).map((section, s) => {
      const sec = isObject(section) ? section : {};
      const list = Array.isArray(sec.lessons) ? sec.lessons : [];
      return {
        ...sec,
        lessons: list.map((given, l) => {
          const where = `outline.sections.${s}.lessons.${l}`;
          if (!isObject(given)) {
            fault(`${where} is a lesson object`);
            return given;
          }
          const lesson: Record<string, unknown> = { ...given };
          const lessonKey = typeof lesson.key === "string" ? lesson.key : "";
          if (!LESSON_KEY_RE.test(lessonKey))
            fault(`${where}.key is lowercase letters, digits and -`);
          else if (lessonKeys.has(lessonKey)) fault(`${where}.key "${lessonKey}" is used twice`);
          lessonKeys.add(lessonKey);
          if (typeof lesson.sourceId === "string") {
            const before = sourceIds.get(`${key}|${lesson.sourceId}`);
            if (before) fault(`${where}.sourceId "${lesson.sourceId}" is ${before}'s too`);
            sourceIds.set(`${key}|${lesson.sourceId}`, where);
            lessons.set(lesson.sourceId, lessonKey);
          }
          if (lesson.video !== undefined) {
            const ref = video(lesson.video, `${where}.video`, fault);
            if (ref) {
              lesson.video = { media: ref };
              courseVideos.push(ref[MEDIA]);
            }
          }
          for (const text of ["notes", "body"] as const) {
            if (lesson[text] !== undefined)
              lesson[text] = richText(lesson[text], `${where}.${text}`, fault);
          }
          if (lesson.kind === "download") {
            const ref = download(lesson.file, `${where}.file`, fault);
            if (ref) lesson.file = ref;
          }
          if (lesson.kind === "session") {
            if (typeof lesson.program !== "string" || !lesson.program.trim()) {
              fault(`${where}.program is a published program's id or its title`);
            } else programs.push({ name: lesson.program, path: [s, l] });
          }
          return lesson;
        }),
      };
    });
    values.outline = { sections };
    const status = (raw.status ?? "draft") as Status;
    if (!STATUSES.includes(status)) fault(`status is ${STATUSES.join(" or ")}`);
    if (values.slug === undefined && typeof raw.title === "string")
      values.slug = slugify(raw.title);
    courses.push({
      file: path,
      key,
      status,
      theme,
      values,
      lessons,
      videos: courseVideos,
      programs,
    });
  }

  for (const [file, text] of [...folder.bundles].sort(([a], [b]) => a.localeCompare(b))) {
    const path = `bundles/${file}`;
    const fault = (message: string) => problems.push({ file: path, message });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      fault(`Not JSON: ${(error as Error).message}`);
      continue;
    }
    if (!isObject(raw)) {
      fault("A bundle is a JSON object");
      continue;
    }
    const key = typeof raw.key === "string" ? raw.key : file.replace(/\.json$/i, "");
    const values: Record<string, unknown> = {};
    for (const name of ["title", "slug", "summary", "price"] as const) {
      if (raw[name] !== undefined) values[name] = raw[name];
    }
    if (values.slug === undefined && typeof raw.title === "string")
      values.slug = slugify(raw.title);
    if (raw.description !== undefined)
      values.description = richText(raw.description, "description", fault);
    if (raw.cover !== undefined) {
      const c = isObject(raw.cover) ? raw.cover : {};
      const ref = picture(c.file, "cover", fault);
      if (ref) values.cover = { media: ref, alt: typeof c.alt === "string" ? c.alt : "" };
    }
    const list = Array.isArray(raw.courses)
      ? raw.courses.filter((c): c is string => typeof c === "string")
      : [];
    for (const c of list) if (!keys.has(c)) fault(`courses: "${c}" is no course in courses/`);
    const status = (raw.status ?? "draft") as Status;
    if (!STATUSES.includes(status)) fault(`status is ${STATUSES.join(" or ")}`);
    bundles.push({ file: path, key, status, values, courses: list });
  }

  // access.csv and progress.csv: each row's problems name its line; a row that names nothing in
  // the folder is a problem (the folder is wrong), one whose person is not on the host is not (it
  // is reported, and the rest imports).
  const csv = (text: string, file: string, columns: string[]) => {
    const rows = parseCsv(text);
    const header = rows.shift();
    const names = (header?.cells ?? []).map((c) => c.trim().toLowerCase());
    for (const required of columns.filter((c) => c.endsWith("*")).map((c) => c.slice(0, -1))) {
      if (!names.includes(required))
        problems.push({ file, message: `The header has no "${required}" column` });
    }
    return rows.map((row) => {
      const cell = (name: string) => {
        const at = names.indexOf(name);
        return at >= 0 ? (row.cells[at] ?? "").trim() : "";
      };
      return { line: row.line, cell };
    });
  };
  const access: AccessRow[] = [];
  const bundleKeys = new Set(bundles.map((b) => b.key));
  if (folder.access !== null) {
    for (const { line, cell } of csv(folder.access, "access.csv", [
      "email*",
      "course",
      "bundle",
      "from",
      "until",
      "completed",
    ])) {
      const fault = (message: string) => problems.push({ file: `access.csv:${line}`, message });
      const email = cell("email").toLowerCase();
      const course = cell("course") || null;
      const bundle = cell("bundle") || null;
      if (!EMAIL_RE.test(email)) fault("email is an address");
      if (Boolean(course) === Boolean(bundle)) fault("name a course or a bundle, not both");
      if (course && !keys.has(course)) fault(`"${course}" is no course in courses/`);
      if (bundle && !bundleKeys.has(bundle)) fault(`"${bundle}" is no bundle in bundles/`);
      const date = (name: string) => {
        const v = cell(name);
        if (!v) return null;
        if (!DATETIME_RE.test(v) || Number.isNaN(Date.parse(v))) {
          fault(`${name} is a date (2024-05-01) or a date and time with its zone`);
          return null;
        }
        return new Date(v).toISOString();
      };
      const completed = /^(true|yes|1)$/i.test(cell("completed"));
      access.push({
        file: "access.csv",
        line,
        email,
        course,
        bundle,
        from: date("from"),
        until: date("until"),
        completed,
      });
    }
  }
  let progress: ProgressRow[] | null = null;
  if (folder.progress !== null) {
    progress = [];
    for (const { line, cell } of csv(folder.progress, "progress.csv", [
      "email*",
      "course*",
      "lesson*",
      "state",
      "done_at",
      "position",
    ])) {
      const fault = (message: string) => problems.push({ file: `progress.csv:${line}`, message });
      const email = cell("email").toLowerCase();
      const course = cell("course");
      if (!EMAIL_RE.test(email)) fault("email is an address");
      if (!keys.has(course)) fault(`"${course}" is no course in courses/`);
      const state = (cell("state") || "done").toLowerCase();
      if (state !== "started" && state !== "done") fault("state is started or done");
      const doneAt = cell("done_at");
      if (doneAt && (!DATETIME_RE.test(doneAt) || Number.isNaN(Date.parse(doneAt))))
        fault("done_at is a date or a date and time");
      const position = cell("position");
      if (position && !/^\d+(\.\d+)?$/.test(position)) fault("position is seconds");
      progress.push({
        file: "progress.csv",
        line,
        email,
        course,
        sourceId: cell("lesson"),
        state: state === "started" ? "started" : "done",
        doneAt: doneAt ? new Date(doneAt).toISOString() : null,
        position: position ? Number(position) : null,
      });
    }
  }
  return {
    courses,
    bundles,
    themes: [...themes].sort(),
    videos,
    files,
    access,
    progress,
    problems,
  };
}

/** Every `{ $media: ref }` in a value replaced by `id(ref)`. */
export function withMedia(value: unknown, id: (ref: string) => string): unknown {
  return replaceMarked(value, MEDIA, id);
}
