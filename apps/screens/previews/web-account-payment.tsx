import { PaymentMethod } from "../../../blocks/web-account-payment/payment.tsx";
import { accountHooks } from "./data/account.ts";

const account = accountHooks("browser");

export const width = 720;

export default function Preview() {
  return <PaymentMethod account={account} returnUrl="https://www.example.com/account" />;
}
