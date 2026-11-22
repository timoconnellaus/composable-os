// For staff (stage 32b): one person's memberships and passes, with what each allows and what is
// left, as the host counts it; and giving a pass by hand or voiding one given by hand, with a
// reason. Both are a person's own act: the host refuses the assistant, an MCP client and an
// automation (the tools are human only), and staff without the memberships:passes permission.
import type { MembershipsHooks } from "@composable-os/pack-memberships/client";
import { allowsWords, day, leftWords } from "@composable-os/pack-memberships/client";
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
  memberships: Pick<MembershipsHooks, "useHoldings" | "useGivePass" | "useVoidPass">;
  personId: string;
  /** The pass types staff may give, as the admin lists them (id and title). */
  passTypes: readonly { id: string; title: string }[];
}) {
  const held = memberships.useHoldings(personId);
  const give = memberships.useGivePass();
  const voided = memberships.useVoidPass();
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
        <Label htmlFor="give-pass-reason">Why (kept on the pass)</Label>
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
