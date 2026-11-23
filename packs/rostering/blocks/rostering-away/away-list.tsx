// Everyone's time off (stage 45 step 7), for someone who rosters: by week, who said they cannot
// work, with their notes, and adding or ending someone's time off for them. The host lets only
// someone who rosters read anyone else's, and only as a person at the screen (never an assistant),
// so this is shown only when the host says the reader rosters (`me.rosters`), and other staff
// never see that anyone is away.
//
// Notes are read on this screen only: kept in the app's cache no longer than they are shown,
// hidden when the page is left, and what was sent is forgotten once the call is over.
import {
  type AwayInput,
  addDays,
  awayKind,
  awayWhen,
  dayLabel,
  forgetAfter,
  type RosteringHooks,
  type RosterRefusal,
  rosterRefusal,
  weekOf,
} from "@composable-os/pack-rostering/client";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "useAwayList" | "useAwayFor" | "useBack" | "usePeople">;

/** Hides what is shown when the page is left; reads it again when it comes back. */
function useForgetOnLeave(forget: () => void, cameBack: () => void): void {
  const latest = useRef({ forget, cameBack });
  latest.current = { forget, cameBack };
  useEffect(() => {
    const hide = () => latest.current.forget();
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      latest.current.forget();
      latest.current.cameBack();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, []);
}

export function TimeOff({
  rostering,
  from,
  locale = "en-AU",
}: {
  rostering: Hooks;
  from?: string;
  locale?: string;
}) {
  const me = rostering.useMe();
  const rosters = me.data?.rosters === true;
  const [start, setStart] = useState<string | null>(from ? weekOf(from) : null);
  const first = start ?? (me.data ? weekOf(me.data.today) : null);
  const list = rostering.useAwayList(
    { from: first ?? "", to: first ? addDays(first, 6) : "" },
    rosters && first !== null,
  );
  const people = rostering.usePeople(rosters);
  const awayFor = rostering.useAwayFor();
  const back = rostering.useBack();
  const [hidden, setHidden] = useState(false);
  const [account, setAccount] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [note, setNote] = useState("");
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const id = useId();
  useForgetOnLeave(
    () => {
      setHidden(true);
      setNote("");
    },
    () => void Promise.resolve(list.refetch?.()).then(() => setHidden(false)),
  );
  if (me.isPending) return <p aria-busy="true">Loading…</p>;
  if (me.error || !me.data) return <p role="alert">{rosterRefusal(me.error).message}</p>;
  if (!rosters) {
    return (
      <p role="status" data-refusal="rostering">
        Other people's time off is seen only by whoever rosters. Yours is on My availability.
      </p>
    );
  }
  const today = me.data.today;

  async function add(event: FormEvent) {
    event.preventDefault();
    setRefusal(null);
    setSaid(null);
    const input: AwayInput & { account: string } = {
      account,
      kind: "leave",
      startsAt,
      endsAt,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    try {
      const made = await forgetAfter(awayFor, input);
      setNote("");
      setSaid(
        made.count
          ? `Saved. They are on ${made.count} shift${made.count === 1 ? "" : "s"} then, which stay theirs with a warning.`
          : "Saved.",
      );
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await list.refetch?.();
  }

  async function end(itemId: string) {
    setRefusal(null);
    try {
      await back.mutateAsync({ id: itemId });
      setSaid("Ended.");
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await list.refetch?.();
  }

  const items = hidden ? [] : (list.data?.items ?? []);
  const names = [...new Set(items.map((i) => i.name))].sort();
  return (
    <section className="grid gap-4" aria-labelledby={`${id}-h`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-h`} className="text-lg font-medium">
          Time off{first ? `: week of ${dayLabel(first, locale, true)}` : ""}
        </h2>
        <nav aria-label="Weeks" className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            aria-label="Previous week"
            onClick={() => first && setStart(addDays(first, -7))}
          >
            ‹ Previous
          </Button>
          <Button type="button" variant="outline" onClick={() => setStart(weekOf(today))}>
            This week
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-label="Next week"
            onClick={() => first && setStart(addDays(first, 7))}
          >
            Next ›
          </Button>
        </nav>
      </header>
      {said ? (
        <p role="status" className="text-sm">
          {said}
        </p>
      ) : null}
      {refusal ? (
        <p role="alert" className="text-sm" data-refusal={refusal.kind}>
          {refusal.message}
        </p>
      ) : null}
      {list.isPending || hidden ? <p aria-busy="true">Loading time off…</p> : null}
      {list.error ? <p role="alert">{rosterRefusal(list.error).message}</p> : null}
      {list.data && !hidden && !items.length ? <p>Nobody said they are away this week.</p> : null}
      <ul className="grid gap-3">
        {names.map((name) => (
          <li key={name} className="grid gap-1 rounded-md border p-2">
            <h3 className="font-medium">{name}</h3>
            <ul className="grid gap-1 text-sm">
              {items
                .filter((i) => i.name === name)
                .map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {awayKind(item.kind)} · {awayWhen(item, locale)}
                      {item.note ? (
                        <span className="block text-muted-foreground">{item.note}</span>
                      ) : null}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={back.isPending}
                      aria-label={`End ${name}'s ${awayKind(item.kind).toLowerCase()}`}
                      onClick={() => end(item.id)}
                    >
                      End
                    </Button>
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
      <form
        className="grid gap-2 rounded-md border p-3"
        onSubmit={add}
        aria-label="Add leave for someone"
      >
        <h3 className="text-sm font-medium">Add leave for someone</h3>
        <label htmlFor={`${id}-who`} className="text-sm">
          Who
        </label>
        <select
          id={`${id}-who`}
          className="rounded-md border border-input px-2 py-1 text-sm"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          required
        >
          <option value="">Choose…</option>
          {(people.data?.people ?? []).map((p) => (
            <option key={p.account} value={p.account}>
              {p.name}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-from`} className="text-sm">
          From
        </label>
        <input
          id={`${id}-from`}
          type="datetime-local"
          className="rounded-md border border-input px-2 py-1 text-sm"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          required
        />
        <label htmlFor={`${id}-until`} className="text-sm">
          Until
        </label>
        <input
          id={`${id}-until`}
          type="datetime-local"
          className="rounded-md border border-input px-2 py-1 text-sm"
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
          required
        />
        <label htmlFor={`${id}-note`} className="text-sm">
          Note (optional)
        </label>
        <input
          id={`${id}-note`}
          className="rounded-md border border-input px-2 py-1 text-sm"
          value={note}
          maxLength={500}
          autoComplete="off"
          onChange={(e) => setNote(e.target.value)}
        />
        <Button type="submit" disabled={awayFor.isPending || !account}>
          Add leave
        </Button>
      </form>
    </section>
  );
}
