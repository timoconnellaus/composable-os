import { NeedsAttention } from "../../../blocks/native-account-attention/attention.tsx";
import { Screen } from "../../../blocks/native-base/screen.tsx";
import { accountHooks, portal } from "./data/account.ts";

const account = accountHooks("device");

export default function Preview() {
  return (
    <Screen title="My account">
      <NeedsAttention
        account={account}
        sections={portal.sections}
        onSection={() => {}}
        onManage={() => {}}
      />
    </Screen>
  );
}
