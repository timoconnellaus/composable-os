// Buying a pass on a gym's site (stage 32b): the pass types on sale (class packs, drop-ins, an
// intro offer) with the host's price, what each gives and how long it is valid, and a button that
// starts the order and opens the payment provider's page. The price, whether it is on sale, and
// the intro offer's one per person are the host's (`x.memberships.buy`, the host's order): a guest is
// refused an intro offer and told to sign in, and a second one is refused, whatever this shows.
// The pass is granted by the host once the provider confirms the payment. Web only.
//
// What must be agreed to first (stage 44: the terms, a waiver) is the host's answer too: when
// "Buy" is refused with it, the documents are shown inline (the web-agree block's step) and "Buy"
// is tried again. A visitor's agreements travel in the buying call, held in memory until then; a
// member's are recorded as they agree. A minor is told a parent or guardian buys it.
import {
  type AgreeInput,
  type AgreementsHooks,
  agreementRefusal,
  forgetAfter,
  purchaseErrorWords,
  type RefusedDocument,
  withAgreements,
} from "@composable-os/client";
import type { MembershipsHooks } from "@composable-os/pack-memberships/client";
import { allowsWords, formatPrice, refusalWords } from "@composable-os/pack-memberships/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";
import { Input } from "../ui-input/input.tsx";
import { Label } from "../ui-label/label.tsx";
import { useForgetOnLeave } from "../web-agree/agree.tsx";
import { GuestAgreementStep, MemberAgreementStep } from "../web-agree/agreement-step.tsx";

/** The agreements hooks the inline step uses: a member's (due, accept) and a visitor's (words). */
export type PassesAgreements = Pick<AgreementsHooks, "useDue" | "useAccept" | "useGuestVersions">;

export function Passes({
  memberships,
  agreements,
  returnUrl,
  signedIn,
  signInUrl,
}: {
  memberships: Pick<MembershipsHooks, "usePassTypes" | "useBuyPass">;
  /** For what must be agreed to first, shown inline. Without it, the refusal is only named. */
  agreements?: PassesAgreements;
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
  // What the host said must be agreed to first, for which pass.
  const [due, setDue] = useState<{ id: string; documents: RefusedDocument[] } | null>(null);
  // A visitor's agreements for one pass: this component's state only, kept if the purchase does
  // not start (nothing typed twice), forgotten once it starts and when they leave the page.
  const [agreed, setAgreed] = useState<{ id: string; given: AgreeInput[] } | null>(null);
  // A member's "a copy is on its way", for the pass they agreed for.
  const [said, setSaid] = useState<{ id: string; words: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useForgetOnLeave(() => setAgreed(null));
  if (isPending) return <p aria-busy="true">Loading the passes…</p>;
  if (error || !data) return <p role="alert">We could not load the passes.</p>;
  if (!data.passTypes.length) return <p>No passes are on sale yet.</p>;

  async function onBuy(
    passTypeId: string,
    given: AgreeInput[] | null = agreed?.id === passTypeId ? agreed.given : null,
  ) {
    setProblem(null);
    setBusy(true);
    try {
      const outcome = await withAgreements((previous) =>
        forgetAfter(start, {
          passTypeId,
          ...(signedIn ? {} : { email }),
          ...(!signedIn && given && previous?.kind !== "read_again" ? { agreements: given } : {}),
        }),
      );
      if (outcome.kind !== "done") setAgreed(null);
      if (outcome.kind === "due") {
        if (agreements) setDue({ id: passTypeId, documents: outcome.documents });
        else {
          setProblem({
            id: passTypeId,
            words: `Something must be agreed to first: ${outcome.documents.map((d) => d.title).join(", ")}.`,
          });
        }
        return;
      }
      if (outcome.kind === "minor_payer") {
        setProblem({ id: passTypeId, words: outcome.message });
        return;
      }
      const order = outcome.value;
      // Recorded with the order: nothing of it is kept here any more.
      setAgreed(null);
      const page = await forgetAfter(checkout, {
        id: order.id,
        ...(order.token ? { token: order.token } : {}),
        returnUrl,
      });
      window.location.assign(page.url);
    } catch (e) {
      const refusal = agreementRefusal(e);
      if (refusal) setAgreed(null);
      const details = (e as { details?: { rule?: unknown; reason?: unknown } }).details;
      setProblem({
        id: passTypeId,
        words: purchaseErrorWords(e) ?? (refusal ? refusal.message : refusalWords(details)),
      });
    } finally {
      setBusy(false);
    }
  }

  if (due && agreements) {
    const back = () => setDue(null);
    const passTypeId = due.id;
    return signedIn ? (
      <MemberAgreementStep
        agreements={agreements}
        documents={due.documents}
        continueLabel="Agree and buy"
        onCancel={back}
        onAgreed={(copy) => {
          setDue(null);
          if (copy) setSaid({ id: passTypeId, words: copy });
          void onBuy(passTypeId, null);
        }}
      />
    ) : (
      <GuestAgreementStep
        agreements={agreements}
        documents={due.documents}
        continueLabel="Agree and buy"
        onCancel={back}
        onAgreed={(given) => {
          setDue(null);
          setAgreed({ id: passTypeId, given });
          void onBuy(passTypeId, given);
        }}
      />
    );
  }

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
              {said?.id === type.id ? <p role="status">{said.words}</p> : null}
              {agreed?.id === type.id ? (
                <p className="text-sm">
                  What you agreed to is kept for this purchase: press Buy to try again.
                </p>
              ) : null}
              {problem?.id === type.id ? <p role="alert">{problem.words}</p> : null}
            </form>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
