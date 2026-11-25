import { NeedsAttention } from "../../../blocks/web-account-attention/attention.tsx";
import { accountHooks, portal } from "./data/account.ts";

const account = accountHooks("browser");

export const width = 720;

export default function Preview() {
  return <NeedsAttention account={account} sections={portal.sections} onSection={() => {}} />;
}
