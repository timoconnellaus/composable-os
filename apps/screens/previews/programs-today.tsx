import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { Today } from "../../../packs/programs/blocks/programs-today/today.tsx";
import { fakeClient, react, TODAY } from "../src/fake.ts";
import { sessionGet, today } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, {
    "x.programs.today": today,
    "x.programs.sessionGet": sessionGet,
  }),
);

export const width = 880;

export default function Preview() {
  return <Today programs={programs} date={TODAY} />;
}

/** The picture shows the day's strength session open, half done. */
export const click = "Lower body A";
