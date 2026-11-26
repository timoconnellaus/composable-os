import {
  createKnowledgeHooks,
  KNOWLEDGE_HOOKS_CALL,
  type KnowledgeOperations,
} from "@composable-os/pack-knowledge/client";
import { HelpPage } from "../../../packs/knowledge/blocks/knowledge-help-page/help-page.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { helpPages, pauseAnswer } from "./data/knowledge.ts";

const knowledge = createKnowledgeHooks(
  react,
  fakeClient<KnowledgeOperations>(KNOWLEDGE_HOOKS_CALL, {
    "content.get": pauseAnswer,
    "content.list": helpPages,
  }),
);

export const width = 860;

export default function Preview() {
  return (
    <HelpPage
      knowledge={knowledge}
      slug="pause"
      hrefOf={(slug) => `/help/${slug}`}
      onRedirect={() => undefined}
    />
  );
}
