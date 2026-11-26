import {
  createKnowledgeHooks,
  KNOWLEDGE_HOOKS_CALL,
  type KnowledgeOperations,
} from "@composable-os/pack-knowledge/client";
import { HelpCentreScreen } from "../../../packs/knowledge/blocks/knowledge-native-help/help-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { helpPages, topics } from "./data/knowledge.ts";

const knowledge = createKnowledgeHooks(
  react,
  fakeClient<KnowledgeOperations>(KNOWLEDGE_HOOKS_CALL, {
    "x.knowledge.helpTopics": topics,
    "content.list": helpPages,
  }),
);

export default function Preview() {
  return <HelpCentreScreen knowledge={knowledge} onOpenPage={() => undefined} />;
}
