// One lesson in the studio's app (stage 42). The video player is a prop, so this block depends on
// no device package: the app passes its own (`expo-video`, with the signed HLS address), and an
// offline player can replace it later. What the lesson holds is the host's (`useLesson`), the token
// is the host's and is asked for again before it expires (`usePlayback`), and progress is kept by
// the host only while the student holds the course (`useProgress`).
import type { CoursesHooks, Playback } from "@composable-os/pack-courses/client";
import type { ReactNode } from "react";
import { Text } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Screen } from "../native-base/screen.tsx";

/** What the app's player is given, and how it reports where it is. */
export interface NativePlayerProps {
  playback: Playback;
  /** Seconds to start from: where the student left the video. */
  startAt: number;
  onPosition: (seconds: number, duration: number) => void;
  onEnded: () => void;
}

export function LessonScreen({
  courses,
  courseId,
  lessonKey,
  Player,
  onNext,
  renderText,
  renderSession,
}: {
  courses: Pick<CoursesHooks, "useLesson" | "usePlayback" | "useProgress">;
  courseId: string;
  lessonKey: string;
  Player: (props: NativePlayerProps) => ReactNode;
  onNext: (lessonKey: string) => void;
  renderText?: (value: unknown) => ReactNode;
  renderSession?: (courseId: string, lessonKey: string) => ReactNode;
}) {
  const { data, isPending, error } = courses.useLesson(courseId, lessonKey);
  const playback = courses.usePlayback(data?.video ?? null);
  const progress = courses.useProgress();
  const lesson = data?.lesson as
    | { kind?: string; title?: string; notes?: unknown; body?: unknown }
    | undefined;
  return (
    <Screen title={lesson?.title ?? "Lesson"}>
      {isPending ? <Text accessibilityRole="progressbar">Loading the lesson…</Text> : null}
      {error ? <Text accessibilityRole="alert">This lesson is not here.</Text> : null}
      {data && playback.data ? (
        <Player
          playback={playback.data}
          startAt={data.position ?? 0}
          onPosition={(position, duration) =>
            progress.mutate({ courseId, lessonKey, position, duration })
          }
          onEnded={() => progress.mutate({ courseId, lessonKey, state: "done" })}
        />
      ) : null}
      {lesson?.kind === "text" && renderText ? renderText(lesson.body) : null}
      {lesson?.kind === "video" && lesson.notes && renderText ? renderText(lesson.notes) : null}
      {lesson?.kind === "session" && renderSession ? renderSession(courseId, lessonKey) : null}
      {data ? (
        <Button
          label={data.state === "done" ? "Done" : "Mark as done"}
          quiet={data.state === "done"}
          onPress={() => progress.mutate({ courseId, lessonKey, state: "done" })}
        />
      ) : null}
      {data?.next ? (
        <Button
          label={`Next: ${data.next.title}`}
          quiet
          onPress={() => data.next && onNext(data.next.key)}
        />
      ) : null}
    </Screen>
  );
}
