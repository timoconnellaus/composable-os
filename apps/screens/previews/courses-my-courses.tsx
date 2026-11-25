import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
} from "@composable-os/pack-courses/client";
import { MyCourses } from "../../../packs/courses/blocks/courses-my-courses/my-courses.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { myCourses } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, { "x.courses.myCourses": myCourses }),
);

export const width = 720;

export default function Preview() {
  return <MyCourses courses={courses} onContinue={() => {}} />;
}
