// The timetable in the gym's app (stage 31a, decision 9): book and cancel with the membership or
// pass a member already holds. Nothing is bought here: a member with nothing to spend is told so
// by the host, and buys on the website. Whether booking is open, the places left and whether a
// cancel is in time are the host's answers, shown as they come.
import type { BookingsHooks, TimetableClass } from "@composable-os/pack-bookings/client";
import {
  bookingFor,
  classTime,
  placesLabel,
  refusalMessage,
} from "@composable-os/pack-bookings/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

type Hooks = Pick<BookingsHooks, "useTimetable" | "useMyBookings" | "useBook" | "useCancel">;

export function TimetableScreen({ bookings }: { bookings: Hooks }) {
  const timetable = bookings.useTimetable({});
  const mine = bookings.useMyBookings({});
  const [message, setMessage] = useState<string | null>(null);
  const done = (text: string) => {
    setMessage(text);
    timetable.refetch?.();
    mine.refetch?.();
  };
  return (
    <Screen title="Timetable">
      {message ? <Text accessibilityRole="alert">{message}</Text> : null}
      {timetable.isPending ? (
        <Text accessibilityRole="progressbar">Loading the timetable…</Text>
      ) : null}
      {timetable.error ? (
        <Text accessibilityRole="alert">We could not load the timetable.</Text>
      ) : null}
      {timetable.data ? (
        <List empty="No classes in these days.">
          {timetable.data.classes.map((klass) => (
            <ClassItem
              key={klass.id}
              klass={klass}
              booking={bookingFor(klass.id, mine.data?.bookings)}
              bookings={bookings}
              onDone={done}
            />
          ))}
        </List>
      ) : null}
    </Screen>
  );
}

function ClassItem({
  klass,
  booking,
  bookings,
  onDone,
}: {
  klass: TimetableClass;
  booking: { id: string } | undefined;
  bookings: Pick<BookingsHooks, "useBook" | "useCancel">;
  onDone: (message: string) => void;
}) {
  const book = bookings.useBook();
  const cancel = bookings.useCancel();
  const [preview, setPreview] = useState<{
    state: "cancelled" | "late_cancelled";
    message: string;
  } | null>(null);
  const name = klass.title ?? "Class";
  return (
    <View>
      <Row
        title={name}
        detail={[classTime(klass), klass.coach?.name, placesLabel(klass.places)]
          .filter(Boolean)
          .join(" · ")}
      />
      {booking && preview ? (
        <View>
          <Text>{preview.message}</Text>
          <Button
            label="Confirm cancel"
            busy={cancel.isPending}
            onPress={async () => {
              const result = await cancel.mutateAsync({
                bookingId: booking.id,
                confirm: true,
                expect: preview.state,
              });
              setPreview(null);
              onDone(
                result.result === "refused"
                  ? refusalMessage(result, klass.timeZone)
                  : `${name}: ${result.message}`,
              );
            }}
          />
          <Button label="Keep it" quiet onPress={() => setPreview(null)} />
        </View>
      ) : booking ? (
        <Button
          label="Cancel"
          quiet
          busy={cancel.isPending}
          onPress={async () => {
            const asked = await cancel.mutateAsync({ bookingId: booking.id });
            if (asked.result === "refused") onDone(refusalMessage(asked, klass.timeZone));
            else setPreview({ state: asked.state, message: asked.message });
          }}
        />
      ) : (
        <Button
          label="Book"
          busy={book.isPending}
          onPress={async () => {
            const result = await book.mutateAsync({ classId: klass.id });
            onDone(
              result.result === "booked"
                ? `Booked: ${name}, ${classTime(klass)}.`
                : refusalMessage(result, klass.timeZone),
            );
          }}
        />
      )}
    </View>
  );
}
