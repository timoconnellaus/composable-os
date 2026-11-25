// A member's memberships and passes in the gym's app (stage 32b), and their section of the app's
// My account (stage 48), read only: what each allows, what is left this week, this month or in all
// (the host's count), when it stops or expires, a child's the gym linked to them under the child's
// name (decision 8), and their membership's billing state in words through My account's one
// subscriptions part (`native-account-subscriptions`), with a plan change or a pause waiting and
// "Manage on the website" (`onManage`, which the account shell gives). Joining, buying a pass,
// cancelling, resuming, changing plan and the card are on the web only (`noPurchase`: the block
// lint refuses a billing operation or a purchase here). Cooling off (stage 44 step 7, ADR 0647)
// too: while the host says a new member may end their membership for a full refund, the app says
// until when and that it is done on the website; a membership ended that way says where its refund
// is. The window is the host's, never the app's.
import type { Holding, MembershipsHooks } from "@composable-os/pack-memberships/client";
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
import { MySubscriptions } from "../native-account-subscriptions/subscriptions.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";

type Hooks = Pick<MembershipsHooks, "useMine" | "useMySubscriptions" | "useCoolingOff"> &
  Partial<Pick<MembershipsHooks, "useFamily">>;

export function MyMembershipsScreen({
  memberships,
  onManage,
}: {
  memberships: Hooks;
  /** Opens the business's website account page (the account shell gives it). */
  onManage?: () => void;
}) {
  const { data, isPending, error } = memberships.useMine();
  const subs = memberships.useMySubscriptions();
  const all = subs.data?.items ?? [];
  const cooling = memberships.useCoolingOff(all.map((sub) => sub.id));
  const statusOf = (id: string) => cooling.data?.items.find((c) => c.subscriptionId === id);
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
        <List empty="You have no membership or pass yet.">{holdingRows(data.holdings)}</List>
      ) : null}
      <MySubscriptions
        account={{ useSubscriptions: memberships.useMySubscriptions }}
        onManage={onManage}
        empty={null}
        status={subscriptionStatus}
        manageWords="Manage your membership on the gym's website."
        about={(sub) => {
          const status = statusOf(sub.id);
          const words = status?.offered
            ? `You can cancel for a full refund until the end of ${localDay(status.until)}, on the gym's website.`
            : (coolOffProgressWords(status, { amounts: false }) ?? coolingOffClosedWords(status));
          return [changeWords(sub), words].filter(Boolean).join(" ") || null;
        }}
      />
      {cooledOff.map((sub) => (
        <Text key={sub.id}>
          {`${sub.planTitle}: ${coolOffProgressWords(statusOf(sub.id), { amounts: false }) ?? "Ended"}`}
        </Text>
      ))}
      {memberships.useFamily ? (
        <Children
          memberships={{ useFamily: memberships.useFamily, useMine: memberships.useMine }}
        />
      ) : null}
    </Screen>
  );
}

function holdingRows(holdings: readonly Holding[]) {
  return holdings.map((h) => (
    <Row
      key={h.id}
      title={h.title ?? ""}
      detail={`${leftWords(h)} · ${allowsWords(h)}${h.until ? ` · until ${day(h.until)}` : ""}`}
    />
  ));
}

/** Each child the gym linked to the member, with their memberships and passes, under their name. */
function Children({
  memberships,
}: {
  memberships: Pick<MembershipsHooks, "useFamily" | "useMine">;
}) {
  const family = memberships.useFamily();
  return (family.data?.dependants ?? []).map((child) => (
    <Child key={child.personId} child={child} memberships={memberships} />
  ));
}

function Child({
  child,
  memberships,
}: {
  child: { personId: string; name: string };
  memberships: Pick<MembershipsHooks, "useMine">;
}) {
  const theirs = memberships.useMine(child.personId);
  if (!theirs.data?.holdings.length) return null;
  return (
    <>
      <Text>{`${child.name}'s memberships and passes`}</Text>
      <List>{holdingRows(theirs.data.holdings)}</List>
    </>
  );
}
