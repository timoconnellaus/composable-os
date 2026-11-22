// A member's memberships and passes in the gym's app (stage 32b), read only: what each allows,
// what is left this week, this month or in all (the host's count), when it stops or expires, and
// their membership's billing state in words, with a plan change or a pause waiting. Joining,
// buying a pass, cancelling, resuming, changing plan and the card are on the web only (`noPurchase`: the block lint refuses a billing operation or a purchase
// here).
import type { MembershipsHooks } from "@composable-os/pack-memberships/client";
import {
  allowsWords,
  changeWords,
  day,
  isLive,
  leftWords,
  subscriptionStatus,
} from "@composable-os/pack-memberships/client";
import { Text } from "react-native";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

export function MyMembershipsScreen({
  memberships,
}: {
  memberships: Pick<MembershipsHooks, "useMine" | "useMySubscriptions">;
}) {
  const { data, isPending, error } = memberships.useMine();
  const subs = memberships.useMySubscriptions();
  const live = subs.data?.items.filter(isLive) ?? [];
  return (
    <Screen title="My memberships">
      {isPending ? <Text accessibilityRole="progressbar">Loading your memberships…</Text> : null}
      {error ? <Text accessibilityRole="alert">We could not load your memberships.</Text> : null}
      {data ? (
        <List empty="You have no membership or pass yet.">
          {data.holdings.map((h) => (
            <Row
              key={h.id}
              title={h.title ?? ""}
              detail={`${leftWords(h)} · ${allowsWords(h)}${h.until ? ` · until ${day(h.until)}` : ""}`}
            />
          ))}
        </List>
      ) : null}
      {live.map((sub) => (
        <Text key={sub.id}>
          {`${sub.planTitle}: ${subscriptionStatus(sub)}${changeWords(sub) ? `. ${changeWords(sub)}` : ""}`}
        </Text>
      ))}
      {live.length ? <Text>Manage your membership on the gym's website.</Text> : null}
    </Screen>
  );
}
