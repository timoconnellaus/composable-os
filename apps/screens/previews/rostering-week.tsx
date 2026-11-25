import {
  createRosteringHooks,
  ROSTERING_HOOKS_CALL,
  type RosteringOperations,
} from "@composable-os/pack-rostering/client";
import { RosterWeek } from "../../../packs/rostering/blocks/rostering-week/week.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { answers } from "./data/rostering.ts";

const rostering = createRosteringHooks(
  react,
  fakeClient<RosteringOperations>(ROSTERING_HOOKS_CALL, answers),
);

export const width = 1440;

/** A rosterer opens the shift with nobody on it, to put someone on it. */
export const click = "Nobody on it";

export default function Preview() {
  return <RosterWeek rostering={rostering} />;
}
