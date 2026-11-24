// One session to do (stage 41): its plan with every target, last time's numbers at each exercise,
// a row per set to log what was done and how hard it felt, a rest timer after each set, and
// marking the session done. For a member (their own, or a class's: they choose the level they
// take) and for a coach logging for a client (`personId`). Built on the web base layer.
//
// It holds no rules: the targets, the last numbers and whose session it is come from the host
// (`useSession`); a set is logged by the host, which takes its target from the plan and refuses a
// session the caller may not log on; effort's bounds are the host's too.
import {
  describeSet,
  describeSets,
  type Item,
  type Level,
  levelExercises,
  levelLabel,
  loggedFor,
  numberFrom,
  type Prescription,
  type ProgramsHooks,
  type Session,
  type SessionExercise,
  type SetTarget,
} from "@composable-os/pack-programs/client";
import { useEffect, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";
import { Input } from "../ui-input/input.tsx";

export function SessionView({
  programs,
  sessionId,
  personId,
  onRestDone,
}: {
  programs: Pick<ProgramsHooks, "useLogSet" | "useMarkSession" | "useSession" | "useUpdateSet">;
  sessionId: string;
  /** A coach logging for a client names them on a class session. */
  personId?: string;
  /** Called when a rest ends (a sound, a buzz): the app's. */
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

  if (detail.isPending) return <p aria-busy="true">Loading the session…</p>;
  if (detail.error || !detail.data) return <p role="alert">We could not load this session.</p>;
  const { session, exercises, logged } = detail.data;
  const plan = session.plan as unknown as Session | null;
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const refresh = () => detail.refetch?.();

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
        {rest !== null ? (
          <div
            role="timer"
            aria-live="polite"
            className="flex items-center gap-3 rounded-md bg-muted p-3"
          >
            <strong className="text-2xl tabular-nums">{rest}s</strong> rest
            <Button size="sm" variant="ghost" onClick={() => setRest(null)}>
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
              <ItemToDo
                key={item.label}
                programs={programs}
                sessionId={sessionId}
                personId={personId}
                item={item}
                exercises={byId}
                logged={logged}
                onLogged={(target) => {
                  refresh();
                  if (target?.rest) setRest(target.rest);
                }}
              />
            ))}
          </section>
        ))}
        {session.kind === "personal" ? (
          <div className="flex gap-2">
            <Button
              disabled={mark.isPending || session.state === "done"}
              onClick={async () => {
                await mark.mutateAsync({ sessionId, state: "done" });
                refresh();
              }}
            >
              {session.state === "done" ? "Done" : "Mark done"}
            </Button>
            {session.state !== "done" ? (
              <Button
                variant="ghost"
                disabled={mark.isPending}
                onClick={async () => {
                  await mark.mutateAsync({ sessionId, state: "skipped" });
                  refresh();
                }}
              >
                Skip this session
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ItemToDo({
  programs,
  sessionId,
  personId,
  item,
  exercises,
  logged,
  onLogged,
}: {
  programs: Pick<ProgramsHooks, "useLogSet" | "useMarkSession" | "useSession" | "useUpdateSet">;
  sessionId: string;
  personId: string | undefined;
  item: Item;
  exercises: Map<string, SessionExercise>;
  logged: Parameters<typeof loggedFor>[0];
  onLogged: (target: SetTarget | undefined) => void;
}) {
  const taken = logged.find((l) => l.item === item.label)?.level ?? null;
  const [chosen, setChosen] = useState<number | null>(taken);
  const levels = item.kind === "levels" ? item.levels : [];
  const level: Level | undefined =
    levels.find((l) => l.level === chosen) ?? (levels.length === 1 ? levels[0] : undefined);
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
              onClick={() => setChosen(l.level)}
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
          programs={programs}
          sessionId={sessionId}
          personId={personId}
          itemLabel={item.label}
          level={item.kind === "levels" ? level?.level : undefined}
          prescription={p}
          exercise={exercises.get(p.exercise)}
          logged={logged}
          onLogged={onLogged}
        />
      ))}
      {item.kind === "levels" && !level ? (
        <p className="text-sm">Choose the level you take to log it.</p>
      ) : null}
    </div>
  );
}

function ExerciseToDo({
  programs,
  sessionId,
  personId,
  itemLabel,
  level,
  prescription,
  exercise,
  logged,
  onLogged,
}: {
  programs: Pick<ProgramsHooks, "useLogSet" | "useMarkSession" | "useSession" | "useUpdateSet">;
  sessionId: string;
  personId: string | undefined;
  itemLabel: string;
  level: number | undefined;
  prescription: Prescription;
  exercise: SessionExercise | undefined;
  logged: Parameters<typeof loggedFor>[0];
  onLogged: (target: SetTarget | undefined) => void;
}) {
  const last = exercise?.last ?? [];
  return (
    <div className="grid gap-2" data-testid="exercise-to-do">
      <div className="flex flex-wrap items-baseline gap-2">
        <strong>{exercise?.name ?? "Exercise"}</strong>
        <span className="text-sm text-muted-foreground">{describeSets(prescription.sets)}</span>
        {exercise?.video ? (
          <a href={exercise.video} target="_blank" rel="noreferrer" className="text-sm underline">
            Demo
          </a>
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
            programs={programs}
            sessionId={sessionId}
            personId={personId}
            itemLabel={itemLabel}
            level={level}
            exerciseId={prescription.exercise}
            setNumber={i + 1}
            target={set}
            done={loggedFor(logged, itemLabel, prescription.exercise, i + 1)}
            onLogged={onLogged}
          />
        ))}
      </ol>
    </div>
  );
}

function SetRow({
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
  const busy = add.isPending || update.isPending;
  const actual = {
    ...(timed ? { seconds: numberFrom(count) } : { reps: numberFrom(count) }),
    ...(numberFrom(load) !== undefined ? { load: numberFrom(load) } : {}),
  };
  const rpe = numberFrom(effort);
  return (
    <li
      className="flex flex-wrap items-center gap-2 text-sm"
      data-testid="set-row"
      data-done={Boolean(done)}
    >
      <span className="w-12">Set {setNumber}</span>
      <span className="w-40 text-muted-foreground">{describeSet(target)}</span>
      <Input
        aria-label={`Set ${setNumber} ${timed ? "seconds" : "reps"} done`}
        className="h-8 w-16"
        inputMode="numeric"
        value={count}
        onChange={(e) => setCount(e.target.value)}
      />
      <Input
        aria-label={`Set ${setNumber} load`}
        placeholder="kg"
        className="h-8 w-16"
        inputMode="decimal"
        value={load}
        onChange={(e) => setLoad(e.target.value)}
      />
      <Input
        aria-label={`Set ${setNumber} effort`}
        placeholder="RPE"
        className="h-8 w-16"
        inputMode="decimal"
        value={effort}
        onChange={(e) => setEffort(e.target.value)}
      />
      <Button
        size="sm"
        variant={done ? "secondary" : "default"}
        disabled={busy}
        onClick={async () => {
          setError(null);
          try {
            if (done) {
              await update.mutateAsync({
                logId: done.id,
                actual,
                ...(rpe !== undefined ? { rpe } : {}),
              });
            } else {
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
            }
            onLogged(target);
          } catch (e) {
            setError((e as { message?: string }).message ?? "Not logged");
          }
        }}
      >
        {done ? "Update" : "Log set"}
      </Button>
      {done ? <span title="Logged">✓</span> : null}
      {error ? (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      ) : null}
    </li>
  );
}
