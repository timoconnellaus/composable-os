import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { Progress } from "../../../packs/programs/blocks/programs-progress/progress.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { historyOf, progress } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, {
    "x.programs.progress": progress,
    "x.programs.history": historyOf,
  }),
);

export const width = 820;

export default function Preview() {
  return <Progress programs={programs} />;
}

/** The picture shows the squat's sets opened under the table. */
export const click = "History";
