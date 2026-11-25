import { createMembershipsHooks } from "@composable-os/pack-memberships/client";
import {
  AccountScreen,
  type NativeSectionEntry,
  usePackSections,
} from "../../../blocks/native-account/account-screen.tsx";
import { MyMembershipsScreen } from "../../../packs/memberships/blocks/memberships-native-mine/mine-screen.tsx";
import { react } from "../src/fake.ts";
import { accountHooks, agreementsHooks, membershipsClient, signIn } from "./data/account.ts";

const account = accountHooks("device");
const agreements = agreementsHooks();

/** What `cos add native-account` writes in `account-sections.gen.ts` for a gym with Memberships. */
const ACCOUNT_SECTIONS: readonly NativeSectionEntry[] = [
  {
    key: "memberships.memberships",
    pack: "memberships",
    label: "Memberships and passes",
    order: 20,
    component: MyMembershipsScreen,
    hooks: createMembershipsHooks,
  },
];

export default function Preview() {
  const sections = usePackSections(ACCOUNT_SECTIONS, react, membershipsClient);
  return (
    <AccountScreen
      account={account}
      agreements={agreements}
      sections={sections}
      websiteUrl="https://www.example.com/account"
      signIn={signIn}
      endSession={async () => {}}
      onSignOut={() => {}}
      onDeleted={() => {}}
      openUrl={() => {}}
    />
  );
}
