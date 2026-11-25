import {
  createMembershipsHooks,
  MEMBERSHIPS_HOOKS_CALL,
  type MembershipsOperations,
} from "@composable-os/pack-memberships/client";
import { MyMemberships } from "../../../packs/memberships/blocks/memberships-mine/mine.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { coolingOff, family, mineFor, plans, subscriptions } from "./data/memberships.ts";

const memberships = createMembershipsHooks(
  react,
  fakeClient<MembershipsOperations>(MEMBERSHIPS_HOOKS_CALL, {
    "x.memberships.mine": mineFor,
    "me.family": family,
    "x.memberships.plans": plans,
    "subscription.list": subscriptions,
    "subscription.coolingOff": coolingOff,
  }),
);

export const width = 720;

export default function Preview() {
  return <MyMemberships memberships={memberships} />;
}
