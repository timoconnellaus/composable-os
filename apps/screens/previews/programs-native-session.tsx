import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { SessionScreen } from "../../../packs/programs/blocks/programs-native-session/session-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { lowerToday, sessionGet } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, { "x.programs.sessionGet": sessionGet }),
);

export default function Preview() {
  return <SessionScreen programs={programs} sessionId={lowerToday.id} />;
}
