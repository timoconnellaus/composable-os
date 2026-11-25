import {
  AGREEMENTS_HOOKS_CALL,
  type AgreementsOperations,
  createAgreementsHooks,
} from "@composable-os/client";
import { MyAgreementsScreen } from "../../../blocks/native-my-agreements/my-agreements-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { dueForFamily, mine } from "./data/agreements.ts";

const agreements = createAgreementsHooks(
  react,
  fakeClient<AgreementsOperations>(AGREEMENTS_HOOKS_CALL, {
    "me.agreements.due": dueForFamily,
    "me.agreements.list": mine,
  }),
);

export default function Preview() {
  return <MyAgreementsScreen agreements={agreements} />;
}
