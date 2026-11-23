// The regular week (stage 45 step 7), for someone who rosters: every class series' coach and duty
// series' regular person, day by day, and changing who works one from a date. The shifts from
// that date follow, except those that keep their own person; a change that would put someone on
// two shifts at once on any date is refused whole by the host, naming the dates, and shown so.
//
// Shown only when the host says the reader rosters (`me.rosters`): nobody else's screen asks for
// the patterns. Everything shown is the host's answer.
import {
  dayLabel,
  type Pattern,
  patternWhen,
  type RosteringHooks,
  type RosterRefusal,
  refusalNext,
  rosterRefusal,
} from "@composable-os/pack-rostering/client";
import { type FormEvent, useId, useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "usePatterns" | "usePeople" | "useSetPattern">;

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;

export function Patterns({ rostering, locale = "en-AU" }: { rostering: Hooks; locale?: string }) {
  const me = rostering.useMe();
  const rosters = me.data?.rosters === true;
  const patterns = rostering.usePatterns(rosters);
  const people = rostering.usePeople(rosters);
  const [editing, setEditing] = useState<Pattern | null>(null);
  const headingId = useId();
  if (me.isPending) return <p aria-busy="true">Loading…</p>;
  if (me.error || !me.data) return <p role="alert">{rosterRefusal(me.error).message}</p>;
  if (!rosters) {
    return (
      <p role="status" data-refusal="rostering">
        The regular week is for whoever rosters. Your own shifts are on My shifts.
      </p>
    );
  }
  const all = patterns.data?.patterns ?? [];
  return (
    <section className="grid gap-4" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-medium">
        Regular week
      </h2>
      {patterns.isPending ? <p aria-busy="true">Loading the regular week…</p> : null}
      {patterns.error ? <p role="alert">{rosterRefusal(patterns.error).message}</p> : null}
      {patterns.data?.truncated ? (
        <p role="status" className="text-sm">
          There are more patterns than one screen shows.
        </p>
      ) : null}
      <ol className="grid gap-3 md:grid-cols-7" aria-label="Days of the week">
        {DAYS.map(([day, label]) => {
          const on = all.filter((p) => p.weekdays.includes(day));
          return (
            <li key={day} className="min-w-0 rounded-md border p-2">
              <h3 className="text-sm font-medium">{label}</h3>
              {on.length ? (
                <ul className="mt-2 grid gap-2">
                  {on.map((p) => (
                    <li key={`${p.object}:${p.id}`}>
                      <button
                        type="button"
                        className="block w-full rounded-md border p-2 text-left text-sm"
                        aria-label={`${p.title}, ${label} ${p.time ?? ""}, ${p.name ?? "nobody"}. Change who works it`}
                        aria-pressed={editing?.id === p.id}
                        onClick={() => setEditing(p)}
                      >
                        <span className="block text-xs text-muted-foreground">{p.time}</span>
                        <span className="block font-medium">{p.title}</span>
                        <span className="block text-xs">
                          {p.name ?? (p.noAccount ? "A coach with no account" : "Nobody")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Nothing</p>
              )}
            </li>
          );
        })}
      </ol>
      {editing ? (
        <ChangePattern
          rostering={rostering}
          pattern={editing}
          people={people.data?.people ?? []}
          today={me.data.today}
          locale={locale}
          onClose={() => setEditing(null)}
          onChanged={() => patterns.refetch?.()}
        />
      ) : null}
    </section>
  );
}

function ChangePattern({
  rostering,
  pattern,
  people,
  today,
  locale,
  onClose,
  onChanged,
}: {
  rostering: Pick<RosteringHooks, "useSetPattern">;
  pattern: Pattern;
  people: { account: string; name: string }[];
  today: string;
  locale: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const setPattern = rostering.useSetPattern();
  const [account, setAccount] = useState<string>(pattern.account ?? "");
  const [from, setFrom] = useState(today);
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const id = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setRefusal(null);
    setSaid(null);
    try {
      const done = await setPattern.mutateAsync({
        object: pattern.object,
        id: pattern.id,
        account: account || null,
        from,
      });
      setSaid(
        `From ${dayLabel(done.from, locale, true)}, ${people.find((p) => p.account === done.account)?.name ?? "nobody"} works ${pattern.title}.`,
      );
      onChanged();
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
  }

  return (
    <form
      className="grid gap-3 rounded-md border p-3"
      onSubmit={submit}
      aria-label={`Change who works ${pattern.title}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">{pattern.title}</h3>
          <p className="text-sm text-muted-foreground">
            {pattern.objectLabel} · {patternWhen(pattern)} · {pattern.zone}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${id}-who`} className="text-sm">
          Regular person
        </label>
        <select
          id={`${id}-who`}
          className="rounded-md border border-input px-2 py-1 text-sm"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="">Nobody</option>
          {people.map((p) => (
            <option key={p.account} value={p.account}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${id}-from`} className="text-sm">
          From
        </label>
        <input
          id={`${id}-from`}
          type="date"
          className="rounded-md border border-input px-2 py-1 text-sm"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </div>
      {refusal ? (
        <div role="alert" className="text-sm" data-refusal={refusal.kind}>
          <p>{refusal.message}</p>
          {refusal.dates?.length ? (
            <p>On: {refusal.dates.map((d) => dayLabel(d, locale)).join(", ")}</p>
          ) : null}
          {refusalNext(refusal.kind, true) ? <p>{refusalNext(refusal.kind, true)}</p> : null}
        </div>
      ) : null}
      {said ? (
        <p role="status" className="text-sm">
          {said}
        </p>
      ) : null}
      <Button type="submit" disabled={setPattern.isPending}>
        Save from this date
      </Button>
    </form>
  );
}
