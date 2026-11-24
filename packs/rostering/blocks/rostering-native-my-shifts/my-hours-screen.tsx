// My hours in the app (stage 45, the owner's decision of 2026-11-24), a part of My shifts: my own
// hours and shifts for a pay period, as payroll is given them. Hours and counts only, no money.
// The shared logic is the pack's headless entry, as on the web; only the screen differs.
//
// The host answers everything: the periods (the current one and twelve before it), whether I am
// counted and how, my totals and each of my shifts (a locked period's locked figures, or a
// preview of an open one), and each refusal. Nothing about anyone else, and not why a shift was
// marked not worked, only that it was. The figures are fetched only when I pick a period, kept no
// longer than they are shown (`gcTime: 0`), hidden when the app goes to the background (read
// again when it comes back), and never stored.
import {
  basisLabel,
  dayLabel,
  type MyPayPeriod,
  type RosteringHooks,
  refusalNext,
  rosterRefusal,
} from "@composable-os/pack-rostering/client";
import { useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";

export type MyHoursHooks = Pick<RosteringHooks, "useMyPayPeriods" | "useMyPay">;

const stateLabel = (p: MyPayPeriod) =>
  p.state === "locked"
    ? `Locked${p.version && p.version > 1 ? ` (version ${p.version})` : ""}`
    : p.ended
      ? "Ended, not locked yet"
      : "Open";

export function MyHoursNative({
  rostering,
  locale = "en-AU",
}: {
  rostering: MyHoursHooks;
  locale?: string;
}) {
  const [hidden, setHidden] = useState(false);
  const periods = rostering.useMyPayPeriods(!hidden);
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        setChosen(null);
        setHidden(true);
      } else {
        setHidden(false);
      }
    });
    return () => listener.remove();
  }, []);
  const period = periods.data?.periods.find((p) => p.start === chosen) ?? null;
  const refusal = periods.error ? rosterRefusal(periods.error) : null;
  return (
    <View>
      <Text accessibilityRole="header">My hours</Text>
      <Text>Your own hours and shifts for each pay period, as payroll is given them.</Text>
      {hidden || periods.isPending ? (
        <Text accessibilityRole="progressbar">Loading the pay periods…</Text>
      ) : null}
      {!hidden && refusal ? (
        <View>
          <Text accessibilityRole="alert">
            {refusal.kind === "human_only"
              ? "Your hours are shown to you only, at the screen."
              : refusal.message}
          </Text>
          {refusal.kind === "network" || refusal.kind === "other" ? (
            <Button label="Try again" quiet onPress={() => periods.refetch?.()} />
          ) : null}
        </View>
      ) : null}
      {!hidden && periods.data && !periods.data.set ? (
        <Text>Pay periods are not set up yet, so there are no hours to show.</Text>
      ) : null}
      {!hidden && periods.data?.set ? (
        <List>
          {periods.data.periods.map((p) => (
            <Row
              key={p.start}
              title={`${dayLabel(p.start, locale)} – ${dayLabel(p.end, locale)}${chosen === p.start ? " (shown)" : ""}`}
              detail={stateLabel(p)}
              onPress={() => setChosen(chosen === p.start ? null : p.start)}
            />
          ))}
        </List>
      ) : null}
      {!hidden && period ? (
        <PeriodHours key={period.start} rostering={rostering} period={period} locale={locale} />
      ) : null}
    </View>
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
  const data = mine.data;
  const refusal = mine.error ? rosterRefusal(mine.error) : null;
  return (
    <View>
      <Text accessibilityRole="header">
        {dayLabel(period.start, locale, true)} to {dayLabel(period.end, locale, true)}
      </Text>
      {mine.isPending ? <Text accessibilityRole="progressbar">Loading your hours…</Text> : null}
      {refusal ? (
        <View>
          <Text accessibilityRole="alert">
            {refusal.message}
            {refusalNext(refusal.kind, false) ? ` ${refusalNext(refusal.kind, false)}` : ""}
          </Text>
          {refusal.kind === "network" || refusal.kind === "other" ? (
            <Button label="Try again" quiet onPress={() => mine.refetch?.()} />
          ) : null}
        </View>
      ) : null}
      {data && !data.counted ? (
        <Text>
          You are not counted for pay in this period, so there are no hours to show. If you think
          you should be, ask whoever handles pay.
        </Text>
      ) : null}
      {data?.counted ? (
        <View>
          <Text>
            {data.period.preview
              ? "A preview from the roster as it stands: it can change until the period is locked."
              : "Locked: these are the figures payroll was given."}
          </Text>
          <Text>Counted: {basisLabel(data.basis)}</Text>
          <List empty="You have no counted shifts in this period.">
            {data.totals.map((t) => (
              <Row
                key={`${t.basis}:${t.kind?.id ?? t.kindName}`}
                title={t.kindName}
                detail={`${t.shifts} shifts · ${t.hours} hours${t.notWorked ? ` · ${t.notWorked} not worked` : ""}`}
              />
            ))}
          </List>
          <Text>All my hours: {data.hours}</Text>
          {data.lines.length ? (
            <List>
              {data.lines.map((l) => (
                <Row
                  key={`${l.object}:${l.id}`}
                  title={`${dayLabel(l.localDate, locale)} · ${l.title}`}
                  detail={[
                    `${l.localStart.slice(11, 16)}–${l.localEnd.slice(11, 16)}`,
                    l.place,
                    l.notWorked
                      ? "Marked not worked: counts for nothing. Ask whoever rosters why."
                      : `${l.countedMinutes} minutes`,
                    l.clockChange,
                    l.flagged
                      ? "Its list was taken by someone else: whoever handles pay checks it."
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                />
              ))}
            </List>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
