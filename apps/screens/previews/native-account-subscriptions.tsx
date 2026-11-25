import { MySubscriptions } from "../../../blocks/native-account-subscriptions/subscriptions.tsx";
import { Screen } from "../../../blocks/native-base/screen.tsx";
import { accountHooks } from "./data/account.ts";

const account = accountHooks("device");

/** Drawn as the account screen opens it: on a screen of its own, under the section's name. */
export default function Preview() {
  return (
    <Screen title="Subscriptions">
      <MySubscriptions account={account} onManage={() => {}} />
    </Screen>
  );
}
