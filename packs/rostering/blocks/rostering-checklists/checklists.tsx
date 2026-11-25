// How checklists went (stage 45 step 4b, ADR 0650), for whoever rosters: every checklist run in a
// range of dates, by checklist and then by date, each with its shift, its person, whether it is
// open, done, missed or cancelled, how many steps were ticked, how many were ticked for the person
// by someone else, and the steps nobody ticked when it was missed. A closed run takes a correction:
// a note kept beside it, never a change to its ticks.
//
// The host decides who sees this: the screen asks `me` first and shows nothing but a line unless
// the host says the reader rosters, and the host refuses anyone else anyway. The runs are kept no
// longer than they are shown; a correction is sent with `forgetAfter` and kept only on screen.
import {
  addDays,
  type ChecklistRunSummary,
  checklistStateLabel,
  dateIn,
  dayLabel,
  forgetAfter,
  type RosteringHooks,
  type RosterRefusal,
  rosterRefusal,
  shiftTime,
} from "@composable-os/pack-rostering/client";
import { type FormEvent, useId, useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "useChecklistRuns" | "useChecklistCorrect">;

export function ChecklistRuns({
  rostering,
  from,
  to,
  locale = "en-AU",
}: {
  rostering: Hooks;
  /** The first date (local, YYYY-MM-DD); a week before today in the business's zone by default. */
  from?: string;
  /** The last date; today by default. */
  to?: string;
  locale?: string;
}) {
  const me = rostering.useMe();
  const today = me.data?.today ?? null;
  const [range, setRange] = useState<{ from: string; to: string } | null>(
    from && to ? { from, to } : null,
  );
  const [template, setTemplate] = useState<string>("");
  const current = range ?? (today ? { from: from ?? addDays(today, -6), to: to ?? today } : null);
  const rosters = me.data?.rosters === true;
  const runs = rostering.useChecklistRuns(
    rosters && current ? { ...current, ...(template ? { template } : {}) } : null,
  );
  const correct = rostering.useChecklistCorrect();
  const [writing, setWriting] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const id = useId();
  if (me.isPending) return <p aria-busy="true">Loading…</p>;
  if (me.error || !me.data) return <p role="alert">{rosterRefusal(me.error).message}</p>;
  if (!rosters) {
    return <p>How checklists went is shown to whoever rosters.</p>;
  }
  const zone = runs.data?.zone ?? me.data.zone;
  const list = runs.data?.runs ?? [];
  const templates = new Map<string, string>();
  for (const r of list) templates.set(r.template.id, r.template.name);
  const byTemplate = new Map<string, Map<string, ChecklistRunSummary[]>>();
  for (const r of list) {
    const dates = byTemplate.get(r.template.id) ?? new Map<string, ChecklistRunSummary[]>();
    const date = dateIn(r.opens, zone);
    dates.set(date, [...(dates.get(date) ?? []), r]);
    byTemplate.set(r.template.id, dates);
  }

  async function submit(event: FormEvent, run: string) {
    event.preventDefault();
    setRefusal(null);
    setSaid(null);
    try {
      await forgetAfter(correct, { run, text: text.trim() });
      setText("");
      setWriting(null);
      setSaid("Correction added beside it.");
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await runs.refetch?.();
  }

  return (
    <section className="grid gap-4" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="text-lg font-medium">
        How checklists went
      </h2>
      <form
        className="flex flex-wrap items-end gap-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const f = String(data.get("from") ?? "");
          const t = String(data.get("to") ?? "");
          if (f && t) setRange({ from: f, to: t });
        }}
      >
        <label className="grid gap-1" htmlFor={`${id}-from`}>
          <span>From</span>
          <input
            id={`${id}-from`}
            name="from"
            type="date"
            className="rounded-md border px-2 py-1"
            defaultValue={current?.from}
          />
        </label>
        <label className="grid gap-1" htmlFor={`${id}-to`}>
          <span>To</span>
          <input
            id={`${id}-to`}
            name="to"
            type="date"
            className="rounded-md border px-2 py-1"
            defaultValue={current?.to}
          />
        </label>
        <label className="grid gap-1" htmlFor={`${id}-tpl`}>
          <span>Checklist</span>
          <select
            id={`${id}-tpl`}
            className="rounded-md border px-2 py-1"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          >
            <option value="">Every checklist</option>
            {[...templates].map(([tid, name]) => (
              <option key={tid} value={tid}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline">
          Show
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">Times are in {zone}.</p>
      {runs.isPending ? <p aria-busy="true">Loading the checklists…</p> : null}
      {runs.error ? (
        <p role="alert" data-refusal={rosterRefusal(runs.error).kind}>
          {rosterRefusal(runs.error).message}
        </p>
      ) : null}
      {runs.data?.truncated ? (
        <p role="status">More runs than one screen shows: the first ones are shown.</p>
      ) : null}
      {said ? (
        <p role="status" className="text-sm">
          {said}
        </p>
      ) : null}
      {refusal ? (
        <p role="alert" className="text-sm" data-refusal={refusal.kind}>
          {refusal.message}
        </p>
      ) : null}
      {runs.data && !list.length ? <p>No checklists in these dates.</p> : null}
      {[...byTemplate].map(([tid, dates]) => (
        <section key={tid} className="grid gap-2" aria-label={templates.get(tid)}>
          <h3 className="font-medium">{templates.get(tid)}</h3>
          {[...dates].map(([date, items]) => (
            <div key={date} className="grid gap-1">
              <h4 className="text-sm font-medium">{dayLabel(date, locale, true)}</h4>
              <ul className="grid gap-2">
                {items.map((r) => (
                  <li
                    key={r.id}
                    className="grid gap-1 rounded-md border p-2 text-sm"
                    data-run={r.id}
                    data-state={r.state}
                    data-record={r.record}
                  >
                    <p>
                      <span className="font-medium">{r.title}</span>,{" "}
                      {shiftTime({ startsAt: r.opens, endsAt: r.closes }, zone, { locale })} ·{" "}
                      {r.name ?? "Nobody on it"} ·{" "}
                      <span data-checklist-state={r.state}>{checklistStateLabel(r.state)}</span>
                    </p>
                    <p className="text-xs">
                      {r.ticked} of {r.steps} ticked
                      {r.onBehalf ? ` · ${r.onBehalf} ticked for them by someone else` : ""}
                      {r.corrections ? ` · ${r.corrections} correction(s)` : ""}
                    </p>
                    {r.missed.length ? (
                      <p className="text-xs">Not done: {r.missed.join("; ")}</p>
                    ) : null}
                    {r.state !== "open" ? (
                      writing === r.id ? (
                        <form className="grid gap-1" onSubmit={(e) => submit(e, r.id)}>
                          <label className="grid gap-1" htmlFor={`${id}-c-${r.id}`}>
                            <span className="text-xs">Correction</span>
                            <input
                              id={`${id}-c-${r.id}`}
                              className="rounded-md border px-2 py-1"
                              value={text}
                              maxLength={1000}
                              autoComplete="off"
                              onChange={(e) => setText(e.target.value)}
                            />
                          </label>
                          <div className="flex gap-2">
                            <Button
                              type="submit"
                              disabled={correct.isPending || !text.trim()}
                              aria-busy={correct.isPending}
                            >
                              Add correction
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => {
                                setWriting(null);
                                setText("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={`Add a correction to the checklist of ${r.title}`}
                          onClick={() => {
                            setWriting(r.id);
                            setText("");
                          }}
                        >
                          Add a correction
                        </Button>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </section>
  );
}
