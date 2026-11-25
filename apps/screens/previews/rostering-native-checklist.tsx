import {
  createRosteringHooks,
  ROSTERING_HOOKS_CALL,
  type RosteringOperations,
} from "@composable-os/pack-rostering/client";
import { Screen } from "../../../blocks/native-base/screen.tsx";
import { ShiftChecklistNative } from "../../../packs/rostering/blocks/rostering-native-checklist/checklist-screen.tsx";
import { fakeClient, react, TIME_ZONE } from "../src/fake.ts";
import { answers, frontDesk } from "./data/rostering.ts";

const rostering = createRosteringHooks(
  react,
  fakeClient<RosteringOperations>(ROSTERING_HOOKS_CALL, answers),
);

/** The picture shows the checklist open, part ticked, during the shift. */
export const click = "Open the checklist";

export default function Preview() {
  // The checklist sits under a shift on a screen (my shifts); here it is drawn on a screen alone.
  return (
    <Screen title="Front desk, today">
      <ShiftChecklistNative rostering={rostering} shift={frontDesk} zone={TIME_ZONE} />
    </Screen>
  );
}
