import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
} from "@composable-os/pack-courses/client";
import { SubscriptionScreen } from "../../../packs/courses/blocks/courses-native-subscription/subscription-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { mySubscriptions, noOffers } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, {
    "subscription.list": mySubscriptions,
    "subscription.offer.mine": noOffers,
  }),
);

export default function Preview() {
  return <SubscriptionScreen courses={courses} />;
}
