// My hours (stage 45, the owner's decision of 2026-11-24), a part of My shifts: my own hours and
// shifts for a pay period, as payroll is given them. Hours and counts only: no money anywhere.
//
// Everything is the host's answer: which periods there are (the current one and twelve before
// it), whether I am counted for pay and how, my totals per kind of work and each of my shifts with
// its minutes (a locked period's locked figures, or a preview of an open one), and each refusal.
// Nothing about anyone else, and not why a shift was marked not worked (whoever rosters keeps
// that), only that it was. The figures are fetched only when I pick a period, are kept in the
// app's cache no longer than they are shown (`gcTime: 0`), are hidden when the page is left (and
// read again when the browser brings it back), and are never put in an address or stored. It
// announces nothing on its own (no live region): it sits under My shifts, whose own messages do.
import {
  basisLabel,
  dayLabel,
  type MyPayPeriod,
  payPeriodState,
  type RosteringHooks,
  refusalNext,
  rosterRefusal,
} from "@composable-os/pack-rostering/client";
import { useEffect, useId, useRef, useState } from "react";

export type MyHoursHooks = Pick<RosteringHooks, "useMyPayPeriods" | "useMyPay">;

/** Hides what is shown when the page is left; shows it again only once read again. */
function useForgetOnLeave(forget: () => void, cameBack: () => void): void {
  const latest = useRef({ forget, cameBack });
  latest.current = { forget, cameBack };
  useEffect(() => {
    const hide = () => latest.current.forget();
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      latest.current.forget();
      latest.current.cameBack();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, []);
}

export function MyHours({
  rostering,
  locale = "en-AU",
}: {
  rostering: MyHoursHooks;
  locale?: string;
}) {
  const [hidden, setHidden] = useState(false);
  const periods = rostering.useMyPayPeriods(!hidden);
  const [chosen, setChosen] = useState<string | null>(null);
  const headingId = useId();
  useForgetOnLeave(
    () => {
      setHidden(true);
      setChosen(null);
    },
    () => setHidden(false),
  );
  const period = periods.data?.periods.find((p) => p.start === chosen) ?? null;
  return (
    <section className="grid gap-3" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-base font-medium">
        My hours
      </h3>
      <p className="text-sm text-muted-foreground">
        Your own hours and shifts for each pay period, as payroll is given them. Only you see this
        here.
      </p>
      {hidden || periods.isPending ? <p aria-busy="true">Loading the pay periods…</p> : null}
      {!hidden && periods.error ? (
        <PeriodsRefusal error={periods.error} onRetry={() => periods.refetch?.()} />
      ) : null}
      {!hidden && periods.data && !periods.data.set ? (
        <p data-refusal="pay_period_unset">
          Pay periods are not set up yet, so there are no hours to show.
        </p>
      ) : null}
      {!hidden && periods.data?.set ? (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Pay periods">
          {periods.data.periods.map((p) => (
            <li key={p.start}>
              <button
                type="button"
                className="block w-full rounded-md border p-2 text-left text-sm"
                aria-pressed={chosen === p.start}
                data-start={p.start}
                aria-label={`${dayLabel(p.start, locale)} to ${dayLabel(p.end, locale)}, ${payPeriodState(p)}`}
                onClick={() => setChosen(chosen === p.start ? null : p.start)}
              >
                <span className="block font-medium">
                  {dayLabel(p.start, locale)} – {dayLabel(p.end, locale)}
                </span>
                <span className="block text-xs">{payPeriodState(p)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!hidden && period ? (
        <PeriodHours key={period.start} rostering={rostering} period={period} locale={locale} />
      ) : null}
    </section>
  );
}

function PeriodsRefusal({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const refusal = rosterRefusal(error);
  return (
    <div role="alert" className="grid gap-1 text-sm" data-refusal={refusal.kind}>
      <p>
        {refusal.kind === "human_only"
          ? "Your hours are shown to you only, at the screen."
          : refusal.message}
      </p>
      {refusal.kind === "network" || refusal.kind === "other" ? (
        <p>
          <button type="button" className="underline" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : null}
    </div>
  );
}

function PeriodHours({
  rostering,
  period,
  locale,
}: {
  rostering: Pick<RosteringHooks, "useMyPay">;
  period: MyPayPeriod;
  locale: string;
}) {
  const mine = rostering.useMyPay({ start: period.start });
  const id = useId();
  const data = mine.data;
  const refusal = mine.error ? rosterRefusal(mine.error) : null;
  return (
    <section
      className="grid gap-3 rounded-md border p-3"
      aria-labelledby={`${id}-h`}
      aria-busy={mine.isPending}
    >
      <h4 id={`${id}-h`} className="font-medium">
        {dayLabel(period.start, locale, true)} to {dayLabel(period.end, locale, true)}
      </h4>
      {mine.isPending ? <p aria-busy="true">Loading your hours…</p> : null}
      {refusal ? (
        <div role="alert" className="text-sm" data-refusal={refusal.kind}>
          <p>{refusal.message}</p>
          {refusalNext(refusal.kind, false) ? <p>{refusalNext(refusal.kind, false)}</p> : null}
          {refusal.kind === "network" || refusal.kind === "other" ? (
            <p>
              <button type="button" className="underline" onClick={() => mine.refetch?.()}>
                Try again
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
      {data && !data.counted ? (
        <p data-state="not-counted">
          You are not counted for pay in this period, so there are no hours to show. If you think
          you should be, ask whoever handles pay.
        </p>
      ) : null}
      {data?.counted ? (
        <>
          <p className="text-sm" data-state={data.period.preview ? "preview" : "locked"}>
            {data.period.preview
              ? "A preview from the roster as it stands: it can change until the period is locked."
              : `Locked: these are the figures payroll was given${data.period.version && data.period.version > 1 ? ` (version ${data.period.version})` : ""}.`}
          </p>
          <p className="text-sm">Counted: {basisLabel(data.basis)}</p>
          {data.totals.length ? (
            <div className="max-w-full overflow-x-auto">
              <table className="text-sm" aria-label="My hours and shifts">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className="p-1">
                      Kind of work
                    </th>
                    <th scope="col" className="p-1">
                      Shifts
                    </th>
                    <th scope="col" className="p-1">
                      Hours
                    </th>
                    <th scope="col" className="p-1">
                      Not worked
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.totals.map((t) => (
                    <tr key={`${t.basis}:${t.kind?.id ?? t.kindName}`} className="border-t">
                      <th scope="row" className="p-1 text-left font-normal">
                        {t.kindName}
                      </th>
                      <td className="p-1">{t.shifts}</td>
                      <td className="p-1">{t.hours}</td>
                      <td className="p-1">{t.notWorked}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm">You have no counted shifts in this period.</p>
          )}
          <p className="text-sm font-medium">All my hours: {data.hours}</p>
          {data.lines.length ? (
            <details>
              <summary className="cursor-pointer text-sm">Each of my shifts</summary>
              <ul className="grid gap-1 text-sm">
                {data.lines.map((l) => (
                  <li
                    key={`${l.object}:${l.id}`}
                    className="border-t pt-1"
                    data-not-worked={l.notWorked ? "true" : undefined}
                  >
                    <span className="font-medium">{l.title}</span>, {dayLabel(l.localDate, locale)}{" "}
                    {l.localStart.slice(11, 16)}–{l.localEnd.slice(11, 16)}
                    {l.place ? ` · ${l.place}` : ""}
                    {" · "}
                    {l.notWorked
                      ? "Marked not worked: counts for nothing. Ask whoever rosters why."
                      : `${l.countedMinutes} minutes${l.beforeMinutes || l.afterMinutes ? ` (with ${l.beforeMinutes + l.afterMinutes} minutes of set-up and pack-down)` : ""}`}
                    {l.clockChange ? <span className="block text-xs">{l.clockChange}</span> : null}
                    {l.flagged ? (
                      <span className="block text-xs">
                        Its list was taken by someone else: whoever handles pay checks it.
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
