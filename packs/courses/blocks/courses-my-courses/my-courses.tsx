// What a signed-in student holds (stage 42), with how far they are and where to carry on. Which
// courses they hold, and why, is the host's (`useMyCourses`).
import type { CoursesHooks } from "@composable-os/pack-courses/client";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";

const WHY = {
  bought: "Bought",
  bundle: "In a bundle",
  given: "Given to you",
  imported: "From your old account",
  subscription: "Through your subscription",
} as const;

export function MyCourses({
  courses,
  onContinue,
}: {
  courses: Pick<CoursesHooks, "useMyCourses">;
  onContinue: (courseId: string, lessonKey: string | null) => void;
}) {
  const { data, isPending, error } = courses.useMyCourses();
  if (isPending) return <p aria-busy="true">Loading your courses…</p>;
  if (error || !data) return <p role="alert">We could not load your courses.</p>;
  if (!data.courses.length) return <p>You have no courses yet.</p>;
  return (
    <ul className="grid gap-4" aria-label="My courses">
      {data.courses.map((course) => (
        <li key={course.id}>
          <Card>
            <CardHeader>
              <CardTitle>{course.title}</CardTitle>
              <CardDescription>
                {`${WHY[course.why]} · ${course.complete ? "Complete" : `${course.done} of ${course.counted} lessons done`}`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <progress
                value={course.done}
                max={Math.max(course.counted, 1)}
                aria-label="Progress"
                className="w-full"
              />
              <Button onClick={() => onContinue(course.id, course.continueWith)}>
                {course.done ? "Carry on" : "Start"}
              </Button>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
