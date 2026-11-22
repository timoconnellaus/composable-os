// The front desk, for staff (stage 31a): one day's classes, and booking someone into one, a
// walk-in included. Staff are not bound by the booking windows or by "booked by staff only"; the
// places, one booking per person per class and what a booking spends are still the host's, and
// this shows its answer.
import type { BookingsHooks } from "@composable-os/pack-bookings/client";
import { classTime } from "@composable-os/pack-bookings/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

export function Desk({
  bookings,
  date,
  timeZone,
}: {
  bookings: Pick<BookingsHooks, "useDay" | "useBookFor">;
  /** The local date shown, YYYY-MM-DD. */
  date: string;
  /** The gym's zone, e.g. Australia/Sydney. */
  timeZone: string;
}) {
  const day = bookings.useDay({ date, timeZone });
  const bookFor = bookings.useBookFor();
  const [classId, setClassId] = useState<string>("");
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [paidAtDesk, setPaidAtDesk] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  if (day.isPending) return <p aria-busy="true">Loading the day…</p>;
  if (day.error || !day.data) return <p role="alert">We could not load the day.</p>;
  return (
    <section className="grid gap-4" aria-label="Front desk">
      <ul className="grid gap-2">
        {day.data.classes.map((klass) => (
          <li key={klass.id} className="flex justify-between gap-4 rounded-md border p-2">
            <span>
              {klass.title ?? "Class"} · {classTime(klass)}
              {klass.staffOnly ? " · booked by staff" : ""}
            </span>
            <span>
              {klass.booked} booked{klass.state === "scheduled" ? "" : ` · ${klass.state}`}
            </span>
          </li>
        ))}
      </ul>
      <form
        className="grid gap-3"
        aria-label="Book a walk-in"
        onSubmit={async (event) => {
          event.preventDefault();
          const done = await bookFor.mutateAsync({
            classId,
            newPerson: { givenName, ...(familyName ? { familyName } : {}) },
            paidAtDesk,
          });
          setMessage(
            done.result === "booked" ? `Booked ${givenName} in.` : done.message,
          );
          if (done.result === "booked") {
            setGivenName("");
            setFamilyName("");
          }
        }}
      >
        <Label htmlFor="desk-class">Class</Label>
        <select
          id="desk-class"
          value={classId}
          onChange={(event) => setClassId(event.target.value)}
          required
        >
          <option value="">Choose a class</option>
          {day.data.classes.map((klass) => (
            <option key={klass.id} value={klass.id}>
              {klass.title ?? "Class"} · {classTime(klass)}
            </option>
          ))}
        </select>
        <Label htmlFor="desk-given">Given name</Label>
        <Input
          id="desk-given"
          value={givenName}
          onChange={(event) => setGivenName(event.target.value)}
          required
        />
        <Label htmlFor="desk-family">Family name</Label>
        <Input
          id="desk-family"
          value={familyName}
          onChange={(event) => setFamilyName(event.target.value)}
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={paidAtDesk}
            onChange={(event) => setPaidAtDesk(event.target.checked)}
          />
          Paid at the desk (spends no membership or pass)
        </label>
        <Button type="submit" disabled={bookFor.isPending || !classId}>
          Book walk-in
        </Button>
        {message ? <p role="status">{message}</p> : null}
      </form>
    </section>
  );
}
