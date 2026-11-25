import { ContactPreferences } from "../../../blocks/web-account-contact/contact.tsx";
import { accountHooks } from "./data/account.ts";

const account = accountHooks("browser");

export const width = 720;

export default function Preview() {
  return <ContactPreferences account={account} />;
}
