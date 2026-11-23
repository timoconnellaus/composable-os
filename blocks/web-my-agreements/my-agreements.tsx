// My agreements (stage 44 step 5), for the web: what the signed-in member, and each child linked
// to them, has agreed to (each document, the version, when, how and by whom), what is due (with a
// notice when a document changed and must be agreed to again), the signed PDF, and a health form's
// answers to update. With `personId`, one child's only: a child's agreements, for their parent.
//
// What it shows is the host's (me.agreements.list, me.agreements.due, me.agreements.get): a name
// typed and a signature appear only to whoever agreed, and another guardian sees only "agreed by
// a parent or guardian". A child signed in sees no guardian's name or signature.
import {
  type AcceptanceSummary,
  type AgreementsHooks,
  agreedByWords,
  agreementPdfPath,
  agreementTime,
  copyWords,
  type DueDocument,
  type DuePerson,
  dueReasonWords,
  strokePath,
} from "@composable-os/client";
import { useState } from "react";
import { Button } from "../ui-button/button.tsx";
import { Agree, AgreementText } from "../web-agree/agree.tsx";

type Hooks = Pick<AgreementsHooks, "useDue" | "useMine" | "useAcceptance" | "useAccept">;

export function MyAgreements({
  agreements,
  personId,
  pdfUrl = agreementPdfPath,
}: {
  agreements: Hooks;
  /** One child's agreements only (their parent's view). Default: the member's and each child's. */
  personId?: string;
  /** Where an acceptance's PDF downloads from: the host's route on this site by default. */
  pdfUrl?: (acceptanceId: string) => string;
}) {
  const due = agreements.useDue();
  const mine = agreements.useMine();
  const [said, setSaid] = useState<string | null>(null);
  if (due.isPending || mine.isPending) return <p aria-busy="true">Loading your agreements…</p>;
  if (due.error || mine.error || !due.data || !mine.data) {
    return <p role="alert">We could not load your agreements. Try again soon.</p>;
  }
  const me = due.data.people.find((p) => p.self)?.personId ?? null;
  const people = due.data.people.filter((p) => !personId || p.personId === personId);
  return (
    <section className="grid gap-6" aria-label="My agreements">
      {said ? <p role="status">{said}</p> : null}
      {people.map((person) => (
        <PersonAgreements
          key={person.personId}
          person={person}
          me={me}
          items={mine.data?.items.filter((a) => a.personId === person.personId) ?? []}
          agreements={agreements}
          pdfUrl={pdfUrl}
          onAgreed={(text) => {
            setSaid(text);
            due.refetch?.();
            mine.refetch?.();
          }}
        />
      ))}
    </section>
  );
}

function PersonAgreements({
  person,
  me,
  items,
  agreements,
  pdfUrl,
  onAgreed,
}: {
  person: DuePerson;
  me: string | null;
  items: AcceptanceSummary[];
  agreements: Hooks;
  pdfUrl: (acceptanceId: string) => string;
  onAgreed: (said: string) => void;
}) {
  const heading = person.self ? "Your agreements" : `${person.name}'s agreements`;
  return (
    <section className="grid gap-3" aria-label={heading} data-person={person.personId}>
      <h2 className="text-lg font-semibold">{heading}</h2>
      {person.due.length ? (
        <ul className="grid gap-2" aria-label="To agree to">
          {person.due.map((item) => (
            <DueRow
              key={item.documentId}
              person={person}
              item={item}
              agreements={agreements}
              onAgreed={onAgreed}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">Nothing to agree to.</p>
      )}
      {items.length ? (
        <ul className="grid gap-2" aria-label="Agreed">
          {items.map((acceptance) => (
            <AcceptanceRow
              key={acceptance.id}
              acceptance={acceptance}
              me={me}
              agreements={agreements}
              pdfUrl={pdfUrl}
              onAgreed={onAgreed}
              forName={person.self ? null : person.name}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function DueRow({
  person,
  item,
  agreements,
  onAgreed,
}: {
  person: DuePerson;
  item: DueDocument;
  agreements: Pick<Hooks, "useAccept">;
  onAgreed: (said: string) => void;
}) {
  const accept = agreements.useAccept();
  const [open, setOpen] = useState(false);
  const because = dueReasonWords(person.canAgree ? item.reason : "guardian");
  return (
    <li className="grid gap-2 rounded-md border p-3" data-due={item.documentId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-1">
          <strong>{item.title}</strong>
          <span className="text-sm">{because ?? "To read and agree to."}</span>
        </div>
        {person.canAgree && !open ? (
          <Button type="button" onClick={() => setOpen(true)}>
            {item.reason === "agree_again" ? "Read and agree again" : "Read and agree"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <Agree
          key={item.version.id}
          version={item.version}
          forName={person.self ? null : person.name}
          reason={item.reason}
          secondary={{ label: "Close", onClick: () => setOpen(false) }}
          onAgree={async (input) => {
            const accepted = await accept.mutateAsync({
              ...input,
              ...(person.self ? {} : { forPersonId: person.personId }),
            });
            setOpen(false);
            onAgreed(copyWords(accepted));
          }}
        />
      ) : null}
    </li>
  );
}

function AcceptanceRow({
  acceptance,
  me,
  agreements,
  pdfUrl,
  onAgreed,
  forName,
}: {
  acceptance: AcceptanceSummary;
  me: string | null;
  agreements: Pick<Hooks, "useAcceptance" | "useAccept">;
  pdfUrl: (acceptanceId: string) => string;
  onAgreed: (said: string) => void;
  forName: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="grid gap-2 rounded-md border p-3" data-acceptance={acceptance.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-1">
          <strong>{`${acceptance.title}, version ${acceptance.versionNumber}`}</strong>
          <span className="text-sm">
            {`${agreedByWords(acceptance, me)} · ${agreementTime(acceptance.acceptedAt)}`}
          </span>
          <span className="text-muted-foreground text-sm">
            {acceptance.counts ? "In effect" : "Replaced by a later agreement"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide" : "View"}
          </Button>
          <Button asChild variant="outline">
            <a href={pdfUrl(acceptance.id)} download>
              Download PDF
            </a>
          </Button>
        </div>
      </div>
      {open ? (
        <AcceptanceDetail
          id={acceptance.id}
          agreements={agreements}
          onAgreed={onAgreed}
          forName={forName}
          personId={acceptance.personId}
          me={me}
          counts={acceptance.counts}
        />
      ) : null}
    </li>
  );
}

function AcceptanceDetail({
  id,
  agreements,
  onAgreed,
  forName,
  personId,
  me,
  counts,
}: {
  id: string;
  agreements: Pick<Hooks, "useAcceptance" | "useAccept">;
  onAgreed: (said: string) => void;
  forName: string | null;
  personId: string | null;
  me: string | null;
  counts: boolean;
}) {
  // Read only while it is open, and not kept in the app's cache after (it may hold health answers).
  const detail = agreements.useAcceptance(id);
  const accept = agreements.useAccept();
  const [updating, setUpdating] = useState(false);
  if (detail.isPending) return <p aria-busy="true">Loading…</p>;
  if (detail.error || !detail.data) return <p role="alert">We could not load this agreement.</p>;
  const a = detail.data;
  const questions = a.version.questions ?? [];
  return (
    <div className="grid gap-3" data-testid="acceptance">
      <AgreementText version={a.version} />
      {a.answers && questions.length ? (
        <dl className="grid gap-2 text-sm" aria-label="Your answers">
          {questions.map((q) => {
            const answer = a.answers?.find((x) => x.key === q.key);
            return (
              <div key={q.key}>
                <dt>{q.text}</dt>
                <dd className="font-medium">
                  {answer ? (answer.yes ? "Yes" : "No") : "Not answered"}
                  {answer?.note ? `: ${answer.note}` : ""}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {a.typedName ? <p className="text-sm">{`Name typed: ${a.typedName}`}</p> : null}
      {a.signature ? (
        <svg
          role="img"
          aria-label="The signature drawn"
          viewBox={`0 0 ${a.signature.width} ${a.signature.height}`}
          className="aspect-[5/2] w-full max-w-sm rounded-md border"
        >
          {a.signature.strokes.map((stroke, i) => (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: strokes are positional.
              key={i}
              d={strokePath(stroke)}
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      ) : null}
      {questions.length && counts && personId && (personId === me || forName) ? (
        updating ? (
          <Agree
            key={a.version.id}
            version={a.version}
            forName={forName}
            submitLabel="Save my new answers"
            secondary={{ label: "Cancel", onClick: () => setUpdating(false) }}
            onAgree={async (input) => {
              const accepted = await accept.mutateAsync({
                ...input,
                ...(personId === me ? {} : { forPersonId: personId }),
              });
              setUpdating(false);
              onAgreed(copyWords(accepted));
            }}
          />
        ) : (
          <Button type="button" variant="outline" onClick={() => setUpdating(true)}>
            Update the answers
          </Button>
        )
      ) : null}
    </div>
  );
}
