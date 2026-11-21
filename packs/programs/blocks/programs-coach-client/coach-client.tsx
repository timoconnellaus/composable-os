// The coach's view of one client (stage 41): their sessions, newest first, each opened to see what
// was logged and to log on their behalf, and their progress. Built on the web base layer and the
// session and progress blocks. Logging for a client is the host's (`logAdd` with the session's
// person; the row records the coach).
import type { ProgramsHooks } from "@composable-os/pack-programs/client";
import { useState } from "react";
import { Progress } from "../programs-progress/progress.tsx";
import { SessionView } from "../programs-session/session-view.tsx";
import { Button } from "../ui-button/button.tsx";

export function CoachClient({ programs, personId }: { programs: ProgramsHooks; personId: string }) {
  const sessions = programs.useClientSessions(personId);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="grid gap-4" data-testid="coach-client">
      <section aria-label="Sessions" className="grid gap-2">
        {sessions.isPending ? <p aria-busy="true">Loading sessions…</p> : null}
        {(sessions.data?.items ?? []).map((s) => (
          <div key={s.id} className="grid gap-2">
            <div className="flex items-center gap-2 text-sm">
              <Button
                size="sm"
                variant={open === s.id ? "default" : "outline"}
                onClick={() => setOpen(open === s.id ? null : s.id)}
              >
                {String(s.values.date ?? "")} · {String(s.values.name ?? "")}
              </Button>
              <span className="text-muted-foreground">{String(s.values.state ?? "")}</span>
            </div>
            {open === s.id ? (
              <SessionView programs={programs} sessionId={s.id} personId={personId} />
            ) : null}
          </div>
        ))}
        {sessions.data && !sessions.data.items.length ? (
          <p>No sessions yet: assign a program.</p>
        ) : null}
      </section>
      <Progress programs={programs} personId={personId} />
    </div>
  );
}
