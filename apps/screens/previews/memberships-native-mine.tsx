import {
  createMembershipsHooks,
  MEMBERSHIPS_HOOKS_CALL,
  type MembershipsOperations,
} from "@composable-os/pack-memberships/client";
import { MyMembershipsScreen } from "../../../packs/memberships/blocks/memberships-native-mine/mine-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { coolingOff, family, mineFor, subscriptions } from "./data/memberships.ts";

const memberships = createMembershipsHooks(
  react,
  fakeClient<MembershipsOperations>(MEMBERSHIPS_HOOKS_CALL, {
    "x.memberships.mine": mineFor,
    "me.family": family,
    "subscription.list": subscriptions,
    "subscription.coolingOff": coolingOff,
  }),
);

export default function Preview() {
  return <MyMembershipsScreen memberships={memberships} />;
}
