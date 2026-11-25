import { YourOrders } from "../../../blocks/web-account-orders/orders.tsx";
import { accountHooks } from "./data/account.ts";

const account = accountHooks("browser");

export const width = 720;

export default function Preview() {
  return <YourOrders account={account} />;
}
