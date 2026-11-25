import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
} from "@composable-os/pack-courses/client";
import { CourseScreen } from "../../../packs/courses/blocks/courses-native-course/course-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { mobilityForStudent } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, { "x.courses.course": mobilityForStudent }),
);

/** The course as its student sees it, partway through. */
export default function Preview() {
  return <CourseScreen courses={courses} slug="mobility-foundations" onOpenLesson={() => {}} />;
}
