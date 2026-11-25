import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { ClassTodayScreen } from "../../../packs/programs/blocks/programs-native-class-today/class-today-screen.tsx";
import { fakeClient, react, TODAY } from "../src/fake.ts";
import { classToday, classTypes } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, {
    "record.list": classTypes,
    "x.programs.classToday": classToday,
  }),
);

export default function Preview() {
  return <ClassTodayScreen programs={programs} date={TODAY} onOpen={() => undefined} />;
}
