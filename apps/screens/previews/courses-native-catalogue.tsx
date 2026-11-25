import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
} from "@composable-os/pack-courses/client";
import { CatalogueScreen } from "../../../packs/courses/blocks/courses-native-catalogue/catalogue-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { catalogue } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, { "x.courses.catalogue": catalogue }),
);

export default function Preview() {
  return <CatalogueScreen courses={courses} onOpen={() => {}} />;
}
