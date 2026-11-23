// A shift's checklist (stage 45 step 4b, ADR 0650), for the `shiftExtra` slot under a shift (my
// shifts; a rosterer's week). A duty may carry a checklist: its shift's person ticks each step off,
// done (with a note where the step asks for one) or not done (with why), and marks it done, which
// is final. Whoever rosters may tick it for the person, saying why: it is kept, and shown, as
// ticked by them for that person.
//
// The host decides everything here: whose it is to tick (`canTick`, `onBehalf`), when (from the
// shift's start until 2 hours after its end), whether a step needs a note, whether every required
// step is ticked. This shows the host's answer and its refusals, each in its own state.
//
// What someone writes on a step, why it was not done and why it was ticked for them are private:
// kept only in this screen's state, sent with `forgetAfter` (never in a URL, storage or a query's
// key), cleared when the page is left, and read again when the browser brings it back. The
// checklist itself is fetched only when it is opened, and kept no longer than it is shown.
import {
  type ChecklistStep,
  checklistStateLabel,
  forgetAfter,
  type RosteringHooks,
  type RosterRefusal,
  type RosterShift,
  refusalNext,
  rosterRefusal,
  shiftTime,
  tickLabel,
} from "@composable-os/pack-rostering/client";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui-button/button.tsx";

export type ChecklistHooks = Pick<RosteringHooks, "useChecklist" | "useTick" | "useChecklistDone">;

interface Draft {
  note: string;
  why: string;
  /** Asking for why it was not done. */
  notDone: boolean;
}
const EMPTY_DRAFT: Draft = { note: "", why: "", notDone: false };

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

export function ShiftChecklist({
  rostering,
  shift,
  locale = "en-AU",
  zone,
}: {
  rostering: ChecklistHooks;
  shift: RosterShift;
  locale?: string;
  /** The roster's zone, for the times (the shift's own zone first). */
  zone?: string;
}) {
  const [open, setOpen] = useState(false);
  const answer = rostering.useChecklist(open ? { object: shift.object, id: shift.id } : null);
  const tick = rostering.useTick();
  const done = rostering.useChecklistDone();
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [forWhy, setForWhy] = useState("");
  const [refusal, setRefusal] = useState<{ step: number | null; refusal: RosterRefusal } | null>(
    null,
  );
  const [said, setSaid] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const id = useId();
  useForgetOnLeave(
    () => {
      setDrafts({});
      setForWhy("");
      setHidden(true);
    },
    () => void Promise.resolve(answer.refetch?.()).then(() => setHidden(false)),
  );
  if (!shift.checklist) return null;
  const busy = tick.isPending || done.isPending;
  const draftOf = (position: number) => drafts[position] ?? EMPTY_DRAFT;
  const setDraft = (position: number, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [position]: { ...(d[position] ?? EMPTY_DRAFT), ...patch } }));

  const data = hidden ? undefined : answer.data;
  const run = data?.run ?? null;
  const editable = Boolean(data?.canTick) && (run === null || run.state === "open");
  const onBehalf = Boolean(data?.onBehalf);
  const tz = shift.zone ?? zone ?? "UTC";

  async function act(step: number | null, what: () => Promise<unknown>, words: string) {
    setRefusal(null);
    setSaid(null);
    try {
      await what();
      setSaid(words);
      if (step !== null) setDrafts((d) => ({ ...d, [step]: EMPTY_DRAFT }));
    } catch (error) {
      setRefusal({ step, refusal: rosterRefusal(error) });
    }
    await answer.refetch?.();
  }

  function tickStep(
    step: ChecklistStep | { position: number },
    state: "done" | "not_done" | "clear",
  ) {
    const d = draftOf(step.position);
    const input = {
      object: shift.object,
      id: shift.id,
      step: step.position,
      state,
      ...(state === "done" && d.note.trim() ? { note: d.note.trim() } : {}),
      ...(state === "not_done" && d.why.trim() ? { why: d.why.trim() } : {}),
      ...(onBehalf && forWhy.trim() ? { forWhy: forWhy.trim() } : {}),
    };
    return act(
      step.position,
      () => forgetAfter(tick, input),
      state === "clear" ? "Tick cleared." : "Ticked.",
    );
  }

  const steps: {
    position: number;
    text: string;
    required: boolean;
    asksNote: boolean;
    tick: ChecklistStep["tick"];
    history: ChecklistStep["history"];
    missed: boolean;
  }[] =
    run?.steps ??
    (data?.preview ?? []).map((s, position) => ({
      ...s,
      position,
      tick: null,
      history: [],
      missed: false,
    }));
  const state = run ? run.state : (shift.checklist.state ?? null);

  return (
    <section
      className="grid gap-2 rounded-md border p-2 text-sm"
      aria-labelledby={`${id}-name`}
      data-checklist-for={shift.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`${id}-name`} className="font-medium">
          Checklist: {shift.checklist.name}
          {state ? (
            <span className="ml-2 rounded border px-1 text-xs" data-checklist-state={state}>
              {checklistStateLabel(state)}
            </span>
          ) : null}
        </p>
        <Button
          type="button"
          variant="outline"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          aria-label={`${open ? "Close" : "Open"} the checklist ${shift.checklist.name} of ${shift.title}`}
          onClick={() => {
            setOpen((o) => !o);
            setRefusal(null);
            setSaid(null);
          }}
        >
          {open ? "Close checklist" : "Open checklist"}
        </Button>
      </div>
      {open ? (
        <div id={`${id}-body`} className="grid gap-2">
          {answer.isPending || hidden ? <p aria-busy="true">Loading the checklist…</p> : null}
          {answer.error ? (
            <p role="alert" data-refusal={rosterRefusal(answer.error).kind}>
              {rosterRefusal(answer.error).message}
            </p>
          ) : null}
          {data ? (
            <>
              {data.opens && data.tickUntil ? (
                <p className="text-muted-foreground">
                  {editable
                    ? `Tick it off until ${shiftTime({ startsAt: data.tickUntil, endsAt: null }, tz, { withDate: true, locale })}.`
                    : run && run.state !== "open"
                      ? `This checklist is ${checklistStateLabel(run.state).toLowerCase()}: it does not change.`
                      : `It can be ticked from ${shiftTime({ startsAt: data.opens, endsAt: null }, tz, { withDate: true, locale })} until ${shiftTime({ startsAt: data.tickUntil, endsAt: null }, tz, { withDate: true, locale })}.`}
                </p>
              ) : null}
              {editable && onBehalf ? (
                <div className="grid gap-1 rounded-md border p-2">
                  <p>You are ticking this for {data.forName ?? "the person on the shift"}.</p>
                  <label className="grid gap-1" htmlFor={`${id}-for`}>
                    <span>Why you are ticking it for them</span>
                    <input
                      id={`${id}-for`}
                      className="rounded-md border px-2 py-1"
                      value={forWhy}
                      maxLength={500}
                      autoComplete="off"
                      onChange={(e) => setForWhy(e.target.value)}
                    />
                  </label>
                </div>
              ) : null}
              <ol className="grid gap-2" aria-label={`Steps of ${shift.checklist.name}`}>
                {steps.map((step) => {
                  const d = draftOf(step.position);
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
                        <p className="text-xs">
                          {tickLabel(step.tick)}
                          {step.tick.why ? ` · Why: ${step.tick.why}` : ""}
                          {step.tick.onBehalfWhy
                            ? ` · For them because: ${step.tick.onBehalfWhy}`
                            : ""}
                        </p>
                      ) : null}
                      {step.tick?.note ? <p className="text-xs">Note: {step.tick.note}</p> : null}
                      {step.tick?.withheld ? (
                        <p className="text-xs text-muted-foreground">
                          What they wrote is theirs and whoever rosters' to read.
                        </p>
                      ) : null}
                      {step.history.length ? (
                        <details className="text-xs" data-history={step.position}>
                          <summary>Earlier ticks ({step.history.length})</summary>
                          <ul className="grid gap-1">
                            {step.history.map((h) => (
                              <li key={`${h.at}-${h.by}`}>
                                {h.state === "cleared" ? h.label : tickLabel(h)}
                                {h.why ? ` · Why: ${h.why}` : ""}
                                {h.note ? ` · Note: ${h.note}` : ""}
                              </li>
                            ))}
                          </ul>
                        </details>
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
                              onClick={() => tickStep(step, "done")}
                            >
                              Done
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={busy}
                              aria-label={
                                d.notDone
                                  ? `Save ${step.text} as not done`
                                  : `Mark ${step.text} not done`
                              }
                              onClick={() =>
                                d.notDone
                                  ? tickStep(step, "not_done")
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
                                onClick={() => tickStep(step, "clear")}
                              >
                                Clear
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                      {refusal?.step === step.position ? (
                        <Refusal refusal={refusal.refusal} />
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              {editable ? (
                <Button
                  type="button"
                  disabled={busy}
                  aria-busy={busy}
                  aria-label={`Mark the checklist ${shift.checklist.name} done`}
                  onClick={() =>
                    act(
                      null,
                      () =>
                        forgetAfter(done, {
                          object: shift.object,
                          id: shift.id,
                          ...(onBehalf && forWhy.trim() ? { forWhy: forWhy.trim() } : {}),
                        }),
                      "Done. It does not change now.",
                    )
                  }
                >
                  Mark done
                </Button>
              ) : null}
              {run?.closedByName && run.state === "done" ? (
                <p className="text-xs">
                  Marked done by {run.closedByName}
                  {run.account && run.closedBy !== run.account && run.name
                    ? ` for ${run.name}`
                    : ""}
                  {run.closedWhy ? ` · Why: ${run.closedWhy}` : ""}
                </p>
              ) : null}
              {run?.corrections.length ? (
                <section aria-label="Corrections" className="grid gap-1">
                  <h4 className="text-xs font-medium">Corrections</h4>
                  <ul className="grid gap-1 text-xs">
                    {run.corrections.map((c) => (
                      <li key={c.id}>
                        {c.text} ({c.byName})
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : null}
          {said ? (
            <p role="status" className="text-xs">
              {said}
            </p>
          ) : null}
          {refusal && refusal.step === null ? <Refusal refusal={refusal.refusal} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function Refusal({ refusal }: { refusal: RosterRefusal }) {
  const next = refusalNext(refusal.kind, false);
  return (
    <div role="alert" className="text-xs" data-refusal={refusal.kind}>
      <p>{refusal.message}</p>
      {next ? <p>{next}</p> : null}
    </div>
  );
}
