// "Before you go on" (stage 44 step 5), for the web: shown after sign-in when the host says
// something is due (me.agreements.due). Each due document in turn, the member's own first, then
// each child's linked to them; "Not now" goes on to their account. It is a convenience: the host
// refuses a booking or a purchase while anything it needs is due, whatever this screen did.
import { type AgreementsHooks, copyWords, dueReasonWords, dueSteps } from "@composable-os/client";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Agree } from "../web-agree/agree.tsx";

/** No account page to go on to (the block mounted on its own): stay here. */
const stay = () => {};

export function BeforeYouGoOn({
  agreements,
  onDone = stay,
}: {
  agreements: Pick<AgreementsHooks, "useDue" | "useAccept">;
  /** Go on to the account: nothing was due, everything is agreed, or the member chose "Not now". */
  onDone?: () => void;
}) {
  const due = agreements.useDue();
  const accept = agreements.useAccept();
  const [said, setSaid] = useState<string | null>(null);
  // Documents a person cannot agree to themselves (a parent agrees for them), passed for now.
  const [passed, setPassed] = useState<string[]>([]);
  const agreedAny = useRef(false);
  const steps = due.data
    ? dueSteps(due.data.people).filter(
        (s) => !passed.includes(`${s.person.personId}:${s.item.documentId}`),
      )
    : null;
  const nothingAtAll = !!due.data && dueSteps(due.data.people).length === 0 && !agreedAny.current;
  useEffect(() => {
    if (nothingAtAll) onDone();
  }, [nothingAtAll, onDone]);

  if (due.isPending) return <p aria-busy="true">Loading…</p>;
  if (nothingAtAll) return <p role="status">Nothing to agree to.</p>;
  if (due.error || !steps) {
    return (
      <section className="grid gap-3" aria-label="Before you go on">
        <p role="alert">We could not check what is left to agree to. You can carry on for now.</p>
        <Button type="button" onClick={onDone}>
          Go to your account
        </Button>
      </section>
    );
  }
  const step = steps[0];
  if (!step) {
    return (
      <section className="grid gap-3" aria-label="Before you go on">
        <h1 className="text-xl font-semibold">
          {passed.length ? "That is all you can agree to here" : "You are all set"}
        </h1>
        {said ? <p role="status">{said}</p> : null}
        <Button type="button" onClick={onDone}>
          Go to your account
        </Button>
      </section>
    );
  }
  const { person, item } = step;
  const key = `${person.personId}:${item.documentId}`;
  return (
    <section className="grid gap-4" aria-label="Before you go on" data-due-count={steps.length}>
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Before you go on</h1>
        <p className="text-sm">
          {steps.length === 1
            ? "There is one thing to read and agree to."
            : `There are ${steps.length} things to read and agree to. You can do them now, or later before you book or buy.`}
        </p>
        {said ? (
          <p role="status" className="text-sm">
            {said}
          </p>
        ) : null}
      </header>
      {person.canAgree ? (
        <Agree
          key={`${key}:${item.version.id}`}
          version={item.version}
          forName={person.self ? null : person.name}
          reason={item.reason}
          secondary={{ label: "Not now", onClick: onDone }}
          onAgree={async (input) => {
            const accepted = await accept.mutateAsync({
              ...input,
              ...(person.self ? {} : { forPersonId: person.personId }),
            });
            agreedAny.current = true;
            setSaid(copyWords(accepted));
            await due.refetch?.();
          }}
        />
      ) : (
        <div className="grid gap-2" data-agreement-guardian>
          <h2 className="text-lg font-semibold">{item.title}</h2>
          <p>{dueReasonWords("guardian")}</p>
          <p className="text-sm">
            A parent or guardian linked to you agrees to it from their own account, or the business
            records a paper form they signed.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setPassed([...passed, key])}>
              Next
            </Button>
            <Button type="button" variant="outline" onClick={onDone}>
              Not now
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
