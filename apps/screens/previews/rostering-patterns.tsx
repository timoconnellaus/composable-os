import {
  createRosteringHooks,
  ROSTERING_HOOKS_CALL,
  type RosteringOperations,
} from "@composable-os/pack-rostering/client";
import { Patterns } from "../../../packs/rostering/blocks/rostering-patterns/patterns.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { answers } from "./data/rostering.ts";

const rostering = createRosteringHooks(
  react,
  fakeClient<RosteringOperations>(ROSTERING_HOOKS_CALL, answers),
);

export const width = 1280;

export default function Preview() {
  return <Patterns rostering={rostering} />;
}
