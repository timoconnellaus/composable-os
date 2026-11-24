// One session to do, for the mobile app (stage 41): the workout logger. Each set is a row with its
// numbers and a tick; one tap logs it with the numbers shown (a suggestion, greyed, until the
// person types), even with the keyboard open and a number half typed. A tick of a done set takes
// it back; typing over a done set's numbers changes it. Effort (RPE) is an optional tap. Ticking
// a set starts the rest timer (the set's rest time, else `defaultRest`); a timed set has a
// start/stop timer that fills its seconds and ticks it; an exercise folds away when its last set
// is ticked; the sets done show at the top; finishing says what was not ticked. A member's own
// session, a class's (choose the level you take), or a coach logging for a client (`personId`).
//
// Every change shows at once and goes to the host through the pack's one queue
// (`useSessionLog`): in order, retried when it fails, flushed when the app goes to the background
// and when the screen is left, and it says when something could not be saved. The app gives the
// buzz at the end of a rest (`onRestDone`, for example `expo-haptics`), so this block needs no
// device package. It holds no rules: targets, whose session it is and what may be logged are the
// host's, and a set it refuses is shown with its reason.
import {
  describeSet,
  describeSets,
  EFFORTS,
  exerciseDone,
  exerciseKey,
  type Item,
  type LogState,
  levelExercises,
  levelLabel,
  levelOf,
  notTickedText,
  type ProgramsHooks,
  progressOf,
  restAfter,
  type Session,
  type SessionExercise,
  type SetField,
  type SetTarget,
  secondsBetween,
  setKey,
  setRow,
  timed,
  unsaved,
  weighed,
} from "@composable-os/pack-programs/client";
import { useEffect, useState } from "react";
import { AppState, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../native-base/button.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";
import { theme } from "../native-base/theme.ts";

type Programs = Pick<ProgramsHooks, "useMarkSession" | "useSessionLog">;
type Log = ReturnType<Programs["useSessionLog"]>["log"];

export function SessionScreen({
  programs,
  sessionId,
  personId,
  onRestDone,
  defaultRest = 90,
}: {
  programs: Programs;
  sessionId: string;
  personId?: string;
  onRestDone?: () => void;
  /** Seconds of rest after a set whose plan names none. */
  defaultRest?: number;
}) {
  const { detail, log, state } = programs.useSessionLog({
    sessionId,
    ...(personId ? { personId } : {}),
  });
  const mark = programs.useMarkSession();
  const [now, setNow] = useState(Date.now());
  const [restUntil, setRestUntil] = useState<number | null>(null);
  const [clock, setClock] = useState<{ key: string; from: number } | null>(null);
  const [finishing, setFinishing] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  // Nothing waits when the app goes to the background or the screen is left: what is queued is
  // sent now (and, if it cannot be, it stays queued and the screen says so when it is back).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") void log.flush();
    });
    return () => {
      sub.remove();
      void log.flush();
    };
  }, [log]);
  // One clock for the rest and a timed set, from timestamps, so a pause in the background
  // does not drift.
  const ticking = restUntil !== null || clock !== null;
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [ticking]);
  const restFor = restUntil === null ? null : secondsBetween(now, restUntil);
  useEffect(() => {
    if (restUntil !== null && now >= restUntil) {
      setRestUntil(null);
      onRestDone?.();
    }
  }, [now, restUntil, onRestDone]);

  if (detail.isPending)
    return (
      <Screen title="Session">
        <Text tone="muted" accessibilityRole="progressbar">
          Loading…
        </Text>
      </Screen>
    );
  if (!detail.data)
    return (
      <Screen title="Session">
        <Text tone="danger" accessibilityRole="alert">
          We could not load this session. Check the connection and try again.
        </Text>
      </Screen>
    );
  const { session, exercises } = detail.data;
  const plan = session.plan as unknown as Session | null;
  const names = new Map(exercises.map((e) => [e.id, e]));
  const progress = progressOf(state);
  const waiting = unsaved(state);
  const startRest = (target: SetTarget | undefined) => {
    setRestUntil(Date.now() + restAfter(target, defaultRest) * 1000);
    setNow(Date.now());
  };
  const finish = async (anyway: boolean) => {
    setSaid(null);
    const missing = notTickedText(state, (id) => names.get(id)?.name);
    if (missing && !anyway) {
      setFinishing(missing);
      return;
    }
    setFinishing(null);
    if (!(await log.flush())) {
      setSaid(
        "Some sets are not saved yet. They stay on this phone and are sent when the connection is back: try finishing again then.",
      );
      return;
    }
    if (session.kind !== "personal") {
      setSaid("All your sets are saved.");
      return;
    }
    try {
      await mark.mutateAsync({ sessionId, state: "done" });
      detail.refetch?.();
    } catch (e) {
      setSaid((e as { message?: string }).message ?? "We could not mark the session done.");
    }
  };

  return (
    <Screen title={session.name ?? "Session"}>
      <Text style={styles.muted}>
        {[session.programTitle, session.classTypeName, session.date].filter(Boolean).join(" · ")}
      </Text>
      <View accessibilityRole="progressbar" style={styles.progress}>
        <Text style={styles.heading}>
          {progress.done} of {progress.planned} sets
        </Text>
        <View style={styles.track}>
          <View
            style={[
              styles.fill,
              {
                width: `${progress.planned ? Math.round((progress.done / progress.planned) * 100) : 0}%`,
              },
            ]}
          />
        </View>
      </View>
      {waiting && state.failure ? (
        <View style={styles.warning} accessibilityLiveRegion="polite">
          <Text style={styles.warningText}>
            {waiting === 1 ? "1 set is" : `${waiting} sets are`} not saved yet. {state.failure}
          </Text>
          <Button quiet label="Try now" onPress={() => void log.flush()} />
        </View>
      ) : null}
      {restFor !== null ? (
        <View style={styles.timer} accessibilityRole="timer" accessibilityLiveRegion="polite">
          <Text style={styles.timerText}>{restFor}s rest</Text>
          <Button
            quiet
            label="+30s"
            onPress={() => setRestUntil((t) => (t ?? Date.now()) + 30_000)}
          />
          <Button quiet label="Skip" onPress={() => setRestUntil(null)} />
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
              item={item}
              names={names}
              log={log}
              state={state}
              now={now}
              clock={clock}
              onClock={(next) => {
                setClock(next);
                setNow(Date.now());
              }}
              onTicked={startRest}
            />
          ))}
        </View>
      ))}
      {finishing ? (
        <View style={styles.warning}>
          <Text style={styles.warningText}>Not ticked: {finishing}.</Text>
          <View style={styles.row}>
            <Button label="Finish anyway" onPress={() => void finish(true)} />
            <Button quiet label="Keep going" onPress={() => setFinishing(null)} />
          </View>
        </View>
      ) : null}
      {said ? <Text accessibilityLiveRegion="polite">{said}</Text> : null}
      {session.state === "done" ? (
        <Text style={styles.heading}>Done</Text>
      ) : (
        <Button label="Finish session" busy={mark.isPending} onPress={() => void finish(false)} />
      )}
    </Screen>
  );
}

function NativeItem({
  item,
  names,
  log,
  state,
  now,
  clock,
  onClock,
  onTicked,
}: {
  item: Item;
  names: Map<string, SessionExercise>;
  log: Log;
  state: LogState;
  now: number;
  clock: { key: string; from: number } | null;
  onClock: (next: { key: string; from: number } | null) => void;
  onTicked: (target: SetTarget | undefined) => void;
}) {
  const levels = item.kind === "levels" ? item.levels : [];
  const chosen = levelOf(state, item.label);
  const level = levels.find((l) => l.level === chosen);
  const list = item.kind === "all" ? item.exercises : level ? levelExercises(level) : [];
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
              onPress={() => log.dispatch({ type: "level", item: item.label, level: l.level })}
            />
          ))}
        </View>
      ) : null}
      {item.kind === "levels" && !level ? (
        <Text style={styles.muted}>Choose the level you take to log it.</Text>
      ) : null}
      {list.map((p) => (
        <NativeExercise
          key={p.exercise}
          itemLabel={item.label}
          exerciseId={p.exercise}
          targets={p.sets}
          note={p.note}
          exercise={names.get(p.exercise)}
          log={log}
          state={state}
          now={now}
          clock={clock}
          onClock={onClock}
          onTicked={onTicked}
        />
      ))}
    </View>
  );
}

function NativeExercise({
  itemLabel,
  exerciseId,
  targets,
  note,
  exercise,
  log,
  state,
  now,
  clock,
  onClock,
  onTicked,
}: {
  itemLabel: string;
  exerciseId: string;
  targets: SetTarget[];
  note: string | undefined;
  exercise: SessionExercise | undefined;
  log: Log;
  state: LogState;
  now: number;
  clock: { key: string; from: number } | null;
  onClock: (next: { key: string; from: number } | null) => void;
  onTicked: (target: SetTarget | undefined) => void;
}) {
  const folded = exerciseDone(state, itemLabel, exerciseId);
  const [open, setOpen] = useState(false);
  const name = exercise?.name ?? "Exercise";
  const withLoad = weighed(
    state.exercises[exerciseKey(itemLabel, exerciseId)],
    exercise?.measure ?? null,
  );
  if (folded && !open) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name}, all sets done. Show the sets`}
        onPress={() => setOpen(true)}
        style={styles.folded}
      >
        <Text style={styles.name}>✓ {name}</Text>
        <Text style={styles.muted}>{targets.length} sets done</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.exercise}>
      <Pressable accessibilityRole="button" disabled={!folded} onPress={() => setOpen(false)}>
        <Text style={styles.name}>{name}</Text>
      </Pressable>
      <Text style={styles.muted}>{describeSets(targets)}</Text>
      {note ? <Text>{note}</Text> : null}
      {exercise?.last.length ? (
        <Text style={styles.muted}>
          Last time:{" "}
          {exercise.last
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
      {targets.map((target, i) => (
        <NativeSet
          // biome-ignore lint/suspicious/noArrayIndexKey: sets are positions.
          key={i}
          itemLabel={itemLabel}
          exerciseId={exerciseId}
          setNumber={i + 1}
          target={target}
          withLoad={withLoad}
          log={log}
          state={state}
          now={now}
          clock={clock}
          onClock={onClock}
          onTicked={onTicked}
        />
      ))}
    </View>
  );
}

function NativeSet({
  itemLabel,
  exerciseId,
  setNumber,
  target,
  withLoad,
  log,
  state,
  now,
  clock,
  onClock,
  onTicked,
}: {
  itemLabel: string;
  exerciseId: string;
  setNumber: number;
  target: SetTarget;
  withLoad: boolean;
  log: Log;
  state: LogState;
  now: number;
  clock: { key: string; from: number } | null;
  onClock: (next: { key: string; from: number } | null) => void;
  onTicked: (target: SetTarget | undefined) => void;
}) {
  const at = { item: itemLabel, exercise: exerciseId, setNumber };
  const row = setRow(state, itemLabel, exerciseId, setNumber);
  const [effortOpen, setEffortOpen] = useState(false);
  const count: SetField = timed(target) ? "seconds" : "reps";
  const key = setKey(itemLabel, exerciseId, setNumber);
  const running = clock?.key === key;
  const field = (name: SetField, label: string, keyboard: "number-pad" | "decimal-pad") => (
    <TextInput
      accessibilityLabel={`Set ${setNumber} ${label}`}
      keyboardType={keyboard}
      // A suggestion is greyed (the placeholder); what the person typed or ticked is the value.
      placeholder={row.suggested ? (row.values[name] ?? label) : label}
      placeholderTextColor={theme.color.muted}
      value={row.suggested ? "" : (row.values[name] ?? "")}
      onChangeText={(text) => log.dispatch({ type: "edit", ...at, field: name, text })}
      selectTextOnFocus
      style={[styles.input, row.done ? styles.inputDone : null]}
    />
  );
  return (
    <View style={styles.set}>
      <View style={styles.setRow}>
        <Text style={styles.setNumber}>{setNumber}</Text>
        {field(count, count === "reps" ? "reps" : "s", "number-pad")}
        {withLoad ? field("load", "kg", "decimal-pad") : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            row.rpe !== null ? `Set ${setNumber} effort ${row.rpe}` : `Set ${setNumber} effort`
          }
          onPress={() => setEffortOpen((o) => !o)}
          style={styles.effort}
        >
          <Text style={row.rpe !== null ? styles.effortSet : styles.muted}>
            {row.rpe !== null ? `@${row.rpe}` : "RPE"}
          </Text>
        </Pressable>
        {timed(target) && !row.done ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={running ? `Stop set ${setNumber}` : `Start set ${setNumber}`}
            onPress={() => {
              if (!running) {
                onClock({ key, from: Date.now() });
                return;
              }
              onClock(null);
              const seconds = String(secondsBetween(clock?.from ?? Date.now(), Date.now()));
              log.dispatch({ type: "tick", ...at, values: { seconds } });
              onTicked(target);
            }}
            style={[styles.clock, running ? styles.clockRunning : null]}
          >
            <Text style={running ? styles.tickMarkDone : styles.heading}>
              {running ? `${secondsBetween(clock?.from ?? now, now)}s ■` : "▶"}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={`Set ${setNumber} done`}
          accessibilityState={{ checked: row.done }}
          hitSlop={8}
          onPress={() => {
            if (!row.done) onTicked(target);
            log.dispatch({ type: "toggle", ...at });
          }}
          style={[styles.tick, row.done ? styles.tickDone : null]}
        >
          <Text style={row.done ? styles.tickMarkDone : styles.tickMark}>✓</Text>
        </Pressable>
      </View>
      <Text style={styles.muted}>{describeSet(target)}</Text>
      {effortOpen ? (
        <View style={styles.row}>
          {EFFORTS.map((e) => (
            <Pressable
              key={e}
              accessibilityRole="button"
              accessibilityLabel={`Effort ${e}`}
              accessibilityState={{ selected: row.rpe === e }}
              onPress={() => {
                log.dispatch({ type: "rpe", ...at, rpe: row.rpe === e ? null : e });
                setEffortOpen(false);
              }}
              style={[styles.chip, row.rpe === e ? styles.chipOn : null]}
            >
              <Text style={row.rpe === e ? styles.tickMarkDone : styles.heading}>{e}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {row.error ? <Text style={styles.error}>{row.error}</Text> : null}
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
  folded: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: theme.space.sm,
  },
  set: { gap: 2, paddingVertical: theme.space.xs },
  setRow: { flexDirection: "row", alignItems: "center", gap: theme.space.sm },
  setNumber: { width: 20, color: theme.color.muted, fontWeight: "600" },
  input: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius,
    paddingHorizontal: theme.space.sm,
    fontSize: theme.font.body,
    color: theme.color.text,
    backgroundColor: theme.color.background,
    textAlign: "center",
  },
  inputDone: { borderColor: theme.color.primary },
  effort: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  effortSet: { fontWeight: "600", color: theme.color.text },
  clock: {
    minWidth: 56,
    minHeight: 44,
    borderRadius: theme.radius,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.background,
  },
  clockRunning: { backgroundColor: theme.color.primary },
  tick: {
    width: 44,
    height: 44,
    borderRadius: theme.radius,
    borderWidth: 2,
    borderColor: theme.color.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.background,
  },
  tickDone: { backgroundColor: theme.color.primary, borderColor: theme.color.primary },
  tickMark: { fontSize: 20, color: theme.color.muted },
  tickMarkDone: { fontSize: 18, fontWeight: "700", color: theme.color.onPrimary },
  chip: {
    minWidth: 44,
    minHeight: 40,
    borderRadius: theme.radius,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.background,
  },
  chipOn: { backgroundColor: theme.color.primary },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  progress: { gap: theme.space.xs },
  track: { height: 6, borderRadius: 3, backgroundColor: theme.color.surface, overflow: "hidden" },
  fill: { height: 6, backgroundColor: theme.color.primary },
  warning: {
    gap: theme.space.sm,
    padding: theme.space.sm,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.color.danger,
  },
  warningText: { color: theme.color.text },
  error: { color: theme.color.danger, fontSize: theme.font.small },
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
