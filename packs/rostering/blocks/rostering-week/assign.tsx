// Putting someone on a shift (stage 45 step 7), for someone who rosters: opened from a shift on the
// roster week. The people the host says could take it come first (qualified, free, available),
// the rest below with the host's warnings, and those it would clash with or cannot name last,
// each saying why. "Back to the pattern" for a shift of a weekly pattern that keeps its own
// person; nobody on it; offer it to everyone who could take it; and, once it has started, mark it
// not worked with why.
//
// Every answer is the host's: who is eligible and why not (`candidates`, the same dry run a write
// is made with), the warnings a write was made with, and each refusal (double_booked naming the
// other shift, nobody_qualified, the cut-off, a locked pay period, someone who no longer rosters).
// Why a shift was not worked is forgotten once the call is over and when the page is left.
import {
  dateIn,
  forgetAfter,
  type RosteringHooks,
  type RosterRefusal,
  type RosterShift,
  refusalNext,
  rosterRefusal,
  shiftTime,
  warningLabel,
} from "@composable-os/pack-rostering/client";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui-button/button.tsx";

export type AssignHooks = Pick<
  RosteringHooks,
  "useCandidates" | "useAssign" | "useFollow" | "useOffer" | "useMarkNotWorked"
>;

/** Forgets what was typed when the page is left, or brought back from the back-forward cache. */
function useForgetOnLeave(forget: () => void): void {
  const latest = useRef(forget);
  latest.current = forget;
  useEffect(() => {
    const hide = () => latest.current();
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) latest.current();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, []);
}

export function Assign({
  rostering,
  shift,
  zone,
  today,
  locale = "en-AU",
  onClose,
  onChanged,
}: {
  rostering: AssignHooks;
  shift: RosterShift;
  zone: string;
  /** Today's date in the business's zone, as the host gave it (`me.today`). */
  today: string;
  locale?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const candidates = rostering.useCandidates({ object: shift.object, id: shift.id });
  const assign = rostering.useAssign();
  const follow = rostering.useFollow();
  const offer = rostering.useOffer();
  const notWorked = rostering.useMarkNotWorked();
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const headingId = useId();
  const reasonId = useId();
  useForgetOnLeave(() => setReason(""));
  const busy = assign.isPending || follow.isPending || offer.isPending || notWorked.isPending;

  async function act(
    what: () => Promise<{ warnings?: { message: string }[] } | unknown>,
    said: string,
  ) {
    setRefusal(null);
    setDone(null);
    try {
      const answer = (await what()) as { warnings?: { message: string }[] } | undefined;
      const warnings = answer?.warnings ?? [];
      setDone(
        warnings.length
          ? `${said} With warnings: ${warnings.map((w) => w.message).join(" ")}`
          : said,
      );
      onChanged();
      await candidates.refetch?.();
    } catch (error) {
      setRefusal(rosterRefusal(error));
      onChanged();
      await candidates.refetch?.();
    }
  }

  async function markNotWorked(event: FormEvent) {
    event.preventDefault();
    const why = reason.trim();
    if (!why) {
      setRefusal({ kind: "invalid", message: "Say why it was not worked." });
      return;
    }
    await act(
      () =>
        forgetAfter(notWorked, {
          object: shift.object,
          id: shift.id,
          notWorked: true,
          reason: why,
        }),
      "Marked as not worked: it counts for nothing in its pay period.",
    );
    setReason("");
  }

  const data = candidates.data;
  const groups = data
    ? [
        { title: "Could take it", people: data.people.filter((p) => p.eligible) },
        {
          title: "With warnings",
          people: data.people.filter((p) => !p.eligible && !p.clash && !p.noProfile),
        },
        {
          title: "On another shift then, or no profile",
          people: data.people.filter((p) => p.clash || p.noProfile),
        },
      ]
    : [];
  return (
    <aside className="grid content-start gap-3 rounded-md border p-3" aria-labelledby={headingId}>
      <header className="flex items-start justify-between gap-2">
        <div>
          <h3 id={headingId} className="font-medium">
            {shift.title}
          </h3>
          <p className="text-sm text-muted-foreground">
            {shiftTime(shift, zone, { withDate: true, locale })}
            {shift.place ? ` · ${shift.place}` : ""}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={onClose} aria-label="Close the shift">
          Close
        </Button>
      </header>
      {refusal ? (
        <div
          role="alert"
          className="rounded-md border border-destructive p-2 text-sm"
          data-refusal={refusal.kind}
        >
          <p>{refusal.message}</p>
          {refusal.dates?.length ? <p>Dates: {refusal.dates.join(", ")}</p> : null}
          {refusalNext(refusal.kind, true) ? <p>{refusalNext(refusal.kind, true)}</p> : null}
        </div>
      ) : null}
      {done ? (
        <p role="status" className="text-sm">
          {done}
        </p>
      ) : null}
      {candidates.isPending ? <p aria-busy="true">Loading who could take it…</p> : null}
      {candidates.error ? (
        <p role="alert" data-refusal={rosterRefusal(candidates.error).kind}>
          {rosterRefusal(candidates.error).message}
        </p>
      ) : null}
      {data ? (
        <>
          <p className="text-sm">
            On it now: <strong>{data.current.name ?? "nobody"}</strong>
          </p>
          {data.pattern ? (
            <div className="grid gap-1 text-sm">
              <p>
                Its regular person: {data.pattern.name ?? "nobody"}
                {data.pattern.own ? " (this date keeps its own person)" : ""}
              </p>
              {data.pattern.own ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => follow.mutateAsync({ object: shift.object, id: shift.id }),
                      "Back to the pattern.",
                    )
                  }
                >
                  Back to the pattern
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {data.current.account ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  act(
                    () => assign.mutateAsync({ object: shift.object, id: shift.id, account: null }),
                    "Nobody is on it now.",
                  )
                }
              >
                Take {data.current.name ?? "them"} off it
              </Button>
            ) : null}
            {shift.offer ? null : (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  act(
                    () => offer.mutateAsync({ object: shift.object, id: shift.id }),
                    "Offered to everyone who could take it.",
                  )
                }
              >
                Offer to everyone
              </Button>
            )}
          </div>
          {data.truncated ? (
            <p className="text-xs text-muted-foreground">Only the first people are listed.</p>
          ) : null}
          {groups.map((group) =>
            group.people.length ? (
              <section key={group.title} className="grid gap-1" aria-label={group.title}>
                <h4 className="text-sm font-medium">{group.title}</h4>
                <ul className="grid gap-1">
                  {group.people.map((p) => (
                    <li
                      key={p.account}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border p-1.5 text-sm"
                    >
                      <span>
                        {p.name}
                        {p.account === data.current.account ? " (on it)" : ""}
                        {p.warnings.map((w) => (
                          <span
                            key={w.code}
                            className="ml-1 rounded border px-1 text-xs"
                            title={w.message}
                            data-warning={w.code}
                          >
                            {warningLabel(w.code)}
                          </span>
                        ))}
                        {p.clash ? (
                          <span className="block text-xs text-muted-foreground">
                            On {p.clash.title}, {shiftTime(p.clash, zone, { locale })}
                          </span>
                        ) : null}
                        {p.noProfile ? (
                          <span className="block text-xs text-muted-foreground">
                            No profile this shift can name
                          </span>
                        ) : null}
                      </span>
                      {p.account === data.current.account ? null : (
                        <Button
                          type="button"
                          size="sm"
                          variant={p.eligible ? "default" : "outline"}
                          disabled={busy || Boolean(p.clash) || p.noProfile}
                          aria-label={`Put ${p.name} on it`}
                          onClick={() =>
                            act(
                              () =>
                                assign.mutateAsync({
                                  object: shift.object,
                                  id: shift.id,
                                  account: p.account,
                                }),
                              `${p.name} is on it now.`,
                            )
                          }
                        >
                          Put on
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null,
          )}
          {/* Offered once its day has come; whether it has started is the host's (shift_not_started). */}
          {dateIn(shift.startsAt, zone) <= today && !shift.uncovered ? (
            <form className="grid gap-1" onSubmit={markNotWorked} aria-label="Mark not worked">
              <label htmlFor={reasonId} className="text-sm font-medium">
                Not worked? Say why (kept with the shift, for pay)
              </label>
              <input
                id={reasonId}
                className="rounded-md border border-input px-2 py-1 text-sm"
                value={reason}
                maxLength={500}
                autoComplete="off"
                onChange={(e) => setReason(e.target.value)}
              />
              <Button type="submit" variant="outline" disabled={busy}>
                Mark not worked
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}
