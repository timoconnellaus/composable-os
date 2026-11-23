// My shifts in the app (stage 45 step 7), for every rostered person: a cleaner with the
// `rostering.team` role (its role client), a coach whose role client was generated with the grant
// `rostering:roster`, or anyone else on the roster. The next weeks' shifts day by day, each with
// its time in the business's zone and its place, and offering one for someone else to take or
// withdrawing my offer. The shared logic is the pack's headless entry, as on the web; only the
// screen differs.
//
// The host decides and this shows: an offered shift stays mine until taken; an offer nobody could
// take, one past the cut-off, or one already made is refused with its own words. Room is left for
// a duty shift's checklist (`shiftExtra`, step 4b) and my calendar's address (`calendar`, step 5).
import {
  addDays,
  dateIn,
  dayLabel,
  type RosteringHooks,
  type RosterRefusal,
  type RosterShift,
  refusalNext,
  rosterRefusal,
  shiftName,
  shiftTime,
} from "@composable-os/pack-rostering/client";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "useMine" | "useOffers" | "useOffer" | "useWithdraw">;

export function MyShiftsScreen({
  rostering,
  days = 28,
  locale = "en-AU",
  calendar,
  shiftExtra,
}: {
  rostering: Hooks;
  days?: number;
  locale?: string;
  calendar?: ReactNode;
  shiftExtra?: (shift: RosterShift) => ReactNode;
}) {
  const me = rostering.useMe();
  const first = me.data?.today ?? null;
  const mine = rostering.useMine(
    { from: first ?? "", to: first ? addDays(first, Math.min(days, 62) - 1) : "" },
    first !== null,
  );
  const offers = rostering.useOffers();
  const offer = rostering.useOffer();
  const withdraw = rostering.useWithdraw();
  const [refusal, setRefusal] = useState<{ id: string; refusal: RosterRefusal } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const zone = mine.data?.zone ?? me.data?.zone ?? "UTC";
  const busy = offer.isPending || withdraw.isPending;

  async function act(id: string, what: () => Promise<unknown>, done: string) {
    setRefusal(null);
    setSaid(null);
    try {
      await what();
      setSaid(done);
    } catch (error) {
      setRefusal({ id, refusal: rosterRefusal(error) });
    }
    await Promise.all([mine.refetch?.(), offers.refetch?.()]);
  }

  const shifts = mine.data?.shifts ?? [];
  return (
    <Screen title="My shifts">
      {me.isPending || mine.isPending ? (
        <Text accessibilityRole="progressbar">Loading your shifts…</Text>
      ) : null}
      {me.error || mine.error ? (
        <Text accessibilityRole="alert">{rosterRefusal(me.error ?? mine.error).message}</Text>
      ) : null}
      {calendar}
      {me.data ? (
        <Text>
          Times are in {zone}. Offers close {me.data.cutoffMinutes} minutes before a shift starts.
        </Text>
      ) : null}
      {said ? <Text accessibilityRole="alert">{said}</Text> : null}
      {mine.data?.truncated ? (
        <Text>You have more shifts than one screen shows: the first ones are shown.</Text>
      ) : null}
      {mine.data ? (
        <List empty={`You have no shifts in the next ${days} days.`}>
          {shifts.map((shift) => (
            <View key={shift.id} accessible accessibilityLabel={shiftName(shift, zone, locale)}>
              <Row
                title={`${dayLabel(dateIn(shift.startsAt, zone), locale)} · ${shift.title}`}
                detail={[
                  shiftTime(shift, zone, { locale }),
                  shift.place,
                  shift.offer ? "Offered: still yours until someone takes it" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
              {shift.offer ? (
                <Button
                  label={`Withdraw the offer of ${shift.title}`}
                  quiet
                  busy={busy}
                  onPress={() =>
                    act(
                      shift.id,
                      () => withdraw.mutateAsync({ offer: shift.offer?.id ?? "" }),
                      "Offer withdrawn: the shift is still yours.",
                    )
                  }
                />
              ) : (
                <Button
                  label={`Offer ${shift.title}`}
                  quiet
                  busy={busy}
                  onPress={() =>
                    act(
                      shift.id,
                      () => offer.mutateAsync({ object: shift.object, id: shift.id }),
                      "Offered to everyone who could take it. It stays yours until someone does.",
                    )
                  }
                />
              )}
              {refusal?.id === shift.id ? (
                <Text accessibilityRole="alert">
                  {refusal.refusal.message}
                  {refusalNext(refusal.refusal.kind, me.data?.rosters ?? false)
                    ? ` ${refusalNext(refusal.refusal.kind, me.data?.rosters ?? false)}`
                    : ""}
                </Text>
              ) : null}
              {shiftExtra?.(shift)}
            </View>
          ))}
        </List>
      ) : null}
      {offers.data?.mine.length ? (
        <View>
          <Text accessibilityRole="header">My open offers</Text>
          <List>
            {offers.data.mine.map((o) => (
              <Row
                key={o.id}
                title={o.shift.title}
                detail={shiftTime(o.shift, zone, { withDate: true, locale })}
              />
            ))}
          </List>
        </View>
      ) : null}
    </Screen>
  );
}
