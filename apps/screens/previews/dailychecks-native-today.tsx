import {
  createDailyChecksHooks,
  DAILYCHECKS_HOOKS_CALL,
  type DailyChecksOperations,
} from "@composable-os/pack-dailychecks/client";
import { TodaysChecklistsScreen } from "../../../packs/dailychecks/blocks/dailychecks-native-today/today-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { today } from "./data/dailychecks.ts";

const dailychecks = createDailyChecksHooks(
  react,
  fakeClient<DailyChecksOperations>(DAILYCHECKS_HOOKS_CALL, { "x.dailychecks.today": today }),
);

export default function Preview() {
  return <TodaysChecklistsScreen dailychecks={dailychecks} locale="en-GB" />;
}
