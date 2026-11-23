// My calendar (stage 45 step 7, over step 5's feed, ADR 0628), for every rostered person: whether
// I have a private calendar address for my own shifts, making one (or a new one, which stops the
// old), and switching it off. The address is shown once, as the host gives it: copied, or opened
// in a calendar app ("Add to calendar", a webcal link); it is never stored here, never put in a
// URL of this app, and cleared when the page is left or brought back from the back-forward cache.
// The host keeps only its hash, so a lost address is never shown again: the person makes a new one.
//
// Everything is the host's: whether a feed exists, the address, who may make one (the person
// themselves), and each refusal, including a retried request whose answer the host never keeps
// (`address_lost`: a new address was made but cannot be shown; make another).
import {
  type FeedState,
  feedAddresses,
  forgetAfter,
  type RosteringHooks,
  type RosterRefusal,
  rosterRefusal,
} from "@composable-os/pack-rostering/client";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui-button/button.tsx";

type Hooks = Pick<RosteringHooks, "useFeed" | "useFeedRotate" | "useFeedRevoke">;

/** Clears what is shown when the page is left, and when it comes back from the back-forward cache. */
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

export function MyCalendar({
  rostering,
  hostUrl,
}: {
  rostering: Hooks;
  /** The host's address (`https://admin.example.com`): the calendar address is on it. */
  hostUrl: string;
}) {
  const feed = rostering.useFeed();
  const rotate = rostering.useFeedRotate();
  const revoke = rostering.useFeedRevoke();
  const [address, setAddress] = useState<{ https: string; webcal: string } | null>(null);
  const [confirm, setConfirm] = useState<"replace" | "off" | null>(null);
  const [refusal, setRefusal] = useState<RosterRefusal | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const id = useId();
  useForgetOnLeave(() => {
    setAddress(null);
    setSaid(null);
  });
  // Gone from the screen, gone: nothing of it outlives the block.
  useEffect(() => () => setAddress(null), []);

  async function make() {
    setConfirm(null);
    setRefusal(null);
    setSaid(null);
    setAddress(null);
    try {
      const made = await forgetAfter(rotate, {});
      setAddress(feedAddresses(hostUrl, made.path));
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await feed.refetch?.();
  }

  async function off() {
    setConfirm(null);
    setRefusal(null);
    setAddress(null);
    try {
      await revoke.mutateAsync({});
      setSaid(
        "Switched off: the address no longer works. Your calendar keeps what it last fetched.",
      );
    } catch (error) {
      setRefusal(rosterRefusal(error));
    }
    await feed.refetch?.();
  }

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address.https);
      setSaid("Copied. Paste it where your calendar app adds a calendar by address.");
    } catch {
      setSaid("Select the address and copy it.");
    }
  }

  const state: FeedState | undefined = feed.data;
  return (
    <section className="grid gap-3" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="text-lg font-medium">
        My calendar
      </h2>
      <p className="text-sm text-muted-foreground">
        A private address your phone's calendar subscribes to: your own shifts, kept up to date.
        Anyone with the address sees your shifts, so do not share it. Calendar apps fetch it on
        their own schedule, often hours apart: this app is always the latest.
      </p>
      {feed.isPending ? <p aria-busy="true">Loading…</p> : null}
      {feed.error ? <p role="alert">{rosterRefusal(feed.error).message}</p> : null}
      {refusal ? (
        <p role="alert" className="text-sm" data-refusal={refusal.kind}>
          {refusal.message}
        </p>
      ) : null}
      {said ? (
        <p role="status" className="text-sm">
          {said}
        </p>
      ) : null}
      {address ? (
        <div className="grid gap-2 rounded-md border p-3" data-testid="feed-address">
          <label htmlFor={`${id}-a`} className="text-sm font-medium">
            Your calendar address (shown this once)
          </label>
          <input
            id={`${id}-a`}
            readOnly
            value={address.https}
            className="w-full rounded-md border border-input px-2 py-1 font-mono text-xs"
            autoComplete="off"
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={copy}>
              Copy the address
            </Button>
            <Button asChild variant="outline">
              <a href={address.webcal} rel="noreferrer noopener">
                Add to calendar
              </a>
            </Button>
            <Button type="button" variant="outline" onClick={() => setAddress(null)}>
              Done
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            It is not kept here. Lost it? Make a new address: the old one stops working.
          </p>
        </div>
      ) : null}
      {state && !address ? (
        <p className="text-sm" data-feed={state.active ? "on" : "off"}>
          {state.active
            ? `You have a calendar address${state.createdAt ? `, made ${new Date(state.createdAt).toLocaleDateString()}` : ""}.`
            : "You have no calendar address."}
        </p>
      ) : null}
      {state ? (
        confirm ? (
          <div
            role="alertdialog"
            aria-label={confirm === "replace" ? "Make a new address" : "Switch it off"}
            className="grid gap-2 rounded-md border p-2"
          >
            <p className="text-sm">
              {confirm === "replace"
                ? "Make a new address? The one you have stops working, in every calendar that uses it."
                : "Switch it off? The address stops working; your calendar keeps what it last fetched."}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={rotate.isPending || revoke.isPending}
                onClick={confirm === "replace" ? make : off}
              >
                {confirm === "replace" ? "Make a new address" : "Switch it off"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirm(null)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {state.active ? (
              <>
                <Button type="button" variant="outline" onClick={() => setConfirm("replace")}>
                  Make a new address…
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirm("off")}>
                  Switch it off…
                </Button>
              </>
            ) : (
              <Button type="button" disabled={rotate.isPending} onClick={make}>
                Make my calendar address
              </Button>
            )}
          </div>
        )
      ) : null}
    </section>
  );
}
