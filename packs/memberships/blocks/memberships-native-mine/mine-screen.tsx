// A member's memberships and passes in the gym's app (stage 32b), read only: what each allows,
// what is left this week, this month or in all (the host's count), when it stops or expires, and
// their membership's billing state in words, with a plan change or a pause waiting. Joining,
// buying a pass, cancelling, resuming, changing plan and the card are on the web only (`noPurchase`: the block lint refuses a billing operation or a purchase
// here). Cooling off (stage 44 step 7, ADR 0647) too: while the host says a new member may end
// their membership for a full refund, the app says until when and that it is done on the website;
// a membership ended that way says where its refund is. The window is the host's, never the app's.
import type { MembershipsHooks } from "@composable-os/pack-memberships/client";
import {
  allowsWords,
  changeWords,
  coolingOffClosedWords,
  coolOffProgressWords,
  day,
  isLive,
  leftWords,
  localDay,
  subscriptionStatus,
} from "@composable-os/pack-memberships/client";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";

export function MyMembershipsScreen({
  memberships,
}: {
  memberships: Pick<MembershipsHooks, "useMine" | "useMySubscriptions" | "useCoolingOff">;
}) {
  const { data, isPending, error } = memberships.useMine();
  const subs = memberships.useMySubscriptions();
  const all = subs.data?.items ?? [];
  const cooling = memberships.useCoolingOff(all.map((sub) => sub.id));
  const statusOf = (id: string) => cooling.data?.items.find((c) => c.subscriptionId === id);
  const live = all.filter(isLive);
  const cooledOff = all.filter(
    (sub) => !isLive(sub) && statusOf(sub.id)?.coolOff?.state === "ended",
  );
  return (
    <Screen title="My memberships">
      {isPending ? (
        <Text tone="muted" accessibilityRole="progressbar">
          Loading your memberships…
        </Text>
      ) : null}
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
      {live.map((sub) => {
        const status = statusOf(sub.id);
        const words = status?.offered
          ? `You can cancel for a full refund until the end of ${localDay(status.until)}, on the gym's website.`
          : (coolOffProgressWords(status, { amounts: false }) ?? coolingOffClosedWords(status));
        return (
          <Text key={sub.id}>
            {`${sub.planTitle}: ${subscriptionStatus(sub)}${changeWords(sub) ? `. ${changeWords(sub)}` : ""}${words ? ` ${words}` : ""}`}
          </Text>
        );
      })}
      {cooledOff.map((sub) => (
        <Text key={sub.id}>
          {`${sub.planTitle}: ${coolOffProgressWords(statusOf(sub.id), { amounts: false }) ?? "Ended"}`}
        </Text>
      ))}
      {live.length ? <Text>Manage your membership on the gym's website.</Text> : null}
    </Screen>
  );
}
