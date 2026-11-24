// History and progress, for the mobile app (stage 41): sessions done per program, and per
// exercise the sets and bests the host worked out; pressing an exercise shows its sets.
import type { ProgramsHooks } from "@composable-os/pack-programs/client";
import { useState } from "react";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";
import { Text } from "../native-base/text.tsx";

const best = (b: { load: number | null; reps: number | null; seconds: number | null }) =>
  [
    b.load !== null ? `${b.load} kg` : null,
    b.reps !== null ? `${b.reps} reps` : null,
    b.seconds !== null ? `${b.seconds} s` : null,
  ]
    .filter(Boolean)
    .join(" · ");

export function ProgressScreen({
  programs,
  personId,
}: {
  programs: Pick<ProgramsHooks, "useHistory" | "useProgress">;
  personId?: string;
}) {
  const progress = programs.useProgress(personId ? { personId } : {});
  const [exercise, setExercise] = useState<string | null>(null);
  const history = programs.useHistory({
    exerciseId: exercise ?? "none",
    ...(personId ? { personId } : {}),
  });
  if (!progress.data)
    return (
      <Screen title="Progress">
        {progress.error ? (
          <Text tone="danger" accessibilityRole="alert">
            We could not load your progress. Check the connection and try again.
          </Text>
        ) : (
          <Text tone="muted" accessibilityRole="progressbar">
            Loading…
          </Text>
        )}
      </Screen>
    );
  return (
    <Screen title="Progress">
      <List empty="No program yet.">
        {progress.data.assignments.map((a) => (
          <Row key={a.id} title={a.title ?? "Program"} detail={`${a.done} of ${a.sessions} done`} />
        ))}
      </List>
      <List empty="Nothing logged yet.">
        {progress.data.exercises.map((e) => (
          <Row
            key={e.id}
            title={e.name ?? "Exercise"}
            detail={`${e.sets} sets · best ${best(e.best)}`}
            onPress={() => setExercise(e.id)}
          />
        ))}
      </List>
      {exercise && history.error ? (
        <Text tone="danger" accessibilityRole="alert">
          We could not load the sets. Check the connection and try again.
        </Text>
      ) : null}
      {exercise && history.data ? (
        <List>
          {history.data.sets.map((s) => (
            <Row
              key={s.id}
              title={`${s.date ?? ""} · set ${s.setNumber ?? ""}${s.level ? ` · level ${s.level}` : ""}`}
              detail={[
                s.actual.reps,
                s.actual.seconds !== null ? `${s.actual.seconds}s` : null,
                s.actual.load !== null ? `${s.actual.load}kg` : null,
                s.rpe !== null ? `RPE ${s.rpe}` : null,
              ]
                .filter((x) => x !== null)
                .join(" ")}
            />
          ))}
        </List>
      ) : null}
    </Screen>
  );
}
