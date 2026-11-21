// A course in the studio's app (stage 42): its summary and outline with lesson titles and
// minutes; "open" for a holder and for a free preview. No price and no buy button: buying is on
// the web only (`noPurchase`). Whether the student holds the course is the host's (`useCourse`).
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { minutes } from "@composable-os/pack-courses/client";
import { Text } from "react-native";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

export function CourseScreen({
  courses,
  slug,
  onOpenLesson,
}: {
  courses: Pick<CoursesHooks, "useCourse">;
  slug: string;
  /** Pushes the lesson's screen (LessonScreen). */
  onOpenLesson: (courseId: string, lessonKey: string) => void;
}) {
  const { data: course, isPending, error } = courses.useCourse(slug);
  return (
    <Screen title={course?.title ?? "Course"}>
      {isPending ? <Text accessibilityRole="progressbar">Loading the course…</Text> : null}
      {error ? <Text accessibilityRole="alert">This course is not here.</Text> : null}
      {course ? (
        <>
          {course.summary ? <Text>{course.summary}</Text> : null}
          {course.holds ? null : <Text>Find this course on the studio's website.</Text>}
          <List empty="No lessons yet.">
            {course.sections.flatMap((section) =>
              section.lessons.map((lesson) => (
                <Row
                  key={lesson.key}
                  title={`${course.done.includes(lesson.key) ? "✓ " : ""}${lesson.title}`}
                  detail={[
                    section.title,
                    minutes(lesson.duration),
                    lesson.preview ? "Free preview" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  onPress={
                    course.holds || lesson.preview
                      ? () => onOpenLesson(course.id, lesson.key)
                      : undefined
                  }
                />
              )),
            )}
          </List>
        </>
      ) : null}
    </Screen>
  );
}
