// My availability in the app (stage 45 step 7): the times I said I cannot work, adding leave or
// another one-off time, or a regular time off (every week on chosen days), and ending one. Nobody
// approves it; only I and whoever rosters see it. When it covers shifts I am on, they stay mine
// and this offers them in one step. Dates and times are typed as the host takes them (a date
// YYYY-MM-DD, a time HH:MM, in the business's zone): no date picker module is needed, and the host
// says what is wrong with what was typed.
//
// What I write about my time off is forgotten once the call is over (`forgetAfter`) and when the
// screen closes; my list with its notes is kept in the app's cache no longer than it is shown.
import {
  type AwayAnswer,
  type AwayInput,
  awayKind,
  awayWhen,
  forgetAfter,
  type RosteringHooks,
  type RosterRefusal,
  rosterRefusal,
  shiftTime,
} from "@composable-os/pack-rostering/client";
import { useState } from "react";
import { View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "useMyAway" | "useAway" | "useBack" | "useOffer">;

const DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;
type Weekday = (typeof DAYS)[number][0];

interface Form {
  kind: "leave" | "regular";
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  weekdays: Weekday[];
  fromDate: string;
  untilDate: string;
  note: string;
}

const EMPTY: Form = {
  kind: "leave",
  startDate: "",
  startTime: "00:00",
  endDate: "",
  endTime: "23:59",
  weekdays: [],
  fromDate: "",
  untilDate: "",
  note: "",
};

function inputOf(form: Form): AwayInput {
  const note = form.note.trim() ? { note: form.note.trim() } : {};
  if (form.kind === "regular") {
    return {
      kind: "regular",
      weekdays: form.weekdays,
      startTime: form.startTime,
      endTime: form.endTime,
      fromDate: form.fromDate,
      ...(form.untilDate ? { untilDate: form.untilDate } : {}),
      ...note,
    };
  }
  return {
    kind: "leave",
    startsAt: `${form.startDate}T${form.startTime}`,
    endsAt: `${form.endDate}T${form.endTime}`,
    ...note,
  };
}

export function MyAvailabilityScreen({
  rostering,
  locale = "en-AU",
}: {
  rostering: Hooks;
  locale?: string;
}) {
  const me = rostering.useMe();
  const list = rostering.useMyAway({});
  const away = rostering.useAway();
  const back = rostering.useBack();
  const offer = rostering.useOffer();
  const [form, setForm] = useState<Form>(EMPTY);
  const [answer, setAnswer] = useState<AwayAnswer | null>(null);
  const [offered, setOffered] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const zone = me.data?.zone ?? "UTC";
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    setRefusal(null);
    setSaid(null);
    setAnswer(null);
    setOffered([]);
    try {
      const made = await forgetAfter(away, inputOf(form));
      setAnswer(made);
      setForm(EMPTY);
      setSaid("Saved. Only you and whoever rosters can see it.");
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await list.refetch?.();
  }

  async function remove(id: string) {
    setRefusal(null);
    try {
      await back.mutateAsync({ id });
      setSaid("Removed.");
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await list.refetch?.();
  }

  async function offerShift(object: string, id: string) {
    setRefusal(null);
    try {
      await offer.mutateAsync({ object, id });
      setOffered((o) => [...o, id]);
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
  }

  return (
    <Screen title="My availability">
      {me.isPending ? (
        <Text tone="muted" accessibilityRole="progressbar">
          Loading…
        </Text>
      ) : null}
      {me.error ? <Text accessibilityRole="alert">{rosterRefusal(me.error).message}</Text> : null}
      <Text>Times are in {zone}. Only you and whoever rosters see this.</Text>
      {said ? <Text accessibilityRole="alert">{said}</Text> : null}
      {refusal ? <Text accessibilityRole="alert">{refusal.message}</Text> : null}
      {answer?.count ? (
        <View>
          <Text>
            You are on {answer.count} shift{answer.count === 1 ? "" : "s"} then. They stay yours
            until someone takes them: offer them now?
          </Text>
          <List>
            {answer.shifts.map((s) => (
              <View key={s.id}>
                <Row title={s.title} detail={shiftTime(s, zone, { withDate: true, locale })} />
                {offered.includes(s.id) ? (
                  <Text>Offered</Text>
                ) : (
                  <Button
                    label={`Offer ${s.title}`}
                    quiet
                    busy={offer.isPending}
                    onPress={() => offerShift(s.object, s.id)}
                  />
                )}
              </View>
            ))}
          </List>
        </View>
      ) : null}
      <View accessibilityLabel="Add time off">
        <Text accessibilityRole="header">Add time off</Text>
        <View accessibilityRole="radiogroup">
          <Button
            label={form.kind === "leave" ? "One-off time (chosen)" : "One-off time"}
            quiet={form.kind !== "leave"}
            onPress={() => set({ kind: "leave" })}
          />
          <Button
            label={form.kind === "regular" ? "Every week (chosen)" : "Every week"}
            quiet={form.kind !== "regular"}
            onPress={() => set({ kind: "regular" })}
          />
        </View>
        {form.kind === "regular" ? (
          <>
            <View>
              {DAYS.map(([value, label]) => {
                const on = form.weekdays.includes(value);
                return (
                  <Button
                    key={value}
                    label={on ? `${label} (chosen)` : label}
                    quiet={!on}
                    onPress={() =>
                      set({
                        weekdays: on
                          ? form.weekdays.filter((d) => d !== value)
                          : [...form.weekdays, value],
                      })
                    }
                  />
                );
              })}
            </View>
            <Field
              label="From (time, HH:MM)"
              value={form.startTime}
              onChangeText={(v) => set({ startTime: v })}
            />
            <Field
              label="Until (time, HH:MM)"
              value={form.endTime}
              onChangeText={(v) => set({ endTime: v })}
            />
            <Field
              label="Starting on (YYYY-MM-DD)"
              value={form.fromDate}
              onChangeText={(v) => set({ fromDate: v })}
            />
            <Field
              label="Ending on (YYYY-MM-DD, optional)"
              value={form.untilDate}
              onChangeText={(v) => set({ untilDate: v })}
            />
          </>
        ) : (
          <>
            <Field
              label="From (date, YYYY-MM-DD)"
              value={form.startDate}
              onChangeText={(v) => set({ startDate: v })}
            />
            <Field
              label="From (time, HH:MM)"
              value={form.startTime}
              onChangeText={(v) => set({ startTime: v })}
            />
            <Field
              label="Until (date, YYYY-MM-DD)"
              value={form.endDate}
              onChangeText={(v) => set({ endDate: v })}
            />
            <Field
              label="Until (time, HH:MM)"
              value={form.endTime}
              onChangeText={(v) => set({ endTime: v })}
            />
          </>
        )}
        <Field
          label="Note (optional, seen by you and whoever rosters)"
          value={form.note}
          maxLength={500}
          autoComplete="off"
          onChangeText={(v) => set({ note: v })}
        />
        <Button label="Add time off" busy={away.isPending} onPress={submit} />
      </View>
      <Text accessibilityRole="header">My time off</Text>
      {list.isPending ? (
        <Text tone="muted" accessibilityRole="progressbar">
          Loading…
        </Text>
      ) : null}
      {list.data ? (
        <List empty="None from today on.">
          {list.data.items.map((item) => (
            <View key={item.id}>
              <Row
                title={`${awayKind(item.kind)} · ${awayWhen(item, locale)}`}
                detail={item.note}
              />
              <Button
                label={`End ${awayKind(item.kind).toLowerCase()}`}
                quiet
                busy={back.isPending}
                onPress={() => remove(item.id)}
              />
            </View>
          ))}
        </List>
      ) : null}
    </Screen>
  );
}
