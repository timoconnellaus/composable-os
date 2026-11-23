// The inline agreement step (stage 44 step 5), for a block that buys or books: shown when the
// host refused the call with what must be agreed to first (`agreements_due`), before "Pay" or
// "Book" is tried again. Which documents, whose, and which version are the refusal's and
// `me.agreements.due`'s: this shows them in turn and hands back when they are agreed.
//
//   MemberAgreementStep  a signed-in member (or a parent, for a child linked to them): each one is
//                        recorded at once (me.agreements.accept), then the caller tries again.
//   GuestAgreementStep   a visitor without an account: nothing is recorded here; what they give
//                        goes back to the caller for the buying call (`agreements`), and the host
//                        records it with the order. It is kept in memory only, until that call.
import {
  type AgreeInput,
  type AgreementsHooks,
  copyWords,
  dueForRefusal,
  dueReasonWords,
  forgetAfter,
  type RefusedDocument,
} from "@composable-os/client";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Agree, useForgetOnLeave } from "./agree.tsx";

export function MemberAgreementStep({
  agreements,
  documents,
  continueLabel = "Agree and continue",
  onAgreed,
  onCancel,
}: {
  agreements: Pick<AgreementsHooks, "useDue" | "useAccept">;
  /** The documents the host's refusal named. */
  documents: RefusedDocument[];
  /** The last button's words ("Agree and book", "Agree and pay"). */
  continueLabel?: string;
  /** Everything named is agreed: the caller tries again. `said` is what to tell the person. */
  onAgreed: (said: string | null) => void;
  onCancel: () => void;
}) {
  const due = agreements.useDue();
  const accept = agreements.useAccept();
  const [said, setSaid] = useState<string | null>(null);
  const steps = due.data ? dueForRefusal(due.data.people, documents) : null;
  // Agreed to here: once nothing named is due, the caller tries again, once. When nothing was
  // due to begin with (agreed elsewhere meanwhile), the person says when: never a loop of calls.
  const agreedHere = useRef(false);
  const done = useRef(false);
  useEffect(() => {
    if (steps && steps.length === 0 && agreedHere.current && !done.current) {
      done.current = true;
      onAgreed(said);
    }
  });
  if (due.isPending) return <p aria-busy="true">Loading what to agree to…</p>;
  if (due.error || !steps) {
    return (
      <div className="grid gap-2">
        <p role="alert">We could not load what to agree to. Try again soon.</p>
        <Button type="button" variant="outline" onClick={onCancel}>
          Back
        </Button>
      </div>
    );
  }
  const step = steps[0];
  if (!step) {
    if (agreedHere.current) return <p aria-busy="true">Carrying on…</p>;
    return (
      <div className="grid gap-2">
        <p role="status">There is nothing left here for you to agree to.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => onAgreed(null)}>
            Try again
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Back
          </Button>
        </div>
      </div>
    );
  }
  const { person, item } = step;
  return (
    <section className="grid gap-3" aria-label="Before you go on" data-agreement-step="member">
      <p className="text-sm">
        {steps.length === 1
          ? "One thing to agree to first."
          : `${steps.length} things to agree to first. This is the first.`}
      </p>
      {said ? (
        <p role="status" className="text-sm">
          {said}
        </p>
      ) : null}
      {person.canAgree ? (
        <Agree
          key={`${person.personId}:${item.version.id}`}
          version={item.version}
          forName={person.self ? null : person.name}
          reason={item.reason}
          submitLabel={steps.length === 1 ? continueLabel : "Agree"}
          secondary={{ label: "Back", onClick: onCancel }}
          onAgree={async (input: AgreeInput) => {
            const accepted = await forgetAfter(accept, {
              ...input,
              ...(person.self ? {} : { forPersonId: person.personId }),
            });
            agreedHere.current = true;
            setSaid(copyWords(accepted));
            await due.refetch?.();
          }}
        />
      ) : (
        <div className="grid gap-2" data-agreement-guardian>
          <h2 className="text-lg font-semibold">{item.title}</h2>
          <p role="alert">{dueReasonWords("guardian")}</p>
          <p className="text-sm">
            A parent or guardian linked to you agrees to it from their own account, or the business
            records a paper form they signed.
          </p>
          <Button type="button" variant="outline" onClick={onCancel}>
            Back
          </Button>
        </div>
      )}
    </section>
  );
}

export function GuestAgreementStep({
  agreements,
  documents,
  continueLabel = "Agree and pay",
  onAgreed,
  onCancel,
}: {
  agreements: Pick<AgreementsHooks, "useGuestVersions">;
  /** The documents the host's refusal named (a visitor's name no Person). */
  documents: RefusedDocument[];
  continueLabel?: string;
  /** Every document is agreed to: the caller passes these in its buying call, then drops them. */
  onAgreed: (agreed: AgreeInput[]) => void;
  onCancel: () => void;
}) {
  const ids = documents.map((d) => d.versionId);
  const versions = agreements.useGuestVersions(ids);
  // What the visitor gave, by version: in memory only, handed back once, then dropped.
  const [agreed, setAgreed] = useState<AgreeInput[]>([]);
  useForgetOnLeave(() => setAgreed([]));
  if (versions.isPending) return <p aria-busy="true">Loading what to agree to…</p>;
  const found = versions.data?.versions ?? [];
  if (versions.error || found.length !== new Set(ids).size) {
    // A version the host no longer asks for (a new one took effect): start again from "Pay".
    return (
      <div className="grid gap-2">
        <p role="alert">
          {versions.error
            ? "We could not load what to agree to. Try again soon."
            : "What must be agreed to has just changed. Please start again."}
        </p>
        <Button type="button" variant="outline" onClick={onCancel}>
          Back
        </Button>
      </div>
    );
  }
  const next = found.find((v) => !agreed.some((a) => a.versionId === v.id));
  if (!next) return <p aria-busy="true">Carrying on…</p>;
  const toGo = found.length - agreed.length;
  return (
    <section className="grid gap-3" aria-label="Before you pay" data-agreement-step="guest">
      <p className="text-sm">
        {toGo === 1
          ? "One thing to agree to before you pay."
          : `${toGo} things to agree to before you pay. This is the first.`}{" "}
        A copy of each is emailed to you once your payment goes through.
      </p>
      <Agree
        key={next.id}
        version={next}
        submitLabel={toGo === 1 ? continueLabel : "Agree"}
        secondary={{
          label: "Back",
          onClick: () => {
            setAgreed([]);
            onCancel();
          },
        }}
        onAgree={(input) => {
          const all = [...agreed, input];
          if (all.length === found.length) {
            setAgreed([]);
            onAgreed(all);
          } else setAgreed(all);
        }}
      />
    </section>
  );
}
