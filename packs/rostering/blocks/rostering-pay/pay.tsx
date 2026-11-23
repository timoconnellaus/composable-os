// Pay (stage 45 step 7), for someone who handles pay, a person only: the pay periods, who is
// counted and how, a period's hours and shifts per person and kind of work with each shift's
// evidence (its class list taken, by whom, flagged when not by its person), locking a period that
// has ended, reopening one with why, and its CSV for payroll. No rates and no money: the host
// holds none.
//
// Everything is the host's answer: which periods exist, what each counts (a locked period's
// locked lines, an open one's preview), whether it may be locked, and each refusal (the period
// not set, not ended, already locked or overlapping one, the roster changed while locking, a
// shift inside a locked period). Shown only when the host says the reader handles pay
// (`me.pays`), so no one else's screen asks for any of it. Figures are kept in the app's cache no
// longer than they are shown, hidden when the page is left, and the CSV is handed to the person
// and not kept; why a period was reopened is forgotten once the call is over.
import {
  basisLabel,
  dayLabel,
  forgetAfter,
  type PayBasisValue,
  type Period,
  type RosteringHooks,
  type RosterRefusal,
  refusalNext,
  rosterRefusal,
} from "@composable-os/pack-rostering/client";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<
  RosteringHooks,
  | "useMe"
  | "usePeriods"
  | "usePeriodTotals"
  | "useLock"
  | "useReopen"
  | "useExport"
  | "usePayBases"
  | "usePayBasis"
>;

/** Hides what is shown when the page is left; shows it again only once read again. */
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

/** Hands a CSV to the person as a file to save; nothing of it is kept here. */
function saveFile(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Pay({ rostering, locale = "en-AU" }: { rostering: Hooks; locale?: string }) {
  const me = rostering.useMe();
  const pays = me.data?.pays === true;
  const [hidden, setHidden] = useState(false);
  const periods = rostering.usePeriods({ count: 8 }, pays && !hidden);
  const [chosen, setChosen] = useState<string | null>(null);
  const headingId = useId();
  useForgetOnLeave(
    () => {
      setHidden(true);
      setChosen(null);
    },
    () => setHidden(false),
  );
  if (me.isPending) return <p aria-busy="true">Loading…</p>;
  if (me.error || !me.data) return <p role="alert">{rosterRefusal(me.error).message}</p>;
  if (!pays) {
    return (
      <p role="status" data-refusal="forbidden">
        Pay is seen only by whoever handles pay, at the screen themselves.
      </p>
    );
  }
  if (hidden) return <p aria-busy="true">Loading…</p>;
  const period = periods.data?.periods.find((p) => p.start === chosen) ?? null;
  return (
    <section className="grid gap-4" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-medium">
        Pay periods
      </h2>
      <p className="text-sm text-muted-foreground">
        Hours and shifts for payroll. No rates or money are kept here: payroll applies them.
      </p>
      {periods.isPending ? <p aria-busy="true">Loading the periods…</p> : null}
      {periods.error ? <p role="alert">{rosterRefusal(periods.error).message}</p> : null}
      {periods.data && !periods.data.set ? (
        <p role="status" data-refusal="pay_period_unset">
          The date a pay period starts is not set yet, so nothing is totalled. Set it in Settings,
          Rostering ({periods.data.setting.period}).
        </p>
      ) : null}
      {periods.data?.set ? (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Periods">
          {periods.data.periods.map((p) => (
            <li key={p.start}>
              <button
                type="button"
                className="block w-full rounded-md border p-2 text-left text-sm"
                aria-pressed={chosen === p.start}
                data-start={p.start}
                aria-label={`${dayLabel(p.start, locale)} to ${dayLabel(p.end, locale)}, ${p.state === "locked" ? "locked" : p.ended ? "ended, open" : "open"}`}
                onClick={() => setChosen(p.start)}
              >
                <span className="block font-medium">
                  {dayLabel(p.start, locale)} – {dayLabel(p.end, locale)}
                </span>
                <span className="block text-xs">
                  {p.state === "locked"
                    ? `Locked (version ${p.versions.at(-1)?.version ?? 1})`
                    : p.ended
                      ? "Ended, not locked"
                      : "Open"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {period ? (
        <PeriodView
          key={period.start}
          rostering={rostering}
          period={period}
          locale={locale}
          onChanged={() => periods.refetch?.()}
        />
      ) : null}
      <Counted rostering={rostering} today={me.data.today} />
    </section>
  );
}

function PeriodView({
  rostering,
  period,
  locale,
  onChanged,
}: {
  rostering: Pick<RosteringHooks, "usePeriodTotals" | "useLock" | "useReopen" | "useExport">;
  period: Period;
  locale: string;
  onChanged: () => void;
}) {
  const totals = rostering.usePeriodTotals({ start: period.start });
  const lock = rostering.useLock();
  const reopen = rostering.useReopen();
  const exported = rostering.useExport();
  const [confirmLock, setConfirmLock] = useState(false);
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const id = useId();
  useForgetOnLeave(
    () => setReason(""),
    () => undefined,
  );

  async function run(what: () => Promise<unknown>, done: string) {
    setRefusal(null);
    setSaid(null);
    try {
      await what();
      setSaid(done);
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    onChanged();
    await totals.refetch?.();
  }

  async function doReopen(event: FormEvent) {
    event.preventDefault();
    const why = reason.trim();
    if (!why) {
      setRefusal({ kind: "invalid", message: "Say why it is reopened." });
      return;
    }
    await run(
      () => forgetAfter(reopen, { start: period.start, reason: why }),
      "Reopened. Its locked version is kept; lock it again for a new one.",
    );
    setReason("");
  }

  async function download() {
    setRefusal(null);
    try {
      const file = await forgetAfter(exported, { start: period.start });
      saveFile(file.filename, file.csv);
      setSaid(file.locked ? "The CSV was saved." : "The CSV was saved, marked as a preview.");
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
  }

  const data = totals.data;
  const locked = period.state === "locked";
  return (
    <section className="grid gap-3 rounded-md border p-3" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="font-medium">
        {dayLabel(period.start, locale, true)} to {dayLabel(period.end, locale, true)}
      </h3>
      {data?.period.preview ? (
        <p className="text-sm" role="status">
          A preview from the roster as it stands: it changes until the period is locked.
        </p>
      ) : null}
      {refusal ? (
        <div role="alert" className="text-sm" data-refusal={refusal.kind}>
          <p>{refusal.message}</p>
          {refusalNext(refusal.kind, false) ? <p>{refusalNext(refusal.kind, false)}</p> : null}
        </div>
      ) : null}
      {said ? (
        <p role="status" className="text-sm">
          {said}
        </p>
      ) : null}
      {totals.isPending ? <p aria-busy="true">Loading…</p> : null}
      {totals.error ? <p role="alert">{rosterRefusal(totals.error).message}</p> : null}
      {data ? (
        <>
          <div className="max-w-full overflow-x-auto">
            <table className="text-sm" aria-label="Hours and shifts per person">
              <thead>
                <tr className="text-left">
                  <th scope="col" className="p-1">
                    Person
                  </th>
                  <th scope="col" className="p-1">
                    Counted
                  </th>
                  <th scope="col" className="p-1">
                    Kind of work
                  </th>
                  <th scope="col" className="p-1">
                    Shifts
                  </th>
                  <th scope="col" className="p-1">
                    Hours
                  </th>
                  <th scope="col" className="p-1">
                    Not worked
                  </th>
                  <th scope="col" className="p-1">
                    To check
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.totals.map((t) => (
                  <tr key={`${t.account}:${t.kind?.id ?? ""}`} className="border-t">
                    <th scope="row" className="p-1 text-left font-normal">
                      {t.name}
                    </th>
                    <td className="p-1">{basisLabel(t.basis)}</td>
                    <td className="p-1">{t.kindName}</td>
                    <td className="p-1">{t.shifts}</td>
                    <td className="p-1">{t.hours}</td>
                    <td className="p-1">{t.notWorked}</td>
                    <td className="p-1">{t.flagged ? `${t.flagged} flagged` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm">All counted hours: {data.hours}</p>
          <details>
            <summary className="cursor-pointer text-sm">Each shift, with its evidence</summary>
            <div className="max-w-full overflow-x-auto">
              <table className="text-sm" aria-label="Each shift">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className="p-1">
                      Date
                    </th>
                    <th scope="col" className="p-1">
                      Time
                    </th>
                    <th scope="col" className="p-1">
                      Person
                    </th>
                    <th scope="col" className="p-1">
                      Shift
                    </th>
                    <th scope="col" className="p-1">
                      Minutes counted
                    </th>
                    <th scope="col" className="p-1">
                      Evidence
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr
                      key={`${l.object}:${l.id}`}
                      className="border-t"
                      data-flagged={l.flagged ? "true" : undefined}
                    >
                      <td className="p-1">{dayLabel(l.localDate, locale)}</td>
                      <td className="p-1">
                        {l.localStart.slice(11, 16)}–{l.localEnd.slice(11, 16)}
                      </td>
                      <td className="p-1">{l.name}</td>
                      <td className="p-1">
                        {l.title}
                        {l.place ? ` · ${l.place}` : ""}
                      </td>
                      <td className="p-1">
                        {l.counted ? l.countedMinutes : "Not worked"}
                        {l.notWorkedReason ? ` (${l.notWorkedReason})` : ""}
                      </td>
                      <td className="p-1">
                        {l.listTaken === null
                          ? ""
                          : l.listTaken
                            ? `List taken${l.markedBy ? ` by ${l.markedBy}` : ""}`
                            : "List not taken"}
                        {l.flagged ? " · check who ran it" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={exported.isPending}
              onClick={download}
            >
              {locked ? "Export CSV" : "Export a preview CSV"}
            </Button>
            {!locked && period.ended ? (
              confirmLock ? (
                <div
                  role="alertdialog"
                  aria-label="Lock this period"
                  className="grid gap-2 rounded-md border p-2"
                >
                  <p className="text-sm">
                    Lock it? Its hours are kept as they are now, and its shifts can no longer be
                    changed until it is reopened.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      disabled={lock.isPending}
                      onClick={() => {
                        setConfirmLock(false);
                        void run(() => lock.mutateAsync({ start: period.start }), "Locked.");
                      }}
                    >
                      Lock the period
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setConfirmLock(false)}>
                      Not yet
                    </Button>
                  </div>
                </div>
              ) : (
                <Button type="button" onClick={() => setConfirmLock(true)}>
                  Lock…
                </Button>
              )
            ) : null}
          </div>
          {!locked && !period.ended ? (
            <p className="text-xs text-muted-foreground">It can be locked once it has ended.</p>
          ) : null}
          {locked ? (
            <form className="grid gap-1" onSubmit={doReopen} aria-label="Reopen this period">
              <label htmlFor={`${id}-why`} className="text-sm">
                Reopen to correct it: why?
              </label>
              <input
                id={`${id}-why`}
                className="rounded-md border border-input px-2 py-1 text-sm"
                value={reason}
                maxLength={500}
                autoComplete="off"
                onChange={(e) => setReason(e.target.value)}
              />
              <Button type="submit" variant="outline" disabled={reopen.isPending}>
                Reopen
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function Counted({
  rostering,
  today,
}: {
  rostering: Pick<RosteringHooks, "usePayBases" | "usePayBasis">;
  today: string;
}) {
  const bases = rostering.usePayBases({ everyone: true });
  const setBasis = rostering.usePayBasis();
  const [editing, setEditing] = useState<string | null>(null);
  const [basis, setBasisValue] = useState<PayBasisValue>("not_counted");
  const [from, setFrom] = useState(today);
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const id = useId();

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setRefusal(null);
    try {
      await forgetAfter(setBasis, { account: editing, basis, from });
      setEditing(null);
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await bases.refetch?.();
  }

  return (
    <section className="grid gap-2" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="font-medium">
        Who is counted
      </h3>
      {bases.isPending ? <p aria-busy="true">Loading…</p> : null}
      {bases.error ? <p role="alert">{rosterRefusal(bases.error).message}</p> : null}
      {refusal ? (
        <p role="alert" className="text-sm" data-refusal={refusal.kind}>
          {refusal.message}
        </p>
      ) : null}
      <ul className="grid gap-1 text-sm">
        {(bases.data?.items ?? []).map((item) => (
          <li key={item.account} className="grid gap-1 rounded border p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {item.name} · {basisLabel(item.basis)}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Change how ${item.name} is counted`}
                onClick={() => {
                  setEditing(item.account);
                  setBasisValue(item.basis);
                  setFrom(today);
                }}
              >
                Change
              </Button>
            </div>
            {editing === item.account ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={save}
                aria-label={`How ${item.name} is counted`}
              >
                <label className="grid gap-1">
                  <span>Counted</span>
                  <select
                    className="rounded-md border border-input px-2 py-1"
                    value={basis}
                    onChange={(e) => setBasisValue(e.target.value as PayBasisValue)}
                  >
                    <option value="not_counted">{basisLabel("not_counted")}</option>
                    <option value="by_time">{basisLabel("by_time")}</option>
                    <option value="by_class">{basisLabel("by_class")}</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span>From</span>
                  <input
                    type="date"
                    className="rounded-md border border-input px-2 py-1"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <Button type="submit" size="sm" disabled={setBasis.isPending}>
                  Save
                </Button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {bases.data?.truncated ? (
        <p className="text-xs text-muted-foreground">Only the first people are listed.</p>
      ) : null}
    </section>
  );
}
