import {
  CONTENT_HOOKS_CALL,
  type ContentOperations,
  createContentHooks,
} from "@composable-os/pack-content/client";
import { PostPage } from "../../../packs/content/blocks/content-post/post-page.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { pictureUrl, starterAnswer, starterPost } from "./data/content.ts";

const content = createContentHooks(
  react,
  fakeClient<ContentOperations>(CONTENT_HOOKS_CALL, { "content.get": starterAnswer }),
);

export const width = 860;

export default function Preview() {
  return (
    <PostPage
      content={content}
      slug={starterPost.values.slug ?? ""}
      onRedirect={() => undefined}
      mediaUrl={pictureUrl}
    />
  );
}
