import {
  createRosteringHooks,
  ROSTERING_HOOKS_CALL,
  type RosteringOperations,
} from "@composable-os/pack-rostering/client";
import { MyAvailability } from "../../../packs/rostering/blocks/rostering-my-availability/my-availability.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { answers } from "./data/rostering.ts";

const rostering = createRosteringHooks(
  react,
  fakeClient<RosteringOperations>(ROSTERING_HOOKS_CALL, answers),
);

export const width = 800;

export default function Preview() {
  return <MyAvailability rostering={rostering} />;
}
