import {
  createMembershipsHooks,
  MEMBERSHIPS_HOOKS_CALL,
  type MembershipsOperations,
} from "@composable-os/pack-memberships/client";
import { Plans } from "../../../packs/memberships/blocks/memberships-plans/plans.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { plans } from "./data/memberships.ts";

const memberships = createMembershipsHooks(
  react,
  fakeClient<MembershipsOperations>(MEMBERSHIPS_HOOKS_CALL, { "x.memberships.plans": plans }),
);

export const width = 720;

export default function Preview() {
  return (
    <Plans memberships={memberships} signedIn returnUrl="https://studio.example.com/welcome" />
  );
}
