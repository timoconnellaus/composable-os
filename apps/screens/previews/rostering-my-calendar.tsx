import {
  createRosteringHooks,
  ROSTERING_HOOKS_CALL,
  type RosteringOperations,
} from "@composable-os/pack-rostering/client";
import { MyCalendar } from "../../../packs/rostering/blocks/rostering-my-calendar/my-calendar.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { answers, calendarAnswers } from "./data/rostering.ts";

const rostering = createRosteringHooks(
  react,
  fakeClient<RosteringOperations>(ROSTERING_HOOKS_CALL, { ...answers, ...calendarAnswers() }),
);

export const width = 720;

/** The picture shows the address just made, as it is shown once. */
export const click = "Make my calendar address";

export default function Preview() {
  return <MyCalendar rostering={rostering} />;
}
