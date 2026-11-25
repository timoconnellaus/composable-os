import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
} from "@composable-os/pack-courses/client";
import { MySubscription } from "../../../packs/courses/blocks/courses-subscription/my-subscription.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { mySubscriptions } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, { "subscription.list": mySubscriptions }),
);

export const width = 640;

export default function Preview() {
  return <MySubscription courses={courses} returnUrl="https://school.example.com/account" />;
}
