// Offered to me (stage 45 step 7), for every rostered person: the shifts others offered that the
// host says I could take now (I am qualified for the kind of work, free then, and it is before the
// cut-off), soonest first, and a button to take each. Nobody approves a take; the person who
// offered it and whoever rosters are told.
//
// The host decides everything and this shows its answer: when I said I am away then, the host
// asks me to confirm (`unavailable_confirm`) and this asks the same; when someone else took it
// first, the host names them (`offer_taken`); a withdrawn or lapsed offer, one whose shift
// changed hands, one past the cut-off, a clash with a shift of mine, or a kind I am not qualified
// for each has its own state, and the list is refreshed.
import {
  type OpenOffer,
  type RosteringHooks,
  type RosterRefusal,
  refusalNext,
  rosterRefusal,
  shiftTime,
} from "@composable-os/pack-rostering/client";
import { useId, useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<RosteringHooks, "useMe" | "useOffers" | "useTake">;

export function OffersToMe({ rostering, locale = "en-AU" }: { rostering: Hooks; locale?: string }) {
  const me = rostering.useMe();
  const offers = rostering.useOffers();
  const take = rostering.useTake();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ id: string; refusal: RosterRefusal } | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const headingId = useId();
  if (me.isPending || offers.isPending) return <p aria-busy="true">Loading offers…</p>;
  if (me.error || !me.data) return <p role="alert">{rosterRefusal(me.error).message}</p>;
  const zone = me.data.zone;

  async function takeIt(o: OpenOffer, confirmUnavailable: boolean) {
    setRefusal(null);
    setTaken(null);
    try {
      await take.mutateAsync({
        offer: o.id,
        ...(confirmUnavailable ? { confirmUnavailable } : {}),
      });
      setConfirming(null);
      setTaken(
        `${o.shift.title}, ${shiftTime(o.shift, zone, { withDate: true, locale })} is yours now.`,
      );
    } catch (error) {
      const r = rosterRefusal(error);
      if (r.kind === "unavailable_confirm") {
        setConfirming(o.id);
        return;
      }
      setConfirming(null);
      setRefusal({ id: o.id, refusal: r });
    }
    await offers.refetch?.();
  }

  const open = offers.data?.open ?? [];
  return (
    <section className="grid gap-3" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-medium">
        Offered to me
      </h2>
      {taken ? (
        <p role="status" className="text-sm">
          {taken}
        </p>
      ) : null}
      {refusal && !open.some((o) => o.id === refusal.id) ? (
        <div
          role="alert"
          className="rounded-md border p-2 text-sm"
          data-refusal={refusal.refusal.kind}
        >
          <p>{refusal.refusal.message}</p>
          {refusalNext(refusal.refusal.kind, me.data.rosters) ? (
            <p>{refusalNext(refusal.refusal.kind, me.data.rosters)}</p>
          ) : null}
        </div>
      ) : null}
      {offers.error ? <p role="alert">{rosterRefusal(offers.error).message}</p> : null}
      {offers.data && !open.length ? <p>No shifts are offered to you right now.</p> : null}
      <ul className="grid gap-2">
        {open.map((o) => (
          <li
            key={o.id}
            className="grid gap-2 rounded-md border p-3"
            data-offer={o.id}
            aria-label={`${o.shift.title}, ${shiftTime(o.shift, zone, { withDate: true, locale })}, offered by ${o.fromName ?? "whoever rosters"}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{o.shift.title}</p>
                <p className="text-sm text-muted-foreground">
                  {shiftTime(o.shift, zone, { withDate: true, locale })}
                </p>
                <p className="text-sm">
                  Offered by {o.fromName ?? "whoever rosters"}
                  {o.to ? " to you" : ""}
                  {o.unavailable ? " · You said you are away then" : ""}
                </p>
              </div>
              {confirming === o.id ? null : (
                <Button
                  type="button"
                  disabled={take.isPending}
                  aria-label={`Take ${o.shift.title}`}
                  onClick={() => takeIt(o, false)}
                >
                  Take it
                </Button>
              )}
            </div>
            {confirming === o.id ? (
              <div
                role="alertdialog"
                aria-label="You said you are away then"
                className="grid gap-2 rounded-md border p-2"
              >
                <p className="text-sm">You said you are not available then. Take it anyway?</p>
                <div className="flex gap-2">
                  <Button type="button" disabled={take.isPending} onClick={() => takeIt(o, true)}>
                    Take it anyway
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
                    Leave it
                  </Button>
                </div>
              </div>
            ) : null}
            {refusal?.id === o.id ? (
              <div role="alert" className="text-sm" data-refusal={refusal.refusal.kind}>
                <p>{refusal.refusal.message}</p>
                {refusalNext(refusal.refusal.kind, me.data?.rosters ?? false) ? (
                  <p>{refusalNext(refusal.refusal.kind, me.data?.rosters ?? false)}</p>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
