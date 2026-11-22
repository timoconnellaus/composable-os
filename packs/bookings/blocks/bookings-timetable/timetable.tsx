// The timetable for a gym's site (stage 31a): the week's classes, and for a signed-in member a
// Book or Cancel button on each. A parent the gym linked to a child picks who they are booking
// for (ADR 0540); the child's own membership or pass pays. Whether booking is open, whether the gym books a class, the places
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

type Hooks = Pick<
  BookingsHooks,
  "useTimetable" | "useMyBookings" | "useBook" | "useCancel" | "useFamily"
>;

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
  const family = bookings.useFamily();
  const people = family.data?.people ?? [];
  // Whose bookings are shown and made: the member's own unless they pick a child.
  const [personId, setPersonId] = useState<string | null>(null);
  const chosen = people.find((p) => p.personId === personId && !p.self);
  const mine = bookings.useMyBookings(chosen ? { personId: chosen.personId } : {});
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
      {people.length > 1 ? (
        <label className="grid gap-1 text-sm">
          Booking for
          <select
            className="rounded-md border p-2"
            value={chosen?.personId ?? ""}
            onChange={(event) => {
              setPersonId(event.target.value || null);
              setMessage(null);
            }}
          >
            {people.map((person) => (
              <option key={person.personId} value={person.self ? "" : person.personId}>
                {person.self ? "Me" : person.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {timetable.data.classes.length === 0 ? <p>No classes in these days.</p> : null}
      <ul className="grid gap-2">
        {timetable.data.classes.map((klass) => (
          <ClassRow
            key={klass.id}
            klass={klass}
            booking={bookingFor(klass.id, mine.data?.bookings)}
            forPerson={chosen ? { id: chosen.personId, name: chosen.name } : null}
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
  forPerson,
  bookings,
  onDone,
}: {
  klass: TimetableClass;
  booking: { id: string } | undefined;
  /** A child the member is booking for, or null for themselves. */
  forPerson: { id: string; name: string } | null;
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
            const done = await book.mutateAsync({
              classId: klass.id,
              ...(forPerson ? { forPersonId: forPerson.id } : {}),
            });
            onDone(
              done.result === "booked"
                ? `Booked${forPerson ? ` for ${forPerson.name}` : ""}: ${name}, ${classTime(klass)}.`
                : done.result === "waiting"
                  ? `${name}: ${done.message}`
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
