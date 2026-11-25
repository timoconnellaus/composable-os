import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { SessionHistory } from "../../../packs/programs/blocks/programs-history/history.tsx";
import { fakeClient, react, TODAY } from "../src/fake.ts";
import { listRead, sessionGet } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, {
    "my.list": listRead,
    "x.programs.sessionGet": sessionGet,
  }),
);

export const width = 880;

export default function Preview() {
  return <SessionHistory programs={programs} until={TODAY} />;
}

/** The picture shows the newest past session opened, set by set. */
export const click = "Upper body A";
