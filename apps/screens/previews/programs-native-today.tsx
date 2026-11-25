import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { TodayScreen } from "../../../packs/programs/blocks/programs-native-today/today-screen.tsx";
import { fakeClient, react, TODAY } from "../src/fake.ts";
import { today } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, { "x.programs.today": today }),
);

export default function Preview() {
  return <TodayScreen programs={programs} date={TODAY} onOpen={() => undefined} />;
}
