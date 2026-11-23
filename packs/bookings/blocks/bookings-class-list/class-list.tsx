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
