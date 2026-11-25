import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
} from "@composable-os/pack-courses/client";
import { CourseBuilder } from "../../../packs/courses/blocks/courses-builder/course-builder.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { libraryVideos, publishedPrograms, workingCopy } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, {
    "record.get": workingCopy,
    "media.list": libraryVideos,
    "record.list": publishedPrograms,
  }),
);

export const width = 880;

export default function Preview() {
  return <CourseBuilder courses={courses} courseId="crs_1" />;
}
