import { DeleteAccount } from "../../../blocks/native-account-delete/delete.tsx";
import { Screen } from "../../../blocks/native-base/screen.tsx";
import { accountHooks, signIn } from "./data/account.ts";

const account = accountHooks("device");

// The host's preview, shown in full before the confirmation.
export const click = "See what deleting my account does";

export default function Preview() {
  return (
    <Screen title="Delete my account">
      <DeleteAccount
        account={account}
        signIn={signIn}
        endSession={async () => {}}
        onDeleted={() => {}}
      />
    </Screen>
  );
}
