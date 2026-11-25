import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { ClassToday } from "../../../packs/programs/blocks/programs-class-today/class-today.tsx";
import { fakeClient, react, TODAY } from "../src/fake.ts";
import { classToday, classTypes, sessionGet } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, {
    "record.list": classTypes,
    "x.programs.classToday": classToday,
    "x.programs.sessionGet": sessionGet,
  }),
);

export const width = 880;

export default function Preview() {
  return <ClassToday programs={programs} classTypeId="ct_handstands" date={TODAY} />;
}
