// A class's list, for its coach (stage 31a step 7): who is booked, ticked, not come and waiting,
// and a button to tick each name. When the list opens, whether a name can be ticked, and who
// ticked it first when two coaches tick at once are the host's; this shows its answers. Nothing
// here shows what anyone paid with. "Health note" marks a yes on someone's current health form
// (stage 44, decision 18): the host gives the mark only, never the form, and only to a person.
import type { BookingsHooks, MarkResult } from "@composable-os/pack-bookings/client";
import { classTime } from "@composable-os/pack-bookings/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<BookingsHooks, "useRoster" | "useMarkAttended" | "useUndoAttended">;

/** Today's date (YYYY-MM-DD) in `timeZone`. */
const todayIn = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

/**
 * A class's list as the product's admin shows it (stage 47): on a class's page, that class's
 * list; opened from the navigation (a coach), today's classes in this browser's zone to choose
 * one from. Which classes a coach may open (today's only) is the host's: it lists no others.
 */
export function TodayClassList({
  bookings,
  classId,
}: {
  bookings: Hooks & Pick<BookingsHooks, "useDay">;
  classId?: string;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  if (classId) return <ClassList bookings={bookings} classId={classId} />;
  if (chosen) {
    return (
      <div className="grid gap-3">
        <Button type="button" variant="outline" className="w-fit" onClick={() => setChosen(null)}>
          Today's classes
        </Button>
        <ClassList bookings={bookings} classId={chosen} />
      </div>
    );
  }
  return <TodayClasses bookings={bookings} onOpen={setChosen} />;
}

function TodayClasses({
  bookings,
  onOpen,
}: {
  bookings: Pick<BookingsHooks, "useDay">;
  onOpen: (classId: string) => void;
}) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const day = bookings.useDay({ date: todayIn(timeZone), timeZone });
  if (day.isPending) return <p aria-busy="true">Loading today's classes…</p>;
  if (day.error || !day.data) return <p role="alert">We could not load today's classes.</p>;
  if (!day.data.classes.length) return <p role="status">No classes today.</p>;
  return (
    <ul className="grid gap-2" aria-label="Today's classes">
      {day.data.classes.map((klass) => (
        <li key={klass.id}>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between"
            onClick={() => onOpen(klass.id)}
          >
            <span>
              {klass.title ?? "Class"} · {classTime(klass)}
            </span>
            <span>{klass.state === "scheduled" ? `${klass.booked} booked` : klass.state}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

const STATE_LABEL: Record<string, string> = {
  booked: "Booked",
  attended: "Came",
  no_show: "Did not come",
  waiting: "Waiting",
};

export function ClassList({ bookings, classId }: { bookings: Hooks; classId: string }) {
  const list = bookings.useRoster({ classId });
  const tick = bookings.useMarkAttended();
  const untick = bookings.useUndoAttended();
  const [message, setMessage] = useState<string | null>(null);
  if (list.isPending) return <p aria-busy="true">Loading the list…</p>;
  if (list.error || !list.data) return <p role="alert">We could not load the list.</p>;
  const { class: klass } = list.data;
  // Cancelled and moved bookings are not on the list a coach ticks.
  const shown = list.data.bookings.filter((b) => b.state && b.state in STATE_LABEL);
  const say = async (done: Promise<MarkResult>) => {
    setMessage(null);
    try {
      setMessage((await done).message);
    } catch {
      setMessage("That did not work. Try again.");
    }
    await list.refetch?.();
  };
  return (
    <section className="grid gap-3" aria-label="Class list">
      <h2 className="text-lg font-medium">
        {klass.title ?? "Class"} · {classTime(klass)}
      </h2>
      <p>
        {klass.booked} booked of {klass.places ?? "unlimited"}
      </p>
      <ul className="grid gap-2">
        {shown.map((booking) => {
          const name = booking.person?.name ?? "No name";
          return (
            <li
              key={booking.id}
              className="flex items-center justify-between gap-4 rounded-md border p-2"
            >
              <span>
                {name} · {STATE_LABEL[booking.state ?? ""]}
                {booking.markedBy ? ` (${booking.markedBy})` : ""}
                {booking.healthNote ? (
                  <span className="ml-2 rounded border px-1 text-xs" data-testid="health-note">
                    Health note
                  </span>
                ) : null}
              </span>
              {booking.state === "booked" || booking.state === "no_show" ? (
                <Button
                  type="button"
                  disabled={tick.isPending}
                  onClick={() => say(tick.mutateAsync({ bookingId: booking.id }))}
                >
                  Tick {name}
                </Button>
              ) : booking.state === "attended" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={untick.isPending}
                  onClick={() => say(untick.mutateAsync({ bookingId: booking.id }))}
                >
                  Untick {name}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
