import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
} from "@composable-os/pack-courses/client";
import { MyCoursesScreen } from "../../../packs/courses/blocks/courses-native-my-courses/my-courses-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { myCourses } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, { "x.courses.myCourses": myCourses }),
);

export default function Preview() {
  return <MyCoursesScreen courses={courses} onContinue={() => {}} />;
}
