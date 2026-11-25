import {
  createMembershipsHooks,
  MEMBERSHIPS_HOOKS_CALL,
  type MembershipsOperations,
} from "@composable-os/pack-memberships/client";
import { PersonMemberships } from "../../../packs/memberships/blocks/memberships-staff-holdings/holdings.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { staffHoldings, staffPassTypes, subscriptions } from "./data/memberships.ts";

const memberships = createMembershipsHooks(
  react,
  fakeClient<MembershipsOperations>(MEMBERSHIPS_HOOKS_CALL, {
    "x.memberships.holdings": staffHoldings,
    "subscription.list": subscriptions,
    "record.list": staffPassTypes,
  }),
);

export const width = 720;

export default function Preview() {
  return <PersonMemberships memberships={memberships} personId="p_10" />;
}
