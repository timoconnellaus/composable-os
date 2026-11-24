// A person's past sessions (stage 41): newest first, each with its date, its name and how many of
// its sets were logged; one opened shows it set by set, read-only, with the target beside what was
// done, and a logged set can be corrected. For a member (their own) or a coach (`personId`, a
// client's). Built on the web base layer.
//
// It holds no rules: which sessions are the person's, the sets on each and what a correction may
// change are the host's (the seam for a member, `x.programs.logUpdate` for both: the numbers done,
// effort and the note, never the target, the exercise or who recorded it).
import {
  correctionOf,
  describeDone,
  describeSet,
  type LoggedSet,
  type PastSessionsHooks,
  type ProgramsHooks,
  pastSessionsHook,
  type Session,
  sessionSets,
} from "@composable-os/pack-programs/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";
import { Input } from "../ui-input/input.tsx";

type HistoryHooks = PastSessionsHooks & Pick<ProgramsHooks, "useSession" | "useUpdateSet">;

export function SessionHistory({
  programs,
  personId,
  until,
}: {
  /** A member's hooks (`usePastSessions`), or a coach's (`useClientPastSessions`). */
  programs: HistoryHooks;
  /** A coach's client. A member is always themselves. */
  personId?: string;
  /** The last date listed: the person's local today. Default today, UTC. */
  until?: string;
}) {
  // The cursors of the pages before this one: "Newer" goes back one.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const usePastPage = pastSessionsHook(programs, personId);
  const page = usePastPage({
    ...(until ? { until } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const [open, setOpen] = useState<string | null>(null);
  if (page.isPending) return <p aria-busy="true">Loading past sessions…</p>;
  if (page.error || !page.data) return <p role="alert">We could not load past sessions.</p>;
  const { sessions, nextCursor } = page.data;
  return (
    <div className="grid gap-3" data-testid="session-history">
      <ol className="grid gap-2" aria-label="Past sessions">
        {sessions.map((s) => (
          <li key={s.id} className="grid gap-2" data-testid="past-session">
            <Button
              variant={open === s.id ? "default" : "outline"}
              className="h-auto justify-between gap-3 py-2 text-left"
              aria-expanded={open === s.id}
              onClick={() => setOpen(open === s.id ? null : s.id)}
            >
              <span className="grid">
                <span className="font-medium">{s.name ?? "Session"}</span>
                <span className="text-xs opacity-80">
                  {[s.date, s.programTitle, s.state === "skipped" ? "skipped" : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="text-sm tabular-nums" data-testid="sets-done">
                {s.setsDone} of {s.setsPlanned} sets
              </span>
            </Button>
            {open === s.id ? (
              <PastSession programs={programs} sessionId={s.id} personId={personId} />
            ) : null}
          </li>
        ))}
      </ol>
      {!sessions.length && !cursor ? <p>No past sessions yet.</p> : null}
      <div className="flex gap-2">
        {cursor ? (
          <Button variant="ghost" size="sm" onClick={() => setCursors((c) => c.slice(0, -1))}>
            Newer
          </Button>
        ) : null}
        {nextCursor ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(null);
              setCursors((c) => [...c, nextCursor]);
            }}
          >
            Older
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** One past session, set by set: the target and what was done, and a correction per set. */
function PastSession({
  programs,
  sessionId,
  personId,
}: {
  programs: Pick<ProgramsHooks, "useSession" | "useUpdateSet">;
  sessionId: string;
  personId: string | undefined;
}) {
  const detail = programs.useSession({ sessionId, ...(personId ? { personId } : {}) });
  if (detail.isPending) return <p aria-busy="true">Loading the session…</p>;
  if (detail.error || !detail.data) return <p role="alert">We could not load this session.</p>;
  const { session, exercises, logged } = detail.data;
  const names = new Map(exercises.map((e) => [e.id, e.name]));
  const sets = sessionSets(session.plan as unknown as Session | null, logged);
  return (
    <Card data-testid="past-session-detail">
      <CardHeader>
        <CardTitle>{session.name}</CardTitle>
        <CardDescription>
          {[session.programTitle, session.date, session.focus].filter(Boolean).join(" · ")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-1 text-sm">
          {sets.map((s) => (
            <li
              key={`${s.item}-${s.exercise}-${s.setNumber}`}
              className="grid gap-1 border-b py-1 last:border-0"
              data-testid="past-set"
              data-item={s.item}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <strong>{s.item}</strong>
                <span>{s.logged?.exerciseName ?? names.get(s.exercise) ?? "Exercise"}</span>
                {s.level !== null ? (
                  <span className="text-xs text-muted-foreground">level {s.level}</span>
                ) : null}
                <span className="text-muted-foreground">
                  set {s.setNumber}
                  {s.target ? `: ${describeSet(s.target)}` : ""}
                </span>
              </div>
              {s.logged ? (
                <LoggedRow
                  programs={programs}
                  set={s.logged}
                  timed={s.target ? s.target.kind !== "reps" : s.logged.actual.seconds !== null}
                  onCorrected={() => detail.refetch?.()}
                />
              ) : (
                <span className="text-muted-foreground">Not logged</span>
              )}
            </li>
          ))}
          {!sets.length ? <li>This session has no sets.</li> : null}
        </ol>
      </CardContent>
    </Card>
  );
}

function LoggedRow({
  programs,
  set,
  timed,
  onCorrected,
}: {
  programs: Pick<ProgramsHooks, "useUpdateSet">;
  set: LoggedSet;
  timed: boolean;
  onCorrected: () => void;
}) {
  const update = programs.useUpdateSet();
  const [editing, setEditing] = useState(false);
  const [count, setCount] = useState("");
  const [load, setLoad] = useState("");
  const [effort, setEffort] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    setCount(String((timed ? set.actual.seconds : set.actual.reps) ?? ""));
    setLoad(String(set.actual.load ?? ""));
    setEffort(String(set.rpe ?? ""));
    setNote(set.note ?? "");
    setError(null);
    setEditing(true);
  };
  if (!editing)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="past-set-done">{describeDone(set)}</span>
        {set.recordedAs === "staff" && set.recordedByName ? (
          <span className="text-xs text-muted-foreground">by {set.recordedByName}</span>
        ) : null}
        {set.note ? <span className="text-xs italic">{set.note}</span> : null}
        <Button size="sm" variant="ghost" onClick={start}>
          Correct
        </Button>
      </div>
    );
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      aria-label={`Correct set ${set.setNumber ?? ""}`}
      onSubmit={async (event) => {
        event.preventDefault();
        const correction = correctionOf(set, { count, load, rpe: effort, note }, timed);
        if (!correction) {
          setEditing(false);
          return;
        }
        setError(null);
        try {
          await update.mutateAsync(correction);
          setEditing(false);
          onCorrected();
        } catch (e) {
          setError((e as { message?: string }).message ?? "Not corrected");
        }
      }}
    >
      <Input
        aria-label={`Set ${set.setNumber ?? ""} ${timed ? "seconds" : "reps"} done`}
        placeholder={timed ? "Seconds" : "Reps"}
        className="h-8 w-20"
        inputMode="numeric"
        value={count}
        onChange={(e) => setCount(e.target.value)}
      />
      <Input
        aria-label={`Set ${set.setNumber ?? ""} load`}
        placeholder="kg"
        className="h-8 w-20"
        inputMode="decimal"
        value={load}
        onChange={(e) => setLoad(e.target.value)}
      />
      <Input
        aria-label={`Set ${set.setNumber ?? ""} effort`}
        placeholder="RPE"
        className="h-8 w-16"
        inputMode="decimal"
        value={effort}
        onChange={(e) => setEffort(e.target.value)}
      />
      <Input
        aria-label={`Set ${set.setNumber ?? ""} note`}
        placeholder="Note"
        className="h-8 w-48"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button size="sm" type="submit" disabled={update.isPending}>
        Save
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {error ? (
        <p role="alert" className="w-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
