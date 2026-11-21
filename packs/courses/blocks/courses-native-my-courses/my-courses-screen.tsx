// The courses a signed-in student holds, in the studio's app (stage 42), with how far they are.
// Which they hold is the host's (`useMyCourses`); nothing here is for sale (`noPurchase`).
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { Text } from "react-native";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

export function MyCoursesScreen({
  courses,
  onContinue,
}: {
  courses: Pick<CoursesHooks, "useMyCourses">;
  onContinue: (courseId: string, lessonKey: string | null) => void;
}) {
  const { data, isPending, error } = courses.useMyCourses();
  return (
    <Screen title="My courses">
      {isPending ? <Text accessibilityRole="progressbar">Loading your courses…</Text> : null}
      {error ? <Text accessibilityRole="alert">We could not load your courses.</Text> : null}
      {data ? (
        <List empty="You have no courses yet.">
          {data.courses.map((course) => (
            <Row
              key={course.id}
              title={course.title ?? "Course"}
              detail={course.complete ? "Complete" : `${course.done} of ${course.counted} lessons done`}
              onPress={() => onContinue(course.id, course.continueWith)}
            />
          ))}
        </List>
      ) : null}
    </Screen>
  );
}
