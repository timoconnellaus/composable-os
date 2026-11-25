import type { RichText as RichTextValue } from "@composable-os/pack-content/client";
import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
} from "@composable-os/pack-courses/client";
import { RichText } from "../../../packs/content/blocks/content-rich-text/rich-text.tsx";
import { LessonPlayer } from "../../../packs/courses/blocks/courses-player/player.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { ninetyNinety, ninetyNinetyPlayback } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, {
    "x.courses.lesson": ninetyNinety,
    "media.play": ninetyNinetyPlayback,
  }),
);

export const width = 800;

/** The lesson as it opens, before its video plays (the notes drawn by content-rich-text). */
export default function Preview() {
  return (
    <LessonPlayer
      courses={courses}
      courseId="crs_1"
      lessonKey="ninety-ninety"
      onNext={() => {}}
      // The notes are the outline's rich text, as the host stores it.
      renderText={(value) => <RichText value={value as RichTextValue} />}
    />
  );
}
