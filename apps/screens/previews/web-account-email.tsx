import { ChangeSignInAddress } from "../../../blocks/web-account-email/email.tsx";
import { accountHooks, signIn } from "./data/account.ts";

const account = accountHooks("browser");

export const width = 720;
// The form that asks for a code at the new address.
export const click = "Change sign-in address";
export const fill = [["New sign-in address", "hannah@okafor.example.com"]];

export default function Preview() {
  return <ChangeSignInAddress account={account} signIn={signIn} />;
}
