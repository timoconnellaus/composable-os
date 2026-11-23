// The coach's class list in the gym's app (stage 31a step 9, decision 10): today's classes, and
// for the one picked, who is booked, ticked, not come and waiting, with a button to tick each
// name, untick it, or mark them as not come. For a staff account holding the Bookings coach role
// (its role client, never the staff client): the role reaches today's classes only, and no money,
// no other people, no booking or cancelling. When the list opens, whether a name can be marked
// and who marked it first when two coaches tick at once are the host's answers, shown as they
// come. Nothing here shows what anyone paid with.
import type { BookingsHooks, MarkResult } from "@composable-os/pack-bookings/client";
import { classTime } from "@composable-os/pack-bookings/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

type Hooks = Pick<
  BookingsHooks,
  "useDay" | "useRoster" | "useMarkAttended" | "useUndoAttended" | "useMarkNoShow"
>;

const STATE_LABEL: Record<string, string> = {
  booked: "Booked",
  attended: "Came",
  no_show: "Did not come",
  waiting: "Waiting",
};

/**
 * `date` is today's date where the gym is (YYYY-MM-DD) and `timeZone` the gym's zone: the app
 * passes them; which classes a coach may see is the host's (its role's today).
 */
export function ClassListScreen({
  bookings,
  date,
  timeZone,
}: {
  bookings: Hooks;
  date: string;
  timeZone: string;
}) {
  const day = bookings.useDay({ date, timeZone });
  const [classId, setClassId] = useState<string | null>(null);
  if (classId) {
    return <ClassRoster bookings={bookings} classId={classId} onBack={() => setClassId(null)} />;
  }
  return (
    <Screen title="Today's classes">
      {day.isPending ? <Text accessibilityRole="progressbar">Loading the classes…</Text> : null}
      {day.error ? <Text accessibilityRole="alert">We could not load today's classes.</Text> : null}
      {day.data ? (
        <List empty="No classes today.">
          {day.data.classes.map((klass) => (
            <Row
              key={klass.id}
              title={klass.title ?? "Class"}
              detail={[
                classTime(klass),
                klass.room,
                `${klass.booked} booked of ${klass.places ?? "unlimited"}`,
                klass.state === "cancelled" ? "Cancelled" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              onPress={() => setClassId(klass.id)}
            />
          ))}
        </List>
      ) : null}
    </Screen>
  );
}

function ClassRoster({
  bookings,
  classId,
  onBack,
}: {
  bookings: Pick<Hooks, "useRoster" | "useMarkAttended" | "useUndoAttended" | "useMarkNoShow">;
  classId: string;
  onBack: () => void;
}) {
  const list = bookings.useRoster({ classId });
  const tick = bookings.useMarkAttended();
  const untick = bookings.useUndoAttended();
  const noShow = bookings.useMarkNoShow();
  const [message, setMessage] = useState<string | null>(null);
  const say = async (done: Promise<MarkResult>) => {
    setMessage(null);
    try {
      setMessage((await done).message);
    } catch {
      setMessage("That did not work. Try again.");
    }
    await list.refetch?.();
  };
  const busy = tick.isPending || untick.isPending || noShow.isPending;
  return (
    <Screen title={list.data?.class.title ?? "Class list"}>
      <Button label="Back to today's classes" quiet onPress={onBack} />
      {list.isPending ? <Text accessibilityRole="progressbar">Loading the list…</Text> : null}
      {list.error ? <Text accessibilityRole="alert">We could not load the list.</Text> : null}
      {message ? <Text accessibilityRole="alert">{message}</Text> : null}
      {list.data ? (
        <View>
          <Text>
            {classTime(list.data.class)} · {list.data.class.booked} booked of{" "}
            {list.data.class.places ?? "unlimited"}
          </Text>
          <List empty="Nobody is booked yet.">
            {list.data.bookings
              // Cancelled and moved bookings are not on the list a coach ticks.
              .filter((b) => b.state && b.state in STATE_LABEL)
              .map((booking) => {
                const name = booking.person?.name ?? "No name";
                return (
                  <View key={booking.id}>
                    <Row
                      title={name}
                      detail={`${STATE_LABEL[booking.state ?? ""]}${booking.markedBy ? ` (${booking.markedBy})` : ""}${booking.healthNote ? " · Health note" : ""}`}
                    />
                    {booking.state === "booked" || booking.state === "no_show" ? (
                      <Button
                        label={`Tick ${name}`}
                        busy={busy}
                        onPress={() => say(tick.mutateAsync({ bookingId: booking.id }))}
                      />
                    ) : null}
                    {booking.state === "booked" ? (
                      <Button
                        label={`${name} did not come`}
                        quiet
                        busy={busy}
                        onPress={() => say(noShow.mutateAsync({ bookingId: booking.id }))}
                      />
                    ) : null}
                    {booking.state === "attended" ? (
                      <Button
                        label={`Untick ${name}`}
                        quiet
                        busy={busy}
                        onPress={() => say(untick.mutateAsync({ bookingId: booking.id }))}
                      />
                    ) : null}
                  </View>
                );
              })}
          </List>
        </View>
      ) : null}
    </Screen>
  );
}
