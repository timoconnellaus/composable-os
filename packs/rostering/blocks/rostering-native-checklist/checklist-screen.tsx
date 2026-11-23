// A shift's checklist in the app (stage 45 step 4b, ADR 0650), for the native my-shifts'
// `shiftExtra` slot: the same as the web's, over the native base. The shift's person ticks each
// step off (done, with a note where the step asks for one; not done, with why) and marks it done,
// which is final; whoever rosters may tick it for them, saying why, kept as ticked by them for that
// person. The host decides whose it is, when it may be ticked and whether it is complete: this
// shows its answer and its refusals.
//
// What someone writes on a step is private: kept only in this screen's state, sent with
// `forgetAfter`, and cleared when the app goes to the background (so the app switcher's snapshot
// never shows it). The checklist is fetched only when opened, and kept no longer than it is shown.
import {
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
import { useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";

export type ChecklistHooks = Pick<RosteringHooks, "useChecklist" | "useTick" | "useChecklistDone">;

interface Draft {
  note: string;
  why: string;
  notDone: boolean;
}
const EMPTY: Draft = { note: "", why: "", notDone: false };

export function ShiftChecklistNative({
  rostering,
  shift,
  locale = "en-AU",
  zone,
}: {
  rostering: ChecklistHooks;
  shift: RosterShift;
  locale?: string;
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
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        setDrafts({});
        setForWhy("");
        setHidden(true);
      } else {
        void Promise.resolve(answer.refetch?.()).then(() => setHidden(false));
      }
    });
    return () => listener.remove();
  }, [answer.refetch]);
  if (!shift.checklist) return null;
  const busy = tick.isPending || done.isPending;
  const data = hidden ? undefined : answer.data;
  const run = data?.run ?? null;
  const editable = Boolean(data?.canTick) && (run === null || run.state === "open");
  const onBehalf = Boolean(data?.onBehalf);
  const tz = shift.zone ?? zone ?? "UTC";
  const draftOf = (p: number) => drafts[p] ?? EMPTY;
  const setDraft = (p: number, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [p]: { ...(d[p] ?? EMPTY), ...patch } }));

  async function act(step: number | null, what: () => Promise<unknown>, words: string) {
    setRefusal(null);
    setSaid(null);
    try {
      await what();
      setSaid(words);
      if (step !== null) setDrafts((d) => ({ ...d, [step]: EMPTY }));
    } catch (error) {
      setRefusal({ step, refusal: rosterRefusal(error) });
    }
    await answer.refetch?.();
  }
  const tickStep = (position: number, state: "done" | "not_done" | "clear") => {
    const d = draftOf(position);
    return act(
      position,
      () =>
        forgetAfter(tick, {
          object: shift.object,
          id: shift.id,
          step: position,
          state,
          ...(state === "done" && d.note.trim() ? { note: d.note.trim() } : {}),
          ...(state === "not_done" && d.why.trim() ? { why: d.why.trim() } : {}),
          ...(onBehalf && forWhy.trim() ? { forWhy: forWhy.trim() } : {}),
        }),
      state === "clear" ? "Tick cleared." : "Ticked.",
    );
  };
  const steps =
    run?.steps ??
    (data?.preview ?? []).map((s, position) => ({ ...s, position, tick: null, missed: false }));
  const state = run ? run.state : (shift.checklist.state ?? null);
  const alert = (r: RosterRefusal) => {
    const next = refusalNext(r.kind, false);
    return (
      <Text accessibilityRole="alert">
        {r.message}
        {next ? ` ${next}` : ""}
      </Text>
    );
  };

  return (
    <View>
      <Text accessibilityRole="header">
        Checklist: {shift.checklist.name}
        {state ? ` · ${checklistStateLabel(state)}` : ""}
      </Text>
      <Button
        label={open ? "Close checklist" : `Open the checklist of ${shift.title}`}
        quiet
        onPress={() => {
          setOpen((o) => !o);
          setRefusal(null);
          setSaid(null);
        }}
      />
      {open ? (
        <View>
          {answer.isPending || hidden ? (
            <Text accessibilityRole="progressbar">Loading the checklist…</Text>
          ) : null}
          {answer.error ? alert(rosterRefusal(answer.error)) : null}
          {data?.tickUntil && editable ? (
            <Text>
              Tick it off until{" "}
              {shiftTime({ startsAt: data.tickUntil, endsAt: null }, tz, {
                withDate: true,
                locale,
              })}
              .
            </Text>
          ) : null}
          {run && run.state !== "open" ? (
            <Text>
              This checklist is {checklistStateLabel(run.state).toLowerCase()}: it does not change.
            </Text>
          ) : null}
          {editable && onBehalf ? (
            <View>
              <Text>You are ticking this for {data?.forName ?? "the person on the shift"}.</Text>
              <Field
                label="Why you are ticking it for them"
                value={forWhy}
                maxLength={500}
                onChangeText={setForWhy}
              />
            </View>
          ) : null}
          {steps.map((step) => {
            const d = draftOf(step.position);
            return (
              <View key={step.position} accessible={false}>
                <Text>
                  {step.text} ({step.required ? "required" : "optional"}
                  {step.asksNote ? ", asks for a note" : ""})
                </Text>
                {step.tick ? <Text>{tickLabel(step.tick)}</Text> : null}
                {step.tick?.why ? <Text>Why: {step.tick.why}</Text> : null}
                {step.tick?.note ? <Text>Note: {step.tick.note}</Text> : null}
                {step.missed ? <Text>Missed</Text> : null}
                {editable ? (
                  <View>
                    <Field
                      label={
                        step.asksNote ? `Note on ${step.text} (needed)` : `Note on ${step.text}`
                      }
                      value={d.note}
                      maxLength={1000}
                      onChangeText={(note) => setDraft(step.position, { note })}
                    />
                    {d.notDone ? (
                      <Field
                        label={`Why ${step.text} was not done`}
                        value={d.why}
                        maxLength={500}
                        onChangeText={(why) => setDraft(step.position, { why })}
                      />
                    ) : null}
                    <Button
                      label={`Tick ${step.text} done`}
                      busy={busy}
                      onPress={() => tickStep(step.position, "done")}
                    />
                    <Button
                      label={d.notDone ? `Save ${step.text} as not done` : `${step.text}: not done`}
                      quiet
                      busy={busy}
                      onPress={() =>
                        d.notDone
                          ? tickStep(step.position, "not_done")
                          : setDraft(step.position, { notDone: true })
                      }
                    />
                    {step.tick ? (
                      <Button
                        label={`Clear the tick of ${step.text}`}
                        quiet
                        busy={busy}
                        onPress={() => tickStep(step.position, "clear")}
                      />
                    ) : null}
                  </View>
                ) : null}
                {refusal?.step === step.position ? alert(refusal.refusal) : null}
              </View>
            );
          })}
          {editable ? (
            <Button
              label="Mark the checklist done"
              busy={busy}
              onPress={() =>
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
            />
          ) : null}
          {run?.corrections.map((c) => (
            <Text key={c.id}>
              Correction: {c.text} ({c.byName})
            </Text>
          ))}
          {said ? <Text accessibilityRole="alert">{said}</Text> : null}
          {refusal && refusal.step === null ? alert(refusal.refusal) : null}
        </View>
      ) : null}
    </View>
  );
}
