import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
} from "@composable-os/pack-courses/client";
import { CourseCatalogue } from "../../../packs/courses/blocks/courses-catalogue/catalogue.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { catalogueFor } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, { "x.courses.catalogue": catalogueFor }),
);

export default function Preview() {
  return <CourseCatalogue courses={courses} onOpenCourse={() => {}} onOpenBundle={() => {}} />;
}
