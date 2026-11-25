import {
  createRosteringHooks,
  ROSTERING_HOOKS_CALL,
  type RosteringOperations,
} from "@composable-os/pack-rostering/client";
import { MyShiftsScreen } from "../../../packs/rostering/blocks/rostering-native-my-shifts/my-shifts-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { answers } from "./data/rostering.ts";

const rostering = createRosteringHooks(
  react,
  fakeClient<RosteringOperations>(ROSTERING_HOOKS_CALL, answers),
);

export default function Preview() {
  return <MyShiftsScreen rostering={rostering} days={7} />;
}
