// The roster week (stage 45 step 7): a week grid, days across on a wide screen and one under
// another on a phone, each day's shifts in order of start with the kind of work, the place and who
// is on it; shifts with nobody on them marked, my own highlighted, an open offer shown. For the
// team it is read only. For someone who rosters (the host's `me.rosters`, never guessed here) each
// shift opens the assign panel beside it, and the roster carries each shift's warnings, which the
// host gives to rosterers only.
//
// Times are the host's: each shift's start and end are shown in the business's zone (the roster's
// `zone`), never the device's, and each day's length comes from the host's `days` (a clock-change
// day says so). Nothing here works out who may be on a shift: the assign panel shows the host's
// answer. Room is left for the checklist on a duty shift (step 4b) in `shiftExtra`.
import {
  addDays,
  clockChange,
  dayLabel,
  personOn,
  type RosteringHooks,
  type RosterShift,
  rosterRefusal,
  shiftName,
  shiftsByDay,
  shiftTime,
  warningLabel,
  weekOf,
} from "@composable-os/pack-rostering/client";
import { type ReactNode, useId, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Assign, type AssignHooks } from "./assign.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "useWeek"> & Partial<AssignHooks>;

/** A stable colour per kind of work (display only): the same kind is always the same colour. */
const COLOURS = [
  "border-l-sky-600",
  "border-l-emerald-600",
  "border-l-amber-600",
  "border-l-violet-600",
  "border-l-rose-600",
  "border-l-teal-600",
  "border-l-orange-600",
  "border-l-indigo-600",
];
function colourOf(shift: RosterShift): string {
  const key = shift.kind?.id ?? shift.object;
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return COLOURS[h % COLOURS.length] as string;
}

export function RosterWeek({
  rostering,
  from,
  locale = "en-AU",
  shiftExtra,
}: {
  rostering: Hooks;
  /** The Monday (or any date) to open on; the week of today in the business's zone by default. */
  from?: string;
  locale?: string;
  /** Something to show under a shift (the checklist of a duty shift, once step 4b is built). */
  shiftExtra?: (shift: RosterShift) => ReactNode;
}) {
  const me = rostering.useMe();
  const [start, setStart] = useState<string | null>(from ? weekOf(from) : null);
  const first = start ?? (me.data ? weekOf(me.data.today) : null);
  const week = rostering.useWeek(
    { from: first ?? "", to: first ? addDays(first, 6) : "" },
    first !== null,
  );
  const [open, setOpen] = useState<RosterShift | null>(null);
  const headingId = useId();
  if (me.isPending) return <p aria-busy="true">Loading the roster…</p>;
  if (me.error || !me.data) {
    return <p role="alert">{rosterRefusal(me.error).message}</p>;
  }
  const today = me.data.today;
  const rosters = me.data.rosters && Boolean(rostering.useCandidates && rostering.useAssign);
  const zone = week.data?.zone ?? me.data.zone;
  const go = (date: string) => {
    setOpen(null);
    setStart(weekOf(date));
  };
  return (
    <section className="grid gap-4" aria-labelledby={headingId}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-medium">
          Roster{first ? `: week of ${dayLabel(first, locale, true)}` : ""}
        </h2>
        <nav aria-label="Weeks" className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => first && go(addDays(first, -7))}
            aria-label="Previous week"
          >
            ‹ Previous
          </Button>
          <Button type="button" variant="outline" onClick={() => go(today)}>
            This week
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => first && go(addDays(first, 7))}
            aria-label="Next week"
          >
            Next ›
          </Button>
        </nav>
      </header>
      <p className="text-sm text-muted-foreground">
        Times are in {zone}.{rosters ? " Choose a shift to put someone on it." : ""}
      </p>
      {week.isPending ? <p aria-busy="true">Loading the week…</p> : null}
      {week.error ? <p role="alert">{rosterRefusal(week.error).message}</p> : null}
      {week.data?.truncated ? (
        <p role="status" className="rounded-md border p-2 text-sm">
          This week has more shifts than one screen shows: the first ones are shown.
        </p>
      ) : null}
      {week.data ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_minmax(18rem,22rem)]">
          <ol className="grid grid-cols-1 gap-3 md:grid-cols-7" aria-label="Days of the week">
            {shiftsByDay(week.data).map(({ day, shifts }) => {
              const change = clockChange(day);
              return (
                <li
                  key={day.date}
                  className="min-w-0 rounded-md border p-2"
                  data-date={day.date}
                  data-today={day.date === today ? "true" : undefined}
                >
                  <h3 className="text-sm font-medium">
                    {dayLabel(day.date, locale)}
                    {day.date === today ? " (today)" : ""}
                  </h3>
                  {change ? (
                    <p className="text-xs text-muted-foreground" data-testid="clock-change">
                      {change}
                    </p>
                  ) : null}
                  {shifts.length ? (
                    <ul
                      className="mt-2 grid gap-2"
                      aria-label={`Shifts on ${dayLabel(day.date, locale, true)}`}
                    >
                      {shifts.map((shift) => (
                        <li key={`${shift.object}:${shift.id}`}>
                          <ShiftCard
                            shift={shift}
                            zone={zone}
                            locale={locale}
                            selected={open?.id === shift.id}
                            onOpen={rosters ? () => setOpen(shift) : undefined}
                          />
                          {shiftExtra?.(shift)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">No shifts</p>
                  )}
                </li>
              );
            })}
          </ol>
          {open && rosters && rostering.useCandidates && rostering.useAssign ? (
            <Assign
              rostering={rostering as AssignHooks}
              shift={open}
              zone={zone}
              today={today}
              locale={locale}
              onClose={() => setOpen(null)}
              onChanged={() => week.refetch?.()}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ShiftCard({
  shift,
  zone,
  locale,
  selected,
  onOpen,
}: {
  shift: RosterShift;
  zone: string;
  locale: string;
  selected: boolean;
  onOpen: (() => void) | undefined;
}) {
  const body = (
    <>
      <span className="block text-xs text-muted-foreground">
        {shiftTime(shift, zone, { locale })}
      </span>
      <span className="block font-medium">{shift.title}</span>
      {shift.place ? <span className="block text-xs">{shift.place}</span> : null}
      <span className={`block text-xs ${shift.uncovered ? "font-semibold" : ""}`}>
        {personOn(shift)}
      </span>
      {shift.offer ? (
        <span className="mt-1 inline-block rounded border px-1 text-xs">Offered</span>
      ) : null}
      {(shift.warnings ?? []).map((w) => (
        <span
          key={`${w.code}:${w.account ?? ""}`}
          className="mt-1 mr-1 inline-block rounded border border-destructive px-1 text-xs text-destructive"
          title={w.message}
          data-warning={w.code}
        >
          {warningLabel(w.code)}
        </span>
      ))}
    </>
  );
  const look = [
    "block w-full rounded-md border border-l-4 p-2 text-left text-sm",
    colourOf(shift),
    shift.uncovered ? "border-dashed" : "",
    shift.mine ? "bg-accent ring-2 ring-ring" : "",
    selected ? "outline outline-2 outline-ring" : "",
  ].join(" ");
  const name = shiftName(shift, zone, locale);
  if (onOpen) {
    return (
      <button
        type="button"
        className={look}
        aria-label={name}
        aria-pressed={selected}
        data-shift={shift.id}
        data-mine={shift.mine ? "true" : undefined}
        data-uncovered={shift.uncovered ? "true" : undefined}
        onClick={onOpen}
      >
        {body}
      </button>
    );
  }
  return (
    <article
      className={look}
      aria-label={name}
      data-shift={shift.id}
      data-mine={shift.mine ? "true" : undefined}
      data-uncovered={shift.uncovered ? "true" : undefined}
    >
      {body}
    </article>
  );
}
