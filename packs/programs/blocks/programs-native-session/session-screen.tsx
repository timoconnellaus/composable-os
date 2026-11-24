// One session to do, for the mobile app (stage 41): targets, last time's numbers, a row per set
// to log what was done and how hard it felt, a rest timer, and marking it done. A member's own
// session, a class's (choose the level you take), or a coach logging for a client (`personId`).
// The app gives the buzz at the end of a rest (`onRestDone`, for example `expo-haptics`), so this
// block needs no device package. It holds no rules: targets, whose session it is and what may be
// logged are the host's.
import {
  describeSet,
  describeSets,
  type Item,
  levelExercises,
  levelLabel,
  loggedFor,
  numberFrom,
  type ProgramsHooks,
  type Session,
  type SetTarget,
} from "@composable-os/pack-programs/client";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Field } from "../native-base/field.tsx";
import { Screen } from "../native-base/screen.tsx";
import { theme } from "../native-base/theme.ts";

export function SessionScreen({
  programs,
  sessionId,
  personId,
  onRestDone,
}: {
  programs: Pick<ProgramsHooks, "useLogSet" | "useMarkSession" | "useSession" | "useUpdateSet">;
  sessionId: string;
  personId?: string;
  onRestDone?: () => void;
}) {
  const detail = programs.useSession({ sessionId, ...(personId ? { personId } : {}) });
  const mark = programs.useMarkSession();
  const [rest, setRest] = useState<number | null>(null);
  useEffect(() => {
    if (rest === null) return undefined;
    if (rest <= 0) {
      setRest(null);
      onRestDone?.();
      return undefined;
    }
    const timer = setTimeout(() => setRest((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [rest, onRestDone]);
  if (detail.isPending)
    return (
      <Screen title="Session">
        <Text>Loading…</Text>
      </Screen>
    );
  if (!detail.data)
    return (
      <Screen title="Session">
        <Text>We could not load this session.</Text>
      </Screen>
    );
  const { session, exercises, logged } = detail.data;
  const plan = session.plan as unknown as Session | null;
  const names = new Map(exercises.map((e) => [e.id, e]));
  return (
    <Screen title={session.name ?? "Session"}>
      <Text style={styles.muted}>
        {[session.programTitle, session.classTypeName, session.date].filter(Boolean).join(" · ")}
      </Text>
      {rest !== null ? (
        <View style={styles.timer} accessibilityRole="timer" accessibilityLiveRegion="polite">
          <Text style={styles.timerText}>{rest}s rest</Text>
          <Button quiet label="Skip" onPress={() => setRest(null)} />
        </View>
      ) : null}
      {plan?.warmup?.text ? <Text>{plan.warmup.text}</Text> : null}
      {(plan?.blocks ?? []).map((block) => (
        <View key={block.label} style={styles.block}>
          <Text style={styles.heading}>
            Block {block.label}
            {block.rounds ? ` · ${block.rounds} rounds` : ""}
          </Text>
          {(block.notes ?? []).map((n) => (
            <Text key={n.text} style={styles.muted}>
              {n.text}
            </Text>
          ))}
          {block.items.map((item) => (
            <NativeItem
              key={item.label}
              programs={programs}
              sessionId={sessionId}
              personId={personId}
              item={item}
              names={names}
              logged={logged}
              onLogged={(t) => {
                detail.refetch?.();
                if (t?.rest) setRest(t.rest);
              }}
            />
          ))}
        </View>
      ))}
      {session.kind === "personal" ? (
        <Button
          label={session.state === "done" ? "Done" : "Mark done"}
          busy={mark.isPending}
          disabled={session.state === "done"}
          onPress={async () => {
            await mark.mutateAsync({ sessionId, state: "done" });
            detail.refetch?.();
          }}
        />
      ) : null}
    </Screen>
  );
}

function NativeItem({
  programs,
  sessionId,
  personId,
  item,
  names,
  logged,
  onLogged,
}: {
  programs: Pick<ProgramsHooks, "useLogSet" | "useMarkSession" | "useSession" | "useUpdateSet">;
  sessionId: string;
  personId: string | undefined;
  item: Item;
  names: Map<
    string,
    {
      name: string | null;
      last: { reps: number | null; seconds: number | null; load: number | null }[];
    }
  >;
  logged: Parameters<typeof loggedFor>[0];
  onLogged: (target: SetTarget | undefined) => void;
}) {
  const taken = logged.find((l) => l.item === item.label)?.level ?? null;
  const [chosen, setChosen] = useState<number | null>(taken);
  const levels = item.kind === "levels" ? item.levels : [];
  const level =
    levels.find((l) => l.level === chosen) ?? (levels.length === 1 ? levels[0] : undefined);
  // Everyone's exercises (beside the levels, if any), then the level's.
  const list =
    item.kind === "all"
      ? item.exercises
      : [...(item.exercises ?? []), ...(level ? levelExercises(level) : [])];
  return (
    <View style={styles.item}>
      <Text style={styles.heading}>{item.label}</Text>
      {(item.notes ?? []).map((n) => (
        <Text key={n.text} style={styles.muted}>
          {n.text}
        </Text>
      ))}
      {levels.length > 1 ? (
        <View style={styles.row}>
          {levels.map((l) => (
            <Button
              key={l.level}
              quiet={l.level !== level?.level}
              label={levelLabel(l)}
              onPress={() => setChosen(l.level)}
            />
          ))}
        </View>
      ) : null}
      {list.map((p) => {
        const e = names.get(p.exercise);
        return (
          <View key={p.exercise} style={styles.exercise}>
            <Text style={styles.name}>{e?.name ?? "Exercise"}</Text>
            <Text style={styles.muted}>{describeSets(p.sets)}</Text>
            {p.note ? <Text>{p.note}</Text> : null}
            {e?.last.length ? (
              <Text style={styles.muted}>
                Last time:{" "}
                {e.last
                  .map((s) =>
                    [
                      s.reps,
                      s.seconds !== null ? `${s.seconds}s` : null,
                      s.load !== null ? `${s.load}kg` : null,
                    ]
                      .filter((x) => x !== null)
                      .join(" "),
                  )
                  .join(", ")}
              </Text>
            ) : null}
            {p.sets.map((set, i) => (
              <NativeSet
                // biome-ignore lint/suspicious/noArrayIndexKey: sets are positions.
                key={i}
                programs={programs}
                sessionId={sessionId}
                personId={personId}
                itemLabel={item.label}
                level={item.kind === "levels" ? level?.level : undefined}
                exerciseId={p.exercise}
                setNumber={i + 1}
                target={set}
                done={loggedFor(logged, item.label, p.exercise, i + 1)}
                onLogged={onLogged}
              />
            ))}
          </View>
        );
      })}
    </View>
  );
}

function NativeSet({
  programs,
  sessionId,
  personId,
  itemLabel,
  level,
  exerciseId,
  setNumber,
  target,
  done,
  onLogged,
}: {
  programs: Pick<ProgramsHooks, "useLogSet" | "useMarkSession" | "useSession" | "useUpdateSet">;
  sessionId: string;
  personId: string | undefined;
  itemLabel: string;
  level: number | undefined;
  exerciseId: string;
  setNumber: number;
  target: SetTarget;
  done: ReturnType<typeof loggedFor>;
  onLogged: (target: SetTarget | undefined) => void;
}) {
  const add = programs.useLogSet();
  const update = programs.useUpdateSet();
  const timed = target.kind !== "reps";
  const [count, setCount] = useState(
    String(
      (timed ? done?.actual.seconds : done?.actual.reps) ?? (timed ? target.seconds : target.reps),
    ),
  );
  const [load, setLoad] = useState(String(done?.actual.load ?? target.load ?? ""));
  const [effort, setEffort] = useState(String(done?.rpe ?? ""));
  const [error, setError] = useState<string | null>(null);
  const actual = {
    ...(timed ? { seconds: numberFrom(count) } : { reps: numberFrom(count) }),
    ...(numberFrom(load) !== undefined ? { load: numberFrom(load) } : {}),
  };
  const rpe = numberFrom(effort);
  return (
    <View style={styles.set}>
      <Text>
        Set {setNumber}: {describeSet(target)} {done ? "✓" : ""}
      </Text>
      <View style={styles.row}>
        <Field
          label={timed ? "Seconds" : "Reps"}
          keyboardType="numeric"
          value={count}
          onChangeText={setCount}
        />
        <Field label="kg" keyboardType="decimal-pad" value={load} onChangeText={setLoad} />
        <Field
          label="RPE"
          keyboardType="decimal-pad"
          value={effort}
          onChangeText={setEffort}
          error={error}
        />
      </View>
      <Button
        label={done ? "Update" : "Log set"}
        quiet={Boolean(done)}
        busy={add.isPending || update.isPending}
        onPress={async () => {
          setError(null);
          try {
            if (done)
              await update.mutateAsync({
                logId: done.id,
                actual,
                ...(rpe !== undefined ? { rpe } : {}),
              });
            else
              await add.mutateAsync({
                sessionId,
                item: itemLabel,
                exerciseId,
                ...(level !== undefined ? { level } : {}),
                setNumber,
                actual,
                ...(rpe !== undefined ? { rpe } : {}),
                ...(personId ? { personId } : {}),
              });
            onLogged(target);
          } catch (e) {
            setError((e as { message?: string }).message ?? "Not logged");
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  muted: { color: theme.color.muted, fontSize: theme.font.small },
  heading: { fontSize: theme.font.body, fontWeight: "600", color: theme.color.text },
  name: { fontSize: theme.font.body, fontWeight: "600" },
  block: { gap: theme.space.sm, marginTop: theme.space.md },
  item: {
    gap: theme.space.sm,
    padding: theme.space.sm,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius,
  },
  exercise: { gap: theme.space.xs },
  set: { gap: theme.space.xs, paddingVertical: theme.space.xs },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  timer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    padding: theme.space.md,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius,
  },
  timerText: { fontSize: theme.font.title, fontWeight: "700" },
});
