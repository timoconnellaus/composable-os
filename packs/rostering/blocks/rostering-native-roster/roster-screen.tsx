// The roster in the app (stage 45 step 7), for every rostered person: the week as a day-by-day
// list on a phone, each day's shifts in order of start with the kind of work, the place and who
// is on it, shifts with nobody on them marked and my own marked as mine. Read only; a rosterer
// rosters on the web. Each shift's time is shown in the business's zone, and each day's length is
// the host's (a clock-change day says so), never worked out from the phone's own zone.
import {
  addDays,
  clockChange,
  dayLabel,
  personOn,
  type RosteringHooks,
  rosterRefusal,
  shiftName,
  shiftsByDay,
  shiftTime,
  warningLabel,
  weekOf,
} from "@composable-os/pack-rostering/client";
import { useState } from "react";
import { View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "useWeek">;

export function RosterScreen({
  rostering,
  locale = "en-AU",
}: {
  rostering: Hooks;
  locale?: string;
}) {
  const me = rostering.useMe();
  const [start, setStart] = useState<string | null>(null);
  const first = start ?? (me.data ? weekOf(me.data.today) : null);
  const week = rostering.useWeek(
    { from: first ?? "", to: first ? addDays(first, 6) : "" },
    first !== null,
  );
  const zone = week.data?.zone ?? me.data?.zone ?? "UTC";
  return (
    <Screen title={first ? `Roster: week of ${dayLabel(first, locale)}` : "Roster"}>
      <View>
        <Button
          label="Previous week"
          quiet
          disabled={!first}
          onPress={() => first && setStart(addDays(first, -7))}
        />
        <Button
          label="Next week"
          quiet
          disabled={!first}
          onPress={() => first && setStart(addDays(first, 7))}
        />
      </View>
      {me.isPending || week.isPending ? (
        <Text tone="muted" accessibilityRole="progressbar">
          Loading the roster…
        </Text>
      ) : null}
      {me.error || week.error ? (
        <Text accessibilityRole="alert">{rosterRefusal(me.error ?? week.error).message}</Text>
      ) : null}
      {week.data ? <Text>Times are in {zone}.</Text> : null}
      {week.data?.truncated ? (
        <Text>This week has more shifts than one screen shows: the first ones are shown.</Text>
      ) : null}
      {week.data
        ? shiftsByDay(week.data).map(({ day, shifts }) => (
            <View key={day.date}>
              <Text accessibilityRole="header">
                {dayLabel(day.date, locale)}
                {day.date === me.data?.today ? " (today)" : ""}
              </Text>
              {clockChange(day) ? <Text>{clockChange(day)}</Text> : null}
              <List empty="No shifts">
                {shifts.map((shift) => (
                  <View
                    key={`${shift.object}:${shift.id}`}
                    accessible
                    accessibilityLabel={shiftName(shift, zone, locale)}
                  >
                    <Row
                      title={`${shiftTime(shift, zone, { locale })} · ${shift.title}${shift.mine ? " (mine)" : ""}`}
                      detail={[
                        shift.place,
                        personOn(shift),
                        shift.offer ? "Offered" : null,
                        ...(shift.warnings ?? []).map((w) => warningLabel(w.code)),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    />
                  </View>
                ))}
              </List>
            </View>
          ))
        : null}
    </Screen>
  );
}
