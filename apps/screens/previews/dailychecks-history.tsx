import {
  createDailyChecksHooks,
  DAILYCHECKS_HOOKS_CALL,
  type DailyChecksOperations,
} from "@composable-os/pack-dailychecks/client";
import { ChecklistHistory } from "../../../packs/dailychecks/blocks/dailychecks-history/history.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { history } from "./data/dailychecks.ts";

const dailychecks = createDailyChecksHooks(
  react,
  fakeClient<DailyChecksOperations>(DAILYCHECKS_HOOKS_CALL, {
    "x.dailychecks.history": history,
  }),
);

export default function Preview() {
  return <ChecklistHistory dailychecks={dailychecks} locale="en-GB" />;
}
