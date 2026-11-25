import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { ExerciseBank } from "../../../packs/programs/blocks/programs-bank/exercise-bank.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { bankPage } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, { "record.list": bankPage }),
);

export const width = 880;

export default function Preview() {
  return <ExerciseBank programs={programs} />;
}

/** The picture shows one exercise opened for editing, with its easier and harder versions. */
export const click = "Chest-to-wall handstand";
