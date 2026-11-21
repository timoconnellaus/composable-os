// The course builder (stage 42), a staff block in the company's web app: sections and lessons in
// order (moved by buttons, so by keyboard too), each lesson's kind, video from the media library,
// session from a published Programs program, text, preview flag and minutes; save, then publish.
// The edits are the pack's pure `outlineEdits`, which never change a lesson's key; the host checks
// the outline on save (its schema, a video that is ready, a program that exists) and a person
// publishes (an assistant's request to publish waits for one, ADR 0480).
import type { CoursesHooks, LessonKind, Outline } from "@composable-os/pack-courses/client";
import { outlineEdits } from "@composable-os/pack-courses/client";
import { useEffect, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

const KINDS: { value: LessonKind; label: string }[] = [
  { value: "video", label: "Video" },
  { value: "text", label: "Text" },
  { value: "session", label: "Training session" },
  { value: "download", label: "Download" },
];

export function CourseBuilder({
  courses,
  courseId,
}: {
  courses: Pick<
    CoursesHooks,
    "useWorkingCopy" | "useSaveOutline" | "usePublishCourse" | "useLibraryVideos" | "usePublishedPrograms"
  >;
  courseId: string;
}) {
  const working = courses.useWorkingCopy(courseId);
  const videos = courses.useLibraryVideos();
  const programs = courses.usePublishedPrograms();
  const save = courses.useSaveOutline();
  const publish = courses.usePublishCourse();
  const [outline, setOutline] = useState<Outline | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [newSection, setNewSection] = useState("");

  useEffect(() => {
    const value = working.data?.values.outline as Outline | null | undefined;
    if (value && !outline) setOutline(value?.sections ? value : { sections: [] });
    else if (working.data && !outline) setOutline({ sections: [] });
  }, [working.data, outline]);

  if (working.isPending || !outline) return <p aria-busy="true">Loading the course…</p>;
  if (working.error) return <p role="alert">This course is not here.</p>;

  const onSave = async () => {
    setMessage(null);
    try {
      await save.mutateAsync({ object: "courses.course", id: courseId, values: { outline } });
      setMessage("Saved");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Not saved");
    }
  };
  const onPublish = async () => {
    setMessage(null);
    try {
      await save.mutateAsync({ object: "courses.course", id: courseId, values: { outline } });
      await publish.mutateAsync({ object: "courses.course", id: courseId });
      setMessage("Published");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Not published");
    }
  };

  return (
    <section className="grid gap-6" aria-label="Course builder">
      {outline.sections.map((section, s) => (
        <fieldset key={section.key} className="grid gap-3 rounded-lg border p-4">
          <legend className="px-1 font-semibold">{section.title}</legend>
          <ol className="grid gap-3">
            {(section.lessons ?? []).map((lesson, i) => (
              <li key={lesson.key} className="grid gap-2 rounded border p-3" aria-label={lesson.title}>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="Lesson title"
                    value={lesson.title}
                    onChange={(e) =>
                      setOutline(outlineEdits.updateLesson(outline, lesson.key, { title: e.target.value }))
                    }
                  />
                  <span className="text-sm">{KINDS.find((k) => k.value === lesson.kind)?.label}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => setOutline(outlineEdits.moveLesson(outline, lesson.key, section.key, i - 1))}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Move down"
                    onClick={() => setOutline(outlineEdits.moveLesson(outline, lesson.key, section.key, i + 1))}
                  >
                    ↓
                  </Button>
                  {s > 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setOutline(
                          outlineEdits.moveLesson(outline, lesson.key, outline.sections[s - 1]?.key ?? section.key, 999),
                        )
                      }
                    >
                      To the section above
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => setOutline(outlineEdits.removeLesson(outline, lesson.key))}>
                    Remove
                  </Button>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={lesson.preview === true}
                    onChange={(e) => setOutline(outlineEdits.updateLesson(outline, lesson.key, { preview: e.target.checked }))}
                  />
                  Free preview
                </label>
                {lesson.kind === "video" || lesson.kind === "session" ? (
                  <label className="grid gap-1 text-sm">
                    {lesson.kind === "video" ? "Video" : "Video to follow along to (optional)"}
                    <select
                      value={("video" in lesson && lesson.video?.media) || ""}
                      onChange={(e) =>
                        setOutline(
                          outlineEdits.updateLesson(outline, lesson.key, {
                            video: e.target.value ? { media: e.target.value } : undefined,
                          }),
                        )
                      }
                    >
                      <option value="">Choose a ready video</option>
                      {(videos.data?.items ?? []).map((v) => (
                        <option key={v.id} value={v.id}>
                          {String(v.values.name ?? v.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {lesson.kind === "session" ? (
                  <label className="grid gap-1 text-sm">
                    Program (week 1, first session)
                    <select
                      value={("program" in lesson && lesson.program) || ""}
                      onChange={(e) =>
                        setOutline(
                          outlineEdits.updateLesson(outline, lesson.key, { program: e.target.value, week: 1, session: 0 }),
                        )
                      }
                    >
                      <option value="">Choose a published program</option>
                      {(programs.data?.items ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {String(p.values.title ?? p.title ?? p.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            {KINDS.map((kind) => (
              <Button
                key={kind.value}
                size="sm"
                variant="outline"
                onClick={() => setOutline(outlineEdits.addLesson(outline, section.key, kind.value, `New ${kind.label.toLowerCase()}`))}
              >
                {`Add ${kind.label.toLowerCase()}`}
              </Button>
            ))}
          </div>
        </fieldset>
      ))}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newSection.trim()) return;
          setOutline(outlineEdits.addSection(outline, newSection.trim()));
          setNewSection("");
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor="new-section">New section</Label>
          <Input id="new-section" value={newSection} onChange={(e) => setNewSection(e.target.value)} />
        </div>
        <Button type="submit" variant="outline">
          Add section
        </Button>
      </form>
      <div className="flex gap-2">
        <Button onClick={() => void onSave()} disabled={save.isPending}>
          Save
        </Button>
        <Button variant="secondary" onClick={() => void onPublish()} disabled={save.isPending || publish.isPending}>
          Publish
        </Button>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
