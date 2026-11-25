import { DeleteAccount } from "../../../blocks/web-account-delete/delete.tsx";
import { accountHooks, signIn } from "./data/account.ts";

const account = accountHooks("browser");

export const width = 720;
// The host's preview, shown in full before the confirmation.
export const click = "See what deleting my account does";

export default function Preview() {
  return <DeleteAccount account={account} signIn={signIn} onDeleted={() => {}} />;
}
