import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { ProgramBuilder } from "../../../packs/programs/blocks/programs-builder/program-builder.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { coachMe, handstandProgram, listRead, PROGRAM_ID, versions } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, {
    "record.get": handstandProgram,
    "record.list": listRead,
    "record.versions": versions,
    "user.me": coachMe,
  }),
);

export default function Preview() {
  return <ProgramBuilder programs={programs} programId={PROGRAM_ID} />;
}
