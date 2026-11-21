// A class type's session for a day (stage 41): its plan with every level, for a member to choose
// the level they take and log their numbers, or for a coach running the class. Built on the web
// base layer and the session block. Which sessions a class has, and what a member reads of them
// (the coach's notes left out), are the host's (`useClassToday`).
import type { ProgramsHooks } from "@composable-os/pack-programs/client";
import { useState } from "react";
import { SessionView } from "../programs-session/session-view.tsx";
import { Input } from "../ui-input/input.tsx";

export function ClassToday({
  programs,
  classTypeId,
  date,
}: {
  programs: ProgramsHooks;
  classTypeId?: string;
  date?: string;
}) {
  const types = programs.useClassTypes();
  const [chosen, setChosen] = useState(classTypeId ?? "");
  const [day, setDay] = useState(date ?? "");
  const id = chosen || String(types.data?.items[0]?.id ?? "");
  const classes = programs.useClassToday({
    classTypeId: id || "none",
    ...(day ? { date: day } : {}),
  });
  return (
    <div className="grid gap-4" data-testid="class-today">
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Class"
          className="h-9 rounded-md border px-2"
          value={id}
          onChange={(e) => setChosen(e.target.value)}
        >
          {(types.data?.items ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {String(t.values.name ?? t.id)}
            </option>
          ))}
        </select>
        <Input
          aria-label="Date"
          type="date"
          value={day || classes.data?.date || ""}
          onChange={(e) => setDay(e.target.value)}
          className="w-44"
        />
      </div>
      {classes.isPending ? <p aria-busy="true">Loading the class…</p> : null}
      {classes.data && !classes.data.sessions.length ? <p>No class session on this day.</p> : null}
      {(classes.data?.sessions ?? []).map((s) => (
        <SessionView key={s.id} programs={programs} sessionId={s.id} />
      ))}
    </div>
  );
}
