import {
  createKnowledgeHooks,
  KNOWLEDGE_HOOKS_CALL,
  type KnowledgeOperations,
} from "@composable-os/pack-knowledge/client";
import { ToRead } from "../../../packs/knowledge/blocks/knowledge-to-read/to-read.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { injury, sections, toRead } from "./data/knowledge.ts";

const knowledge = createKnowledgeHooks(
  react,
  fakeClient<KnowledgeOperations>(KNOWLEDGE_HOOKS_CALL, {
    "x.knowledge.toRead": toRead,
    "content.staffGet": injury,
    "record.list": sections,
  }),
);

export const width = 760;

export default function Preview() {
  return <ToRead knowledge={knowledge} />;
}
