import {
  createKnowledgeHooks,
  KNOWLEDGE_HOOKS_CALL,
  type KnowledgeOperations,
} from "@composable-os/pack-knowledge/client";
import { Procedures } from "../../../packs/knowledge/blocks/knowledge-procedures/procedures.tsx";
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

export const width = 860;

/** The picture shows a procedure open in the reader, to confirm at its end. */
export default function Preview() {
  return <Procedures knowledge={knowledge} procedureId="rec_injury" mediaUrl={pictureUrl} />;
}
