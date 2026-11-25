import { YourFamily } from "../../../blocks/web-account-family/family.tsx";
import { accountHooks } from "./data/account.ts";

const account = accountHooks("browser");

export const width = 720;

export default function Preview() {
  return <YourFamily account={account} />;
}
