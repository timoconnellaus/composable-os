// The front desk, for staff (stage 31a): one day's classes, and booking someone into one, a
// member on file or a walk-in. Staff are not bound by the booking windows or by "booked by staff
// only"; a class that was cancelled or is over, the places, one booking per person per class,
// what a booking spends and whether a walk-in is already on file are the host's, and this shows
// its answers.
import type { BookForResult, BookingsHooks } from "@composable-os/pack-bookings/client";
import { classTime, todayIn } from "@composable-os/pack-bookings/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

type Hooks = Pick<BookingsHooks, "useDay" | "useBookFor" | "useFindPeople">;

/**
 * The front desk as the product's admin shows it (stage 47): today in the desk's own zone (the
 * browser's), with a day to choose. The admin passes it nothing but the hooks.
 */
export function FrontDesk({ bookings }: { bookings: Hooks }) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [date, setDate] = useState(() => todayIn(timeZone));
  return (
    <div className="grid gap-4">
      <div className="grid max-w-xs gap-1">
        <Label htmlFor="desk-date">Day</Label>
        <Input
          id="desk-date"
          type="date"
          value={date}
          onChange={(event) => {
            if (event.target.value) setDate(event.target.value);
          }}
        />
      </div>
      <Desk bookings={bookings} date={date} timeZone={timeZone} />
    </div>
  );
}

export function Desk({
  bookings,
  date,
  timeZone,
}: {
  bookings: Hooks;
  /** The local date shown, YYYY-MM-DD. */
  date: string;
  /** The gym's zone, e.g. Australia/Sydney. */
  timeZone: string;
}) {
  const day = bookings.useDay({ date, timeZone });
  const bookFor = bookings.useBookFor();
  const [classId, setClassId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [personId, setPersonId] = useState<string | null>(null);
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [paidAtDesk, setPaidAtDesk] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [matches, setMatches] = useState<
    NonNullable<Extract<BookForResult, { result: "refused" }>["people"]>
  >([]);
  const found = bookings.useFindPeople({ query });
  if (day.isPending) return <p aria-busy="true">Loading the day…</p>;
  if (day.error || !day.data) return <p role="alert">We could not load the day.</p>;
  // Only a scheduled class can be booked; the host refuses the others anyway.
  const open = day.data.classes.filter((klass) => klass.state === "scheduled");
  const submit = async (confirmNew = false, chosen = personId) => {
    setMessage(null);
    try {
      const done = await bookFor.mutateAsync({
        classId,
        ...(chosen
          ? { personId: chosen }
          : { newPerson: { givenName, ...(familyName ? { familyName } : {}) }, confirmNew }),
        paidAtDesk,
      });
      if (done.result === "booked") {
        setMessage("Booked in.");
        setMatches([]);
        setGivenName("");
        setFamilyName("");
        setPersonId(null);
        setQuery("");
        return;
      }
      if (done.result === "waiting") {
        setMessage(done.message);
        return;
      }
      setMatches(done.people ?? []);
      setMessage(done.message);
    } catch {
      setMessage("That did not work. Try again, or check the class and the person.");
    }
  };
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
        aria-label="Book someone in"
        onSubmit={async (event) => {
          event.preventDefault();
          await submit();
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
          {open.map((klass) => (
            <option key={klass.id} value={klass.id}>
              {klass.title ?? "Class"} · {classTime(klass)}
            </option>
          ))}
        </select>
        <Label htmlFor="desk-find">Find someone on file</Label>
        <Input
          id="desk-find"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPersonId(null);
          }}
        />
        {found.data?.people.length ? (
          <ul className="grid gap-1" aria-label="People on file">
            {found.data.people.map((person) => (
              <li key={person.id}>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="desk-person"
                    checked={personId === person.id}
                    onChange={() => setPersonId(person.id)}
                  />
                  {person.name ?? "No name"}
                  {person.email ? ` · ${person.email}` : ""}
                </label>
              </li>
            ))}
          </ul>
        ) : null}
        {personId ? null : (
          <>
            <Label htmlFor="desk-given">Given name (a walk-in)</Label>
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
          </>
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={paidAtDesk}
            onChange={(event) => setPaidAtDesk(event.target.checked)}
          />
          Paid at the desk (spends no membership or pass)
        </label>
        <Button type="submit" disabled={bookFor.isPending || !classId}>
          {personId ? "Book them in" : "Book walk-in"}
        </Button>
        {message ? <p role="status">{message}</p> : null}
        {matches.length ? (
          <section className="grid gap-2" aria-label="Already on file">
            {matches.map((person) => (
              <Button
                key={person.id}
                variant="outline"
                type="button"
                onClick={() => submit(false, person.id)}
              >
                Book {person.name}
              </Button>
            ))}
            <Button variant="ghost" type="button" onClick={() => submit(true, null)}>
              Someone new: book anyway
            </Button>
          </section>
        ) : null}
      </form>
    </section>
  );
}
