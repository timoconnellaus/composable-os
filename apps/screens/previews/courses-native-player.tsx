import type { RichText } from "@composable-os/pack-content/client";
import {
  COURSES_HOOKS_CALL,
  type CoursesOperations,
  createCoursesHooks,
  hostMediaUrl,
} from "@composable-os/pack-courses/client";
import { Image, Text, View } from "react-native";
import { RichTextView } from "../../../packs/content/blocks/content-native-rich-text/rich-text-view.tsx";
import {
  LessonScreen,
  type NativePlayerProps,
} from "../../../packs/courses/blocks/courses-native-player/lesson-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { ninetyNinety, ninetyNinetyPlayback } from "./data/courses.ts";

const courses = createCoursesHooks(
  react,
  fakeClient<CoursesOperations>(COURSES_HOOKS_CALL, {
    "x.courses.lesson": ninetyNinety,
    "media.play": ninetyNinetyPlayback,
  }),
);

/** The app's own player, as it is before playing: the poster, and where the student left off. */
function Player({ playback, startAt }: NativePlayerProps) {
  const at = `${Math.floor(startAt / 60)}:${String(Math.round(startAt % 60)).padStart(2, "0")}`;
  return (
    <View
      style={{
        borderRadius: 12,
        overflow: "hidden",
        aspectRatio: 16 / 9,
        width: "100%",
        backgroundColor: "#8d7560",
      }}
    >
      <Image source={{ uri: playback.poster }} style={{ width: "100%", height: "100%" }} />
      <View
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: 64,
          height: 64,
          marginTop: -32,
          marginLeft: -32,
          borderRadius: 32,
          backgroundColor: "rgba(255,255,255,0.9)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ fontSize: 26, color: "#3b2f27", marginLeft: 4 }}>▶</Text>
      </View>
      <Text
        style={{
          position: "absolute",
          left: 10,
          bottom: 10,
          color: "#fff",
          backgroundColor: "rgba(0,0,0,0.55)",
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        {`Resume from ${at}`}
      </Text>
    </View>
  );
}

const mediaUrl = hostMediaUrl("https://host.example.com");

export default function Preview() {
  return (
    <LessonScreen
      courses={courses}
      courseId="crs_1"
      lessonKey="ninety-ninety"
      Player={Player}
      onNext={() => {}}
      renderText={(value) => (
        <RichTextView
          value={value as RichText}
          openUrl={() => {}}
          mediaUrl={mediaUrl}
          width={780}
        />
      )}
    />
  );
}
