import {
  createRosteringHooks,
  ROSTERING_HOOKS_CALL,
  type RosteringOperations,
} from "@composable-os/pack-rostering/client";
import { ShiftChecklist } from "../../../packs/rostering/blocks/rostering-checklist/checklist.tsx";
import { fakeClient, react, TIME_ZONE } from "../src/fake.ts";
import { answers, frontDesk } from "./data/rostering.ts";

const rostering = createRosteringHooks(
  react,
  fakeClient<RosteringOperations>(ROSTERING_HOOKS_CALL, answers),
);

export const width = 720;

/** The picture shows the checklist open, part ticked, during the shift. */
export const click = "Open checklist";

export default function Preview() {
  return <ShiftChecklist rostering={rostering} shift={frontDesk} zone={TIME_ZONE} />;
}
