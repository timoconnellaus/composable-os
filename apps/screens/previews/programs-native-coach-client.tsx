import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL,
  type ProgramsOperations,
} from "@composable-os/pack-programs/client";
import { CoachClientScreen } from "../../../packs/programs/blocks/programs-native-coach-client/coach-client-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { listRead, MEMBER } from "./data/programs.ts";

const programs = createProgramsHooks(
  react,
  fakeClient<ProgramsOperations>(PROGRAMS_HOOKS_CALL, { "record.list": listRead }),
);

export default function Preview() {
  return (
    <CoachClientScreen
      programs={programs}
      personId={MEMBER.id}
      name={MEMBER.name}
      onOpen={() => undefined}
    />
  );
}
