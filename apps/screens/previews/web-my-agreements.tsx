import {
  AGREEMENTS_HOOKS_CALL,
  type AgreementsOperations,
  createAgreementsHooks,
} from "@composable-os/client";
import { MyAgreements } from "../../../blocks/web-my-agreements/my-agreements.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { dueForFamily, mine } from "./data/agreements.ts";

const agreements = createAgreementsHooks(
  react,
  fakeClient<AgreementsOperations>(AGREEMENTS_HOOKS_CALL, {
    "me.agreements.due": dueForFamily,
    "me.agreements.list": mine,
  }),
);

export const width = 720;

export default function Preview() {
  return <MyAgreements agreements={agreements} />;
}
