import {
  AGREEMENTS_HOOKS_CALL,
  type AgreementsOperations,
  createAgreementsHooks,
} from "@composable-os/client";
import { BeforeYouGoOnScreen } from "../../../blocks/native-agreements-due/before-you-go-on-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { dueForMe } from "./data/agreements.ts";

const agreements = createAgreementsHooks(
  react,
  fakeClient<AgreementsOperations>(AGREEMENTS_HOOKS_CALL, { "me.agreements.due": dueForMe }),
);

export default function Preview() {
  return <BeforeYouGoOnScreen agreements={agreements} onDone={() => {}} />;
}
