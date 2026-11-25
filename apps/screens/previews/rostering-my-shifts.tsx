import {
  createRosteringHooks,
  ROSTERING_HOOKS_CALL,
  type RosteringOperations,
} from "@composable-os/pack-rostering/client";
import { MyShifts } from "../../../packs/rostering/blocks/rostering-my-shifts/my-shifts.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { answers } from "./data/rostering.ts";

const rostering = createRosteringHooks(
  react,
  fakeClient<RosteringOperations>(ROSTERING_HOOKS_CALL, answers),
);

export const width = 800;

export default function Preview() {
  return <MyShifts rostering={rostering} days={7} />;
}
