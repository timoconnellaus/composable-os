import {
  createKnowledgeHooks,
  KNOWLEDGE_HOOKS_CALL,
  type KnowledgeOperations,
} from "@composable-os/pack-knowledge/client";
import { HelpCentre } from "../../../packs/knowledge/blocks/knowledge-help-centre/help-centre.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { helpPages, topics } from "./data/knowledge.ts";

const knowledge = createKnowledgeHooks(
  react,
  fakeClient<KnowledgeOperations>(KNOWLEDGE_HOOKS_CALL, {
    "x.knowledge.helpTopics": topics,
    "content.list": helpPages,
  }),
);

export const width = 860;

export default function Preview() {
  return <HelpCentre knowledge={knowledge} hrefOf={(slug) => `/help/${slug}`} />;
}
