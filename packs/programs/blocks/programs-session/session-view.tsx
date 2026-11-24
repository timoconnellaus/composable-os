// One session to do (stage 41): the workout logger, built on the web base layer. Its plan with
// every target and last time's numbers; a row per set with its numbers and a tick. One tap on a
// tick logs the set with the numbers shown (a suggestion, greyed, until the person types; a number
// still being typed counts); a tick of a done set takes it back, and typing over a done set's
// numbers changes it. Effort (RPE) is an optional tap. A tick starts the rest timer (the set's rest,
// else `defaultRest`); a timed set has a start/stop timer that fills its seconds and ticks it; an
// exercise folds away when its last set is ticked; the sets done show at the top; finishing says
// what was not ticked. For a member (their own, or a class's: they choose the level they take) and
// for a coach logging for a client (`personId`).
//
// It is the mobile session's logic (`useSessionLog`, the pack's one queue): every change shows at
// once and is saved in order, retried when it fails, and flushed when the page is hidden. It holds
// no rules: the targets, the last numbers and whose session it is come from the host; a set is
// logged by the host, which takes its target from the plan, refuses a session the caller may not
// log on and says why it refused a set; effort's bounds are the host's too.
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
  type Prescription,
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
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";
import { Input } from "../ui-input/input.tsx";

type Programs = Pick<ProgramsHooks, "useMarkSession" | "useSessionLog">;
type Log = ReturnType<Programs["useSessionLog"]>["log"];
type Clock = { key: string; from: number } | null;

/** What every row of the session is given. */
interface Shared {
  log: Log;
  state: LogState;
  now: number;
  clock: Clock;
  onClock: (next: Clock) => void;
  onTicked: (target: SetTarget | undefined) => void;
}

export function SessionView({
  programs,
  sessionId,
  personId,
  onRestDone,
  defaultRest = 90,
}: {
  programs: Programs;
  sessionId: string;
  /** A coach logging for a client names them. */
  personId?: string;
  /** Called when a rest ends (a sound, a buzz): the app's. */
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
  const [clock, setClock] = useState<Clock>(null);
  const [finishing, setFinishing] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  // Nothing waits when the page is hidden or the view closed: what is queued is sent now.
  useEffect(() => {
    const target = globalThis as unknown as {
      addEventListener?: (name: string, fn: () => void) => void;
      removeEventListener?: (name: string, fn: () => void) => void;
    };
    const send = () => void log.flush();
    target.addEventListener?.("pagehide", send);
    target.addEventListener?.("visibilitychange", send);
    return () => {
      target.removeEventListener?.("pagehide", send);
      target.removeEventListener?.("visibilitychange", send);
      send();
    };
  }, [log]);
  const ticking = restUntil !== null || clock !== null;
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [ticking]);
  useEffect(() => {
    if (restUntil !== null && now >= restUntil) {
      setRestUntil(null);
      onRestDone?.();
    }
  }, [now, restUntil, onRestDone]);

  if (detail.isPending) return <p aria-busy="true">Loading the session…</p>;
  if (detail.error || !detail.data) return <p role="alert">We could not load this session.</p>;
  const { session, exercises } = detail.data;
  const plan = session.plan as unknown as Session | null;
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const progress = progressOf(state);
  const waiting = unsaved(state);
  const restFor = restUntil === null ? null : secondsBetween(now, restUntil);
  const shared: Shared = {
    log,
    state,
    now,
    clock,
    onClock: (next) => {
      setClock(next);
      setNow(Date.now());
    },
    onTicked: (target) => {
      setRestUntil(Date.now() + restAfter(target, defaultRest) * 1000);
      setNow(Date.now());
    },
  };
  const finish = async (anyway: boolean) => {
    setSaid(null);
    const missing = notTickedText(state, (id) => byId.get(id)?.name);
    if (missing && !anyway) {
      setFinishing(missing);
      return;
    }
    setFinishing(null);
    if (!(await log.flush())) {
      setSaid(
        "Some sets are not saved yet. They stay here and are sent when the connection is back: try finishing again then.",
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
    <Card data-testid="session-view">
      <CardHeader>
        <CardTitle>{session.name}</CardTitle>
        <CardDescription>
          {[session.programTitle, session.classTypeName, session.date, session.focus]
            .filter(Boolean)
            .join(" · ")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-1" data-testid="progress">
          <span className="text-sm font-medium">
            {progress.done} of {progress.planned} sets
          </span>
          <progress className="h-1.5 w-full" max={progress.planned || 1} value={progress.done} />
        </div>
        {waiting && state.failure ? (
          <div
            role="alert"
            className="flex items-center gap-3 rounded-md border border-destructive p-3 text-sm"
          >
            <span>
              {waiting === 1 ? "1 set is" : `${waiting} sets are`} not saved yet. {state.failure}
            </span>
            <Button size="sm" variant="outline" onClick={() => void log.flush()}>
              Try now
            </Button>
          </div>
        ) : null}
        {restFor !== null ? (
          <div
            role="timer"
            aria-live="polite"
            className="flex items-center gap-3 rounded-md bg-muted p-3"
          >
            <strong className="text-2xl tabular-nums">{restFor}s</strong> rest
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRestUntil((t) => (t ?? Date.now()) + 30_000)}
            >
              +30 s
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRestUntil(null)}>
              Skip
            </Button>
          </div>
        ) : null}
        {plan?.warmup?.text || plan?.warmup?.exercises?.length ? (
          <section aria-label="Warm-up" className="grid gap-1 text-sm">
            <h3 className="font-semibold">Warm-up</h3>
            {plan.warmup.text ? <p className="whitespace-pre-wrap">{plan.warmup.text}</p> : null}
            <ul>
              {(plan.warmup.exercises ?? []).map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: warm-up lines are positions.
                <li key={i}>
                  {byId.get(p.exercise)?.name ?? "Exercise"}: {describeSets(p.sets)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {(plan?.notes ?? []).map((n) => (
          <p key={n.text} className="text-sm italic">
            {n.text}
          </p>
        ))}
        {(plan?.blocks ?? []).map((block) => (
          <section key={block.label} aria-label={`Block ${block.label}`} className="grid gap-3">
            <h3 className="font-semibold">
              Block {block.label}
              {block.rounds ? ` · ${block.rounds} rounds` : ""}
            </h3>
            {(block.notes ?? []).map((n) => (
              <p key={n.text} className="text-sm italic">
                {n.text}
              </p>
            ))}
            {block.items.map((item) => (
              <ItemToDo key={item.label} item={item} exercises={byId} shared={shared} />
            ))}
          </section>
        ))}
        {finishing ? (
          <div role="alert" className="grid gap-2 rounded-md border p-3 text-sm">
            <p>Not ticked: {finishing}.</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void finish(true)}>
                Finish anyway
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFinishing(null)}>
                Keep going
              </Button>
            </div>
          </div>
        ) : null}
        {said ? <p aria-live="polite">{said}</p> : null}
        <div className="flex gap-2">
          {session.state === "done" ? (
            <Button disabled>Done</Button>
          ) : (
            <Button disabled={mark.isPending} onClick={() => void finish(false)}>
              Finish session
            </Button>
          )}
          {session.kind === "personal" && session.state !== "done" ? (
            <Button
              variant="ghost"
              disabled={mark.isPending}
              onClick={async () => {
                await mark.mutateAsync({ sessionId, state: "skipped" });
                detail.refetch?.();
              }}
            >
              Skip this session
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function ItemToDo({
  item,
  exercises,
  shared,
}: {
  item: Item;
  exercises: Map<string, SessionExercise>;
  shared: Shared;
}) {
  const levels = item.kind === "levels" ? item.levels : [];
  const chosen = levelOf(shared.state, item.label);
  const level = levels.find((l) => l.level === chosen);
  // Everyone's exercises (beside the levels, if any), then the level's.
  const prescriptions =
    item.kind === "all"
      ? item.exercises
      : [...(item.exercises ?? []), ...(level ? levelExercises(level) : [])];
  return (
    <div
      className="grid gap-2 rounded-md border p-3"
      data-testid="item-to-do"
      data-item={item.label}
    >
      <div className="font-medium">{item.label}</div>
      {(item.notes ?? []).map((n) => (
        <p key={n.text} className="text-sm italic">
          {n.text}
        </p>
      ))}
      {levels.length > 1 ? (
        <fieldset className="flex flex-wrap gap-1" aria-label="The level you take">
          {levels.map((l) => (
            <Button
              key={l.level}
              size="sm"
              variant={l.level === level?.level ? "default" : "outline"}
              aria-pressed={l.level === level?.level}
              onClick={() =>
                shared.log.dispatch({ type: "level", item: item.label, level: l.level })
              }
            >
              {levelLabel(l)}
            </Button>
          ))}
        </fieldset>
      ) : null}
      {level?.mode === "alternatives" ? (
        <p className="text-xs text-muted-foreground">Do one of these.</p>
      ) : null}
      {prescriptions.map((p) => (
        <ExerciseToDo
          key={p.exercise}
          itemLabel={item.label}
          prescription={p}
          exercise={exercises.get(p.exercise)}
          shared={shared}
        />
      ))}
      {item.kind === "levels" && !level ? (
        <p className="text-sm">Choose the level you take to log it.</p>
      ) : null}
    </div>
  );
}

function ExerciseToDo({
  itemLabel,
  prescription,
  exercise,
  shared,
}: {
  itemLabel: string;
  prescription: Prescription;
  exercise: SessionExercise | undefined;
  shared: Shared;
}) {
  const [open, setOpen] = useState(false);
  const folded = exerciseDone(shared.state, itemLabel, prescription.exercise);
  const last = exercise?.last ?? [];
  const name = exercise?.name ?? "Exercise";
  const withLoad = weighed(
    shared.state.exercises[exerciseKey(itemLabel, prescription.exercise)],
    exercise?.measure ?? null,
  );
  if (folded && !open) {
    return (
      <button
        type="button"
        className="flex items-baseline justify-between text-left text-sm"
        data-testid="exercise-folded"
        onClick={() => setOpen(true)}
      >
        <strong>✓ {name}</strong>
        <span className="text-muted-foreground">{prescription.sets.length} sets done</span>
      </button>
    );
  }
  return (
    <div className="grid gap-2" data-testid="exercise-to-do">
      <div className="flex flex-wrap items-baseline gap-2">
        <strong>{name}</strong>
        <span className="text-sm text-muted-foreground">{describeSets(prescription.sets)}</span>
        {exercise?.video ? (
          <a href={exercise.video} target="_blank" rel="noreferrer" className="text-sm underline">
            Demo
          </a>
        ) : null}
        {folded ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Fold
          </Button>
        ) : null}
      </div>
      {prescription.note ? <p className="text-sm">{prescription.note}</p> : null}
      {exercise?.cues ? <p className="text-xs text-muted-foreground">{exercise.cues}</p> : null}
      {last.length ? (
        <p className="text-xs text-muted-foreground" data-testid="last-time">
          Last time ({last[0]?.date}):{" "}
          {last
            .map((s) =>
              [
                s.reps !== null ? `${s.reps} reps` : null,
                s.seconds !== null ? `${s.seconds} s` : null,
                s.load !== null ? `${s.load} kg` : null,
              ]
                .filter(Boolean)
                .join(" "),
            )
            .join(", ")}
        </p>
      ) : null}
      <ol className="grid gap-1">
        {prescription.sets.map((set, i) => (
          <SetRow
            // biome-ignore lint/suspicious/noArrayIndexKey: sets are positions.
            key={i}
            itemLabel={itemLabel}
            exerciseId={prescription.exercise}
            setNumber={i + 1}
            target={set}
            withLoad={withLoad}
            shared={shared}
          />
        ))}
      </ol>
    </div>
  );
}

function SetRow({
  itemLabel,
  exerciseId,
  setNumber,
  target,
  withLoad,
  shared,
}: {
  itemLabel: string;
  exerciseId: string;
  setNumber: number;
  target: SetTarget;
  withLoad: boolean;
  shared: Shared;
}) {
  const { log, state, now, clock, onClock, onTicked } = shared;
  const at = { item: itemLabel, exercise: exerciseId, setNumber };
  const row = setRow(state, itemLabel, exerciseId, setNumber);
  const [effortOpen, setEffortOpen] = useState(false);
  const count: SetField = timed(target) ? "seconds" : "reps";
  const key = setKey(itemLabel, exerciseId, setNumber);
  const running = clock?.key === key;
  const field = (name: SetField, label: string, mode: "numeric" | "decimal") => (
    <Input
      aria-label={`Set ${setNumber} ${name === "load" ? "load" : `${name} done`}`}
      className={`h-9 w-16 text-center ${row.suggested ? "placeholder:text-muted-foreground" : ""}`}
      inputMode={mode}
      // A suggestion is greyed (the placeholder); what the person typed or ticked is the value.
      placeholder={row.suggested ? (row.values[name] ?? label) : label}
      value={row.suggested ? "" : (row.values[name] ?? "")}
      onChange={(e) => log.dispatch({ type: "edit", ...at, field: name, text: e.target.value })}
    />
  );
  return (
    <li className="grid gap-1 text-sm" data-testid="set-row" data-done={row.done}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-6 font-medium text-muted-foreground">{setNumber}</span>
        {field(count, count === "reps" ? "reps" : "s", "numeric")}
        {withLoad ? field("load", "kg", "decimal") : null}
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Set ${setNumber} effort`}
          aria-expanded={effortOpen}
          onClick={() => setEffortOpen((o) => !o)}
        >
          {row.rpe !== null ? `@${row.rpe}` : "RPE"}
        </Button>
        {timed(target) && !row.done ? (
          <Button
            size="sm"
            variant={running ? "default" : "outline"}
            onClick={() => {
              if (!running) {
                onClock({ key, from: Date.now() });
                return;
              }
              onClock(null);
              const seconds = String(secondsBetween(clock?.from ?? Date.now(), Date.now()));
              log.dispatch({ type: "tick", ...at, values: { seconds } });
              onTicked(target);
            }}
          >
            {running ? `Stop ${secondsBetween(clock?.from ?? now, now)} s` : "Start"}
          </Button>
        ) : null}
        <button
          type="button"
          aria-pressed={row.done}
          aria-label={`Set ${setNumber} done`}
          className={`flex h-9 w-9 items-center justify-center rounded-md border-2 ${row.done ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground"}`}
          // Before the field loses focus: the tick takes the number as typed.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!row.done) onTicked(target);
            log.dispatch({ type: "toggle", ...at });
          }}
        >
          ✓
        </button>
        <span className="text-muted-foreground">{describeSet(target)}</span>
      </div>
      {effortOpen ? (
        <fieldset className="flex flex-wrap gap-1" aria-label={`Set ${setNumber} effort`}>
          {EFFORTS.map((e) => (
            <Button
              key={e}
              size="sm"
              variant={row.rpe === e ? "default" : "outline"}
              aria-pressed={row.rpe === e}
              onClick={() => {
                log.dispatch({ type: "rpe", ...at, rpe: row.rpe === e ? null : e });
                setEffortOpen(false);
              }}
            >
              {e}
            </Button>
          ))}
        </fieldset>
      ) : null}
      {row.error ? (
        <span role="alert" className="text-destructive">
          {row.error}
        </span>
      ) : null}
    </li>
  );
}
