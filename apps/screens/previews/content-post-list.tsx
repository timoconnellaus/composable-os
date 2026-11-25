import {
  CONTENT_HOOKS_CALL,
  type ContentOperations,
  createContentHooks,
} from "@composable-os/pack-content/client";
import { PostList } from "../../../packs/content/blocks/content-post-list/post-list.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { pictureUrl, posts } from "./data/content.ts";

const content = createContentHooks(
  react,
  fakeClient<ContentOperations>(CONTENT_HOOKS_CALL, { "content.list": posts }),
);

export const width = 640;

export default function Preview() {
  return (
    <PostList
      content={content}
      hrefOf={(slug) => `/blog/${slug}`}
      olderHref={(cursor) => `/blog?after=${cursor}`}
      mediaUrl={pictureUrl}
    />
  );
}
