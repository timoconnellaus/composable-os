// A course's outline (stage 42, step 4; ADR 0478): one document of sections of lessons, versioned
// and copied whole when the course is published, as a program's layout is (ADR 0448).
//
//   outline → sections (a key, a title) → lessons, each one kind:
//     video     a ready video from the media library, and notes in rich text
//     text      a page of rich text
//     session   a published Programs program and one session of its layout (week, position),
//               with an optional video to follow along to
//     download  a file from the media library (a PDF) and a note
//
// Every lesson has a key that names it for good (progress is kept by it), a title, a duration in
// minutes, whether it is a free preview, and the id it had on the old platform (for the import).
// The title, kind, duration and preview flag are for everyone who may read the course; the rest is
// for holders only (`holders`, ADR 0477), unless the lesson is a free preview. The host removes
// those parts for everyone else and plays their videos only to a holder: nothing here decides it.
import {
  type DocumentNode,
  type DocumentObjectNode,
  type DocumentSchema,
  FILE_NODE,
  RICH_TEXT_SCHEMA,
  VIDEO_NODE,
} from "@composable-os/sdk";

/** The kinds of lesson, in the order the builder offers them. */
export const LESSON_KINDS = ["video", "text", "session", "download"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

/** The most sections a course has, and lessons a section. */
export const MAX_SECTIONS = 50;
export const MAX_LESSONS_PER_SECTION = 100;
/** The most an outline may be, in bytes of its JSON. */
export const OUTLINE_MAX_BYTES = 524_288;

const optional = (node: DocumentNode): DocumentNode => ({ ...node, optional: true });
const richText: DocumentNode = { type: "use", def: "richText" };
/** A section's and a lesson's key and title. */
const keyNode: DocumentNode = {
  type: "text",
  min: 1,
  max: 40,
  chars: "abcdefghijklmnopqrstuvwxyz0123456789-",
};
const titleNode: DocumentNode = { type: "text", min: 1, max: 200, noMarkup: true };

/** What every lesson has, whatever its kind. */
const common: Record<string, DocumentNode> = {
  key: {
    ...keyNode,
    description:
      "The lesson's name for good: progress is kept by it. Never changed once published.",
  },
  title: titleNode,
  duration: optional({
    type: "number",
    min: 0,
    max: 600,
    integer: true,
    description: "Minutes",
  }),
  preview: optional({
    type: "boolean",
    description: "A free preview: everyone who may read the course reads it, and plays its video",
  }),
  sourceId: optional({
    type: "text",
    max: 100,
    description: "Its id on the platform it was imported from",
  }),
};

const lesson = (
  fields: Record<string, DocumentNode>,
  holders: readonly string[],
): DocumentObjectNode => ({
  type: "object",
  fields: { ...common, ...fields },
  // The lesson's own material is for holders, unless it is a free preview.
  holders: { keys: holders, unless: "preview" },
});

/** The outline's schema: a document field's `schema` (with rich text's definitions in it). */
export const OUTLINE_SCHEMA: DocumentSchema = {
  root: {
    type: "object",
    fields: {
      sections: {
        type: "array",
        max: MAX_SECTIONS,
        unique: "key",
        of: {
          type: "object",
          fields: {
            key: keyNode,
            title: titleNode,
            lessons: {
              type: "array",
              max: MAX_LESSONS_PER_SECTION,
              unique: "key",
              // A lesson's key once in the whole outline: its progress is kept by it.
              uniqueAcross: true,
              of: {
                type: "union",
                tag: "kind",
                variants: {
                  video: lesson({ video: VIDEO_NODE, notes: optional(richText) }, [
                    "video",
                    "notes",
                  ]),
                  text: lesson({ body: richText }, ["body"]),
                  session: lesson(
                    {
                      program: {
                        type: "ref",
                        to: "programs.program",
                        description: "A published Programs program",
                      },
                      week: { type: "number", min: 1, max: 52, integer: true },
                      session: {
                        type: "number",
                        min: 0,
                        max: 13,
                        integer: true,
                        description: "Which session of that week (0 is the first)",
                      },
                      video: optional(VIDEO_NODE),
                    },
                    ["program", "week", "session", "video"],
                  ),
                  download: lesson(
                    {
                      file: FILE_NODE,
                      note: optional({ type: "text", max: 2000, multiline: true, noMarkup: true }),
                    },
                    ["file", "note"],
                  ),
                },
              },
            },
          },
        },
      },
    },
  },
  defs: { ...(RICH_TEXT_SCHEMA.defs ?? {}), richText: RICH_TEXT_SCHEMA.root },
};

// --- The outline as data -------------------------------------------------------------------------

/** A video value (`VIDEO_NODE`). */
export interface VideoValue {
  media: string;
  poster?: string;
}

interface LessonBase {
  key: string;
  title: string;
  duration?: number;
  preview?: boolean;
  sourceId?: string;
}

/** A lesson as the outline holds it. Holders' parts are absent for a reader without access. */
export type Lesson =
  | (LessonBase & { kind: "video"; video?: VideoValue; notes?: unknown })
  | (LessonBase & { kind: "text"; body?: unknown })
  | (LessonBase & {
      kind: "session";
      program?: string;
      week?: number;
      session?: number;
      video?: VideoValue;
    })
  | (LessonBase & { kind: "download"; file?: string; note?: string });

export interface Section {
  key: string;
  title: string;
  lessons: Lesson[];
}

export interface Outline {
  sections: Section[];
}

/** The value as an outline, or an empty one when it is not one. */
export function asOutline(value: unknown): Outline {
  const v = value as Outline | null | undefined;
  return v && Array.isArray(v.sections) ? v : { sections: [] };
}

/** Every lesson in order, as the outline holds it (no copies). */
const allLessons = (outline: Outline): Lesson[] =>
  outline.sections.flatMap((section) => section.lessons ?? []);

/** Every lesson in order, with its section's key. */
export function lessonsOf(outline: Outline): (Lesson & { section: string })[] {
  return outline.sections.flatMap((section) =>
    (section.lessons ?? []).map((l) => ({ ...l, section: section.key })),
  );
}

/** One lesson by its key, with its section's key, or null. */
export function findLesson(outline: Outline, key: string): (Lesson & { section: string }) | null {
  for (const section of outline.sections) {
    const found = section.lessons?.find((l) => l.key === key);
    if (found) return { ...found, section: section.key };
  }
  return null;
}

/** The lesson after this one, or null at the end. */
export function nextLesson(outline: Outline, key: string): Lesson | null {
  const all = allLessons(outline);
  const at = all.findIndex((l) => l.key === key);
  return at >= 0 ? (all[at + 1] ?? null) : null;
}

/** Where a lesson's video is, if it has one (a video lesson's, or a session's follow-along). */
export function lessonVideo(lesson: Lesson): VideoValue | null {
  return (lesson.kind === "video" || lesson.kind === "session") && lesson.video
    ? lesson.video
    : null;
}

/** The programs a course's session lessons use, each once. */
export function sessionPrograms(outline: Outline): string[] {
  return [
    ...new Set(
      allLessons(outline)
        .map((l) => (l.kind === "session" ? l.program : undefined))
        .filter((p): p is string => Boolean(p)),
    ),
  ];
}

/**
 * How far a student is: the lessons that count (every lesson that is not a download), how many of
 * them are done, and whether the course is complete (all of them, or imported as completed). A
 * lesson the outline no longer has does not count, whatever its progress row says.
 */
export function completion(
  outline: Outline,
  done: ReadonlySet<string>,
  importedComplete = false,
): { counted: number; done: number; complete: boolean } {
  const counted = allLessons(outline).filter((l) => l.kind !== "download");
  const doneCount = counted.filter((l) => done.has(l.key)).length;
  return {
    counted: counted.length,
    done: doneCount,
    complete: importedComplete || (counted.length > 0 && doneCount === counted.length),
  };
}

/** A video counts as watched once its position is within this many seconds of its end. */
export const END_SECONDS = 10;

/** Whether a video left at `position` of `duration` seconds has been watched to its end. */
export function watchedToEnd(position: number, duration: number | null | undefined): boolean {
  return typeof duration === "number" && duration > 0 && position >= duration - END_SECONDS;
}

/** What is wrong with an outline beyond its schema: a lesson key used twice across sections. */
export function outlineProblems(outline: Outline): string[] {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const section of outline.sections) {
    for (const l of section.lessons ?? []) {
      const before = seen.get(l.key);
      if (before) problems.push(`The lesson key "${l.key}" is in ${before} and ${section.key}`);
      else seen.set(l.key, section.key);
    }
  }
  return problems;
}
