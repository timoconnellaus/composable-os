import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { SessionView } from "../../../packs/programs/blocks/programs-session/session-view.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { lowerToday, sessionGet } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, { "x.programs.sessionGet": sessionGet }),
);

export const width = 820;

export default function Preview() {
  return <SessionView programs={programs} sessionId={lowerToday.id} />;
}
