import {
  createKnowledgeHooks,
  KNOWLEDGE_HOOKS_CALL,
  type KnowledgeOperations,
} from "@composable-os/pack-knowledge/client";
import { ReadStatus } from "../../../packs/knowledge/blocks/knowledge-read-status/read-status.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { readOne, readOverview } from "./data/knowledge.ts";

const knowledge = createKnowledgeHooks(
  react,
  fakeClient<KnowledgeOperations>(KNOWLEDGE_HOOKS_CALL, {
    "x.knowledge.readStatus": (input) => (input.id ? readOne : readOverview),
  }),
);

export const width = 760;

/** The picture shows one procedure's people: who has confirmed and who has not. */
export const click = { role: "button", name: "Who has read When someone is hurt" };

export default function Preview() {
  return <ReadStatus knowledge={knowledge} />;
}
