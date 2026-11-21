// The course catalogue in the studio's app (stage 42). Buying is on the web only (the owner's
// decision): this screen shows no price and no buy button, and the block lint holds it to that
// (`noPurchase` in block.json). What is published is the host's (`useCatalogue`).
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { Text } from "react-native";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

const LEVELS = { 1: "Beginner", 2: "Intermediate", 3: "Advanced" } as const;

export function CatalogueScreen({
  courses,
  onOpen,
}: {
  courses: Pick<CoursesHooks, "useCatalogue">;
  /** Pushes the course's screen (CourseScreen) on the app's native stack. */
  onOpen: (slug: string) => void;
}) {
  const { data, isPending, error } = courses.useCatalogue({});
  return (
    <Screen title="Courses">
      {isPending ? <Text accessibilityRole="progressbar">Loading courses…</Text> : null}
      {error ? <Text accessibilityRole="alert">We could not load the courses.</Text> : null}
      {data ? (
        <List empty="No courses yet.">
          {data.courses.map((course) => (
            <Row
              key={course.id}
              title={course.title ?? "Course"}
              detail={[course.level ? LEVELS[course.level as 1 | 2 | 3] : null, `${course.lessons} lessons`]
                .filter(Boolean)
                .join(" · ")}
              onPress={course.slug ? () => onOpen(course.slug as string) : undefined}
            />
          ))}
        </List>
      ) : null}
    </Screen>
  );
}
