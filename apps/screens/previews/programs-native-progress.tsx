import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { ProgressScreen } from "../../../packs/programs/blocks/programs-native-progress/progress-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { historyOf, progress } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, {
    "x.programs.progress": progress,
    "x.programs.history": historyOf,
  }),
);

export default function Preview() {
  return <ProgressScreen programs={programs} />;
}
