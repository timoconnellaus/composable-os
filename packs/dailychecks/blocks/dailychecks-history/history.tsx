// How each day went (ADR 0651), for those who manage checklists: every checklist done on its own,
// day by day, done (by whom, for whom, when, and whether after its due time) or missed (with the
// steps nobody ticked). Opening a day shows its steps and who ticked each and when. Read-only: a
// finished or missed day never changes, and today's is ticked on Today's checklists.
//
// The host decides who reads this (checklists:write); anyone else is refused and sees that state.
// What someone wrote on a step is kept no longer than it is on screen (`gcTime: 0`).
import {
  addDays,
  type DailyChecksHooks,
  dateLabel,
  dayRefusal,
  dayStateLabel,
  type HistoryDay,
  stepsOf,
  tickLabel,
  timeIn,
} from "@composable-os/pack-dailychecks/client";
import { useId, useState } from "react";
import { Button } from "../ui-button/button.tsx";

export type HistoryHooks = Pick<DailyChecksHooks, "useHistory" | "useDay">;

/** Today in the browser's zone: only a starting point for the dates shown; the host decides. */
function localToday(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}

export function ChecklistHistory({
  dailychecks,
  locale = "en-AU",
  days = 14,
}: {
  dailychecks: HistoryHooks;
  locale?: string;
  /** How many days back the list starts with (at most 62). */
  days?: number;
}) {
  const id = useId();
  const [to, setTo] = useState(localToday);
  const span = Math.min(Math.max(days, 1), 62);
  const from = addDays(to, -(span - 1));
  const answer = dailychecks.useHistory({ from, to });
  const [open, setOpen] = useState<HistoryDay | null>(null);
  const data = answer.data;
  return (
    <section className="grid gap-3" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        Checklist history
      </h2>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm" htmlFor={`${id}-to`}>
          <span>Up to</span>
          <input
            id={`${id}-to`}
            type="date"
            className="rounded-md border px-2 py-1"
            value={to}
            onChange={(e) => e.target.value && setTo(e.target.value)}
          />
        </label>
        <Button type="button" variant="outline" onClick={() => setTo(addDays(to, -span))}>
          Earlier
        </Button>
      </div>
      {answer.isPending ? <p aria-busy="true">Loading how each day went…</p> : null}
      {answer.error ? (
        <p role="alert" data-refusal={dayRefusal(answer.error).kind}>
          {dayRefusal(answer.error).message}
        </p>
      ) : null}
      {data && !data.days.length ? (
        <p data-empty="history">No checklist was due in these days.</p>
      ) : null}
      {data?.days.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th scope="col">Day</th>
              <th scope="col">Checklist</th>
              <th scope="col">How it went</th>
              <th scope="col">Steps</th>
              <th scope="col">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => (
              <tr key={d.run} data-history-run={d.run} data-state={d.state}>
                <td>{dateLabel(d.date, locale)}</td>
                <td>{d.template.name}</td>
                <td>
                  {dayStateLabel(d.state)}
                  {d.state === "done" && d.finishedBy
                    ? ` by ${d.finishedBy}${d.finishedFor ? ` for ${d.finishedFor}` : ""}${
                        d.finishedAt ? ` at ${timeIn(d.finishedAt, data.zone, locale)}` : ""
                      }`
                    : ""}
                  {d.late ? (d.state === "done" ? " (after it was due)" : " (past due)") : ""}
                  {d.missed.length ? ` · Not done: ${d.missed.join("; ")}` : ""}
                  {d.notDone
                    ? ` · ${d.notDone} ${d.notDone === 1 ? "step" : "steps"} ticked not done`
                    : ""}
                  {d.onBehalf ? ` · ${d.onBehalf} ticked for someone` : ""}
                </td>
                <td>
                  {d.ticked} of {d.steps}
                </td>
                <td>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={`Open ${d.template.name} on ${dateLabel(d.date, locale)}`}
                    onClick={() => setOpen(open?.run === d.run ? null : d)}
                  >
                    {open?.run === d.run ? "Close" : "Open"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {data?.truncated ? (
        <p className="text-xs">Only the latest 500 are shown: choose fewer days.</p>
      ) : null}
      {open && data ? (
        <DayDetail hooks={dailychecks} day={open} zone={data.zone} locale={locale} />
      ) : null}
    </section>
  );
}

function DayDetail({
  hooks,
  day,
  zone,
  locale,
}: {
  hooks: HistoryHooks;
  day: HistoryDay;
  zone: string;
  locale: string;
}) {
  const answer = hooks.useDay({ template: day.template.id, date: day.date });
  const item = answer.data?.item;
  return (
    <section
      className="grid gap-2 rounded-md border p-3 text-sm"
      aria-label={`${day.template.name} on ${dateLabel(day.date, locale)}`}
      data-history-detail={day.run}
    >
      <h3 className="font-medium">
        {day.template.name}, {dateLabel(day.date, locale)}
      </h3>
      {answer.isPending ? <p aria-busy="true">Loading…</p> : null}
      {answer.error ? <p role="alert">{dayRefusal(answer.error).message}</p> : null}
      {item ? (
        <ol className="grid gap-1">
          {stepsOf(item).map((s) => (
            <li key={s.position} data-step={s.position}>
              <span className="font-medium">{s.text}</span>
              {s.tick
                ? ` · ${tickLabel(s.tick)} at ${timeIn(s.tick.at, zone, locale)}${
                    s.tick.why ? ` · Why: ${s.tick.why}` : ""
                  }${s.tick.note ? ` · Note: ${s.tick.note}` : ""}${
                    s.tick.onBehalfWhy ? ` · For them because: ${s.tick.onBehalfWhy}` : ""
                  }`
                : s.missed
                  ? " · Missed"
                  : " · Not ticked"}
            </li>
          ))}
        </ol>
      ) : null}
      {item?.run?.closedWhy ? (
        <p className="text-xs">Finished for them because: {item.run.closedWhy}</p>
      ) : null}
    </section>
  );
}
