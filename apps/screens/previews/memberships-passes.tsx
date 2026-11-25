import {
  createMembershipsHooks,
  MEMBERSHIPS_HOOKS_CALL,
  type MembershipsOperations,
} from "@composable-os/pack-memberships/client";
import { Passes } from "../../../packs/memberships/blocks/memberships-passes/passes.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { passTypes } from "./data/memberships.ts";

const memberships = createMembershipsHooks(
  react,
  fakeClient<MembershipsOperations>(MEMBERSHIPS_HOOKS_CALL, {
    "x.memberships.passTypes": passTypes,
  }),
);

export const width = 720;

export default function Preview() {
  return (
    <Passes memberships={memberships} signedIn returnUrl="https://studio.example.com/passes" />
  );
}
