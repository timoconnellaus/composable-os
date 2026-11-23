// My shifts (stage 45 step 7), for every rostered person: my shifts over the next weeks, day by
// day, each with its time in the business's zone, its place, and a button to offer it to everyone
// who could take it, or to withdraw my open offer. An offered shift stays mine (in my list and my
// pay) until someone takes it; the host says so, and refuses an offer it would not let through
// (nobody else qualified, past the cut-off, already offered), each with its own state here.
//
// Room is left for what later steps add: a duty shift's checklist under the shift (`shiftExtra`,
// step 4b) and my calendar's address above the list (`calendar`, step 5).
import {
  addDays,
  dateIn,
  dayLabel,
  type RosteringHooks,
  type RosterRefusal,
  type RosterShift,
  refusalNext,
  rosterRefusal,
  shiftName,
  shiftTime,
} from "@composable-os/pack-rostering/client";
import { type ReactNode, useId, useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "useMine" | "useOffers" | "useOffer" | "useWithdraw">;

export function MyShifts({
  rostering,
  from,
  days = 28,
  locale = "en-AU",
  calendar,
  shiftExtra,
}: {
  rostering: Hooks;
  /** The first date; today in the business's zone by default. */
  from?: string;
  /** How many days ahead (at most 62). */
  days?: number;
  locale?: string;
  /** My calendar's address and its buttons (the calendar feed block, once step 5 is built). */
  calendar?: ReactNode;
  /** Something to show under a shift (its checklist, once step 4b is built). */
  shiftExtra?: (shift: RosterShift) => ReactNode;
}) {
  const me = rostering.useMe();
  const first = from ?? me.data?.today ?? null;
  const mine = rostering.useMine(
    { from: first ?? "", to: first ? addDays(first, Math.min(days, 62) - 1) : "" },
    first !== null,
  );
  const offers = rostering.useOffers();
  const offer = rostering.useOffer();
  const withdraw = rostering.useWithdraw();
  const [refusal, setRefusal] = useState<{ id: string; refusal: RosterRefusal } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const headingId = useId();
  if (me.isPending) return <p aria-busy="true">Loading your shifts…</p>;
  if (me.error || !me.data) return <p role="alert">{rosterRefusal(me.error).message}</p>;
  const zone = mine.data?.zone ?? me.data.zone;
  const busy = offer.isPending || withdraw.isPending;

  async function act(id: string, what: () => Promise<unknown>, done: string) {
    setRefusal(null);
    setSaid(null);
    try {
      await what();
      setSaid(done);
    } catch (error) {
      setRefusal({ id, refusal: rosterRefusal(error) });
    }
    await Promise.all([mine.refetch?.(), offers.refetch?.()]);
  }

  const shifts = mine.data?.shifts ?? [];
  const byDate = new Map<string, RosterShift[]>();
  for (const s of shifts) {
    const date = dateIn(s.startsAt, zone);
    byDate.set(date, [...(byDate.get(date) ?? []), s]);
  }
  return (
    <section className="grid gap-4" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-medium">
        My shifts
      </h2>
      {calendar}
      <p className="text-sm text-muted-foreground">
        Times are in {zone}. Offers close {me.data.cutoffMinutes} minutes before a shift starts.
      </p>
      {said ? (
        <p role="status" className="text-sm">
          {said}
        </p>
      ) : null}
      {mine.isPending ? <p aria-busy="true">Loading your shifts…</p> : null}
      {mine.error ? <p role="alert">{rosterRefusal(mine.error).message}</p> : null}
      {mine.data?.truncated ? (
        <p role="status" className="text-sm">
          You have more shifts than one screen shows: the first ones are shown.
        </p>
      ) : null}
      {mine.data && !shifts.length ? <p>You have no shifts in the next {days} days.</p> : null}
      <ol className="grid gap-3" aria-label="Days">
        {[...byDate.entries()].map(([date, list]) => (
          <li key={date} className="grid gap-2">
            <h3 className="text-sm font-medium">{dayLabel(date, locale, true)}</h3>
            <ul className="grid gap-2">
              {list.map((shift) => (
                <li
                  key={shift.id}
                  className="grid gap-1 rounded-md border p-3"
                  aria-label={shiftName(shift, zone, locale)}
                  data-shift={shift.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{shift.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {shiftTime(shift, zone, { locale })}
                        {shift.place ? ` · ${shift.place}` : ""}
                      </p>
                      {shift.offer ? (
                        <p className="text-sm">Offered: still yours until someone takes it.</p>
                      ) : null}
                    </div>
                    {shift.offer ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        aria-label={`Withdraw the offer of ${shift.title}`}
                        onClick={() =>
                          act(
                            shift.id,
                            () => withdraw.mutateAsync({ offer: shift.offer?.id ?? "" }),
                            "Offer withdrawn: the shift is still yours.",
                          )
                        }
                      >
                        Withdraw offer
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        aria-label={`Offer ${shift.title} for someone else to take`}
                        onClick={() =>
                          act(
                            shift.id,
                            () => offer.mutateAsync({ object: shift.object, id: shift.id }),
                            "Offered to everyone who could take it. It stays yours until someone does.",
                          )
                        }
                      >
                        Offer
                      </Button>
                    )}
                  </div>
                  {refusal?.id === shift.id ? (
                    <div role="alert" className="text-sm" data-refusal={refusal.refusal.kind}>
                      <p>{refusal.refusal.message}</p>
                      {refusalNext(refusal.refusal.kind, me.data?.rosters ?? false) ? (
                        <p>{refusalNext(refusal.refusal.kind, me.data?.rosters ?? false)}</p>
                      ) : null}
                    </div>
                  ) : null}
                  {shiftExtra?.(shift)}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {offers.data?.mine.length ? (
        <section className="grid gap-2" aria-label="My open offers">
          <h3 className="text-sm font-medium">My open offers</h3>
          <ul className="grid gap-1 text-sm">
            {offers.data.mine.map((o) => (
              <li key={o.id}>
                {o.shift.title}, {shiftTime(o.shift, zone, { withDate: true, locale })}
                {o.to ? " (to one person)" : ""}
                {o.closesAt
                  ? ` · closes ${shiftTime({ startsAt: o.closesAt, endsAt: null }, zone, { withDate: true, locale })}`
                  : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
