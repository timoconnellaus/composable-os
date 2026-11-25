import { MySubscriptions } from "../../../blocks/web-account-subscriptions/subscriptions.tsx";
import { accountHooks } from "./data/account.ts";

const account = accountHooks("browser");

export const width = 720;

export default function Preview() {
  return <MySubscriptions account={account} />;
}
