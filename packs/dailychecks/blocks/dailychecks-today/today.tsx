// Today's checklists (ADR 0651): the checklists done on their own (opening, closing, cleaning) that
// are due today and that the viewer may do, each with when it is due by and its steps. Anyone who
// may do one ticks its steps (done, with a note where the step asks; not done, with why); whoever
// ticks the last step finishes it, and a finished one never changes. Someone who manages checklists
// sees every one and may tick for someone who may do it, saying why: kept, and shown, as ticked by
// them for that person.
//
// The host decides everything here: what is due, who may do it (`mayDo`, `canTick`), who may tick
// for whom, whether a step needs a note, when it is finished. This shows its answer and refusals.
//
// What someone writes on a step, why it was not done and why it was ticked for someone are
// private: kept only in this screen's state, sent with `forgetAfter` (never in a URL, storage or a
// query's key), cleared when the page is left, and read again when the browser brings it back.
import {
  type DailyChecksHooks,
  type DayItem,
  type DayRefusal,
  dayRefusal,
  dayStateLabel,
  finishedLabel,
  forgetAfter,
  stepsOf,
  tickLabel,
  timeIn,
} from "@composable-os/pack-dailychecks/client";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui-button/button.tsx";

export type TodayHooks = Pick<DailyChecksHooks, "useToday" | "useDay" | "useTick" | "useDone">;

interface Draft {
  note: string;
  why: string;
  /** Asking for why it was not done. */
  notDone: boolean;
}
const EMPTY: Draft = { note: "", why: "", notDone: false };

/** Forgets what was typed when the page is left, or brought back from the back-forward cache. */
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

export function TodaysChecklists({
  dailychecks,
  locale = "en-AU",
}: {
  dailychecks: TodayHooks;
  locale?: string;
}) {
  const answer = dailychecks.useToday();
  const [hidden, setHidden] = useState(false);
  const [epoch, setEpoch] = useState(0);
  useForgetOnLeave(
    () => {
      setHidden(true);
      setEpoch((e) => e + 1);
    },
    () => void Promise.resolve(answer.refetch?.()).then(() => setHidden(false)),
  );
  const data = hidden ? undefined : answer.data;
  return (
    <section className="grid gap-3" aria-label="Today's checklists">
      <h2 className="text-lg font-semibold">Today's checklists</h2>
      {answer.isPending || hidden ? <p aria-busy="true">Loading today's checklists…</p> : null}
      {answer.error ? (
        <p role="alert" data-refusal={dayRefusal(answer.error).kind}>
          {dayRefusal(answer.error).message}
        </p>
      ) : null}
      {data && !data.items.length ? <p data-empty="today">Nothing is due for you today.</p> : null}
      {data?.items.map((item) => (
        <DayChecklist
          key={`${item.template.id}:${epoch}`}
          hooks={dailychecks}
          item={item}
          zone={data.zone}
          you={data.you}
          youManage={data.youManage}
          locale={locale}
          refetch={() => answer.refetch?.()}
        />
      ))}
    </section>
  );
}

function DayChecklist({
  hooks,
  item,
  zone,
  you,
  youManage,
  locale,
  refetch,
}: {
  hooks: TodayHooks;
  item: DayItem;
  zone: string;
  you: string;
  youManage: boolean;
  locale: string;
  refetch: () => unknown;
}) {
  const id = useId();
  const tick = hooks.useTick();
  const done = hooks.useDone();
  // Someone who manages checklists ticks for someone who may do it: whom, from the host.
  const detail = hooks.useDay(
    youManage && item.canTick ? { template: item.template.id, date: item.date } : null,
  );
  const [forWhom, setForWhom] = useState<string>(item.mayDo ? you : "");
  const [forWhy, setForWhy] = useState("");
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [refusal, setRefusal] = useState<{ step: number | null; refusal: DayRefusal } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const busy = tick.isPending || done.isPending;
  const steps = stepsOf(item);
  const draftOf = (p: number) => drafts[p] ?? EMPTY;
  const setDraft = (p: number, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [p]: { ...(d[p] ?? EMPTY), ...patch } }));
  const forOther = forWhom !== "" && forWhom !== you;
  const forInput = forOther
    ? { for: forWhom, ...(forWhy.trim() ? { forWhy: forWhy.trim() } : {}) }
    : {};
  // Someone else's tick is changed only by whoever manages checklists (the host refuses it).
  const mayChange = (step: { tick: { by: string } | null }) =>
    !step.tick || step.tick.by === you || youManage;
  const requiredLeft = steps.some((s) => s.required && !s.tick);
  const anyLeft = steps.some((s) => !s.tick);
  const name = item.template.name;

  async function act(step: number | null, what: () => Promise<unknown>, words: string) {
    setRefusal(null);
    setSaid(null);
    try {
      await what();
      setSaid(words);
      if (step !== null) setDrafts((d) => ({ ...d, [step]: EMPTY }));
    } catch (error) {
      setRefusal({ step, refusal: dayRefusal(error) });
    }
    await refetch();
  }

  function tickStep(position: number, state: "done" | "not_done" | "clear") {
    const d = draftOf(position);
    return act(
      position,
      () =>
        forgetAfter(tick, {
          template: item.template.id,
          date: item.date,
          step: position,
          state,
          ...(state === "done" && d.note.trim() ? { note: d.note.trim() } : {}),
          ...(state === "not_done" && d.why.trim() ? { why: d.why.trim() } : {}),
          ...forInput,
        }),
      state === "clear" ? "Tick cleared." : "Ticked.",
    );
  }

  const finished = finishedLabel(item, locale, zone);
  return (
    <article
      className="grid gap-2 rounded-md border p-3 text-sm"
      aria-labelledby={`${id}-name`}
      data-day-checklist={item.template.id}
      data-state={item.state}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-name`} className="font-medium">
          {name}
          <span className="ml-2 rounded border px-1 text-xs" data-checklist-state={item.state}>
            {dayStateLabel(item.state)}
          </span>
          {item.late ? (
            <span className="ml-2 rounded border px-1 text-xs" data-late="true">
              {item.state === "done" ? "Done late" : "Past due"}
            </span>
          ) : null}
        </h3>
        {item.dueAt ? (
          <p className="text-muted-foreground">Due by {timeIn(item.dueAt, zone, locale)}</p>
        ) : null}
      </header>
      {item.template.purpose ? (
        <p className="text-muted-foreground">{item.template.purpose}</p>
      ) : null}
      {finished ? <p data-finished="true">{finished}</p> : null}
      {item.run?.closedWhy ? <p className="text-xs">Why: {item.run.closedWhy}</p> : null}
      {item.canTick && youManage ? (
        <div className="grid gap-1 rounded-md border p-2">
          <label className="grid gap-1" htmlFor={`${id}-for`}>
            <span>Ticking as</span>
            <select
              id={`${id}-for`}
              className="rounded-md border px-2 py-1"
              value={forWhom}
              onChange={(e) => setForWhom(e.target.value)}
            >
              {item.mayDo ? (
                <option value={you}>Myself</option>
              ) : (
                <option value="">Choose someone</option>
              )}
              {(detail.data?.doers ?? [])
                .filter((d) => d.id !== you)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    For {d.name}
                  </option>
                ))}
            </select>
          </label>
          {forOther ? (
            <label className="grid gap-1" htmlFor={`${id}-forwhy`}>
              <span>Why you are ticking it for them</span>
              <input
                id={`${id}-forwhy`}
                className="rounded-md border px-2 py-1"
                value={forWhy}
                maxLength={500}
                autoComplete="off"
                onChange={(e) => setForWhy(e.target.value)}
              />
            </label>
          ) : null}
        </div>
      ) : null}
      <ol className="grid gap-2" aria-label={`Steps of ${name}`}>
        {steps.map((step) => {
          const d = draftOf(step.position);
          const editable = item.canTick && mayChange(step);
          return (
            <li
              key={step.position}
              className="grid gap-1 rounded-md border p-2"
              data-step={step.position}
              data-ticked={step.tick ? (step.tick.done ? "done" : "not_done") : undefined}
              data-missed={step.missed ? "true" : undefined}
            >
              <p>
                <span className="font-medium">{step.text}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {step.required ? "Required" : "Optional"}
                  {step.asksNote ? " · asks for a note" : ""}
                </span>
              </p>
              {step.tick ? (
                <p className="text-xs" data-tick-label="true">
                  {tickLabel(step.tick)} · {timeIn(step.tick.at, zone, locale)}
                  {step.tick.why ? ` · Why: ${step.tick.why}` : ""}
                  {step.tick.onBehalfWhy ? ` · For them because: ${step.tick.onBehalfWhy}` : ""}
                </p>
              ) : null}
              {step.tick?.note ? <p className="text-xs">Note: {step.tick.note}</p> : null}
              {step.tick?.withheld ? (
                <p className="text-xs text-muted-foreground">
                  What they wrote is theirs and whoever manages checklists' to read.
                </p>
              ) : null}
              {step.missed ? <p className="text-xs font-semibold">Missed</p> : null}
              {editable ? (
                <div className="grid gap-1">
                  <label className="grid gap-1" htmlFor={`${id}-note-${step.position}`}>
                    <span className="text-xs">
                      {step.asksNote ? "Note (needed to tick it done)" : "Note (optional)"}
                    </span>
                    <input
                      id={`${id}-note-${step.position}`}
                      className="rounded-md border px-2 py-1"
                      value={d.note}
                      maxLength={1000}
                      autoComplete="off"
                      aria-label={`Note on ${step.text}`}
                      onChange={(e) => setDraft(step.position, { note: e.target.value })}
                    />
                  </label>
                  {d.notDone ? (
                    <label className="grid gap-1" htmlFor={`${id}-why-${step.position}`}>
                      <span className="text-xs">Why it was not done</span>
                      <input
                        id={`${id}-why-${step.position}`}
                        className="rounded-md border px-2 py-1"
                        value={d.why}
                        maxLength={500}
                        autoComplete="off"
                        aria-label={`Why ${step.text} was not done`}
                        onChange={(e) => setDraft(step.position, { why: e.target.value })}
                      />
                    </label>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={busy}
                      aria-busy={busy}
                      aria-label={`Tick ${step.text} done`}
                      onClick={() => tickStep(step.position, "done")}
                    >
                      Done
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      aria-label={
                        d.notDone ? `Save ${step.text} as not done` : `Mark ${step.text} not done`
                      }
                      onClick={() =>
                        d.notDone
                          ? tickStep(step.position, "not_done")
                          : setDraft(step.position, { notDone: true })
                      }
                    >
                      {d.notDone ? "Save not done" : "Not done"}
                    </Button>
                    {step.tick ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        aria-label={`Clear the tick of ${step.text}`}
                        onClick={() => tickStep(step.position, "clear")}
                      >
                        Clear
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {refusal?.step === step.position ? <Refusal refusal={refusal.refusal} /> : null}
            </li>
          );
        })}
      </ol>
      {item.canTick && !requiredLeft && anyLeft ? (
        <Button
          type="button"
          disabled={busy}
          aria-busy={busy}
          aria-label={`Finish ${name} with the optional steps left`}
          onClick={() =>
            act(
              null,
              () => forgetAfter(done, { template: item.template.id, date: item.date, ...forInput }),
              "Finished. It does not change now.",
            )
          }
        >
          Finish
        </Button>
      ) : null}
      {item.canTick ? (
        <p className="text-xs text-muted-foreground">
          Ticking the last step finishes it. Not finished by the end of the day, it is missed.
        </p>
      ) : null}
      {said ? (
        <p role="status" className="text-xs">
          {said}
        </p>
      ) : null}
      {refusal && refusal.step === null ? <Refusal refusal={refusal.refusal} /> : null}
    </article>
  );
}

function Refusal({ refusal }: { refusal: DayRefusal }) {
  return (
    <p role="alert" className="text-xs" data-refusal={refusal.kind}>
      {refusal.message}
    </p>
  );
}
