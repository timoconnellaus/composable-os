// Offered to me, in the app (stage 45 step 7): the shifts the host says I could take now, soonest
// first, and taking one. Nobody approves a take. When I said I am away then, the host asks me to
// confirm and this asks the same in a sheet; when someone else took it first the host names them;
// a withdrawn or lapsed offer, one past the cut-off, a clash, a shift that changed hands, or a
// kind I am not qualified for each shows the host's words, and the list is read again.
import {
  type OpenOffer,
  type RosteringHooks,
  type RosterRefusal,
  refusalNext,
  rosterRefusal,
  shiftTime,
} from "@composable-os/pack-rostering/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Sheet } from "../native-base/sheet.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "useOffers" | "useTake">;

export function OffersScreen({
  rostering,
  locale = "en-AU",
}: {
  rostering: Hooks;
  locale?: string;
}) {
  const me = rostering.useMe();
  const offers = rostering.useOffers();
  const take = rostering.useTake();
  const [confirming, setConfirming] = useState<OpenOffer | null>(null);
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const zone = me.data?.zone ?? "UTC";

  async function takeIt(o: OpenOffer, confirmUnavailable: boolean) {
    setRefusal(null);
    setTaken(null);
    try {
      await take.mutateAsync({
        offer: o.id,
        ...(confirmUnavailable ? { confirmUnavailable } : {}),
      });
      setConfirming(null);
      setTaken(
        `${o.shift.title}, ${shiftTime(o.shift, zone, { withDate: true, locale })} is yours now.`,
      );
    } catch (error) {
      const r = rosterRefusal(error);
      if (r.kind === "unavailable_confirm") {
        setConfirming(o);
        return;
      }
      setConfirming(null);
      setRefusal(r);
    }
    await offers.refetch?.();
  }

  const open = offers.data?.open ?? [];
  return (
    <Screen title="Offered to me">
      {me.isPending || offers.isPending ? (
        <Text accessibilityRole="progressbar">Loading offers…</Text>
      ) : null}
      {me.error || offers.error ? (
        <Text accessibilityRole="alert">{rosterRefusal(me.error ?? offers.error).message}</Text>
      ) : null}
      {taken ? <Text accessibilityRole="alert">{taken}</Text> : null}
      {refusal ? (
        <Text accessibilityRole="alert">
          {refusal.message}
          {refusalNext(refusal.kind, me.data?.rosters ?? false)
            ? ` ${refusalNext(refusal.kind, me.data?.rosters ?? false)}`
            : ""}
        </Text>
      ) : null}
      {offers.data ? (
        <List empty="No shifts are offered to you right now.">
          {open.map((o) => (
            <View key={o.id}>
              <Row
                title={o.shift.title}
                detail={[
                  shiftTime(o.shift, zone, { withDate: true, locale }),
                  `Offered by ${o.fromName ?? "whoever rosters"}${o.to ? " to you" : ""}`,
                  o.unavailable ? "You said you are away then" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
              <Button
                label={`Take ${o.shift.title}`}
                busy={take.isPending}
                onPress={() => takeIt(o, false)}
              />
            </View>
          ))}
        </List>
      ) : null}
      <Sheet
        open={confirming !== null}
        title="You said you are away then"
        onClose={() => setConfirming(null)}
      >
        <Text>You said you are not available then. Take it anyway?</Text>
        <Button
          label="Take it anyway"
          busy={take.isPending}
          onPress={() => confirming && takeIt(confirming, true)}
        />
        <Button label="Leave it" quiet onPress={() => setConfirming(null)} />
      </Sheet>
    </Screen>
  );
}
