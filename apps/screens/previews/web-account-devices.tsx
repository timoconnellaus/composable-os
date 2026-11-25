import { SignInAndDevices } from "../../../blocks/web-account-devices/devices.tsx";
import { accountHooks } from "./data/account.ts";

const account = accountHooks("browser");

export const width = 720;

export default function Preview() {
  return <SignInAndDevices account={account} onSignOut={() => {}} />;
}
