// One lesson, for a holder (stage 42): a video with its captions that resumes where it was left,
// a page of text, a download, or a training session from Programs; mark done; the next lesson.
// What the lesson holds is the host's (`useLesson`, empty without access); the video plays with a
// token the host signs and asks for again before it expires (`usePlayback`); progress is kept by
// the host only while the student holds the course (`useProgress`).
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { mediaPath } from "@composable-os/pack-courses/client";
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "../ui-button/button.tsx";

/** How often the player keeps the position while a video plays, in seconds of video. */
const KEEP_EVERY = 15;

export function LessonPlayer({
  courses,
  courseId,
  lessonKey,
  onNext,
  renderText,
  renderSession,
}: {
  courses: Pick<CoursesHooks, "useLesson" | "usePlayback" | "useProgress">;
  courseId: string;
  lessonKey: string;
  onNext: (lessonKey: string) => void;
  /** Draws rich text (the Content pack's renderer, `content-rich-text`). */
  renderText?: (value: unknown) => ReactNode;
  /** Draws a session lesson's own Programs session (the Programs session block). */
  renderSession?: (courseId: string, lessonKey: string) => ReactNode;
}) {
  const { data, isPending, error } = courses.useLesson(courseId, lessonKey);
  const playback = courses.usePlayback(data?.video ?? null);
  const progress = courses.useProgress();
  const video = useRef<HTMLVideoElement | null>(null);
  const kept = useRef(0);

  useEffect(() => {
    kept.current = 0;
  }, [lessonKey]);

  if (isPending) return <p aria-busy="true">Loading the lesson…</p>;
  if (error || !data) return <p role="alert">This lesson is not here.</p>;
  const lesson = data.lesson as {
    kind: string;
    title: string;
    notes?: unknown;
    body?: unknown;
    file?: string;
    note?: string;
  };
  const keep = (state?: "done") =>
    progress.mutate({
      courseId,
      lessonKey,
      ...(state ? { state } : {}),
      ...(video.current ? { position: video.current.currentTime, duration: video.current.duration } : {}),
    });

  return (
    <article className="grid gap-4" aria-labelledby="lesson-title">
      <h1 id="lesson-title" className="text-2xl font-semibold">
        {lesson.title}
      </h1>
      {playback.data ? (
        // biome-ignore lint/a11y/useMediaCaption: the stream's manifest carries its caption tracks.
        <video
          ref={video}
          controls
          playsInline
          src={playback.data.hls}
          poster={playback.data.poster}
          className="w-full rounded-lg"
          onLoadedMetadata={(e) => {
            if (data.position) e.currentTarget.currentTime = data.position;
          }}
          onTimeUpdate={(e) => {
            const at = e.currentTarget.currentTime;
            if (Math.abs(at - kept.current) >= KEEP_EVERY) {
              kept.current = at;
              keep();
            }
          }}
          onEnded={() => keep("done")}
        />
      ) : null}
      {lesson.kind === "video" && lesson.notes && renderText ? renderText(lesson.notes) : null}
      {lesson.kind === "text" && renderText ? renderText(lesson.body) : null}
      {lesson.kind === "download" && lesson.file ? (
        <p>
          <a href={mediaPath(lesson.file)} download>
            Download
          </a>
          {lesson.note ? ` · ${lesson.note}` : null}
        </p>
      ) : null}
      {lesson.kind === "session" && renderSession ? renderSession(courseId, lessonKey) : null}
      <div className="flex gap-2">
        <Button variant={data.state === "done" ? "outline" : "default"} onClick={() => keep("done")}>
          {data.state === "done" ? "Done" : "Mark as done"}
        </Button>
        {data.next ? (
          <Button variant="outline" onClick={() => data.next && onNext(data.next.key)}>
            {`Next: ${data.next.title}`}
          </Button>
        ) : null}
      </div>
      {playback.data?.captions.length ? (
        <p className="text-sm">Captions: {playback.data.captions.map((c) => c.label).join(", ")}</p>
      ) : null}
    </article>
  );
}
