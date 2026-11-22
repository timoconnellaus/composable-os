// Buying a pass on a gym's site (stage 32b): the pass types on sale (class packs, drop-ins, an
// intro offer) with the host's price, what each gives and how long it is valid, and a button that
// starts the order and opens the payment provider's page. The price, whether it is on sale, and
// the intro offer's one per person are the host's (`x.memberships.buy`, the host's order): a guest is
// refused an intro offer and told to sign in, and a second one is refused, whatever this shows.
// The pass is granted by the host once the provider confirms the payment. Web only.
import type { MembershipsHooks } from "@composable-os/pack-memberships/client";
import { allowsWords, formatPrice, refusalWords } from "@composable-os/pack-memberships/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";

export function Passes({
  memberships,
  returnUrl,
  signedIn,
  signInUrl,
}: {
  memberships: Pick<MembershipsHooks, "usePassTypes" | "useBuyPass">;
  /** Where the provider's page sends the buyer back to (one of the host's listed origins). */
  returnUrl: string;
  /** A signed-in customer buys as themselves; a guest gives their email. */
  signedIn: boolean;
  /** Where a guest signs in for an intro offer. */
  signInUrl?: string;
}) {
  const { data, isPending, error } = memberships.usePassTypes();
  const { start, checkout } = memberships.useBuyPass();
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState<{ id: string; words: string } | null>(null);
  if (isPending) return <p aria-busy="true">Loading the passes…</p>;
  if (error || !data) return <p role="alert">We could not load the passes.</p>;
  if (!data.passTypes.length) return <p>No passes are on sale yet.</p>;

  async function onBuy(passTypeId: string) {
    setProblem(null);
    try {
      const order = await start.mutateAsync({
        passTypeId,
        ...(signedIn ? {} : { email }),
      });
      const page = await checkout.mutateAsync({
        id: order.id,
        ...(order.token ? { token: order.token } : {}),
        returnUrl,
      });
      window.location.assign(page.url);
    } catch (e) {
      const details = (e as { details?: { rule?: unknown; reason?: unknown } }).details;
      setProblem({ id: passTypeId, words: refusalWords(details) });
    }
  }

  const busy = start.isPending || checkout.isPending;
  return (
    <section className="grid gap-4" aria-label="Passes">
      {data.passTypes.map((type) => (
        <Card key={type.id} data-intro={type.onePerPerson ? "true" : undefined}>
          <CardHeader>
            <CardTitle>{type.title}</CardTitle>
            <CardDescription>
              {`${formatPrice(type.price, data.currency)} · ${type.summary ?? allowsWords({ ...type, per: "total" })}${type.validDays ? ` · valid ${type.validDays} days` : ""}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {type.description ? <p>{type.description}</p> : null}
            {type.onePerPerson ? (
              <p className="text-sm">
                {signedIn ? "One per person." : "One per person: sign in to buy it."}
                {!signedIn && signInUrl ? (
                  <>
                    {" "}
                    <a href={signInUrl} className="underline">
                      Sign in
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            <form
              className="grid max-w-sm gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void onBuy(type.id);
              }}
            >
              {signedIn ? null : (
                <>
                  <Label htmlFor={`pass-email-${type.id}`}>Your email</Label>
                  <Input
                    id={`pass-email-${type.id}`}
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </>
              )}
              <Button type="submit" disabled={busy}>
                Buy
              </Button>
              {problem?.id === type.id ? <p role="alert">{problem.words}</p> : null}
            </form>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
