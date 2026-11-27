// "Before you go on" (stage 44): after sign-in, each document the host says is due, the
// customer's own first, then each child's linked to them; "Not now" goes to the account. Nothing
// due: straight on to the account. A convenience only: the host refuses a booking or a purchase
// while anything it needs is due. For a styled screen, copy the web-agreements-due block.
import { type AgreeInput, copyWords, type DuePerson, dueSteps } from "@composable-os/client";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AgreeForm } from "../agree-form.tsx";
import { signedOut } from "../agreements.ts";
import { useScreenHost } from "../screen-host/index.ts";

export const Route = createFileRoute("/before-you-go-on")({ component: BeforeYouGoOn });

function BeforeYouGoOn() {
  const host = useScreenHost();
  const navigate = useNavigate();
  const [people, setPeople] = useState<DuePerson[] | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(
    async (first: boolean) => {
      try {
        const due = await host.api.call("me.agreements.due", {});
        const people: DuePerson[] = due.people;
        if (first && !dueSteps(people).length) await navigate({ to: "/account", replace: true });
        else setPeople(people);
      } catch (error) {
        if (signedOut(error)) await navigate({ to: "/sign-in" });
        else setFailed(true);
      }
    },
    [host, navigate],
  );
  useEffect(() => {
    void load(true);
  }, [load]);

  if (failed) {
    return (
      <main>
        <p role="alert">We could not check what is left to agree to.</p>
        <Link to="/account">Go to your account</Link>
      </main>
    );
  }
  if (!people) return <main aria-busy="true">Loading…</main>;
  // Someone a parent or guardian agrees for cannot agree here: those are left for their parent.
  const step = dueSteps(people).find((s) => s.person.canAgree);
  return (
    <main>
      <h1>Before you go on</h1>
      {said ? <p role="status">{said}</p> : null}
      {step ? (
        <AgreeForm
          key={`${step.person.personId}:${step.item.version.id}`}
          version={step.item.version}
          forName={step.person.self ? null : step.person.name}
          onAgree={async (input: AgreeInput) => {
            const accepted = await host.api.call("me.agreements.accept", {
              ...input,
              ...(step.person.self ? {} : { forPersonId: step.person.personId }),
            });
            setSaid(copyWords(accepted));
            await load(false);
          }}
        />
      ) : (
        <p>You are all set.</p>
      )}
      <p>
        <Link to="/account">{step ? "Not now" : "Go to your account"}</Link>
      </p>
    </main>
  );
}
