// The timetable for a gym's site (stage 31a): the week's classes, and for a signed-in member a
// Book or Cancel button on each. Whether booking is open, whether the gym books a class, the places
// left, whether a cancel is in time and what it spends are the host's: this shows its answers.
import type { BookingsHooks, TimetableClass } from "@composable-os/pack-bookings/client";
import {
  bookingFor,
  classTime,
  placesLabel,
  refusalMessage,
} from "@composable-os/pack-bookings/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<BookingsHooks, "useTimetable" | "useMyBookings" | "useBook" | "useCancel">;

export function Timetable({
  bookings,
  from,
  to,
}: {
  bookings: Hooks;
  /** The first moment shown (ISO 8601); the host's default is now. */
  from?: string;
  to?: string;
}) {
  const timetable = bookings.useTimetable({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
  const mine = bookings.useMyBookings({});
  const [message, setMessage] = useState<string | null>(null);
  if (timetable.isPending) return <p aria-busy="true">Loading the timetable…</p>;
  if (timetable.error || !timetable.data) {
    return <p role="alert">We could not load the timetable. Try again soon.</p>;
  }
  const refresh = () => {
    timetable.refetch?.();
    mine.refetch?.();
  };
  return (
    <section className="grid gap-4" aria-label="Timetable">
      {message ? <p role="status">{message}</p> : null}
      {timetable.data.classes.length === 0 ? <p>No classes in these days.</p> : null}
      <ul className="grid gap-2">
        {timetable.data.classes.map((klass) => (
          <ClassRow
            key={klass.id}
            klass={klass}
            booking={bookingFor(klass.id, mine.data?.bookings)}
            bookings={bookings}
            onDone={(text) => {
              setMessage(text);
              refresh();
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function ClassRow({
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
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
      <div className="grid gap-1">
        <strong>{name}</strong>
        <span>{classTime(klass)}</span>
        <span className="text-muted-foreground text-sm">
          {[klass.coach?.name, klass.room?.name, placesLabel(klass.places)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {booking ? (
        preview ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>{preview.message}</span>
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={async () => {
                const done = await cancel.mutateAsync({
                  bookingId: booking.id,
                  confirm: true,
                  expect: preview.state,
                });
                setPreview(null);
                onDone(
                  done.result === "refused"
                    ? refusalMessage(done, klass.timeZone)
                    : `${name}: ${done.message}`,
                );
              }}
            >
              Confirm cancel
            </Button>
            <Button variant="outline" onClick={() => setPreview(null)}>
              Keep it
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            disabled={cancel.isPending}
            onClick={async () => {
              const asked = await cancel.mutateAsync({ bookingId: booking.id });
              if (asked.result === "refused") onDone(refusalMessage(asked, klass.timeZone));
              else setPreview({ state: asked.state, message: asked.message });
            }}
          >
            Cancel {name}
          </Button>
        )
      ) : (
        <Button
          disabled={book.isPending}
          onClick={async () => {
            const done = await book.mutateAsync({ classId: klass.id });
            onDone(
              done.result === "booked"
                ? `Booked: ${name}, ${classTime(klass)}.`
                : refusalMessage(done, klass.timeZone),
            );
          }}
        >
          Book {name}
        </Button>
      )}
    </li>
  );
}
