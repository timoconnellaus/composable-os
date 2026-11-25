import {
  createDailyChecksHooks,
  DAILYCHECKS_HOOKS_CALL,
  type DailyChecksOperations,
} from "@composable-os/pack-dailychecks/client";
import { TodaysChecklists } from "../../../packs/dailychecks/blocks/dailychecks-today/today.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { today } from "./data/dailychecks.ts";

const dailychecks = createDailyChecksHooks(
  react,
  fakeClient<DailyChecksOperations>(DAILYCHECKS_HOOKS_CALL, {
    "x.dailychecks.today": today,
  }),
);

export const width = 720;

export default function Preview() {
  return <TodaysChecklists dailychecks={dailychecks} locale="en-GB" />;
}
