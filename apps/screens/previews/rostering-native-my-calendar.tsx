import {
  createRosteringHooks,
  ROSTERING_HOOKS_CALL,
  type RosteringOperations,
} from "@composable-os/pack-rostering/client";
import { MyCalendarScreen } from "../../../packs/rostering/blocks/rostering-native-my-calendar/my-calendar-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { answers, calendarAnswers } from "./data/rostering.ts";

const rostering = createRosteringHooks(
  react,
  fakeClient<RosteringOperations>(ROSTERING_HOOKS_CALL, { ...answers, ...calendarAnswers() }),
);

/** The picture shows the address just made, as it is shown once. */
export const click = "Make my calendar address";

export default function Preview() {
  return (
    <MyCalendarScreen rostering={rostering} openUrl={() => undefined} copy={() => undefined} />
  );
}
