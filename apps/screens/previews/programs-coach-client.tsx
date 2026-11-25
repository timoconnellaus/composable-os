import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { CoachClient } from "../../../packs/programs/blocks/programs-coach-client/coach-client.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { historyOf, listRead, MEMBER, progress, sessionGet } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, {
    "record.list": listRead,
    "x.programs.sessionGet": sessionGet,
    "x.programs.progress": progress,
    "x.programs.history": historyOf,
  }),
);

export const width = 880;

export default function Preview() {
  return <CoachClient programs={programs} personId={MEMBER.id} />;
}
