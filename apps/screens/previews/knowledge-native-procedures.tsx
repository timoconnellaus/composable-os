import {
  createKnowledgeHooks,
  KNOWLEDGE_HOOKS_CALL,
  type KnowledgeOperations,
} from "@composable-os/pack-knowledge/client";
import { ProceduresScreen } from "../../../packs/knowledge/blocks/knowledge-native-procedures/procedures-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { pictureUrl } from "./data/content.ts";
import { injury, procedureHits, procedures, sections, toRead } from "./data/knowledge.ts";

const knowledge = createKnowledgeHooks(
  react,
  fakeClient<KnowledgeOperations>(KNOWLEDGE_HOOKS_CALL, {
    "content.staffList": procedures,
    "content.staffGet": injury,
    "content.search": procedureHits,
    "record.list": sections,
    "x.knowledge.toRead": toRead,
  }),
);

export default function Preview() {
  return (
    <ProceduresScreen
      knowledge={knowledge}
      openUrl={() => undefined}
      mediaUrl={pictureUrl}
      width={358}
    />
  );
}
