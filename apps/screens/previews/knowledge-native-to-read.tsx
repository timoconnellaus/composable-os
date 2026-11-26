import {
  createKnowledgeHooks,
  KNOWLEDGE_HOOKS_CALL,
  type KnowledgeOperations,
} from "@composable-os/pack-knowledge/client";
import { ToReadScreen } from "../../../packs/knowledge/blocks/knowledge-native-to-read/to-read-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { pictureUrl } from "./data/content.ts";
import { injury, toRead } from "./data/knowledge.ts";

const knowledge = createKnowledgeHooks(
  react,
  fakeClient<KnowledgeOperations>(KNOWLEDGE_HOOKS_CALL, {
    "x.knowledge.toRead": toRead,
    "content.staffGet": injury,
  }),
);

/** The picture shows a procedure opened from the list, with its confirm at the end. */
export const click = { role: "button", name: "Read When someone is hurt" };

export default function Preview() {
  return (
    <ToReadScreen
      knowledge={knowledge}
      openUrl={() => undefined}
      mediaUrl={pictureUrl}
      width={358}
    />
  );
}
