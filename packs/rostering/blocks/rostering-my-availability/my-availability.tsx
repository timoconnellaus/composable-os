// My availability (stage 45 step 7), for every rostered person: the times I said I cannot work
// (leave and other one-off times, and regular time off such as every Wednesday afternoon), to add
// and to end. Nobody approves it. Only I and whoever rosters ever see it: other staff see nothing,
// not even that I am away.
//
// When I add time off over shifts I am already on, they stay mine (the host lists them in its
// answer, and tells whoever rosters), and this offers them in one step. What I write about my time
// off (the note) is forgotten once the call is over and when I leave the page; it is read back only
// on this screen, and kept in the app's cache no longer than it is shown.
import {
  type AwayAnswer,
  type AwayInput,
  awayKind,
  awayWhen,
  forgetAfter,
  type RosteringHooks,
  type RosterRefusal,
  rosterRefusal,
  shiftTime,
} from "@composable-os/pack-rostering/client";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "useMyAway" | "useAway" | "useBack" | "useOffer">;

const WEEKDAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;

type Weekday = (typeof WEEKDAYS)[number][0];

interface AwayForm {
  kind: "leave" | "other" | "regular";
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  weekdays: Weekday[];
  fromDate: string;
  untilDate: string;
  note: string;
}

const EMPTY: AwayForm = {
  kind: "leave",
  startDate: "",
  startTime: "00:00",
  endDate: "",
  endTime: "23:59",
  weekdays: [],
  fromDate: "",
  untilDate: "",
  note: "",
};

/** Forgets what was typed when the page is left, or brought back from the back-forward cache. */
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

/** What the form asks the host for (the host checks it, and says what is wrong). */
function inputOf(form: AwayForm): AwayInput {
  const note = form.note.trim() ? { note: form.note.trim() } : {};
  if (form.kind === "regular") {
    return {
      kind: "regular",
      weekdays: form.weekdays,
      startTime: form.startTime,
      endTime: form.endTime,
      fromDate: form.fromDate,
      ...(form.untilDate ? { untilDate: form.untilDate } : {}),
      ...note,
    };
  }
  return {
    kind: form.kind,
    startsAt: `${form.startDate}T${form.startTime}`,
    endsAt: `${form.endDate}T${form.endTime}`,
    ...note,
  };
}

export function MyAvailability({
  rostering,
  locale = "en-AU",
}: {
  rostering: Hooks;
  locale?: string;
}) {
  const me = rostering.useMe();
  const list = rostering.useMyAway({});
  const away = rostering.useAway();
  const back = rostering.useBack();
  const offer = rostering.useOffer();
  const [form, setForm] = useState<AwayForm>(EMPTY);
  const [answer, setAnswer] = useState<AwayAnswer | null>(null);
  const [offered, setOffered] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  // Hidden when the page is left, and until it is read again when it comes back.
  const [hidden, setHidden] = useState(false);
  const id = useId();
  useForgetOnLeave(
    () => {
      setForm(EMPTY);
      setAnswer(null);
      setHidden(true);
    },
    () => void Promise.resolve(list.refetch?.()).then(() => setHidden(false)),
  );
  if (me.isPending) return <p aria-busy="true">Loading your availability…</p>;
  if (me.error || !me.data) return <p role="alert">{rosterRefusal(me.error).message}</p>;
  const zone = me.data.zone;
  const set = (patch: Partial<AwayForm>) => setForm((f) => ({ ...f, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setRefusal(null);
    setSaid(null);
    setAnswer(null);
    setOffered([]);
    try {
      const made = await forgetAfter(away, inputOf(form));
      setAnswer(made);
      setForm(EMPTY);
      setSaid("Saved. Only you and whoever rosters can see it.");
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await list.refetch?.();
  }

  async function remove(itemId: string) {
    setRefusal(null);
    setSaid(null);
    try {
      await back.mutateAsync({ id: itemId });
      setSaid("Removed.");
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await list.refetch?.();
  }

  async function offerShift(object: string, shiftId: string) {
    setRefusal(null);
    try {
      await offer.mutateAsync({ object, id: shiftId });
      setOffered((o) => [...o, shiftId]);
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
  }

  const f = (name: string) => `${id}-${name}`;
  return (
    <section className="grid gap-4" aria-labelledby={f("h")}>
      <h2 id={f("h")} className="text-lg font-medium">
        My availability
      </h2>
      <p className="text-sm text-muted-foreground">
        Times are in {zone}. Only you and whoever rosters see this.
      </p>
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
      {answer?.count ? (
        <section className="grid gap-2 rounded-md border p-3" aria-label="Your shifts then">
          <p className="text-sm">
            You are on {answer.count} shift{answer.count === 1 ? "" : "s"} then. They stay yours
            until someone takes them: offer them now?
          </p>
          <ul className="grid gap-1">
            {answer.shifts.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {s.title}, {shiftTime(s, zone, { withDate: true, locale })}
                </span>
                {offered.includes(s.id) ? (
                  <span>Offered</span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={offer.isPending}
                    aria-label={`Offer ${s.title}`}
                    onClick={() => offerShift(s.object, s.id)}
                  >
                    Offer
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <form
        className="grid gap-3 rounded-md border p-3"
        onSubmit={submit}
        aria-label="Add time off"
      >
        <fieldset className="grid gap-1">
          <legend className="text-sm font-medium">What kind</legend>
          {(["leave", "other", "regular"] as const).map((kind) => (
            <label key={kind} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={f("kind")}
                checked={form.kind === kind}
                onChange={() => set({ kind })}
              />
              {kind === "leave"
                ? "Leave"
                : kind === "other"
                  ? "Another one-off time"
                  : "Every week"}
            </label>
          ))}
        </fieldset>
        {form.kind === "regular" ? (
          <>
            <fieldset className="flex flex-wrap gap-3">
              <legend className="text-sm font-medium">Days</legend>
              {WEEKDAYS.map(([value, label]) => (
                <label key={value} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={form.weekdays.includes(value)}
                    onChange={(e) =>
                      set({
                        weekdays: e.target.checked
                          ? [...form.weekdays, value]
                          : form.weekdays.filter((d) => d !== value),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextField
                id={f("st")}
                label="From (time)"
                type="time"
                value={form.startTime}
                onChange={(v) => set({ startTime: v })}
              />
              <TextField
                id={f("et")}
                label="Until (time)"
                type="time"
                value={form.endTime}
                onChange={(v) => set({ endTime: v })}
              />
              <TextField
                id={f("fd")}
                label="Starting on"
                type="date"
                value={form.fromDate}
                onChange={(v) => set({ fromDate: v })}
              />
              <TextField
                id={f("ud")}
                label="Ending on (optional)"
                type="date"
                value={form.untilDate}
                onChange={(v) => set({ untilDate: v })}
              />
            </div>
          </>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <TextField
              id={f("sd")}
              label="From (date)"
              type="date"
              value={form.startDate}
              onChange={(v) => set({ startDate: v })}
            />
            <TextField
              id={f("st1")}
              label="From (time)"
              type="time"
              value={form.startTime}
              onChange={(v) => set({ startTime: v })}
            />
            <TextField
              id={f("ed")}
              label="Until (date)"
              type="date"
              value={form.endDate}
              onChange={(v) => set({ endDate: v })}
            />
            <TextField
              id={f("et1")}
              label="Until (time)"
              type="time"
              value={form.endTime}
              onChange={(v) => set({ endTime: v })}
            />
          </div>
        )}
        <TextField
          id={f("note")}
          label="Note (optional, seen by you and whoever rosters)"
          value={form.note}
          maxLength={500}
          onChange={(v) => set({ note: v })}
        />
        <Button type="submit" disabled={away.isPending}>
          Add time off
        </Button>
      </form>
      <section className="grid gap-2" aria-label="My time off">
        <h3 className="text-sm font-medium">My time off</h3>
        {list.isPending || hidden ? <p aria-busy="true">Loading…</p> : null}
        {list.error ? <p role="alert">{rosterRefusal(list.error).message}</p> : null}
        {list.data && !hidden && !list.data.items.length ? (
          <p className="text-sm">None from today on.</p>
        ) : null}
        {!hidden ? (
          <ul className="grid gap-2">
            {(list.data?.items ?? []).map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
              >
                <span>
                  <strong>{awayKind(item.kind)}</strong> · {awayWhen(item, locale)}
                  {item.note ? (
                    <span className="block text-muted-foreground">{item.note}</span>
                  ) : null}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={back.isPending}
                  aria-label={`End ${awayKind(item.kind).toLowerCase()}: ${awayWhen(item, locale)}`}
                  onClick={() => remove(item.id)}
                >
                  End
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </section>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "date" | "time";
  maxLength?: number;
}) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        maxLength={maxLength}
        autoComplete="off"
        className="rounded-md border border-input px-2 py-1 text-sm"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
