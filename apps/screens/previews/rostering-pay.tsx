import {
  createRosteringHooks,
  ROSTERING_HOOKS_CALL,
  type RosteringOperations,
} from "@composable-os/pack-rostering/client";
import { Pay } from "../../../packs/rostering/blocks/rostering-pay/pay.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { answers } from "./data/rostering.ts";

const rostering = createRosteringHooks(
  react,
  fakeClient<RosteringOperations>(ROSTERING_HOOKS_CALL, answers),
);

export const width = 900;

/** The picture shows a period that has ended and waits to be locked. */
export const click = "22 Feb";

export default function Preview() {
  return <Pay rostering={rostering} />;
}
