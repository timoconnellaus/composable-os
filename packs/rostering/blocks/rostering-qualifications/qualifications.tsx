// Qualifications (stage 45 step 7), for someone who rosters: people down, kinds of work across
// (each class type, each duty), a tick each. A ticked person may take an offered shift of that
// kind without anybody approving; putting someone unticked on one is made with a warning. Who is
// qualified is the host's (`qualifications`), and each tick is the host's write (`qualify`).
//
// Shown only when the host says the reader rosters (`me.rosters`). On a phone the grid scrolls
// sideways inside its own box; the page does not.
import {
  type Qualification,
  type RosteringHooks,
  type RosterRefusal,
  rosterRefusal,
} from "@composable-os/pack-rostering/client";
import { useId, useState } from "react";

type Hooks = Pick<RosteringHooks, "useMe" | "usePeople" | "useQualifications" | "useQualify">;

const key = (account: string, object: string, id: string) => `${account}\u0000${object}\u0000${id}`;

export function Qualifications({ rostering }: { rostering: Hooks }) {
  const me = rostering.useMe();
  const rosters = me.data?.rosters === true;
  const people = rostering.usePeople(rosters);
  const ticks = rostering.useQualifications({}, rosters);
  const qualify = rostering.useQualify();
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const headingId = useId();
  if (me.isPending) return <p aria-busy="true">Loading…</p>;
  if (me.error || !me.data) return <p role="alert">{rosterRefusal(me.error).message}</p>;
  if (!rosters) {
    return (
      <p role="status" data-refusal="rostering">
        Who may do which work is set by whoever rosters.
      </p>
    );
  }
  const held = new Set(
    (ticks.data?.items ?? []).map((q: Qualification) => key(q.account, q.kind.object, q.kind.id)),
  );
  const kinds = people.data?.kinds ?? [];

  async function toggle(account: string, kind: { object: string; id: string }, on: boolean) {
    const k = key(account, kind.object, kind.id);
    setRefusal(null);
    setPending(k);
    try {
      await qualify.mutateAsync({ account, kind, qualified: on });
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await ticks.refetch?.();
    setPending(null);
  }

  return (
    <section className="grid gap-3" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-medium">
        Who may do which work
      </h2>
      <p className="text-sm text-muted-foreground">
        A ticked person can take an offered shift of that kind without anyone approving it.
      </p>
      {refusal ? (
        <p role="alert" className="text-sm" data-refusal={refusal.kind}>
          {refusal.message}
        </p>
      ) : null}
      {people.isPending || ticks.isPending ? <p aria-busy="true">Loading…</p> : null}
      {people.error ? <p role="alert">{rosterRefusal(people.error).message}</p> : null}
      {people.data && !kinds.length ? (
        <p>There are no class types or duties yet. Add them first.</p>
      ) : null}
      {people.data && kinds.length ? (
        <div
          className="max-w-full overflow-x-auto rounded-md border"
          data-testid="qualifications-grid"
        >
          <table className="text-sm">
            <caption className="sr-only">People down, kinds of work across</caption>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 bg-background p-2 text-left">
                  Person
                </th>
                {kinds.map((k) => (
                  <th key={`${k.object}:${k.id}`} scope="col" className="p-2 text-left font-medium">
                    {k.name}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {k.objectLabel}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.data.people.map((p) => (
                <tr key={p.account} className="border-t">
                  <th scope="row" className="sticky left-0 bg-background p-2 text-left font-normal">
                    {p.name}
                  </th>
                  {kinds.map((k) => {
                    const ck = key(p.account, k.object, k.id);
                    const on = held.has(ck);
                    return (
                      <td key={ck} className="p-2 text-center">
                        <input
                          type="checkbox"
                          className="size-5"
                          aria-label={`${p.name} may do ${k.name}`}
                          checked={on}
                          disabled={pending === ck}
                          onChange={(e) =>
                            toggle(p.account, { object: k.object, id: k.id }, e.target.checked)
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {people.data?.truncated ? (
        <p className="text-xs text-muted-foreground">Only the first people are listed.</p>
      ) : null}
    </section>
  );
}
