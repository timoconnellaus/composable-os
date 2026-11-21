// A member's day (stage 41): their own sessions on a date, each opened to do it. Built on the
// web base layer and the session block. Which sessions are theirs is the host's (`useToday`).
import type { ProgramsHooks } from "@composable-os/pack-programs/client";
import { useState } from "react";
import { SessionView } from "../programs-session/session-view.tsx";
import { Button } from "../ui-button/button.tsx";
import { Input } from "../ui-input/input.tsx";

export function Today({
  programs,
  date,
  onRestDone,
}: {
  programs: ProgramsHooks;
  /** The member's local date (YYYY-MM-DD); the host's UTC today when left out. */
  date?: string;
  onRestDone?: () => void;
}) {
  const [day, setDay] = useState(date ?? "");
  const today = programs.useToday(day ? { date: day } : {});
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="grid gap-4" data-testid="today">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Date"
          type="date"
          value={day || today.data?.date || ""}
          onChange={(e) => setDay(e.target.value)}
          className="w-44"
        />
      </div>
      {today.isPending ? <p aria-busy="true">Loading your day…</p> : null}
      {today.error ? <p role="alert">We could not load your sessions.</p> : null}
      {today.data && !today.data.sessions.length ? <p>Nothing planned for this day.</p> : null}
      <ul className="grid gap-2">
        {(today.data?.sessions ?? []).map((s) => (
          <li key={s.id} className="grid gap-2">
            <div className="flex items-center gap-2">
              <Button
                variant={open === s.id ? "default" : "outline"}
                onClick={() => setOpen(open === s.id ? null : s.id)}
              >
                {s.name}
              </Button>
              <span className="text-sm text-muted-foreground">
                {[
                  s.programTitle,
                  s.state === "done" ? "done" : s.state === "skipped" ? "skipped" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {open === s.id ? (
              <SessionView
                programs={programs}
                sessionId={s.id}
                {...(onRestDone ? { onRestDone } : {})}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
