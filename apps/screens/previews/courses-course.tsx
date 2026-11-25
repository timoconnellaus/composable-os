import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
} from "@composable-os/pack-courses/client";
import { CoursePage } from "../../../packs/courses/blocks/courses-course/course-page.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { mobilityForGuest } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, { "x.courses.course": mobilityForGuest }),
);

export const width = 800;

/** A visitor's view: the free previews open, the rest to buy. */
export default function Preview() {
  return (
    <CoursePage
      courses={courses}
      slug="mobility-foundations"
      returnUrl="https://school.example.com/courses/mobility-foundations"
      signedIn={false}
      onOpenLesson={() => {}}
    />
  );
}
