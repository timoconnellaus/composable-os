import { YourDetails } from "../../../blocks/native-account-details/details.tsx";
import { Screen } from "../../../blocks/native-base/screen.tsx";
import { accountHooks, signIn } from "./data/account.ts";

const account = accountHooks("device");

/** Drawn as the account screen opens it: on a screen of its own, under the section's name. */
export default function Preview() {
  return (
    <Screen title="Your details">
      <YourDetails account={account} signIn={signIn} />
    </Screen>
  );
}
