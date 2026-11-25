import { YourDetails } from "../../../blocks/web-account-details/details.tsx";
import { accountHooks, signIn } from "./data/account.ts";

const account = accountHooks("browser");

export const width = 720;

export default function Preview() {
  return <YourDetails account={account} signIn={signIn} />;
}
