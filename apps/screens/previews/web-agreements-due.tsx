import {
  AGREEMENTS_HOOKS_CALL,
  type AgreementsOperations,
  createAgreementsHooks,
} from "@composable-os/client";
import { BeforeYouGoOn } from "../../../blocks/web-agreements-due/before-you-go-on.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { dueForMe } from "./data/agreements.ts";

const agreements = createAgreementsHooks(
  react,
  fakeClient<AgreementsOperations>(AGREEMENTS_HOOKS_CALL, { "me.agreements.due": dueForMe }),
);

export const width = 720;

export default function Preview() {
  return <BeforeYouGoOn agreements={agreements} onDone={() => {}} />;
}
