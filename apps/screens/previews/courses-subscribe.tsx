import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
} from "@composable-os/pack-courses/client";
import { Subscribe } from "../../../packs/courses/blocks/courses-subscribe/subscribe.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { noOffers, plans } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, {
    "x.courses.plans": plans,
    "subscription.offer.mine": noOffers,
  }),
);

export const width = 720;

/** A signed-in member choosing a plan, with its free trial. */
export default function Preview() {
  return <Subscribe courses={courses} returnUrl="https://school.example.com/account" signedIn />;
}
