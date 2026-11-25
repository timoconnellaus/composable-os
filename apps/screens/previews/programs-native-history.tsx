import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { HistoryScreen } from "../../../packs/programs/blocks/programs-native-history/history-screen.tsx";
import { fakeClient, react, TODAY } from "../src/fake.ts";
import { listRead, sessionGet } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, {
    "my.list": listRead,
    "x.programs.sessionGet": sessionGet,
  }),
);

export default function Preview() {
  return <HistoryScreen programs={programs} until={TODAY} />;
}
