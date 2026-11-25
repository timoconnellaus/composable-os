import { ContactPreferences } from "../../../blocks/native-account-contact/contact.tsx";
import { Screen } from "../../../blocks/native-base/screen.tsx";
import { accountHooks } from "./data/account.ts";

const account = accountHooks("device");

/** Drawn as the account screen opens it: on a screen of its own, under the section's name. */
export default function Preview() {
  return (
    <Screen title="Contact preferences">
      <ContactPreferences account={account} />
    </Screen>
  );
}
