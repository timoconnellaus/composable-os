// For staff (stage 32b): one person's memberships and passes, with what each allows and what is
// left, as the host counts it; giving a pass by hand or voiding one given by hand, with a reason;
// and pausing their membership for a set time or ending a pause (stage 32b, decision 10: the host
// holds the plan's shortest and longest pause and asks the provider; the membership shows paused
// once the provider confirms). Both are a person's own act: the host refuses the assistant, an MCP client and an
// automation (the tools are human only), and staff without the memberships:passes permission.
import type { MembershipsHooks } from "@composable-os/pack-memberships/client";
import {
  allowsWords,
  changeWords,
  day,
  leftWords,
  subscriptionStatus,
} from "@composable-os/pack-memberships/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

export function PersonHoldings({
  memberships,
  personId,
  passTypes,
}: {
  memberships: Pick<
    MembershipsHooks,
    | "useHoldings"
    | "useGivePass"
    | "useVoidPass"
    | "useSubscriptionsOf"
    | "usePauseSubscription"
    | "useUnpauseSubscription"
  >;
  personId: string;
  /** The pass types staff may give, as the admin lists them (id and title). */
  passTypes: readonly { id: string; title: string }[];
}) {
  const held = memberships.useHoldings(personId);
  const give = memberships.useGivePass();
  const voided = memberships.useVoidPass();
  const subs = memberships.useSubscriptionsOf(personId);
  const pause = memberships.usePauseSubscription();
  const unpause = memberships.useUnpauseSubscription();
  const [until, setUntil] = useState("");
  const [type, setType] = useState(passTypes[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (held.isPending) return <p aria-busy="true">Loading…</p>;
  if (held.error || !held.data) return <p role="alert">We could not load their memberships.</p>;

  async function act(run: () => Promise<unknown>, done: string) {
    setProblem(null);
    setSaid(null);
    try {
      await run();
      setSaid(done);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That did not work");
    }
  }

  return (
    <section className="grid gap-4" aria-label="Memberships and passes">
      {held.data.holdings.map((h) => (
        <Card key={h.id} data-kind={h.kind}>
          <CardHeader>
            <CardTitle>{h.title}</CardTitle>
            <CardDescription>{`${h.status} · ${allowsWords(h)}`}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <p>{leftWords(h)}</p>
            {h.until ? <p className="text-sm">{`Until ${day(h.until)}`}</p> : null}
            {h.kind === "pass" && h.status === "active" ? (
              <Button
                variant="outline"
                disabled={voided.isPending || reason.trim().length < 3}
                onClick={() =>
                  void act(() => voided.mutateAsync({ passId: h.id, reason }), "The pass is void.")
                }
              >
                Void this pass
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ))}
      {(subs.data?.items ?? [])
        .filter((s) => s.state !== "ended" && s.state !== "expired")
        .map((s) => (
          <Card key={s.id} data-kind="subscription">
            <CardHeader>
              <CardTitle>{s.planTitle}</CardTitle>
              <CardDescription>{subscriptionStatus(s)}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {changeWords(s) ? <p>{changeWords(s)}</p> : null}
              {s.state === "paused" || s.change?.kind === "pause" ? (
                <Button
                  variant="outline"
                  disabled={unpause.isPending || reason.trim().length < 3}
                  onClick={() =>
                    void act(
                      () => unpause.mutateAsync({ id: s.id, reason }),
                      "Asked to end the pause. It shows here once the payment provider confirms.",
                    )
                  }
                >
                  {s.state === "paused" ? "End the pause now" : "Withdraw the pause"}
                </Button>
              ) : s.state === "active" ? (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(
                      () =>
                        pause.mutateAsync({
                          id: s.id,
                          until: new Date(`${until}T00:00:00`).toISOString(),
                          reason,
                        }),
                      "Asked to pause it. It shows paused once the payment provider confirms.",
                    );
                  }}
                >
                  <div className="grid gap-1">
                    <Label htmlFor={`pause-until-${s.id}`}>Pause until</Label>
                    <Input
                      id={`pause-until-${s.id}`}
                      type="date"
                      required
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={pause.isPending || !until || reason.trim().length < 3}
                  >
                    Pause membership
                  </Button>
                </form>
              ) : null}
            </CardContent>
          </Card>
        ))}
      <form
        className="grid max-w-sm gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void act(
            () => give.mutateAsync({ personId, passTypeId: type, reason }),
            "The pass is given.",
          );
        }}
      >
        <Label htmlFor="give-pass-type">Pass to give</Label>
        <select
          id="give-pass-type"
          className="rounded-md border px-2 py-1"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {passTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        <Label htmlFor="give-pass-reason">Why (kept on the pass, or the pause)</Label>
        <Input
          id="give-pass-reason"
          required
          minLength={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button type="submit" disabled={give.isPending || !type}>
          Give pass
        </Button>
      </form>
      {said ? <p role="status">{said}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
