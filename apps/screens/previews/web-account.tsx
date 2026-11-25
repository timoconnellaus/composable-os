import { createMembershipsHooks } from "@composable-os/pack-memberships/client";
import {
  MyAccount,
  usePackSections,
  type WebSectionEntry,
} from "../../../blocks/web-account/account.tsx";
import { MyMemberships } from "../../../packs/memberships/blocks/memberships-mine/mine.tsx";
import { react } from "../src/fake.ts";
import { accountHooks, agreementsHooks, membershipsClient } from "./data/account.ts";

const account = accountHooks("browser");
const agreements = agreementsHooks();

/** What `cos add web-account` writes in `account-sections.gen.ts` for a gym with Memberships. */
const ACCOUNT_SECTIONS: readonly WebSectionEntry[] = [
  {
    key: "memberships.memberships",
    pack: "memberships",
    label: "Memberships and passes",
    order: 20,
    component: MyMemberships,
    hooks: createMembershipsHooks,
  },
];

export default function Preview() {
  const returnUrl = "https://www.example.com/account";
  const sections = usePackSections(ACCOUNT_SECTIONS, react, membershipsClient, returnUrl);
  return (
    <MyAccount
      account={account}
      agreements={agreements}
      sections={sections}
      returnUrl={returnUrl}
      onSignOut={() => {}}
    />
  );
}
