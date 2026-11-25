import {
  CONTENT_HOOKS_CALL,
  type ContentOperations,
  createContentHooks,
} from "@composable-os/pack-content/client";
import { PostScreen } from "../../../packs/content/blocks/content-native-post/post-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { pictureUrl, starterAnswer, starterPost } from "./data/content.ts";

const content = createContentHooks(
  react,
  fakeClient<ContentOperations>(CONTENT_HOOKS_CALL, { "content.get": starterAnswer }),
);

export default function Preview() {
  return (
    <PostScreen
      content={content}
      slug={starterPost.values.slug ?? ""}
      openUrl={() => undefined}
      mediaUrl={pictureUrl}
      onRedirect={() => undefined}
      width={358}
    />
  );
}
