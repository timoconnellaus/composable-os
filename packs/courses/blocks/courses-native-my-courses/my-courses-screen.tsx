// The courses a signed-in student holds, in the studio's app (stage 42), with how far they are.
// Which they hold is the host's (`useMyCourses`); nothing here is for sale (`noPurchase`). As the
// Courses section of the app's My account (stage 48), their course subscription's state follows.
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { subscriptionStatus } from "@composable-os/pack-courses/client";
import { MySubscriptions } from "../native-account-subscriptions/subscriptions.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";

export function MyCoursesScreen({
  courses,
  onContinue,
}: {
  courses: Pick<CoursesHooks, "useMyCourses">;
  /**
   * Opens a course where to carry on. Left out (as a section of My account, ADR 0710), a row is
   * not pressable.
   */
  onContinue?: (courseId: string, lessonKey: string | null) => void;
}) {
  return (
    <Screen title="My courses">
      <CourseRows courses={courses} onContinue={onContinue} />
    </Screen>
  );
}

/**
 * The Courses section of the app's My account (ADR 0710): what they hold, then their course
 * subscription's state, read only, with "Manage on the website" (`onManage`, from the account
 * shell) through My account's one subscriptions part.
 */
export function MyCoursesSectionScreen({
  courses,
  onManage,
}: {
  courses: Pick<CoursesHooks, "useMyCourses" | "useMySubscriptions">;
  onManage?: () => void;
}) {
  return (
    <Screen title="My courses">
      <CourseRows courses={courses} />
      <MySubscriptions
        account={{ useSubscriptions: courses.useMySubscriptions }}
        onManage={onManage}
        empty={null}
        status={subscriptionStatus}
        manageWords="Manage your subscription on the studio's website."
      />
    </Screen>
  );
}

function CourseRows({
  courses,
  onContinue,
}: {
  courses: Pick<CoursesHooks, "useMyCourses">;
  onContinue?: (courseId: string, lessonKey: string | null) => void;
}) {
  const { data, isPending, error } = courses.useMyCourses();
  return (
    <>
      {isPending ? (
        <Text tone="muted" accessibilityRole="progressbar">
          Loading your courses…
        </Text>
      ) : null}
      {error ? <Text accessibilityRole="alert">We could not load your courses.</Text> : null}
      {data ? (
        <List empty="You have no courses yet.">
          {data.courses.map((course) => (
            <Row
              key={course.id}
              title={course.title ?? "Course"}
              detail={
                course.complete ? "Complete" : `${course.done} of ${course.counted} lessons done`
              }
              onPress={onContinue ? () => onContinue(course.id, course.continueWith) : undefined}
            />
          ))}
        </List>
      ) : null}
    </>
  );
}
