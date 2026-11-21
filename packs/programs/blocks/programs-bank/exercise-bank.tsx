// The exercise bank (stage 41): browse and search the gym's exercises, add one, and edit one with
// its easier and harder versions. Built on the web base layer. What an exercise may hold is the
// host's (a refused save shows its words); this edits the fields.
import type { ProgramsHooks, RecordOut } from "@composable-os/pack-programs/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../ui-card/card.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

const MEASURES = [
  { value: "weight_reps", label: "Weight and reps" },
  { value: "reps", label: "Reps" },
  { value: "time", label: "Time" },
  { value: "hold", label: "Hold" },
];

export function ExerciseBank({ programs }: { programs: ProgramsHooks }) {
  const [search, setSearch] = useState("");
  const bank = programs.useBank(search);
  const all = programs.useBank();
  const [editing, setEditing] = useState<RecordOut | "new" | null>(null);
  return (
    <div className="grid gap-4" data-testid="exercise-bank">
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Search the bank"
          placeholder="Search the bank"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <Button onClick={() => setEditing("new")}>Add exercise</Button>
      </div>
      {editing ? (
        <ExerciseForm
          programs={programs}
          exercise={editing === "new" ? null : editing}
          bank={all.data?.items ?? []}
          onDone={() => {
            setEditing(null);
            bank.refetch?.();
            all.refetch?.();
          }}
        />
      ) : null}
      <ul className="grid gap-2" aria-label="Exercises">
        {(bank.data?.items ?? []).map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
            <Button variant="link" onClick={() => setEditing(e)}>
              {String(e.values.name)}
            </Button>
            <span className="text-muted-foreground">
              {[
                MEASURES.find((m) => m.value === e.values.measure)?.label,
                e.values.theme,
                e.values.level,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
        {bank.data && !bank.data.items.length ? <li>No exercise matches.</li> : null}
      </ul>
    </div>
  );
}

function ExerciseForm({
  programs,
  exercise,
  bank,
  onDone,
}: {
  programs: ProgramsHooks;
  exercise: RecordOut | null;
  bank: RecordOut[];
  onDone: () => void;
}) {
  const create = programs.useCreateExercise();
  const update = programs.useUpdateExercise();
  const v = exercise?.values ?? {};
  const [name, setName] = useState(String(v.name ?? ""));
  const [video, setVideo] = useState(String(v.video ?? ""));
  const [cues, setCues] = useState(String(v.cues ?? ""));
  const [measure, setMeasure] = useState(String(v.measure ?? "reps"));
  const [easier, setEasier] = useState<string[]>((v.easier as string[] | null) ?? []);
  const [harder, setHarder] = useState<string[]>((v.harder as string[] | null) ?? []);
  const [error, setError] = useState<string | null>(null);
  const others = bank.filter((e) => e.id !== exercise?.id);
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const save = async () => {
    setError(null);
    const values = {
      name: name.trim(),
      video: video.trim() || null,
      cues: cues.trim() || null,
      measure,
      easier: easier.length ? easier : null,
      harder: harder.length ? harder : null,
    };
    try {
      if (exercise)
        await update.mutateAsync({ object: "programs.exercise", id: exercise.id, values });
      else await create.mutateAsync({ object: "programs.exercise", values });
      onDone();
    } catch (e) {
      setError((e as { message?: string }).message ?? "Not saved");
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{exercise ? `Edit ${String(v.name ?? "")}` : "New exercise"}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <div className="grid gap-1">
          <Label htmlFor="exercise-name">Name</Label>
          <Input id="exercise-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="exercise-video">Demo video (a link)</Label>
          <Input id="exercise-video" value={video} onChange={(e) => setVideo(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="exercise-cues">Coaching cues</Label>
          <textarea
            id="exercise-cues"
            className="min-h-16 rounded-md border p-2"
            value={cues}
            onChange={(e) => setCues(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="exercise-measure">Measured by</Label>
          <select
            id="exercise-measure"
            className="h-9 rounded-md border px-2"
            value={measure}
            onChange={(e) => setMeasure(e.target.value)}
          >
            {MEASURES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {[
          ["Easier versions", easier, setEasier] as const,
          ["Harder versions", harder, setHarder] as const,
        ].map(([label, list, set]) => (
          <fieldset key={label} className="grid gap-1">
            <legend className="text-xs text-muted-foreground">{label}</legend>
            <div className="flex flex-wrap gap-1">
              {others.map((e) => (
                <Button
                  key={e.id}
                  size="xs"
                  variant={list.includes(e.id) ? "default" : "outline"}
                  aria-pressed={list.includes(e.id)}
                  onClick={() => set(toggle(list, e.id))}
                >
                  {String(e.values.name)}
                </Button>
              ))}
            </div>
          </fieldset>
        ))}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            disabled={!name.trim() || create.isPending || update.isPending}
            onClick={() => void save()}
          >
            Save
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
