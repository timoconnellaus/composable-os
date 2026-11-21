// History and progress (stage 41): per exercise, a person's sets over time and their bests; per
// program, sessions done against planned. For a member (themselves) or a coach (`personId`).
// Built on the web base layer. The sets and the bests are worked out by the host
// (`useProgress`, `useHistory`); this lays them out.
import type { ProgramsHooks } from "@composable-os/pack-programs/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../ui-card/card.tsx";

const best = (b: { load: number | null; reps: number | null; seconds: number | null }) =>
  [
    b.load !== null ? `${b.load} kg` : null,
    b.reps !== null ? `${b.reps} reps` : null,
    b.seconds !== null ? `${b.seconds} s` : null,
  ]
    .filter(Boolean)
    .join(" · ") || "—";

export function Progress({ programs, personId }: { programs: ProgramsHooks; personId?: string }) {
  const progress = programs.useProgress(personId ? { personId } : {});
  const [exercise, setExercise] = useState<string | null>(null);
  if (progress.isPending) return <p aria-busy="true">Loading progress…</p>;
  if (progress.error || !progress.data) return <p role="alert">We could not load progress.</p>;
  return (
    <div className="grid gap-4" data-testid="progress">
      <Card>
        <CardHeader>
          <CardTitle>Programs</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-1 text-sm">
            {progress.data.assignments.map((a) => (
              <li key={a.id}>
                {a.title}: {a.done} done, {a.skipped} skipped, {a.planned} to come, of {a.sessions}
              </li>
            ))}
            {!progress.data.assignments.length ? <li>No program yet.</li> : null}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Exercises</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th>Exercise</th>
                <th>Sets</th>
                <th>Since</th>
                <th>Best</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {progress.data.exercises.map((e) => (
                <tr key={e.id}>
                  <td>{e.name}</td>
                  <td>{e.sets}</td>
                  <td>{e.first}</td>
                  <td>{best(e.best)}</td>
                  <td>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setExercise(exercise === e.id ? null : e.id)}
                    >
                      History
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {progress.data.capped ? (
            <p className="text-xs">Worked out over the latest sets only.</p>
          ) : null}
        </CardContent>
      </Card>
      {exercise ? (
        <History programs={programs} exerciseId={exercise} {...(personId ? { personId } : {})} />
      ) : null}
    </div>
  );
}

export function History({
  programs,
  exerciseId,
  personId,
}: {
  programs: ProgramsHooks;
  exerciseId: string;
  personId?: string;
}) {
  const history = programs.useHistory({ exerciseId, ...(personId ? { personId } : {}) });
  if (history.isPending) return <p aria-busy="true">Loading history…</p>;
  if (!history.data) return <p role="alert">We could not load this exercise's history.</p>;
  return (
    <Card data-testid="history">
      <CardHeader>
        <CardTitle>{history.data.exercise.name}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <p>Best: {best(history.data.best)}</p>
        <table className="w-full">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th>Date</th>
              <th>Set</th>
              <th>Level</th>
              <th>Target</th>
              <th>Done</th>
              <th>RPE</th>
            </tr>
          </thead>
          <tbody>
            {history.data.sets.map((s) => (
              <tr key={s.id}>
                <td>{s.date}</td>
                <td>{s.setNumber}</td>
                <td>{s.level ?? ""}</td>
                <td>
                  {[
                    s.target.reps,
                    s.target.seconds !== null ? `${s.target.seconds}s` : null,
                    s.target.load !== null ? `${s.target.load}kg` : null,
                  ]
                    .filter((v) => v !== null)
                    .join(" ")}
                </td>
                <td>
                  {[
                    s.actual.reps,
                    s.actual.seconds !== null ? `${s.actual.seconds}s` : null,
                    s.actual.load !== null ? `${s.actual.load}kg` : null,
                  ]
                    .filter((v) => v !== null)
                    .join(" ")}
                </td>
                <td>{s.rpe ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
