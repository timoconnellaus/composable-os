import { ChangeSignInAddress } from "../../../blocks/native-account-email/email.tsx";
import { Screen } from "../../../blocks/native-base/screen.tsx";
import { accountHooks, signIn } from "./data/account.ts";

const account = accountHooks("device");

// The form that asks for a code at the new address.
export const click = "Change sign-in address";
export const fill = [["New sign-in address", "hannah@okafor.example.com"]];

export default function Preview() {
  return (
    <Screen title="Your details">
      <ChangeSignInAddress account={account} signIn={signIn} />
    </Screen>
  );
}
