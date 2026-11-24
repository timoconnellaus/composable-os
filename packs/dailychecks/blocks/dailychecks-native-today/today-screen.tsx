// Today's checklists in the app (ADR 0651): the same as the web's, over the native base. The
// checklists done on their own that are due today and that the viewer may do; anyone who may do
// one ticks its steps (done, with a note where the step asks; not done, with why), and whoever
// ticks the last step finishes it, which is final. The host decides what is due, who may do it and
// when it is finished: this shows its answer and its refusals. Ticking for someone else is on the
// web (those who manage checklists use the admin).
//
// What someone writes on a step is private: kept only in this screen's state, sent with
// `forgetAfter`, and cleared when the app goes to the background (so the app switcher's snapshot
// never shows it). Today's checklists are kept no longer than they are shown.
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
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";

export type TodayHooks = Pick<DailyChecksHooks, "useToday" | "useTick" | "useDone">;

interface Draft {
  note: string;
  why: string;
  notDone: boolean;
}
const EMPTY: Draft = { note: "", why: "", notDone: false };

export function TodaysChecklistsScreen({
  dailychecks,
  locale = "en-AU",
}: {
  dailychecks: TodayHooks;
  locale?: string;
}) {
  const answer = dailychecks.useToday();
  const [hidden, setHidden] = useState(false);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        setHidden(true);
        setEpoch((e) => e + 1);
      } else {
        void Promise.resolve(answer.refetch?.()).then(() => setHidden(false));
      }
    });
    return () => listener.remove();
  }, [answer.refetch]);
  const data = hidden ? undefined : answer.data;
  // In the app a person does their own: the ones they may do (someone who manages checklists
  // ticks for others in the admin).
  const items = data?.items.filter((item) => item.mayDo) ?? [];
  return (
    <Screen title="Today's checklists">
      {answer.isPending || hidden ? (
        <Text tone="muted" accessibilityRole="progressbar">
          Loading today's checklists…
        </Text>
      ) : null}
      {answer.error ? (
        <Text tone="danger" accessibilityRole="alert">
          {dayRefusal(answer.error).message}
        </Text>
      ) : null}
      {data && !items.length ? <Text>Nothing is due for you today.</Text> : null}
      {data
        ? items.map((item) => (
            <DayChecklistNative
              key={`${item.template.id}:${epoch}`}
              hooks={dailychecks}
              item={item}
              zone={data.zone}
              you={data.you}
              locale={locale}
              refetch={() => answer.refetch?.()}
            />
          ))
        : null}
    </Screen>
  );
}

function DayChecklistNative({
  hooks,
  item,
  zone,
  you,
  locale,
  refetch,
}: {
  hooks: TodayHooks;
  item: DayItem;
  zone: string;
  you: string;
  locale: string;
  refetch: () => unknown;
}) {
  const tick = hooks.useTick();
  const done = hooks.useDone();
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [refusal, setRefusal] = useState<{ step: number | null; refusal: DayRefusal } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const busy = tick.isPending || done.isPending;
  const steps = stepsOf(item);
  // In the app a person ticks only for themselves.
  const canTick = item.canTick && item.mayDo;
  const draftOf = (p: number) => drafts[p] ?? EMPTY;
  const setDraft = (p: number, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [p]: { ...(d[p] ?? EMPTY), ...patch } }));
  const requiredLeft = steps.some((s) => s.required && !s.tick);
  const anyLeft = steps.some((s) => !s.tick);

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
  const tickStep = (position: number, state: "done" | "not_done" | "clear") => {
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
        }),
      state === "clear" ? "Tick cleared." : "Ticked.",
    );
  };
  const alert = (r: DayRefusal) => (
    <Text tone="danger" accessibilityRole="alert">
      {r.message}
    </Text>
  );
  const finished = finishedLabel(item, locale, zone);

  return (
    <View>
      <Text accessibilityRole="header">
        {item.template.name} · {dayStateLabel(item.state)}
        {item.late ? (item.state === "done" ? " · done late" : " · past due") : ""}
      </Text>
      {item.dueAt ? <Text>Due by {timeIn(item.dueAt, zone, locale)}</Text> : null}
      {finished ? <Text>{finished}</Text> : null}
      {steps.map((step) => {
        const d = draftOf(step.position);
        const mine = !step.tick || step.tick.by === you;
        return (
          <View key={step.position} accessible={false}>
            <Text>
              {step.text} ({step.required ? "required" : "optional"}
              {step.asksNote ? ", asks for a note" : ""})
            </Text>
            {step.tick ? (
              <Text>
                {tickLabel(step.tick)} at {timeIn(step.tick.at, zone, locale)}
              </Text>
            ) : null}
            {step.tick?.why ? <Text>Why: {step.tick.why}</Text> : null}
            {step.tick?.note ? <Text>Note: {step.tick.note}</Text> : null}
            {step.missed ? <Text>Missed</Text> : null}
            {canTick && mine ? (
              <View>
                <Field
                  label={step.asksNote ? `Note on ${step.text} (needed)` : `Note on ${step.text}`}
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
      {canTick && !requiredLeft && anyLeft ? (
        <Button
          label={`Finish ${item.template.name}`}
          busy={busy}
          onPress={() =>
            act(
              null,
              () => forgetAfter(done, { template: item.template.id, date: item.date }),
              "Finished. It does not change now.",
            )
          }
        />
      ) : null}
      {said ? (
        <Text tone="danger" accessibilityRole="alert">
          {said}
        </Text>
      ) : null}
      {refusal && refusal.step === null ? alert(refusal.refusal) : null}
    </View>
  );
}
